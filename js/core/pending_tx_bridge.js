// pending_tx_bridge.js — Accelerates cross-device discovery
//
// After uploads (books, credential mappings, etc.), registers the tx ID with
// a lightweight bridge service. On another device, the sync/sign-in flow
// queries the bridge to discover recent tx IDs before Arweave GraphQL
// indexing catches up (10+ min typical delay).
//
// All operations are best-effort. If the bridge is unavailable, the app falls
// back to GraphQL-only discovery with no user-visible impact.

const DEFAULT_BRIDGE_URL = 'https://bookish-pending-tx.bookish.workers.dev';
const REGISTER_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 3000;

function getBridgeUrl() {
  return (typeof window !== 'undefined' && window.BOOKISH_PENDING_TX_BRIDGE) || DEFAULT_BRIDGE_URL;
}

// AbortSignal.timeout() requires Safari 16+ (iOS 16+). Use AbortController
// fallback so bridge registration works on older devices.
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/**
 * Derive the bridge lookup key: SHA-256(walletAddress.toLowerCase() + 'bookish')
 * Same derivation as Account-Lookup-Key used for account metadata on Arweave.
 */
export async function deriveLookupKey(walletAddress) {
  const input = walletAddress.toLowerCase() + 'bookish';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Register pending tx IDs using a pre-derived lookup key.
 * Fire-and-forget: never throws, never blocks the caller.
 *
 * @param {string} lookupKey - 64-char hex lookup key
 * @param {string|string[]} txIds - One or more Arweave transaction IDs
 */
export async function registerPendingTxByKey(lookupKey, txIds) {
  try {
    if (!lookupKey || !txIds) return;
    const ids = Array.isArray(txIds) ? txIds : [txIds];
    if (ids.length === 0) return;

    const url = getBridgeUrl();

    await fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookupKey, txIds: ids }),
      signal: timeoutSignal(REGISTER_TIMEOUT_MS),
    });
  } catch {
    // Silently ignore — bridge registration is best-effort
  }
}

/**
 * Fetch pending tx IDs using a pre-derived lookup key.
 * Returns an empty array on any error or timeout.
 *
 * @param {string} lookupKey - 64-char hex lookup key
 * @returns {Promise<string[]>} Array of pending Arweave transaction IDs
 */
export async function fetchPendingTxIdsByKey(lookupKey) {
  try {
    if (!lookupKey) return [];

    const url = getBridgeUrl();

    const r = await fetch(`${url}/pending?key=${lookupKey}`, {
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!r.ok) return [];

    const data = await r.json();
    return Array.isArray(data?.txIds) ? data.txIds : [];
  } catch {
    return [];
  }
}

/**
 * Register one or more pending tx IDs with the bridge.
 * Convenience wrapper that derives the key from a wallet address.
 * Fire-and-forget: never throws, never blocks the caller.
 *
 * @param {string} walletAddress - EVM wallet address
 * @param {string|string[]} txIds - One or more Arweave transaction IDs
 */
export async function registerPendingTx(walletAddress, txIds) {
  try {
    if (!walletAddress || !txIds) return;
    const lookupKey = await deriveLookupKey(walletAddress);
    await registerPendingTxByKey(lookupKey, txIds);
  } catch {
    // Silently ignore
  }
}

/**
 * Fetch pending tx IDs from the bridge for a wallet address.
 * Convenience wrapper that derives the key from a wallet address.
 * Returns an empty array on any error or timeout.
 *
 * @param {string} walletAddress - EVM wallet address
 * @returns {Promise<string[]>} Array of pending Arweave transaction IDs
 */
export async function fetchPendingTxIds(walletAddress) {
  try {
    if (!walletAddress) return [];
    const lookupKey = await deriveLookupKey(walletAddress);
    return await fetchPendingTxIdsByKey(lookupKey);
  } catch {
    return [];
  }
}
