// wallet_core.js - Ethereum wallet derivation from BIP39 seed
// Derives Base mainnet wallet addresses for self-funding and transactions

import { ethers } from 'https://esm.sh/ethers@6.13.0';
import { WALLET_STORAGE_KEY } from './storage_constants.js';

const BASE_PRIMARY_RPC = 'https://mainnet.base.org';
const BASE_FALLBACK_RPC = 'https://base.llamarpc.com';

let _provider = null;
let _usingFallback = false;

function getProvider() {
  if (!_provider) {
    const url = _usingFallback ? BASE_FALLBACK_RPC : BASE_PRIMARY_RPC;
    _provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true });
  }
  return _provider;
}

/**
 * Derive Ethereum wallet from BIP39 mnemonic seed
 * Uses standard BIP44 path: m/44'/60'/0'/0/0 (Ethereum)
 * @param {string} mnemonic - 12-word BIP39 mnemonic
 * @returns {Promise<{address: string, wallet: ethers.HDNodeWallet}>}
 */
export async function deriveWalletFromSeed(mnemonic) {
  try {
    const wallet = ethers.Wallet.fromPhrase(mnemonic);
    return { address: wallet.address, wallet };
  } catch (error) {
    console.error('Wallet derivation failed:', error);
    throw new Error(`Failed to derive wallet: ${error.message}`);
  }
}

/**
 * Get Base mainnet native ETH balance with primary+fallback RPC
 * @param {string} address - Ethereum address
 * @returns {Promise<{balanceETH: string, ok: boolean}>} ok=true means RPC succeeded; ok=false means both RPCs failed
 */
export async function getWalletBalance(address) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await getProvider().getBalance(address);
      return { balanceETH: ethers.formatEther(raw), ok: true };
    } catch (error) {
      _provider = null;
      if (attempt === 0) {
        continue;
      }
      if (attempt === 1 && !_usingFallback) {
        _usingFallback = true;
        continue;
      }
      console.warn('Balance fetch failed on both RPCs:', error.message || error);
      return { balanceETH: '0', ok: false };
    }
  }
  return { balanceETH: '0', ok: false };
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
