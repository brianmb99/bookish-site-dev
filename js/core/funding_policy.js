// funding_policy.js - Pure funding decision engine extracted from irys_client_browser.js
// Mirrors actual inline logic for testability

// Constants match irys_client_browser.js
const FUND_BUFFER_BPS = 1000; // 10%
const FUND_COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes
const INSUFF_FUNDS_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
const RETRY_AFTER_FUND_MS = 180000; // 3 minutes
const RETRY_WITH_RECENT_FUND_MS = 480000; // 8 minutes

// Helper: compute buffer (10% of price in BPS)
export function computeBuffer(priceWei, bufferBps = FUND_BUFFER_BPS) {
  const price = BigInt(priceWei);
  return (price * BigInt(bufferBps)) / 10000n;
}

// Helper: check if last fund matches current identity
function lastFundMatchesIdentity(lastFund, identity) {
  if (!lastFund) return false;
  return lastFund.node === identity.node &&
    lastFund.token === identity.token &&
    lastFund.address?.toLowerCase?.() === identity.address?.toLowerCase?.();
}

// Helper: compute cooldown remaining
function lastFundCooldownRemaining(lastFund, cooldownMs, nowMs) {
  if (!lastFund) return 0;
  const rem = (lastFund.at || 0) + cooldownMs - nowMs;
  return rem > 0 ? rem : 0;
}

// Main decision function: should we fund, skip (cooldown), or block (insufficient)?
// Mirrors logic in irys_client_browser.js lines 220-295
export function decideFunding({
  priceWei,
  lastFund, // { at, node, token, address, amountWei, txHash } or null
  fundBlock, // { address, reason, until } or null
  identity, // { node, token, address }
  walletBalWei, // BigInt string or null
  gasReserveWei, // BigInt string (computed by caller: gasLimit * feePerGas * 1.2)
  nowMs = Date.now()
}) {
  const price = BigInt(priceWei);
  const buffer = computeBuffer(price);
  const amount = price + buffer;

  // Check 1: active fund block (insufficient funds block from recent failure)
  if (fundBlock && fundBlock.address?.toLowerCase?.() === identity.address?.toLowerCase?.()) {
    if ((fundBlock.until || 0) > nowMs) {
      return {
        action: 'block',
        reason: 'fund-block-active',
        amountWei: null,
        retryWindowMs: null,
        details: fundBlock
      };
    }
  }

  // Check 2: cooldown (don't re-fund same identity within 8 min)
  const cooldownMs = lastFundMatchesIdentity(lastFund, identity)
    ? lastFundCooldownRemaining(lastFund, FUND_COOLDOWN_MS, nowMs)
    : 0;

  if (cooldownMs > 0) {
    return {
      action: 'skip',
      reason: 'cooldown',
      amountWei: null,
      retryWindowMs: Math.max(RETRY_WITH_RECENT_FUND_MS, cooldownMs + 60000),
      cooldownRemainingMs: cooldownMs,
      lastFund
    };
  }

  // Check 3: wallet balance precheck (ensure enough for amount + gas)
  if (walletBalWei != null) {
    const walletBal = BigInt(walletBalWei);
    const gasReserve = BigInt(gasReserveWei || 0);
    const totalNeeded = amount + gasReserve;

    if (walletBal < totalNeeded) {
      return {
        action: 'block',
        reason: 'insufficient-balance',
        amountWei: amount.toString(),
        retryWindowMs: null,
        details: {
          walletBalWei: walletBal.toString(),
          amountWei: amount.toString(),
          gasReserveWei: gasReserve.toString(),
          totalNeededWei: totalNeeded.toString()
        }
      };
    }
  }

  // All checks passed: proceed with funding
  return {
    action: 'fund',
    reason: 'ok',
    amountWei: amount.toString(),
    bufferWei: buffer.toString(),
    priceWei: price.toString(),
    retryWindowMs: RETRY_AFTER_FUND_MS
  };
}

// Export constants for tests and caller
export const CONSTANTS = {
  FUND_BUFFER_BPS,
  FUND_COOLDOWN_MS,
  INSUFF_FUNDS_COOLDOWN_MS,
  RETRY_AFTER_FUND_MS,
  RETRY_WITH_RECENT_FUND_MS
};
