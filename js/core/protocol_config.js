// protocol_config.js - Protocol configuration constants

export const PROTOCOL_CONFIG = {
  UPLOAD_PROXY: 'https://bookish-upload-proxy.bookish.workers.dev',

  // Protocol fee: ~$0.01 at ~$2100/ETH (snapshot 2026-03-23), collected via pre-signed ETH tx
  FLAT_FEE_WEI: '4700000000000', // 0.0000047 ETH = 4.7e12 wei
  FEE_CURRENCY: 'ETH',
  FEE_VERSION: 3,

  PROTOCOL_WALLET: '0x7dbb8Bf8359dF93146A4656EB1292fcB1fd9a500',

  FEE_ENABLED: true,
};
