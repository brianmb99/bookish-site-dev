// wallet_core.js - Ethereum wallet derivation from BIP39 seed
// Derives Base mainnet wallet addresses for self-funding and transactions

import { ethers } from 'https://esm.sh/ethers@6.13.0';
import { WALLET_STORAGE_KEY } from './storage_constants.js';

// Base mainnet network configuration
const BASE_MAINNET_RPC = 'https://mainnet.base.org';
const BASE_MAINNET_CHAIN_ID = 8453;

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
 * Get Base mainnet wallet balance (in ETH)
 * @param {string} address - Ethereum address
 * @returns {Promise<{balanceETH: string, balanceUSD: string}>}
 */
export async function getWalletBalance(address) {
  try {
    const provider = new ethers.JsonRpcProvider(BASE_MAINNET_RPC);
    const balance = await provider.getBalance(address);
    const balanceETH = ethers.formatEther(balance);

    // For mainnet, USD value could be calculated with price oracle
    // For now, returning $0 (price calculation is out of scope for Phase 1b)
    return {
      balanceETH,
      balanceUSD: '0.00',
    };
  } catch (error) {
    console.error('Balance fetch failed:', error);
    // Return $0 on error (better than throwing)
    return {
      balanceETH: '0',
      balanceUSD: '0.00',
    };
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
