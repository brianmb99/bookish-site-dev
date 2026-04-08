// tarn_auth.js — JWT auth lifecycle for Tarn API write operations
//
// Manages challenge/verify flow: wallet signs EIP-191 message → API issues JWT.
// Caches token in memory; re-authenticates lazily when expired.

const API_BASE = window.BOOKISH_API_BASE || 'https://api.tarn.dev';

let _cachedToken = null;
let _tokenExp = 0;

/**
 * Get a valid JWT for the Tarn API, authenticating if needed.
 * Requires window.bookishWallet to be initialized.
 * @returns {Promise<string>} JWT token
 */
export async function ensureAuth() {
  // Return cached token if still valid (with 30s buffer)
  if (_cachedToken && Date.now() / 1000 < _tokenExp - 30) {
    return _cachedToken;
  }

  const address = await window.bookishWallet?.getAddress?.();
  if (!address) throw new Error('Wallet not available for auth');

  // 1. Request challenge
  const challengeRes = await fetch(`${API_BASE}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase() }),
    signal: AbortSignal.timeout(10000),
  });
  if (!challengeRes.ok) {
    const err = await challengeRes.json().catch(() => ({}));
    throw new Error(err.error || `Auth challenge failed: ${challengeRes.status}`);
  }
  const { nonce, message } = await challengeRes.json();

  // 2. Sign challenge message with wallet (EIP-191 personal_sign)
  const { Wallet } = await import('https://esm.sh/ethers@6.13.0');
  const pk = await window.bookishWallet.getPrivateKey();
  const wallet = new Wallet(pk);
  const signature = await wallet.signMessage(message);

  // 3. Verify signature → get JWT
  const verifyRes = await fetch(`${API_BASE}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase(), nonce, signature }),
    signal: AbortSignal.timeout(10000),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.error || `Auth verify failed: ${verifyRes.status}`);
  }
  const { token, expiresIn } = await verifyRes.json();

  // Cache token
  _cachedToken = token;
  _tokenExp = Date.now() / 1000 + (expiresIn || 900);

  console.info('[Bookish:Auth] Authenticated with Tarn API (expires in', expiresIn, 's)');
  return _cachedToken;
}

/**
 * Get current cached token without triggering auth.
 * @returns {string|null}
 */
export function getToken() {
  if (_cachedToken && Date.now() / 1000 < _tokenExp - 30) return _cachedToken;
  return null;
}

/**
 * Clear cached auth (e.g. on logout).
 */
export function clearAuth() {
  _cachedToken = null;
  _tokenExp = 0;
}
