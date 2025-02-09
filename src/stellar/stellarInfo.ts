import { EdgeCurrencyInfo } from 'edge-core-js/types'

import { makeOuterPlugin } from '../common/innerPlugin'
import type { StellarTools } from './StellarTools'
import type { StellarNetworkInfo } from './stellarTypes'

const networkInfo: StellarNetworkInfo = {
  baseReserve: '10000000',
  stellarServers: ['https://horizon.stellar.org']
}

export const currencyInfo: EdgeCurrencyInfo = {
  // Basic currency information:
  currencyCode: 'XLM',
  displayName: 'Stellar',
  pluginId: 'stellar',
  walletType: 'wallet:stellar',

  defaultSettings: {},

  memoMaxLength: 19,

  addressExplorer: 'https://stellarchain.io/address/%s',
  transactionExplorer: 'https://stellarchain.io/tx/%s',

  denominations: [
    // An array of Objects of the possible denominations for this currency
    {
      name: 'XLM',
      multiplier: '10000000',
      symbol: '*'
    }
  ],
  metaTokens: [] // Deprecated
}

export const stellar = makeOuterPlugin<StellarNetworkInfo, StellarTools>({
  currencyInfo,
  networkInfo,

  async getInnerPlugin() {
    return await import(
      /* webpackChunkName: "stellar" */
      './StellarTools'
    )
  }
})
