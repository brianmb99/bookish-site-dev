// wallet_core.js - Ethereum wallet derivation from BIP39 seed
// Derives Base mainnet wallet addresses for self-funding and transactions

import { ethers } from 'https://esm.sh/ethers@6.13.0';
import { WALLET_STORAGE_KEY } from './storage_constants.js';

const BASE_MAINNET_RPC = 'https://base.llamarpc.com';

/**
 * Derive Ethereum wallet from BIP39 mnemonic seed
 * Uses standard BIP44 path: m/44'/60'/0'/0/0 (Ethereum)
 * @param {string} mnemonic - 12-word BIP39 mnemonic
 * @returns {Promise<{address: string, wallet: ethers.HDNodeWallet}>}
 */
export async function deriveWalletFromSeed(mnemonic) {
  try {
    // Derive HD wallet from mnemonic (standard Ethereum path)
    const wallet = ethers.Wallet.fromPhrase(mnemonic);

    return {
      address: wallet.address,
      wallet,
    };
  } catch (error) {
    console.error('Wallet derivation failed:', error);
    throw new Error(`Failed to derive wallet: ${error.message}`);
  }
}

/**
 * Get Base mainnet native ETH balance
 * @param {string} address - Ethereum address
 * @returns {Promise<{balanceETH: string}>} balanceETH is a decimal ETH string (e.g. "0.000050")
 */
export async function getWalletBalance(address) {
  try {
    const provider = new ethers.JsonRpcProvider(BASE_MAINNET_RPC, 8453, { staticNetwork: true });
    const raw = await provider.getBalance(address);
    const balanceETH = ethers.formatEther(raw);
    return { balanceETH };
  } catch (error) {
    console.error('Balance fetch failed:', error);
    return { balanceETH: '0' };
  }
}

/**
 * Format address for display (0x1234...5678)
 * @param {string} address - Full Ethereum address
 * @returns {string} - Shortened address
 */
export function formatAddress(address) {
  if (!address || address.length < 10) return address;
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

/**
 * Copy address to clipboard
 * @param {string} address - Ethereum address to copy
 * @returns {Promise<void>}
 */
export async function copyAddressToClipboard(address) {
  try {
    await navigator.clipboard.writeText(address);
  } catch (error) {
    console.error('Clipboard copy failed:', error);
    throw new Error('Failed to copy address to clipboard');
  }
}

/**
 * Validate Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean}
 */
export function isValidAddress(address) {
  return ethers.isAddress(address);
}

/**
 * Store wallet address to localStorage
 * @param {string} address - Ethereum address to store
 */
export function storeWalletAddress(address) {
  if (!address) {
    throw new Error('Address is required');
  }
  localStorage.setItem(WALLET_STORAGE_KEY, address.toLowerCase());
}
