// crypto_core.js - Shared AES-GCM encryption/decryption helpers
// Layout: iv(12 bytes) | tag(16 bytes) | ciphertext
// Used by wallet.js and browser_client.js

/**
 * Convert hex string to Uint8Array
 * @param {string} hex - Hex string (must be even length)
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  if (!hex || hex.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Convert Uint8Array to base64 string
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Import raw key bytes as AES-GCM CryptoKey
 * @param {Uint8Array} keyBytes - Raw key material (32 bytes for AES-256)
 * @returns {Promise<CryptoKey>}
 */
export async function importAesKey(keyBytes) {
  return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt data with AES-GCM, return bytes in format: iv(12)|tag(16)|ciphertext
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {Uint8Array} plaintext - Data to encrypt
 * @returns {Promise<Uint8Array>} - Encrypted bytes with iv and tag prepended
 */
export async function encryptBytes(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const full = new Uint8Array(buf); // ciphertext||tag
  const tag = full.slice(full.length - 16);
  const ct = full.slice(0, full.length - 16);
  const out = new Uint8Array(12 + 16 + ct.length);
  out.set(iv, 0);
  out.set(tag, 12);
  out.set(ct, 28);
  return out;
}

/**
 * Decrypt data with AES-GCM from format: iv(12)|tag(16)|ciphertext
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {Uint8Array} encryptedBytes - Encrypted data with iv and tag prepended
 * @returns {Promise<Uint8Array>} - Decrypted plaintext
 */
export async function decryptBytes(aesKey, encryptedBytes) {
  const iv = encryptedBytes.slice(0, 12);
  const tag = encryptedBytes.slice(12, 28);
  const ct = encryptedBytes.slice(28);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length); // reconstruct ciphertext||tag for WebCrypto
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, joined);
  return new Uint8Array(ptBuf);
}

/**
 * Encrypt JSON object to base64 string
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {Object} obj - Object to encrypt
 * @returns {Promise<string>} - Base64 encoded encrypted data
 */
export async function encryptJson(aesKey, obj) {
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const encrypted = await encryptBytes(aesKey, pt);
  return bytesToBase64(encrypted);
}

/**
 * Decrypt base64 string to JSON object
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {string} b64 - Base64 encoded encrypted data
 * @returns {Promise<Object>} - Decrypted and parsed JSON object
 */
export async function decryptJson(aesKey, b64) {
  const bytes = base64ToBytes(b64);
  const pt = await decryptBytes(aesKey, bytes);
  return JSON.parse(new TextDecoder().decode(pt));
}

/**
 * Encrypt JSON object to Uint8Array (for direct upload)
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {Object} obj - Object to encrypt
 * @returns {Promise<Uint8Array>} - Encrypted bytes
 */
export async function encryptJsonToBytes(aesKey, obj) {
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  return await encryptBytes(aesKey, pt);
}

/**
 * Decrypt Uint8Array to JSON object
 * @param {CryptoKey} aesKey - AES-GCM key
 * @param {Uint8Array} bytes - Encrypted bytes
 * @returns {Promise<Object>} - Decrypted and parsed JSON object
 */
export async function decryptBytesToJson(aesKey, bytes) {
  const pt = await decryptBytes(aesKey, bytes);
  return JSON.parse(new TextDecoder().decode(pt));
}

/**
 * Derive privacy-preserving lookup key from Ethereum address
 * Uses SHA-256(address.toLowerCase() + salt) to prevent on-chain linkage
 * @param {string} address - Ethereum address (0x...)
 * @returns {Promise<string>} - Hex string of hashed lookup key
 */
export async function deriveHashedAddressLookupKey(address) {
  const salt = 'bookish-account-lookup-v1';
  const input = address.toLowerCase() + salt;
  const inputBytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', inputBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive symmetric key from seed phrase and store in localStorage as bookish.sym
 * This key is used for encrypting BOTH book entries AND account metadata saved to Arweave
 * Derived deterministically from seed phrase using SHA-256 + salt
 * @param {string} mnemonic - 12-word BIP39 mnemonic
 * @returns {Promise<string>} - Hex-encoded symmetric key (64 chars)
 */
export async function deriveAndStoreSymmetricKey(mnemonic) {
  if (!mnemonic || typeof mnemonic !== 'string') {
    throw new Error('Invalid mnemonic: must be a non-empty string');
  }

  // Use same derivation as wallet.js ensure() for consistency
  const salt = new TextEncoder().encode('bookish-evm-v1');
  const seedBytes = new TextEncoder().encode(mnemonic);
  const toHash = new Uint8Array(seedBytes.length + salt.length);
  toHash.set(seedBytes, 0);
  toHash.set(salt, seedBytes.length);

  // Derive 256-bit key using SHA-256
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toHash));
  const symHex = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');

  // Store in localStorage
  localStorage.setItem('bookish.sym', symHex);

  console.log('[Bookish:CryptoCore] Symmetric key derived and stored (bookish.sym)');

  return symHex;
}

/**
 * Store seed phrase encrypted in localStorage
 * Encrypts seed with bookish.sym key, stores as bookish.account.sessionEnc
 * This allows auto-persistence and other operations without re-authenticating
 * Cleared on logout
 * @param {string} seed - BIP39 seed phrase
 * @returns {Promise<void>}
 */
export async function storeSessionEncryptedSeed(seed) {
  try {
    const symHex = localStorage.getItem('bookish.sym');
    if (!symHex) {
      throw new Error('Symmetric key (bookish.sym) not found');
    }

    const symKeyBytes = hexToBytes(symHex);
    const symKey = await importAesKey(symKeyBytes);

    const seedBytes = new TextEncoder().encode(seed);
    const encrypted = await encryptBytes(symKey, seedBytes);
    const encryptedB64 = bytesToBase64(encrypted);

    localStorage.setItem('bookish.account.sessionEnc', encryptedB64);
    console.log('[Bookish:CryptoCore] Session-encrypted seed stored');
  } catch (error) {
    console.error('[Bookish:CryptoCore] Failed to store session-encrypted seed:', error);
    throw error;
  }
}

/**
 * Retrieve and decrypt seed phrase from localStorage
 * Returns null if not available (user needs to authenticate)
 * @returns {Promise<string|null>} - Decrypted seed phrase or null
 */
export async function getSessionEncryptedSeed() {
  try {
    const encryptedB64 = localStorage.getItem('bookish.account.sessionEnc');
    if (!encryptedB64) {
      return null;
    }

    const symHex = localStorage.getItem('bookish.sym');
    if (!symHex) {
      console.warn('[Bookish:CryptoCore] bookish.sym not found, cannot decrypt session seed');
      return null;
    }

    const symKeyBytes = hexToBytes(symHex);
    const symKey = await importAesKey(symKeyBytes);

    const encrypted = base64ToBytes(encryptedB64);
    const decrypted = await decryptBytes(symKey, encrypted);
    const seed = new TextDecoder().decode(decrypted);

    return seed;
  } catch (error) {
    console.error('[Bookish:CryptoCore] Failed to decrypt session seed:', error);
    return null;
  }
}

/**
 * Clear session-encrypted seed from localStorage
 * Called on logout or when session should be invalidated
 */
export function clearSessionEncryptedSeed() {
  localStorage.removeItem('bookish.account.sessionEnc');
  console.log('[Bookish:CryptoCore] Session-encrypted seed cleared');
}

// PRF key functions removed — passkey no longer supported



