import algosdk, {
  decodeUnsignedTransaction,
  encodeUnsignedTransaction,
  Transaction
} from 'algosdk'
import { abs, add, gt, sub } from 'biggystring'
import { asMaybe } from 'cleaners'
import {
  EdgeCurrencyEngine,
  EdgeCurrencyEngineOptions,
  EdgeSpendInfo,
  EdgeTransaction,
  EdgeWalletInfo,
  InsufficientFundsError,
  JsonObject,
  NoAmountSpecifiedError
} from 'edge-core-js/types'
import { base16 } from 'rfc4648'

import { CurrencyEngine } from '../common/engine'
import { PluginEnvironment } from '../common/innerPlugin'
import {
  asyncWaterfall,
  cleanTxLogs,
  getOtherParams,
  makeMutex,
  Mutex
} from '../common/utils'
import { AlgorandTools } from './algorandPlugin'
import {
  AccountInformation,
  AlgorandNetworkInfo,
  AlgorandWalletOtherData,
  asAccountInformation,
  asAlgorandPrivateKeys,
  asAlgorandUnsignedTx,
  asAlgorandWalletOtherData,
  asBaseTxOpts,
  asIndexerPayTransactionResponse,
  asPayTransaction,
  asSafeAlgorandWalletInfo,
  asSuggestedTransactionParams,
  BaseTransaction,
  BaseTxOpts,
  IndexerPayTransactionResponse,
  SafeAlgorandWalletInfo,
  SuggestedTransactionParams
} from './algorandTypes'

const { Algodv2, Indexer } = algosdk

const ACCOUNT_POLL_MILLISECONDS = 5000
const TRANSACTION_POLL_MILLISECONDS = 3000

export class AlgorandEngine extends CurrencyEngine<
  AlgorandTools,
  SafeAlgorandWalletInfo
