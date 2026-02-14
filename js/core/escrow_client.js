// escrow_client.js - Client for Arweave-based escrow encryption
// Calls the faucet worker to derive escrow keys and encrypt seed payload.
// The worker uses ESCROW_MASTER_KEY as the "password" in credential key derivation.
// The encryption key never leaves the worker — only the lookupKey and encrypted payload are returned.
// The client then uploads the encrypted payload to Arweave as a standard credential-mapping.

// Worker base URL
const ESCROW_ENCRYPT_URL = 'https://bookish-faucet.bookish.workers.dev/escrow/encrypt';

/**
 * Request escrow encryption from the worker.
 * Worker derives keys from (email + ESCROW_MASTER_KEY), encrypts the seed,
 * and returns { lookupKey, encryptedPayload (base64) }.
 *
 * @param {string} email - User's email address
 * @param {string} seed - User's 12-word BIP39 seed phrase
 * @param {string} displayName - User's display name
 * @returns {Promise<{lookupKey: string, encryptedPayload: Uint8Array}>}
 * @throws {Error} If worker request fails or returns an error
 */
export async function requestEscrowEncryption(email, seed, displayName) {
  if (!email || !seed) {
    throw new Error('email and seed are required for escrow encryption');
  }

  const resp = await fetch(ESCROW_ENCRYPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, seed, displayName })
  });

  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({}));
    throw new Error(errorData.error || `Escrow encrypt failed: ${resp.status}`);
  }

  const data = await resp.json();

  if (!data.success || !data.lookupKey || !data.encryptedPayload) {
    throw new Error('Invalid escrow encrypt response');
  }

  // Decode base64 payload to Uint8Array
  const encryptedPayload = Uint8Array.from(atob(data.encryptedPayload), c => c.charCodeAt(0));

  return {
    lookupKey: data.lookupKey,
    encryptedPayload
  };
}
