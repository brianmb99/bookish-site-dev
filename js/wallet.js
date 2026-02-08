// wallet.js - Hidden EVM wallet (Base) stored locally, encrypted with the Bookish symmetric key
// Exposes window.bookishWallet with: ensure(), getAddress(), getBalance(), signMessage(), export(), import()

import { Wallet, JsonRpcProvider } from 'https://esm.sh/ethers@6';
import { hexToBytes, importAesKey, encryptJson as coreEncryptJson, decryptJson as coreDecryptJson } from './core/crypto_core.js';

const BASE_RPC = window.BOOKISH_BASE_RPC || 'https://mainnet.base.org';
const STORAGE_KEY = 'bookish.evmWallet.v1';

async function getAesKeyFromSym(){
  const symHex = localStorage.getItem('bookish.sym');
  if(!symHex || !/^[0-9a-fA-F]{64}$/.test(symHex)) return null;
  const raw = hexToBytes(symHex.trim());
  return await importAesKey(raw);
}

async function encryptJson(obj){
  const key = await getAesKeyFromSym();
  if(!key) throw new Error('sym-key-missing');
  return coreEncryptJson(key, obj);
}

async function decryptJson(b64){
  const key = await getAesKeyFromSym();
  if(!key) throw new Error('sym-key-missing');
  return coreDecryptJson(key, b64);
}

function getProvider(){ return new JsonRpcProvider(BASE_RPC); }

async function loadRecord(){ const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return null; try { return JSON.parse(raw); } catch{ return null; } }
async function saveRecord(rec){ localStorage.setItem(STORAGE_KEY, JSON.stringify(rec)); }

async function ensure(){
  const existing = await loadRecord();
  if(existing) return true;
  const symHex = localStorage.getItem('bookish.sym');
  if(!symHex || !/^[0-9a-fA-F]{64}$/.test(symHex)) return false;
  // Derive deterministic private key from symmetric key + salt
  const salt = new TextEncoder().encode('bookish-evm-v1');
  const symBytes = hexToBytes(symHex.trim());
  const toHash = new Uint8Array(symBytes.length + salt.length);
  toHash.set(symBytes,0); toHash.set(salt, symBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toHash));
  let pkHex = '0x'+Array.from(digest).map(b=>b.toString(16).padStart(2,'0')).join('');
  // Ensure non-zero (extremely unlikely to be zero)
  if(/^0x0+$/.test(pkHex)) pkHex = '0x01'.padEnd(66,'0');
  const wallet = new Wallet(pkHex, getProvider());
  const enc = await encryptJson({ privateKey: wallet.privateKey });
  await saveRecord({ addr: wallet.address, enc, v:1, d:'kdf' });
  return true;
}

async function getAddress(){ const rec = await loadRecord(); return rec?.addr || null; }

async function getWallet(){
  const rec = await loadRecord(); if(!rec) throw new Error('wallet-missing');
  const parsed = await decryptJson(rec.enc);
  const provider = getProvider();
  return new Wallet(parsed.privateKey, provider);
}

async function getBalance(){ const addr = await getAddress(); if(!addr) return null; const provider = getProvider(); const bal = await provider.getBalance(addr); return bal; }

async function signMessage(message){ const w = await getWallet(); return await w.signMessage(message); }

async function exportWallet(){ const rec = await loadRecord(); return rec || null; }
async function importWallet(rec){ if(!rec || !rec.addr || !rec.enc) throw new Error('bad-import'); await saveRecord(rec); return true; }

async function getPrivateKey(){ const rec = await loadRecord(); if(!rec) throw new Error('wallet-missing'); const parsed = await decryptJson(rec.enc); return parsed.privateKey; }

window.bookishWallet = { ensure, getAddress, getBalance, signMessage, export: exportWallet, import: importWallet, getPrivateKey };
