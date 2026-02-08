// account_creation.js - Pure account creation (seed generation + wallet derivation)
// No Arweave, no UI - just core account generation logic

import { generateMnemonic, validateMnemonic } from 'https://esm.sh/@scure/bip39@1.3.0';
import { wordlist } from 'https://esm.sh/@scure/bip39@1.3.0/wordlists/english';

/**
 * Generate a new 12-word BIP39 mnemonic seed
 * @returns {string} - 12-word mnemonic phrase
 */
export function generateSeed() {
  return generateMnemonic(wordlist, 128); // 128 bits = 12 words
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
 * Derive Ethereum wallet from BIP39 seed
 * @param {string} mnemonic - 12-word BIP39 seed
 * @returns {Promise<{address: string, privateKey: string}>}
 */
export async function deriveWalletFromSeed(mnemonic) {
  if (!isValidSeed(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic');
  }

  // Import ethers dynamically
  const { HDNodeWallet } = await import('https://esm.sh/ethers@6');

  // Derive wallet from mnemonic (BIP44 path: m/44'/60'/0'/0/0)
  const wallet = HDNodeWallet.fromPhrase(mnemonic);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey
  };
}

/**
 * Create a new account (seed + wallet)
 * Pure function - no side effects, no storage, no UI
 * @returns {Promise<{seed: string, address: string, privateKey: string}>}
 */
export async function createNewAccount() {
  const seed = generateSeed();
  const { address, privateKey } = await deriveWalletFromSeed(seed);

  return {
    seed,
    address,
    privateKey,
    createdAt: Date.now()
  };
}

/**
 * Restore account from existing seed
 * @param {string} mnemonic - Existing 12-word seed
 * @returns {Promise<{seed: string, address: string, privateKey: string}>}
 */
export async function restoreAccountFromSeed(mnemonic) {
  if (!isValidSeed(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic. Please check your seed phrase.');
  }

  const { address, privateKey } = await deriveWalletFromSeed(mnemonic);

  return {
    seed: mnemonic,
    address,
    privateKey,
    createdAt: Date.now() // Restoration timestamp
  };
}