> {
  otherData!: AlgorandWalletOtherData
  networkInfo: AlgorandNetworkInfo

  queryTxMutex: Mutex
  suggestedTransactionParams: SuggestedTransactionParams
  minimumAddressBalance: string

  constructor(
    env: PluginEnvironment<AlgorandNetworkInfo>,
    tools: AlgorandTools,
    walletInfo: SafeAlgorandWalletInfo,
    opts: EdgeCurrencyEngineOptions
  ) {
    super(env, tools, walletInfo, opts)
    this.networkInfo = env.networkInfo

    this.queryTxMutex = makeMutex()
    this.suggestedTransactionParams = {
      flatFee: false,
      fee: 0,
      firstRound: 0,
      lastRound: 0,
      genesisID: this.networkInfo.genesisID,
      genesisHash: this.networkInfo.genesisHash
    }
    this.minimumAddressBalance = this.networkInfo.minimumAddressBalance
  }

  setOtherData(raw: any): void {
    this.otherData = asAlgorandWalletOtherData(raw)
  }

  async fetchAccountInfo(account: string): Promise<AccountInformation> {
    return await asyncWaterfall(
      this.networkInfo.algodServers.map(server => async () => {
        const client = new Algodv2('', server, '')
        const response = await client.accountInformation(account).do()
        const out = asAccountInformation(response)
        return out
      })
    )
  }

  getRecipientBalance = async (account: string): Promise<string> => {
    try {
      const accountInfo = await this.fetchAccountInfo(account)
      return accountInfo.amount.toString()
    } catch (e: any) {
      return this.minimumAddressBalance
    }
  }

  async queryBalance(): Promise<void> {
    try {
      const accountInfo: AccountInformation = await this.fetchAccountInfo(
        this.walletLocalData.publicKey
      )

      const { amount, round } = accountInfo

      this.updateBalance(this.currencyInfo.currencyCode, amount.toString())

      if (round > this.walletLocalData.blockHeight) {
        this.walletLocalData.blockHeight = round
        this.walletLocalDataDirty = true
        this.currencyEngineCallbacks.onBlockHeightChanged(
          this.walletLocalData.blockHeight
        )
      }
    } catch (e: any) {
      this.log.warn(`queryBalance Error `, e)
    }
  }

  async queryTransactionParams(): Promise<void> {
    try {
      const params: SuggestedTransactionParams = await asyncWaterfall(
        this.networkInfo.algodServers.map(server => async () => {
          const client = new Algodv2('', server, '')
          const response = await client.getTransactionParams().do()
          const out = asSuggestedTransactionParams(response)

          if (out.genesisHash !== this.networkInfo.genesisHash) {
            throw new Error('Server genesisHash mismatch')
          }

          return out
        })
      )

      this.suggestedTransactionParams = params
    } catch (e: any) {
      this.log.warn('queryTransactionParams error:', e)
    }
  }

  processAlgorandTransaction(tx: BaseTransaction): void {
    const {
      fee,
      'confirmed-round': confirmedRound,
      id,
      'round-time': roundTime,
      sender,
      'tx-type': txType
    } = tx

    let nativeAmount: string
    let networkFee: string
    const ourReceiveAddresses = []

    switch (txType) {
      case 'pay': {
        const { amount } = asPayTransaction(tx)['payment-transaction']

        nativeAmount = amount.toString()
        networkFee = fee.toString()

        if (sender === this.walletInfo.keys.publicKey) {
          nativeAmount = `-${add(nativeAmount, networkFee)}`
        } else {
          networkFee = '0'
          ourReceiveAddresses.push(this.walletInfo.keys.publicKey)
        }
        break
      }
      default: {
        // Unrecognized tx type
        return
      }
    }

    const edgeTransaction: EdgeTransaction = {
      txid: id,
      date: roundTime,
      currencyCode: this.currencyInfo.currencyCode,
      blockHeight: confirmedRound,
      nativeAmount,
      networkFee,
      ourReceiveAddresses,
      signedTx: '',
      walletId: this.walletId
    }

    this.addTransaction(this.currencyInfo.currencyCode, edgeTransaction)
  }

  async queryTransactions(): Promise<void> {
    return await this.queryTxMutex(
      async () => await this.queryTransactionsInner()
    )
  }

  async queryTransactionsInner(): Promise<void> {
    const minRound = this.otherData.latestRound // init query

    let latestTxid: string | undefined // To store newest found txid
    let latestRound = this.otherData.latestRound // To store next loop query ending round

    let progressRound = 0 // for tracking progress
    let nextQueryToken: string | undefined // to continue where previous query left off. The first server to respond will be the only one that can serve requests with this token.
    let continueQuery = true
    do {
      const indexerTransactions: IndexerPayTransactionResponse =
        await asyncWaterfall(
          this.networkInfo.indexerServers.map(server => async () => {
            const client = new Indexer({}, server, '')
            const response = await client
              .lookupAccountTransactions(this.walletLocalData.publicKey)
              .minRound(minRound)
              .nextToken(nextQueryToken ?? '')
              // .limit(1000) // default response limit is 1000
              .do()
            const out = asIndexerPayTransactionResponse(response)
            return out
          })
        )
      const { 'next-token': nextToken, transactions } = indexerTransactions

      if (transactions.length === 0) break

      for (const tx of transactions) {
        if (latestTxid == null) {
          // the very first tx is the most recent
          latestTxid = tx.id
          latestRound = tx['confirmed-round']
        }
        progressRound = tx['confirmed-round']
        if (tx.id === this.otherData.latestTxid) {
          continueQuery = false
          break
        }
        try {
          this.processAlgorandTransaction(tx)
        } catch (e: any) {
          this.log.warn('processAlgorandTransaction error:', e)
        }
      }

      latestRound = latestRound ?? this.walletLocalData.blockHeight
      const progress = (latestRound - progressRound) / (latestRound - minRound)
      this.tokenCheckTransactionsStatus[this.currencyInfo.currencyCode] =
        progress
      this.updateOnAddressesChecked()

      nextQueryToken = nextToken
    } while (nextQueryToken != null && continueQuery)

    if (latestTxid != null && this.otherData.latestTxid !== latestTxid) {
      this.otherData.latestTxid = latestTxid
      this.otherData.latestRound = latestRound
      this.walletLocalDataDirty = true
    }

    this.tokenCheckTransactionsStatus[this.currencyInfo.currencyCode] = 1
    this.updateOnAddressesChecked()

    if (this.transactionsChangedArray.length > 0) {
      this.walletLocalDataDirty = true
      this.currencyEngineCallbacks.onTransactionsChanged(
        this.transactionsChangedArray
      )
      this.transactionsChangedArray = []
    }
  }

  // // ****************************************************************************
  // // Public methods
  // // ****************************************************************************

  async startEngine(): Promise<void> {
    this.engineOn = true
    this.addToLoop('queryBalance', ACCOUNT_POLL_MILLISECONDS).catch(() => {})
    this.addToLoop('queryTransactionParams', ACCOUNT_POLL_MILLISECONDS).catch(
      () => {}
    )
    this.addToLoop('queryTransactions', TRANSACTION_POLL_MILLISECONDS).catch(
      () => {}
    )
    await super.startEngine()
  }

  async resyncBlockchain(): Promise<void> {
    await this.killEngine()
    await this.clearBlockchainCache()
    await this.startEngine()
  }

  calcFee(rawTx: Transaction): string {
    const sizeBytes = rawTx.estimateSize()
    const fee = Math.max(
      this.suggestedTransactionParams.fee * sizeBytes,
      this.networkInfo.minimumTxFee
    )
    return fee.toString()
  }

  async makeSpend(edgeSpendInfoIn: EdgeSpendInfo): Promise<EdgeTransaction> {
    const { edgeSpendInfo, currencyCode } = this.makeSpendCheck(edgeSpendInfoIn)

    const spendableAlgoBalance = sub(
      this.getBalance({
        currencyCode: this.currencyInfo.currencyCode
      }),
      this.minimumAddressBalance
    )

    if (edgeSpendInfo.spendTargets.length !== 1) {
      throw new Error('Error: only one output allowed')
    }

    const {
      nativeAmount: amount,
      memo,
      publicAddress
    } = edgeSpendInfo.spendTargets[0]

    if (publicAddress == null)
      throw new Error('makeSpend Missing publicAddress')
    if (amount == null) throw new NoAmountSpecifiedError()

    const { type }: BaseTxOpts = asMaybe(asBaseTxOpts)(
      edgeSpendInfo.otherParams
    ) ?? { type: 'pay' }

    let note: Uint8Array | undefined
    if (memo != null) {
      note = Uint8Array.from(Buffer.from(memo, 'ascii'))
    }

    let rawTx: Transaction
    let nativeAmount = amount
    let networkFee = '0'
    let fee: string
    let recipient: string | undefined
    switch (type) {
      case 'pay': {
        rawTx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          to: publicAddress,
          from: this.walletInfo.keys.publicKey,
          amount: BigInt(amount),
          note,
          suggestedParams: { ...this.suggestedTransactionParams }
        })
        fee = this.calcFee(rawTx)

        networkFee = fee
        nativeAmount = `-${add(nativeAmount, networkFee)}`
        recipient = publicAddress

        if (gt(abs(nativeAmount), spendableAlgoBalance)) {
          throw new InsufficientFundsError()
        }

        break
      }
      default:
        throw new Error('Unrecognized transaction type')
    }

    rawTx.flatFee = true
    rawTx.fee = parseInt(fee)

    const otherParams = {
      encodedTx: base16.stringify(encodeUnsignedTransaction(rawTx)),
      recipient
    }

    const edgeTransaction: EdgeTransaction = {
      txid: '',
      date: 0,
      currencyCode,
      blockHeight: 0,
      nativeAmount,
      networkFee,
      ourReceiveAddresses: [],
      signedTx: '',
      otherParams,
      walletId: this.walletId
    }

    return edgeTransaction
  }

  async signTx(
    edgeTransaction: EdgeTransaction,
    privateKeys: JsonObject
  ): Promise<EdgeTransaction> {
    const { encodedTx, recipient } = asAlgorandUnsignedTx(
      getOtherParams(edgeTransaction)
    )

    const rawTx = decodeUnsignedTransaction(
      Uint8Array.from(base16.parse(encodedTx))
    )

    if (recipient != null) {
      await this.checkRecipientMinimumBalance(
        this.getRecipientBalance,
        rawTx.amount.toString(),
        recipient
      )
    }

    const keys = asAlgorandPrivateKeys(this.currencyInfo.pluginId)(privateKeys)
    const secretKey = algosdk.mnemonicToSecretKey(keys.mnemonic)
    const signedTxBytes = rawTx.signTxn(secretKey.sk)
    const signedTx = base16.stringify(signedTxBytes)

    edgeTransaction.signedTx = signedTx
    return edgeTransaction
  }

  async broadcastTx(
    edgeTransaction: EdgeTransaction
  ): Promise<EdgeTransaction> {
    const signedTxBytes = Uint8Array.from(
      base16.parse(edgeTransaction.signedTx)
    )

    try {
      const { txId } = await asyncWaterfall(
        this.networkInfo.algodServers.map(server => async () => {
          const client = new Algodv2('', server, '')
          return await client.sendRawTransaction(signedTxBytes).do()
        })
      )
      edgeTransaction.txid = txId
      edgeTransaction.date = Date.now() / 1000
    } catch (e: any) {
      this.warn('FAILURE broadcastTx failed: ', e)
      throw e
    }

    this.warn(`SUCCESS broadcastTx\n${cleanTxLogs(edgeTransaction)}`)
    return edgeTransaction
  }

  getDisplayPrivateSeed(privateKeys: JsonObject): string {
    const algorandPrivateKeys = asAlgorandPrivateKeys(
      this.currencyInfo.pluginId
    )(privateKeys)
    return algorandPrivateKeys.mnemonic
  }

  getDisplayPublicSeed(): string {
    return this.walletInfo.keys.publicKey ?? ''
  }
}

export async function makeCurrencyEngine(
  env: PluginEnvironment<AlgorandNetworkInfo>,
  tools: AlgorandTools,
  walletInfo: EdgeWalletInfo,
  opts: EdgeCurrencyEngineOptions
): Promise<EdgeCurrencyEngine> {
  const safeWalletInfo = asSafeAlgorandWalletInfo(walletInfo)
  const engine = new AlgorandEngine(env, tools, safeWalletInfo, opts)

  await engine.loadEngine(tools, safeWalletInfo, opts)

  return engine
}
