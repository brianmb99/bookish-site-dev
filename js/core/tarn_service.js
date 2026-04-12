// tarn_service.js — Singleton TarnClient wrapper for Bookish
// Manages session persistence, JWT auto-refresh, and provides
// a single access point for all Tarn operations.

import { TarnClient } from '../lib/tarn/tarn.js';

const TARN_API = window.BOOKISH_API_BASE || 'https://api.tarn.dev';
const APP_ID = 'bookish';

const STORAGE_KEYS = {
  SESSION: 'bookish.tarn.session',
  SESSION_KEY: 'bookish.tarn.sessionKey',
  EMAIL: 'bookish.email',
  DISPLAY_NAME: 'bookish.displayName',
  ACTIVE_FIELDS: 'bookish_active_fields',
};

/** @type {TarnClient|null} */
let _client = null;

// ============ SESSION ENCRYPTION ============
// Session data is encrypted at rest with a random AES-256-GCM key.
//
// THREAT MODEL:
// The encrypted session AND the session key are both in localStorage.
// This protects against casual inspection (someone browsing localStorage
// can't read raw key material), but NOT against a determined attacker
// with JS execution on this origin (XSS). An XSS attacker can read both
// localStorage values and decrypt the session.
//
// This is the same limitation every web app faces. The real protection is
// the browser's same-origin policy. Browsers don't offer a persistent,
// origin-scoped secret store inaccessible to JS. Alternatives considered:
//   - sessionStorage: clears on tab close → users re-enter password per tab
//   - Non-extractable CryptoKeys in IndexedDB: can't serialize for AES-GCM use
// Both degrade UX without meaningful security improvement.
//
// The primary defense is XSS prevention (CSP, input sanitization, no inline
// scripts with user data). If an attacker achieves JS execution on the
// origin, session key storage is moot — they can call TarnClient directly.

async function generateSessionKey() {
  return await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

async function encryptSession(sessionData, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(sessionData));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoded
  ));
  const result = new Uint8Array(iv.length + ciphertext.length);
  result.set(iv, 0);
  result.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...result));
}

async function decryptSession(base64, key) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function exportSessionKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function importSessionKey(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return await crypto.subtle.importKey(
    'raw', bytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

// ============ SESSION PERSISTENCE ============

async function saveSession(client, email) {
  try {
    const sessionData = await client.exportSession();
    if (!sessionData) return;

    const sessionKey = await generateSessionKey();
    const encrypted = await encryptSession(sessionData, sessionKey);
    const keyBase64 = await exportSessionKey(sessionKey);

    localStorage.setItem(STORAGE_KEYS.SESSION, encrypted);
    localStorage.setItem(STORAGE_KEYS.SESSION_KEY, keyBase64);
    if (email) localStorage.setItem(STORAGE_KEYS.EMAIL, email);
  } catch (err) {
    console.warn('[TarnService] Failed to save session:', err.message);
  }
}

async function restoreSession() {
  try {
    const encrypted = localStorage.getItem(STORAGE_KEYS.SESSION);
    const keyBase64 = localStorage.getItem(STORAGE_KEYS.SESSION_KEY);
    if (!encrypted || !keyBase64) return null;

    const sessionKey = await importSessionKey(keyBase64);
    const sessionData = await decryptSession(encrypted, sessionKey);
    return await TarnClient.fromSession(TARN_API, APP_ID, sessionData);
  } catch (err) {
    console.warn('[TarnService] Failed to restore session:', err.message);
    clearSession();
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEYS.SESSION);
  localStorage.removeItem(STORAGE_KEYS.SESSION_KEY);
  localStorage.removeItem(STORAGE_KEYS.EMAIL);
  localStorage.removeItem(STORAGE_KEYS.DISPLAY_NAME);
}

// ============ PUBLIC API ============

/**
 * Initialize the service — restores session from localStorage if available.
 * Call once on app startup.
 * @returns {Promise<boolean>} true if a session was restored
 */
export async function init() {
  if (_client) return true;
  _client = await restoreSession();
  return !!_client;
}

/**
 * Register a new account.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{dataLookupKey: string}>}
 */
export async function register(email, password) {
  const client = new TarnClient(TARN_API, APP_ID);
  const result = await client.register(email, password);
  _client = client;
  await saveSession(client, email);
  return result;
}

/**
 * Log in to an existing account.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{dataLookupKey: string}>}
 */
export async function login(email, password) {
  const client = new TarnClient(TARN_API, APP_ID);
  const result = await client.login(email, password);
  _client = client;
  await saveSession(client, email);
  return result;
}

/**
 * Log out — clears session and in-memory state.
 */
export function logout() {
  _client = null;
  clearSession();
}

/**
 * Check if user is logged in (has a restored or active session).
 * @returns {boolean}
 */
export function isLoggedIn() {
  return !!_client;
}

/**
 * Get the TarnClient instance. Auto-refreshes JWT if expired.
 * @returns {Promise<TarnClient>}
 * @throws if not logged in
 */
export async function getClient() {
  if (!_client) throw new Error('Not logged in');

  // Pro-actively refresh if JWT is expired or about to expire.
  // isAuthenticated only checks !!jwt; we need to check actual expiry
  // to avoid the race where getClient() returns a client whose next
  // API call triggers #requireAuth() → "JWT expired".
  let needsRefresh = !_client.isAuthenticated;
  if (!needsRefresh) {
    try {
      // Peek at JWT expiry (same logic as TarnClient.#requireAuth)
      const session = await _client.exportSession();
      if (session?.jwt) {
        const parts = session.jwt.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        // Refresh if expired or within 30s of expiry
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000) + 30) {
          needsRefresh = true;
        }
      }
    } catch {
      needsRefresh = true;
    }
  }

  if (needsRefresh) {
    try {
      await _client.refreshAuth();
      await saveSession(_client, localStorage.getItem(STORAGE_KEYS.EMAIL));
    } catch (err) {
      _client = null;
      clearSession();
      throw new Error('Session expired — please sign in again');
    }
  }

  return _client;
}

/**
 * Get the data lookup key (available after login/register).
 * @returns {string|null}
 */
export function getDataLookupKey() {
  return _client?.dataLookupKey || null;
}

/**
 * Get the stored email for display purposes.
 * @returns {string|null}
 */
export function getEmail() {
  return localStorage.getItem(STORAGE_KEYS.EMAIL);
}

/**
 * Get/set display name (stored locally).
 * @param {string} [name] — if provided, sets the display name
 * @returns {string|null}
 */
export function displayName(name) {
  if (name !== undefined) {
    localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, name);
    return name;
  }
  return localStorage.getItem(STORAGE_KEYS.DISPLAY_NAME);
}

/**
 * Update saved session (call after operations that change JWT).
 */
export async function persistSession() {
  if (_client) {
    await saveSession(_client, localStorage.getItem(STORAGE_KEYS.EMAIL));
  }
}

// ============ UI PREFERENCES ============

export function getActiveFields() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.ACTIVE_FIELDS);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export function setActiveFields(fields) {
  localStorage.setItem(STORAGE_KEYS.ACTIVE_FIELDS, JSON.stringify(fields));
}

/** Storage keys used by this service (for external cleanup). */
export { STORAGE_KEYS };
