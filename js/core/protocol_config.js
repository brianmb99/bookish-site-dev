// protocol_config.js - Protocol configuration constants

export const PROTOCOL_CONFIG = {
  // Protocol revenue wallet (Base mainnet)
  // This wallet collects the 25% fee from all funding transactions
  // Separate from the faucet wallet
  PROTOCOL_WALLET: '0xaf93cBd1270aA26F5672056cEbbFa8Bb3130c4a4',

  // Fee percentage in basis points (25% = 2500 bps)
  FEE_BPS: 2500,

  // Minimum fee in wei - skip fee if below this (saves gas)
  // ~$0.001 worth of ETH at $3000/ETH = 0.00000033 ETH = 330000000000 wei
  MIN_FEE_WEI: '300000000000',

  // Feature flag - easy to disable if issues
  FEE_ENABLED: true,
};
