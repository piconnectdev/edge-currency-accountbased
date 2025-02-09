import { mul } from 'biggystring'
import { asEither, asNumber, asObject, asString, asValue } from 'cleaners'
import { EdgeIo, EdgeParsedUri, EdgeTokenMap } from 'edge-core-js/types'

import { cleanMultiFetch, makeQueryParams, QueryParams } from './network'
import { computeCRC, formatPixKey } from './pixkey'

const MAX_TIMEOUT_S = 60 * 60 * 24 * 7

const asSmartPayQrDecode = asEither(
  asObject({
    status: asValue('ok'),
    msg: asString,
    data: asObject({
      amount: asNumber,
      name: asString,
      key: asString,
      timeout: asNumber
    })
  }),
  asObject({
    status: asValue('failed'),
    msg: asString
  })
)

const asSmartPaySwapQuote = asObject({
  status: asValue('ok'),
  msg: asString,
  data: asObject({
    amount_usd: asString, // '0.000020',
    price_brl: asString, // '0.1923',
    total_brl: asString, // '0.00',
    fee_brl: asString, // '0.00',
    send_brl: asString, // '0.0001',
    timeout: asNumber, // 491,
    amount_txusdt: asString, // '0.000020',
    price_txusdt: asNumber, // 1,
    value_usd: asString, // '0.000020',
    total_txusdt: asString // '0.000020'
  })
})

export const parsePixKey = async (
  io: EdgeIo,
  tokens: EdgeTokenMap,
  code: string,
  smartPayPublicAddress: string,
  smartPayUserId: string
): Promise<EdgeParsedUri | undefined> => {
  const now = new Date()

  // Get USDT info
  const tokenId = Object.keys(tokens).find(
    id => tokens[id].currencyCode === 'USDT'
  )
  if (tokenId == null) return
  const token = tokens[tokenId]

  const minNativeAmount = mul('0.5', token.denominations[0].multiplier)

  if (code.length > 36) {
    const crc = computeCRC(code.slice(0, -4))
    if (!code.endsWith(crc)) {
      return
    }
    try {
      const qrcode = encodeURIComponent(code)
      const decode = await cleanMultiFetch(
        asSmartPayQrDecode,
        ['https://connect.smartpay.com.vc'],
        `api/pix/qrdecode?qrcode=${qrcode}`,
        undefined,
        undefined,
        io.fetch
      )
      if (decode.status !== 'ok') {
        throw new Error(decode.msg)
      }
      const { data: decodeData } = decode
      const { amount, key, name, timeout: decodeTimeout } = decodeData
      if (decodeTimeout > 0 && decodeTimeout < 120) {
        throw new Error('ErrorPixExpired')
      }

      let nativeAmount: string | undefined
      let expireDate: Date | undefined
      if (amount !== 0) {
        const paramsObj: QueryParams = {
          type: 'buy',
          profile: 'transfer',
          currency: 'brl',
          conv: 'txusdt',
          target: 'amount',
          user: smartPayUserId,
          amount: amount === 0 ? 100 : amount
        }
        const params = makeQueryParams(paramsObj)

        // Get swap quote
        const quote = await cleanMultiFetch(
          asSmartPaySwapQuote,
          ['https://connect.smartpay.com.vc'],
          `api/swapix/swapquote?${params}`,
          undefined,
          undefined,
          io.fetch
        )

        const { data: quoteData } = quote
        const { amount_txusdt: amountTxusdt, timeout: quoteTimeout } = quoteData
        if (quoteTimeout > 0 && quoteTimeout < 120) {
          throw new Error('ErrorPixExpired')
        }

        nativeAmount = mul(amountTxusdt, token.denominations[0].multiplier)
        const timeout = Math.min(
          decodeTimeout > 0 ? decodeTimeout : MAX_TIMEOUT_S,
          quoteTimeout > 0 ? quoteTimeout : MAX_TIMEOUT_S
        )
        expireDate = new Date(now.getTime() + timeout * 1000)
      }

      const out: EdgeParsedUri = {
        currencyCode: 'USDT',
        metadata: {
          name,
          notes: `To PIX: ${key}`
        },
        expireDate,
        nativeAmount,
        minNativeAmount,
        publicAddress: smartPayPublicAddress,
        uniqueIdentifier: code
      }
      return out
    } catch (e: any) {
      console.log(`Could not query PIX address ${code}: ${e.message}`)
    }
  } else {
    const [isPix, pixKey] = formatPixKey(code)
    if (!isPix) return
    const out: EdgeParsedUri = {
      currencyCode: 'USDT',
      minNativeAmount,
      metadata: {
        name: `PIX: ${pixKey}`,
        notes: `To PIX: ${pixKey}`
      },
      publicAddress: 'TUmgPbM5J6om7Z2PJjzrbSEbXit84ZhVCj',
      uniqueIdentifier: pixKey
    }
    return out
  }
}
