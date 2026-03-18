// protocol_config.js - Protocol configuration constants

export const PROTOCOL_CONFIG = {
  UPLOAD_PROXY: 'https://bookish-upload-proxy.bookish.workers.dev',

  // Protocol fee: ~$0.002 at $2000/ETH, collected via pre-signed ETH tx by the upload proxy
  FLAT_FEE_WEI: '1000000000000', // 0.000001 ETH = 1e12 wei
  FEE_CURRENCY: 'ETH',
  FEE_VERSION: 2,

  PROTOCOL_WALLET: '0x7dbb8Bf8359dF93146A4656EB1292fcB1fd9a500',

  FEE_ENABLED: true,
};
