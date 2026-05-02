// tarn_service.js — Singleton TarnClient wrapper for Bookish.
//
// Owns the singleton TarnClient instance, the schema declaration handed to
// it, and the small amount of UI-side metadata that doesn't belong in the
// SDK (display name, active-fields preference, the email — for display
// only, never re-used as auth material).
//
// The new schema-first SDK does session resume internally — pass it a
// storage adapter and `TarnClient.create()` rehydrates any persisted blob
// before returning. We use TarnStorage.localStorage() so the at-rest blob
// continues to live in localStorage exactly where it did before, just now
// behind the SDK's own key (TarnStorage default key 'tarn:session:v1').
//
// Threat model unchanged: the persisted blob is opaque base64url ciphertext
// encrypted under an origin-scoped, non-extractable AES-256-GCM key in
// IndexedDB. An XSS attacker on this origin can drive the SDK to act as
// the user up to the blob's hard expiry, but cannot exfiltrate the
// wrapping key for off-origin replay. Credential change / recovery /
// account delete clear the wrapping key and invalidate every previously-
// emitted blob.

import { TarnClient, TarnStorage } from '../lib/tarn/tarn-client.bundle.js';
import { bookishSchema } from './bookish-schema.js';

const TARN_API = window.BOOKISH_API_BASE || 'https://api.tarn.dev';
const APP_ID = 'bookish';
const APP_NAME = 'Bookish';

const STORAGE_KEYS = {
  EMAIL: 'bookish.email',
  DISPLAY_NAME: 'bookish.displayName',
  ACTIVE_FIELDS: 'bookish_active_fields',
};

/** @type {TarnClient|null} */
let _client = null;
/** @type {Promise<TarnClient>|null} */
let _initPromise = null;
/** Cached after register/login. Used by the bookish-api subscription routes. */
let _dataLookupKey = null;
const DLK_STORAGE_KEY = 'bookish.tarn.dlk';

function buildClient() {
  return TarnClient.create({
    apiBase: TARN_API,
    appId: APP_ID,
    schema: bookishSchema,
    storage: TarnStorage.localStorage(),
  });
}

function clearLocalMetadata() {
  localStorage.removeItem(STORAGE_KEYS.EMAIL);
  localStorage.removeItem(STORAGE_KEYS.DISPLAY_NAME);
  localStorage.removeItem(DLK_STORAGE_KEY);
}

// ============ PUBLIC API ============

/**
 * Initialize the service — constructs the singleton client. The new SDK
 * resumes any persisted session inside `TarnClient.create()`; if a blob
 * is present and decryptable, the returned client is already logged in.
 *
 * Idempotent: subsequent calls return the existing client.
 *
 * @returns {Promise<boolean>} true if a session was restored (logged in)
 */
export async function init() {
  if (_client) return _client.isLoggedIn();
  if (!_initPromise) _initPromise = buildClient();
  _client = await _initPromise;
  _initPromise = null;
  // Restore dlk cache from localStorage if a session was resumed (the SDK
  // doesn't expose dlk directly, and resume bypasses register/login).
  if (_client.isLoggedIn() && !_dataLookupKey) {
    _dataLookupKey = localStorage.getItem(DLK_STORAGE_KEY) || null;
  }
  return _client.isLoggedIn();
}

async function ensureClient() {
  if (_client) return _client;
  await init();
  return _client;
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
 * either the phrase or the PDF bytes; Bookish never persists them either.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{
 *   dataLookupKey?: string,
 *   recoveryPhrase: string,
 *   pdfBytes: Uint8Array,
 *   emailDelivered?: boolean,
 * }>}
 */
export async function register(email, password) {
  const client = await ensureClient();
  const result = await client.register(email, password, {
    recoveryAcknowledged: true,
    emailRecoveryKit: true,
    recipientEmail: email,
    appName: APP_NAME,
  });
  if (email) localStorage.setItem(STORAGE_KEYS.EMAIL, email);
  if (result?.dataLookupKey) {
    _dataLookupKey = result.dataLookupKey;
    localStorage.setItem(DLK_STORAGE_KEY, result.dataLookupKey);
  }
  return result;
}

/**
 * Log in to an existing account.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{dataLookupKey?: string}>}
 */
export async function login(email, password) {
  const client = await ensureClient();
  const result = await client.login(email, password);
  if (email) localStorage.setItem(STORAGE_KEYS.EMAIL, email);
  if (result?.dataLookupKey) {
    _dataLookupKey = result.dataLookupKey;
    localStorage.setItem(DLK_STORAGE_KEY, result.dataLookupKey);
  }
  return result;
}

/**
 * Log out — clears the local session via the SDK (which forgets the
 * persisted blob and invalidates the IndexedDB wrapping key) and clears
 * Bookish's UI-side metadata.
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  const client = _client;
  clearLocalMetadata();
  _dataLookupKey = null;
  if (client) {
    try { await client.session.clear(); } catch (err) {
      console.warn('[TarnService] session.clear failed:', err.message);
    }
  }
  // Drop the singleton so subsequent operations re-init from a clean slate.
  _client = null;
  _initPromise = null;
}

/**
 * Check if user is logged in.
 * @returns {boolean}
 */
export function isLoggedIn() {
  return !!_client && _client.isLoggedIn();
}

/**
 * Get the TarnClient instance. JWT expiry is handled inside the SDK
 * (challenge-response refresh on first authenticated call).
 * @returns {Promise<TarnClient>}
 * @throws if not logged in
 */
export async function getClient() {
  if (!_client) throw new Error('Not logged in');
  if (!_client.isLoggedIn()) throw new Error('Not logged in');
  return _client;
}

/**
 * Get the cached `dataLookupKey` from the most recent register/login (or
 * the persisted-on-resume copy from localStorage). Used by the bookish-api
 * subscription routes which key per-user state on the dlk.
 *
 * Returns null if not logged in or never captured.
 * @returns {string|null}
 */
export function getDataLookupKey() {
  if (_dataLookupKey) return _dataLookupKey;
  if (isLoggedIn()) return localStorage.getItem(DLK_STORAGE_KEY);
  return null;
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
