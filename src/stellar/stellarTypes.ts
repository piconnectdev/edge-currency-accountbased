import { asMaybe, asNumber, asObject, asString } from 'cleaners'

import { asSafeCommonWalletInfo } from '../common/types'

export interface StellarNetworkInfo {
  baseReserve: string
  stellarServers: string[]
}

export interface StellarBalance {
  balance: string
  buying_liabilities: string
  selling_liabilities: string
  asset_type: string
}

export interface StellarAccount {
  id: string
  sequence: number
  balances: StellarBalance[]
}

export interface StellarCustomToken {
  currencyCode: string
  currencyName: string
  multiplier: string
  contractAddress: string
}

export interface StellarPayment {
  id: string
  paging_token: string
  type: 'payment'
  created_at: string
  transaction_hash: string
  asset_type: string
  from: string
  to: string
  amount: string
  transaction: Function
}

export interface StellarCreateAccount {
  id: string
  paging_token: string
  type: 'create_account'
  created_at: string
  transaction_hash: string
  asset_type: string
  source_account: string
  account: string
  starting_balance: string
  transaction: Function
}

export type StellarOperation = StellarPayment | StellarCreateAccount

export interface StellarTransaction {
  fee_paid: number
  memo_type: string
  ledger_attr: number
}
export const asStellarWalletOtherData = asObject({
  lastPagingToken: asMaybe(asString, '0'),
  accountSequence: asMaybe(asNumber, 0)
})

export type StellarWalletOtherData = ReturnType<typeof asStellarWalletOtherData>

export const asFeeStats = asObject({
  fee_charged: asObject({
    // max: asString,
    // min: asString,
    // mode: asString,
    // p10: asString,
    // p20: asString,
    // p30: asString,
    // p40: asString,
    p50: asString,
    // p60: asString,
    p70: asString,
    // p80: asString,
    // p90: asString,
    p95: asString
    // p99: asString
  })
})

export type SafeStellarWalletInfo = ReturnType<typeof asSafeStellarWalletInfo>
export const asSafeStellarWalletInfo = asSafeCommonWalletInfo

export type StellarPrivateKeys = ReturnType<typeof asStellarPrivateKeys>
export const asStellarPrivateKeys = asObject({
  stellarKey: asString
})
