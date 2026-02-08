// seed_core.js - BIP39 seed generation and validation utilities
// Pure utility module — no auth dependencies

import { generateMnemonic, validateMnemonic } from 'https://esm.sh/@scure/bip39@1.3.0';
import { wordlist } from 'https://esm.sh/@scure/bip39@1.3.0/wordlists/english';
import { ACCOUNT_STORAGE_KEY, SEED_SHOWN_KEY } from './storage_constants.js';

/**
 * Generate a new 12-word BIP39 mnemonic seed
 * @returns {string} - 12-word mnemonic phrase
 */
export function generateSeed() {
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
 * Check if a account exists in storage
 * @returns {boolean}
 */
export function hasAccount() {
  const record = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!record) return false;

  try {
    const parsed = JSON.parse(record);
    return !!parsed.derivation;
  } catch {
    return false;
  }
}

/**
 * Get account metadata without decrypting
 * @returns {Object|null} - Account metadata or null
 */
export function getAccountMetadata() {
  const accountRecordStr = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountRecordStr) return null;

  try {
    const record = JSON.parse(accountRecordStr);
    return {
      version: record.version,
      wordCount: record.wordCount || 12,
      derivation: record.derivation,
      created: record.created,
    };
  } catch {
    return null;
  }
}

/**
 * Mark that seed has been shown to user (for one-time display tracking)
 */
export function markSeedAsShown() {
  localStorage.setItem(SEED_SHOWN_KEY, Date.now().toString());
}

/**
 * Check if seed has been shown before
 * @returns {boolean}
 */
export function wasSeedShown() {
  return !!localStorage.getItem(SEED_SHOWN_KEY);
}

/**
 * Clear seed shown flag
 */
export function clearSeedShownFlag() {
  localStorage.removeItem(SEED_SHOWN_KEY);
}

/**
 * Clear account from storage
 */
export function clearAccount() {
  localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  localStorage.removeItem(SEED_SHOWN_KEY);
}
