// tarn_service.js — Singleton TarnClient wrapper for Bookish.
//
// Owns session persistence (Tarn SDK Section 7) and exposes a single access
// point for all Tarn operations. The SDK handles at-rest encryption of the
// session via a non-extractable AES-256-GCM key in IndexedDB; this wrapper
// just hands the opaque blob to localStorage and back.

import { TarnClient } from '../lib/tarn/tarn-client.bundle.js';

const TARN_API = window.BOOKISH_API_BASE || 'https://api.tarn.dev';
const APP_ID = 'bookish';
const APP_NAME = 'Bookish';

const STORAGE_KEYS = {
  SESSION: 'bookish.tarn.session',
  EMAIL: 'bookish.email',
  DISPLAY_NAME: 'bookish.displayName',
  ACTIVE_FIELDS: 'bookish_active_fields',
};

/** @type {TarnClient|null} */
let _client = null;

// ============ SESSION PERSISTENCE ============
//
// Threat model: the persisted blob is opaque base64url ciphertext encrypted
// under an origin-scoped, non-extractable AES-256-GCM key in IndexedDB. An
// XSS attacker on this origin can call resumeSession() to act as the user
// up to the blob's 7-day hard expiry, but cannot exfiltrate the wrapping
// key for off-origin replay. Credential change / recovery / delete clear
// the wrapping key and invalidate every previously-emitted blob.
//
// See TARN_PROTOCOL.md § Session persistence (Section 7) for the full
// threat-model discussion.

async function saveSession(client, email) {
  try {
    const blob = await client.serializeSession();
    localStorage.setItem(STORAGE_KEYS.SESSION, blob);
    if (email) localStorage.setItem(STORAGE_KEYS.EMAIL, email);
  } catch (err) {
    console.warn('[TarnService] Failed to save session:', err.message);
  }
}

async function restoreSession() {
  const blob = localStorage.getItem(STORAGE_KEYS.SESSION);
  if (!blob) return null;
  // resumeSession returns null (never throws) on any recoverable failure:
  // expired, tampered, schema-mismatched, wrong origin, IndexedDB error.
  const client = await TarnClient.resumeSession(TARN_API, APP_ID, blob);
  if (!client) {
    // Stale blob — the wrapping key has been rotated (changeCredentials,
    // recoverAccount, deleteAccount) or the blob itself expired. Drop the
    // localStorage entry so future restoreSession() calls short-circuit.
    localStorage.removeItem(STORAGE_KEYS.SESSION);
  }
  return client;
}

function clearLocalStorage() {
  localStorage.removeItem(STORAGE_KEYS.SESSION);
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
 *
 * The Tarn SDK generates a 24-word BIP39 recovery phrase + a rendered PDF
 * client-side, and (by default) forwards the PDF to the user's email via
 * Tarn's recovery-email forwarder. The phrase + PDF are returned in-memory
 * so the caller can also display the words + offer a local download.
 *
 * The caller MUST surface the phrase to the user. The SDK does not cache
 * either the phrase or the PDF bytes — Bookish never persists them either;
 * the user is the only durable store.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{
 *   dataLookupKey: string,
 *   recoveryPhrase: string,
 *   pdfBytes: Uint8Array,
 *   emailDelivered: boolean,
 * }>}
 */
export async function register(email, password) {
  const client = new TarnClient(TARN_API, APP_ID);
  const result = await client.register(email, password, {
    recoveryAcknowledged: true,
    emailRecoveryKit: true,
    recipientEmail: email,
    appName: APP_NAME,
  });
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
 * Log out — clears in-memory state and the persisted session blob
 * synchronously, then schedules the IndexedDB wrapping-key wipe. After
 * the IndexedDB wipe completes, any previously-emitted session blob on
 * this origin is unreadable. Awaiting the returned promise ensures both
 * have completed; a fire-and-forget call still gets immediate
 * isLoggedIn() === false and the persisted blob removed.
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  const client = _client;
  _client = null;
  clearLocalStorage();
  if (client) {
    try { await client.clearSession(); } catch (err) {
      console.warn('[TarnService] clearSession failed:', err.message);
    }
  }
}

/**
 * Check if user is logged in (has a restored or active session).
 * @returns {boolean}
 */
export function isLoggedIn() {
  return !!_client;
}

/**
 * Get the TarnClient instance. JWT expiry is handled inside the SDK
 * (challenge-response refresh on first authenticated call).
 * @returns {Promise<TarnClient>}
 * @throws if not logged in
 */
export async function getClient() {
  if (!_client) throw new Error('Not logged in');
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
 * Re-emit the persisted session blob. Call after operations that mutate
 * the in-memory client state in a way the persisted blob should reflect
 * (e.g., a fresh JWT after silent reauth). The SDK does not auto-refresh
 * `expiresAt` on use — every call here resets the 7-day window.
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
