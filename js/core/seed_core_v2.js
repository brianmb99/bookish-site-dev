// seed_core_v2.js - BIP39 seed with PRF-based encryption (v2 architecture)
// Uses WebAuthn PRF extension for deterministic key derivation across devices

import { generateMnemonic, validateMnemonic } from 'https://esm.sh/@scure/bip39@1.3.0';
import { wordlist } from 'https://esm.sh/@scure/bip39@1.3.0/wordlists/english';
import { encryptJson, decryptJson } from './crypto_core.js';
import { authenticateWithPRF } from './passkey_core_v2.js';

const ACCOUNT_V2_STORAGE_KEY = 'bookish.account.v2';
const SEED_SHOWN_KEY = 'bookish.seed.shown.v2';

/**
 * Generate a new 12-word BIP39 mnemonic seed
 * @returns {string} - 12-word mnemonic phrase
 */
export function generateSeed() {
  // Generate 128 bits of entropy for 12-word seed
  return generateMnemonic(wordlist, 128);
}

/**
 * Validate a BIP39 mnemonic seed
 * @param {string} mnemonic - Mnemonic phrase to validate
 * @returns {boolean} - True if valid
 */
export function isValidSeed(mnemonic) {
  try {
    return validateMnemonic(mnemonic, wordlist);
  } catch {
    return false;
  }
}

/**
 * Encrypt and store seed with PRF-derived encryption key
 * @param {string} mnemonic - 12-word mnemonic to store
 * @param {CryptoKey} prfEncryptionKey - Encryption key from PRF passkey
 * @param {string} credentialId - Passkey credential ID (for reference)
 * @returns {Promise<void>}
 */
