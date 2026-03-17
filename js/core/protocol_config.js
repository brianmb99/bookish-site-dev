// protocol_config.js - Protocol configuration constants

export const PROTOCOL_CONFIG = {
  UPLOAD_PROXY: 'https://bookish-upload-proxy.bookish.workers.dev',

  // Protocol fee (collected server-side by the upload proxy, not client-side)
  FEE_USDC: '1000',       // $0.001 USDC (6 decimals)
  FEE_CURRENCY: 'USDC',
  FEE_VERSION: 1,

  // Feature flag
  FEE_ENABLED: true,
};
