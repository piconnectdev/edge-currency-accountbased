import { EdgeCurrencyInfo } from 'edge-core-js/types'

import { makeOuterPlugin } from '../common/innerPlugin'
import type { BinanceTools } from './BinanceTools'
import type { BinanceNetworkInfo } from './binanceTypes'

const networkInfo: BinanceNetworkInfo = {
  binanceApiServers: [
    'https://dex.binance.org',
    'https://dex-atlantic.binance.org',
    'https://dex-asiapacific.binance.org',
    'https://dex-european.binance.org'
  ],
  beaconChainApiServers: ['https://api.binance.org']
}

const currencyInfo: EdgeCurrencyInfo = {
  // Basic currency information:
  currencyCode: 'BNB',
  displayName: 'BNB Beacon Chain',
  pluginId: 'binance',
  walletType: 'wallet:binance',

  defaultSettings: {},

  memoMaxLength: 128,

  addressExplorer: 'https://explorer.binance.org/address/%s',
  transactionExplorer: 'https://explorer.binance.org/tx/%s',
  blockExplorer: 'https://explorer.binance.org/block/%s',

  denominations: [
    // An array of Objects of the possible denominations for this currency
    {
      name: 'BNB',
      multiplier: '100000000',
      symbol: 'B'
    }
  ],
  metaTokens: [] // Deprecated
}

export const binance = makeOuterPlugin<BinanceNetworkInfo, BinanceTools>({
  currencyInfo,
  networkInfo,

  async getInnerPlugin() {
    return await import(
      /* webpackChunkName: "bnb" */
      './BinanceTools'
    )
  }
})