export async function storeSeedV2(mnemonic, prfEncryptionKey, credentialId) {
  if (!isValidSeed(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic');
  }

  // Encrypt seed with PRF-derived key
  const encrypted = await encryptJson(prfEncryptionKey, {
    mnemonic,
    created: Date.now(),
    wordCount: 12,
  });

  const accountRecord = {
    version: 2,
    enc: encrypted,
    credentialId,
    derivation: 'prf',
    wordCount: 12,
    created: Date.now(),
  };

  localStorage.setItem(ACCOUNT_V2_STORAGE_KEY, JSON.stringify(accountRecord));
}

/**
 * Retrieve and decrypt stored seed with PRF authentication
 * Automatically authenticates with passkey and derives decryption key
 * @returns {Promise<string>} - Decrypted 12-word mnemonic
 */
export async function retrieveSeedV2() {
  const accountRecordStr = localStorage.getItem(ACCOUNT_V2_STORAGE_KEY);
  if (!accountRecordStr) {
    throw new Error('No account found. Please create or import an account first.');
  }

  const accountRecord = JSON.parse(accountRecordStr);

  if (accountRecord.version !== 2 || accountRecord.derivation !== 'prf') {
    throw new Error('Account is not PRF-based (v1 account). Please create a new v2 account.');
  }

  // Authenticate with PRF passkey and get decryption key
  const { encryptionKey } = await authenticateWithPRF();

  // Decrypt seed
  const decrypted = await decryptJson(encryptionKey, accountRecord.enc);
  return decrypted.mnemonic;
}

/**
 * Check if a v2 account exists in storage
 * @returns {boolean}
 */
export function hasAccountV2() {
  const record = localStorage.getItem(ACCOUNT_V2_STORAGE_KEY);
  if (!record) return false;

  try {
    const parsed = JSON.parse(record);
    return parsed.version === 2 && parsed.derivation === 'prf';
  } catch {
    return false;
  }
}

/**
 * Get account metadata without decrypting
 * @returns {Object|null} - Account metadata or null
 */
export function getAccountV2Metadata() {
  const accountRecordStr = localStorage.getItem(ACCOUNT_V2_STORAGE_KEY);
  if (!accountRecordStr) return null;

  try {
    const record = JSON.parse(accountRecordStr);
    return {
      version: record.version,
      wordCount: record.wordCount || 12,
      derivation: record.derivation,
      created: record.created,
      encrypted: true,
      arweaveTxId: record.arweaveTxId || null, // Phase 1c: Arweave transaction ID
    };
  } catch {
    return null;
  }
}

/**
 * Update account metadata with Arweave transaction ID (Phase 1c)
 * @param {string} txId - Arweave transaction ID
 * @returns {void}
 */
export function setArweaveTxId(txId) {
  const accountRecordStr = localStorage.getItem(ACCOUNT_V2_STORAGE_KEY);
  if (!accountRecordStr) {
    throw new Error('No account found');
  }

  try {
    const record = JSON.parse(accountRecordStr);
    record.arweaveTxId = txId;
    record.persistedAt = Date.now();
    localStorage.setItem(ACCOUNT_V2_STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    throw new Error(`Failed to update account metadata: ${error.message}`);
  }
}

/**
 * Mark that seed has been shown to user (for one-time display tracking)
 * @returns {void}
 */
export function markSeedAsShownV2() {
  localStorage.setItem(SEED_SHOWN_KEY, Date.now().toString());
}

/**
 * Check if seed has been shown before
 * @returns {boolean}
 */
export function wasSeedShownV2() {
  return !!localStorage.getItem(SEED_SHOWN_KEY);
}

/**
 * Clear seed shown flag (for testing purposes)
 * @returns {void}
 */
export function clearSeedShownFlagV2() {
  localStorage.removeItem(SEED_SHOWN_KEY);
}

/**
 * Create new account with PRF-encrypted seed
 * This is the main entry point for AC1-4 (passkey creation + seed generation + encryption + storage)
 * @param {string} userId - Unique user identifier (for PRF salt derivation)
 * @param {string} displayName - Display name for passkey
 * @returns {Promise<{mnemonic: string, walletAddress: string, credentialId: string}>}
 */
export async function createAccountV2(userId, displayName = 'Bookish User') {
  // Import here to avoid circular dependency
  const { createPasskeyWithPRF } = await import('./passkey_core_v2.js');
  const { deriveWalletFromSeed } = await import('./wallet_core.js');
  const { deriveAndStoreSymmetricKey } = await import('./crypto_core.js');

  // Step 1: Create PRF-enabled passkey (AC1-2)
  const { encryptionKey, credentialId } = await createPasskeyWithPRF(userId, displayName);

  // Step 2: Generate BIP39 seed (AC3)
  const mnemonic = generateSeed();

  // Step 3: Encrypt and store seed (AC3-4)
  await storeSeedV2(mnemonic, encryptionKey, credentialId);

  // Step 4: Derive wallet address (AC5)
  const { address } = await deriveWalletFromSeed(mnemonic);

  // Step 5: FIX UAT Bug #1 - Derive and store bookish.sym for book encryption
  // This is required for users to save books (core functionality)
  await deriveAndStoreSymmetricKey(mnemonic);

  // Step 6: Ensure EVM wallet is created
  await window.bookishWallet.ensure();

  return {
    mnemonic,
    walletAddress: address,
    credentialId,
  };
}

/**
 * Import existing seed and encrypt with new PRF passkey
 * @param {string} mnemonic - Existing 12-word mnemonic
 * @param {string} userId - Unique user identifier
 * @param {string} displayName - Display name for passkey
 * @returns {Promise<{walletAddress: string}>}
 */
export async function importSeedV2(mnemonic, userId, displayName = 'Bookish User') {
  if (!isValidSeed(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic. Please check your seed phrase.');
  }

  const { createPasskeyWithPRF } = await import('./passkey_core_v2.js');
  const { deriveWalletFromSeed } = await import('./wallet_core.js');
  const { deriveAndStoreSymmetricKey } = await import('./crypto_core.js');

  // Create PRF passkey
  const { encryptionKey, credentialId } = await createPasskeyWithPRF(userId, displayName);

  // Encrypt and store imported seed
  await storeSeedV2(mnemonic, encryptionKey, credentialId);

  // Derive wallet address
  const { address } = await deriveWalletFromSeed(mnemonic);

  // FIX UAT Bug #1 - Derive and store bookish.sym for book encryption
  await deriveAndStoreSymmetricKey(mnemonic);

  // Ensure EVM wallet is created
  await window.bookishWallet.ensure();

  return { walletAddress: address };
}

/**
 * Clear account from storage (use with extreme caution!)
 * @returns {void}
 */
export function clearAccountV2() {
  localStorage.removeItem(ACCOUNT_V2_STORAGE_KEY);
  localStorage.removeItem(SEED_SHOWN_KEY);
}

/**
 * Export seed phrase (requires PRF authentication)
 * @returns {Promise<string>} - The mnemonic seed phrase
 */
export async function exportSeedV2() {
  return await retrieveSeedV2();
}
