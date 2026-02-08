// credential_core.js - Username+password credential key derivation
// PBKDF2-SHA256 based key derivation for email+password authentication
// Pure crypto module — no DOM, no Arweave, no side effects

import { importAesKey, encryptJsonToBytes, decryptBytesToJson } from './crypto_core.js';

// PBKDF2 configuration (OWASP 2023 recommendation)
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_HASH = 'SHA-256';
const KEY_LENGTH_BITS = 256;

// Domain separation constants
const AUTH_SALT_DOMAIN = 'bookish-auth-v1';
const LOOKUP_DOMAIN = 'bookish-lookup-v1';
const ENCRYPT_DOMAIN = 'bookish-encrypt-v1';

/**
 * Normalize username (email) for consistent key derivation
 * Rules: trim whitespace, convert to lowercase
 * @param {string} email - Raw email input
 * @returns {string} - Normalized email
 */
export function normalizeUsername(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('Email is required');
  }
  return email.trim().toLowerCase();
}

/**
 * Derive all credential keys from email + password
 * Uses PBKDF2-SHA256 with 600,000 iterations
 *
 * Flow:
 *   1. salt = SHA-256(normalizedEmail + AUTH_SALT_DOMAIN)
 *   2. masterKey = PBKDF2(password, salt, 600K iterations) → 32 bytes
 *   3. lookupKey = SHA-256(masterKey + LOOKUP_DOMAIN) → hex string
 *   4. encryptionKey = SHA-256(masterKey + ENCRYPT_DOMAIN) → AES-GCM CryptoKey
 *
 * @param {string} email - User email (will be normalized)
 * @param {string} password - User password
 * @returns {Promise<{masterKey: Uint8Array, lookupKey: string, encryptionKey: CryptoKey}>}
 */
export async function deriveCredentialKeys(email, password) {
  if (!email || !password) {
    throw new Error('Email and password are required');
  }

  const normalizedEmail = normalizeUsername(email);
  const encoder = new TextEncoder();

  // Step 1: Derive deterministic salt from email
  const saltInput = encoder.encode(normalizedEmail + AUTH_SALT_DOMAIN);
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', saltInput));

  // Step 2: Import password as key material for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Step 3: Derive master key via PBKDF2
  const masterKeyBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    passwordKey,
    KEY_LENGTH_BITS
  );
  const masterKey = new Uint8Array(masterKeyBits);

  // Step 4: Derive lookup key = SHA-256(masterKey + LOOKUP_DOMAIN)
  const lookupInput = new Uint8Array(masterKey.length + encoder.encode(LOOKUP_DOMAIN).length);
  lookupInput.set(masterKey, 0);
  lookupInput.set(encoder.encode(LOOKUP_DOMAIN), masterKey.length);
  const lookupHash = new Uint8Array(await crypto.subtle.digest('SHA-256', lookupInput));
  const lookupKey = Array.from(lookupHash).map(b => b.toString(16).padStart(2, '0')).join('');

  // Step 5: Derive encryption key = SHA-256(masterKey + ENCRYPT_DOMAIN) → AES-GCM CryptoKey
  const encryptInput = new Uint8Array(masterKey.length + encoder.encode(ENCRYPT_DOMAIN).length);
  encryptInput.set(masterKey, 0);
  encryptInput.set(encoder.encode(ENCRYPT_DOMAIN), masterKey.length);
  const encryptHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encryptInput));
  const encryptionKey = await importAesKey(encryptHash);

  return { masterKey, lookupKey, encryptionKey };
}

/**
 * Encrypt credential payload (seed + metadata) with credential encryption key
 * Encrypts the entire JSON payload per the spec — nothing stored in plaintext on Arweave.
 * Uses AES-256-GCM via crypto_core.encryptJsonToBytes
 *
 * @param {Object} payload - Credential payload matching credential_mapping schema
 * @param {string} payload.seed - 12-word BIP39 seed phrase
 * @param {string} payload.displayName - User display name
 * @param {number} payload.createdAt - Unix timestamp of account creation
 * @param {CryptoKey} encryptionKey - Credential-derived AES-GCM key
 * @returns {Promise<Uint8Array>} - Encrypted bytes (iv | tag | ciphertext)
 */
export async function encryptCredentialPayload(payload, encryptionKey) {
  if (!payload || !payload.seed || typeof payload.seed !== 'string') {
    throw new Error('Payload with seed is required');
  }
  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }
  const fullPayload = {
    schema: 'credential-mapping',
    version: '0.1.0',
    seed: payload.seed,
    displayName: payload.displayName || 'Bookish User',
    createdAt: payload.createdAt || Date.now()
  };
  return await encryptJsonToBytes(encryptionKey, fullPayload);
}

/**
 * Decrypt credential payload with credential encryption key
 * Returns the full decrypted payload (seed + metadata)
 *
 * @param {Uint8Array} encryptedBytes - Encrypted credential payload (iv | tag | ciphertext)
 * @param {CryptoKey} encryptionKey - Credential-derived AES-GCM key
 * @returns {Promise<{seed: string, displayName: string, createdAt: number}>}
 */
export async function decryptCredentialPayload(encryptedBytes, encryptionKey) {
  if (!encryptedBytes || !(encryptedBytes instanceof Uint8Array)) {
    throw new Error('Encrypted bytes are required');
  }
  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }
  const payload = await decryptBytesToJson(encryptionKey, encryptedBytes);
  if (!payload.seed || typeof payload.seed !== 'string') {
    throw new Error('Decrypted payload missing seed');
  }
  return {
    seed: payload.seed,
    displayName: payload.displayName,
    createdAt: payload.createdAt
  };
}

/**
 * Assess password strength for UI indicator
 * For Alpha (Phase 1): simple heuristic based on length + character diversity
 * Phase 2: integrate zxcvbn for real entropy scoring
 *
 * @param {string} password - Password to assess
 * @returns {{score: number, label: string, percent: number}}
 *   score: 0-5 (0=empty, 1=too short, 2=weak, 3=getting there, 4=strong, 5=very strong)
 *   label: human-readable label
 *   percent: 0-100 for strength bar fill
 */
export function assessPasswordStrength(password) {
  if (!password || password.length === 0) {
    return { score: 0, label: '', percent: 0 };
  }

  if (password.length < 8) {
    return { score: 1, label: 'Too short', percent: 10 };
  }

  // Count character classes
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const classCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

  // Simple scoring: length + diversity
  let points = 0;

  // Length contribution
  if (password.length >= 8) points += 1;
  if (password.length >= 12) points += 1;
  if (password.length >= 16) points += 1;

  // Diversity contribution
  points += classCount;

  // Map to score
  if (points <= 2) {
    return { score: 2, label: 'Weak', percent: 25 };
  }
  if (points <= 4) {
    return { score: 3, label: 'Getting there', percent: 50 };
  }
  if (points <= 5) {
    return { score: 4, label: 'Strong', percent: 80 };
  }
  return { score: 5, label: 'Very strong', percent: 100 };
}

/**
 * Validate email format (basic check)
 * @param {string} email - Email to validate
 * @returns {boolean} - True if email has valid format
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  // Basic check: has @ with text on both sides
  const atIndex = trimmed.indexOf('@');
  return atIndex > 0 && atIndex < trimmed.length - 1 && trimmed.indexOf('@', atIndex + 1) === -1;
}
