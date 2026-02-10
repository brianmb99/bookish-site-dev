// protocol_fee.js - Calculate and execute protocol fee split
// Fee is taken as a percentage of each Irys funding transaction.
// Fee failure never blocks the user's upload.

import { PROTOCOL_CONFIG } from './protocol_config.js';

/**
 * Calculate fee split for a funding amount.
 * @param {bigint|string} totalAmountWei - Total amount the user would fund
 * @returns {{ protocolFeeWei: bigint, irysAmountWei: bigint, feeSkipped: boolean, reason?: string }}
 */
export function calculateFeeSplit(totalAmountWei) {
  const total = BigInt(totalAmountWei);
  const feeBps = BigInt(PROTOCOL_CONFIG.FEE_BPS);
  const minFee = BigInt(PROTOCOL_CONFIG.MIN_FEE_WEI);

  // Calculate fee
  const protocolFee = (total * feeBps) / 10000n;

  // Skip fee if below minimum (not worth the gas)
  if (protocolFee < minFee) {
    return {
      protocolFeeWei: 0n,
      irysAmountWei: total,
      feeSkipped: true,
      reason: 'below-minimum',
    };
  }

  // Remainder goes to Irys
  const irysAmount = total - protocolFee;

  return {
    protocolFeeWei: protocolFee,
    irysAmountWei: irysAmount,
    feeSkipped: false,
  };
}

/**
 * Send protocol fee to the protocol wallet.
 * Fire-and-forget: does not throw on failure so the user's upload continues.
 * @param {bigint} feeWei - Fee amount in wei
 * @param {object} signer - ethers.js Wallet with provider
 * @returns {Promise<{txHash: string}|null>} tx hash or null if skipped/failed
 */
export async function sendProtocolFee(feeWei, signer) {
  if (feeWei <= 0n) return null;

  try {
    const tx = await signer.sendTransaction({
      to: PROTOCOL_CONFIG.PROTOCOL_WALLET,
      value: feeWei,
    });

    // Don't wait for confirmation — fire and forget.
    // The Irys funding tx is what matters for the user.
    return { txHash: tx.hash };
  } catch (err) {
    // Fee failure must never block the upload
    console.error('[Bookish:ProtocolFee] Fee send failed (non-blocking):', err?.code || err?.message || err);
    return null;
  }
}

/**
 * Log fee event to localStorage for debugging / analytics.
 * @param {object} event - event payload
 */
export function logFeeEvent(event) {
  try {
    const log = JSON.parse(localStorage.getItem('bookish.feeLog') || '[]');
    log.push({ ...event, timestamp: Date.now() });
    // Keep last 100 entries
    if (log.length > 100) log.shift();
    localStorage.setItem('bookish.feeLog', JSON.stringify(log));
  } catch { /* never throw from logging */ }
}
