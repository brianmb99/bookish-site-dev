// protocol_config.js - Protocol configuration constants

export const PROTOCOL_CONFIG = {
  // Protocol revenue wallet (Base mainnet)
  // This wallet collects the protocol fee from all uploads
  // Separate from the faucet wallet
  PROTOCOL_WALLET: '0xaf93cBd1270aA26F5672056cEbbFa8Bb3130c4a4',

  // Flat per-upload fee in wei sent to the protocol wallet before every Irys upload.
  // 0.0000025 ETH ≈ $0.005 at $2000/ETH.
  // Sized so the faucet drip (0.000025 ETH) covers ~10 uploads.
  // Gas for the fee tx on Base is ~$0.0004 (<10% of fee), so this is efficient.
  FLAT_FEE_WEI: '2500000000000',

  // Legacy: percentage-based fee for 402-triggered Irys fundings.
  // Kept for reference but no longer used — replaced by FLAT_FEE_WEI.
  FEE_BPS: 2500,
  MIN_FEE_WEI: '33000000000',

  // Feature flag - easy to disable if issues
  FEE_ENABLED: true,
};
