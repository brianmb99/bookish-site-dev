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
 * The Tarn SDK generates a 24-word BIP39 account key client-side and (in
 * Model B, the default) ships an encrypted wrap of it to Tarn so the user
 * can retrieve it later from Settings. The plaintext account key is
 * returned in memory so the caller can surface it to the user once at
 * signup.
 *
 * Tarn no longer renders a PDF kit or forwards anything by email — kit
 * format and delivery are an app concern. Bookish currently shows the
 * 24 words on screen with a copy button and stops there; a downloadable
 * kit can be added later as a separate piece of work.
 *
 * The caller MUST surface the account key to the user (that's what
 * `recoveryAcknowledged: true` is asserting). The SDK does not cache it;
 * Bookish does not persist it either.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{
 *   dataLookupKey?: string,
 *   accountKey: string,
 * }>}
 */
export async function register(email, password) {
  const client = await ensureClient();
  const result = await client.register(email, password, {
    storeAccountKey: true,
    recoveryAcknowledged: true,
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
 * Authenticate using a registered passkey (recovery v2 — phase 4). Peer
 * of `login()`: no prior session required, succeeds the same way (JWT +
 * DEK chain installed, persisted session blob written by the SDK), and
 * the resulting client behaves identically to a password-authenticated
 * one. Subsequent collection / settings / sharing calls all work.
 *
 * Side-effects mirror `login()`:
 *   - On success, cache the SDK's `dataLookupKey` in memory and persist
 *     it to localStorage so subscription / per-user routes can keep
 *     working. The SDK does NOT expose the email on the result of a
 *     passkey auth (passkey-only sessions are username-less by design),
 *     so the email cache is left alone here — callers that have an
 *     email in hand (e.g. the stale-repair handler) can persist it
 *     themselves via the EMAIL storage key if they choose to.
 *
 * `stalePasskeyHandler` is invoked by the SDK ONLY when the server
 * flags the just-used credential as stale (no `passkey_prf` wrapping
 * on the latest gen — typically because a `changeCredentials` ran on
 * another device without re-tapping this passkey). When invoked, the
 * handler MUST return `{ username, password } | null`:
 *   - `{ username, password }` lets the SDK derive the password KEK,
 *     unwrap the latest gen, re-wrap it under this passkey's PRF key,
 *     and submit the repaired envelope. Auth then continues as if the
 *     credential had never been stale.
 *   - `null` aborts the repair; the SDK throws `StalePasskeyError`
 *     (detectable via `err.name === 'StalePasskeyError'`).
 * The wrapper itself does not invoke the handler — it's purely a
 * passthrough.
 *
 * @param {{
 *   stalePasskeyHandler?: () => Promise<{ username: string, password: string } | null>,
 *   credentialId?: string,
 *   deviceLabel?: string,
 * }} [opts]
 * @returns {Promise<{dataLookupKey?: string}>}
 */
export async function authenticateWithPasskey(opts = {}) {
  const client = await ensureClient();
  const result = await client.authenticateWithPasskey(opts);
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
  // Drop singletons FIRST so any callback the SDK fires during clear()
  // can't write back through this module. This re-orders the prior version
  // where the singleton was nulled after the await — the prior order let
  // a re-entry between clearLocalMetadata() and `await client.session.clear()`
  // re-populate the bookish.* metadata in rare cases (see bug from
  // 2026-05-11 UAT walk).
  const client = _client;
  _client = null;
  _initPromise = null;
  _dataLookupKey = null;

  if (client) {
    try { await client.session.clear(); } catch (err) {
      console.warn('[TarnService] session.clear failed:', err.message);
    }
  }

  // Belt-and-suspenders: explicitly clear the Tarn SDK's session blob in
  // localStorage. `session.clear()` is supposed to handle this, but it
  // failed to in the UAT walk; we observed `tarn:session:v1` surviving the
  // logout. If the SDK reliably clears its key in the future, this becomes
  // a no-op. If the SDK ever changes its key, this stale literal becomes
  // dead-code (harmless) — worth re-validating periodically.
  try { localStorage.removeItem('tarn:session:v1'); } catch {}

  // Clear bookish-side metadata LAST so any race with session.clear() that
  // might have re-set keys (observed once during UAT) is overridden by the
  // final clean state.
  clearLocalMetadata();
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

// ============ ACCOUNT KEY (recovery v2) ============
//
// Thin passthroughs to `client.accountKey.*`. The SDK handles the step-up
// auth dance internally for view / rotate / enable / disable — Bookish just
// passes the freshly re-entered password. The plaintext account key is
// returned in memory and must be surfaced once and dropped — never persisted.
//
// `isStored()` is sync but may return null on a fresh client that hasn't
// completed an auth round-trip yet. Callers (e.g. the custody toggle in
// account_ui) handle that null by rendering a "Loading…" state and
// retrying.

/**
 * View the user's stored 24-word account key (Model B only). Triggers a
 * step-up auth dance under the covers; on success returns the phrase in
 * memory. Drop it from any closure as soon as the user has copied it.
 *
 * Throws an Error with `no_account_key_stored` in the message for Model A
 * accounts; throws `AccountKeyPinningError` on a wrap-pinning mismatch
 * (security warning — surface distinctly, do NOT show the would-be phrase).
 *
 * @param {{ password: string }} opts
 * @returns {Promise<{ accountKey: string }>}
 */
async function viewAccountKey(opts) {
  const client = await getClient();
  return client.accountKey.view(opts);
}

/**
 * Rotate the account key. Generates a new 24-word phrase, re-wraps the
 * DEK chain under it, and atomically publishes the bundle. The OLD
 * account key stops working for `recoverAccount` immediately on success.
 *
 * Password and username are unchanged. Pre-rotation data remains
 * decryptable. If the account is in Model B, the new key is also stored
 * (re-wrapped under DEK_gen1).
 *
 * @param {{ password: string }} opts
 * @returns {Promise<{ accountKey: string }>}
 */
async function rotateAccountKey(opts) {
  const client = await getClient();
  return client.accountKey.rotate(opts);
}

/**
 * Disable Model B storage (B → A). Server-side wrap is removed; subsequent
 * `viewAccountKey()` calls fail with `no_account_key_stored`. Idempotent —
 * safe to call on an already-Model-A account.
 *
 * @param {{ password: string }} opts
 * @returns {Promise<void>}
 */
async function disableKeyStorage(opts) {
  const client = await getClient();
  await client.accountKey.disableKeyStorage(opts);
}

/**
 * Enable Model B storage (A → B). Caller passes the password AND the user's
 * existing 24-word account key. The SDK runs a wrap-pinning check before
 * any server round trip — a phrase that doesn't belong to this account
 * throws `AccountKeyPinningError` synchronously.
 *
 * @param {{ password: string, accountKey: string }} opts
 * @returns {Promise<void>}
 */
async function enableKeyStorage(opts) {
  const client = await getClient();
  await client.accountKey.enableKeyStorage(opts);
}

/**
 * Whether Tarn currently stores a wrap of this account's account key.
 *
 * - `true`  — Model B. `viewAccountKey()` is available.
 * - `false` — Model A (no backup stored). `viewAccountKey()` will fail
 *             with `no_account_key_stored`.
 * - `null`  — unknown (fresh client; no `/auth/verify` round-trip yet).
 *             Callers render a "Loading…" UI and retry shortly after.
 *
 * @returns {boolean | null}
 */
function isAccountKeyStored() {
  if (!_client) return null;
  return _client.accountKey.isStored();
}

/**
 * Namespaced accessor for the new account-key surface — mirrors the SDK
 * grouping (`tarn.accountKey.*`). The flat names above are kept for
 * symmetry with the existing flat exports (`register`, `login`, etc.) but
 * UI code should prefer this namespace because it reads cleaner at the
 * callsite.
 */
export const accountKey = {
  view: viewAccountKey,
  rotate: rotateAccountKey,
  disableKeyStorage,
  enableKeyStorage,
  isStored: isAccountKeyStored,
};

// ============ PASSKEYS (recovery v2 — phase 3, sign-in in phase 4) ============
//
// Thin passthroughs to `client.passkeys.*`. The SDK handles WebAuthn-PRF
// registration / list / remove / supported-detection internally. Bookish
// just surfaces these in the Account & Security settings section.
//
// Sign-in via passkey (`authenticateWithPasskey`) is exposed as a top-level
// wrapper below — it's a peer of `login()` (no prior session), not a
// passkeys-namespace method. The password-change re-tap callback
// (`passkeyTapHandler`) remains unwrapped: it belongs to a future
// change-password affordance Bookish doesn't have yet.

/**
 * Whether this browser/device can register and use passkeys (WebAuthn +
 * PRF extension + platform authenticator). Apps must feature-detect
 * before surfacing the affordance.
 *
 * @returns {Promise<boolean>}
 */
async function passkeysIsSupported() {
  const client = await ensureClient();
  return client.passkeys.isSupported();
}

/**
 * Register a new passkey for the logged-in account. Triggers the
 * platform-authenticator prompt (Touch ID / Face ID / Windows Hello /
 * security key). The DEK chain gains a `passkey_prf` wrapping per gen so
 * the resulting credential can independently unwrap data.
 *
 * @param {{ deviceLabel?: string }} [opts]
 * @returns {Promise<{ credentialId: string, deviceLabel: string | null }>}
 */
async function passkeysRegister(opts = {}) {
  const client = await getClient();
  return client.passkeys.register(opts);
}

/**
 * List the passkeys registered for this account. Each entry is one
 * device the user has enrolled. `lastUsedAt` is null for credentials
 * that have never authenticated.
 *
 * Each entry also carries a `stale` flag, but Bookish does NOT surface
 * it in the UI — just-in-time repair handles staleness transparently at
 * sign-in time. The flag is left on the returned objects untouched in
 * case future phases need it.
 *
 * @returns {Promise<Array<{ credentialId: string, deviceLabel: string | null, createdAt: number, lastUsedAt: number | null, stale: boolean }>>}
 */
async function passkeysList() {
  const client = await getClient();
  return client.passkeys.list();
}

/**
 * Remove a registered passkey. Step-up gated — caller passes the
 * freshly-typed password so the server can confirm possession.
 *
 * @param {{ credentialId: string, password: string }} opts
 * @returns {Promise<void>}
 */
async function passkeysRemove(opts) {
  const client = await getClient();
  return client.passkeys.remove(opts);
}

/**
 * Namespaced accessor for the passkey surface — mirrors the SDK grouping
 * (`tarn.passkeys.*`). Same shape and motivation as `accountKey` above.
 */
export const passkeys = {
  isSupported: passkeysIsSupported,
  register: passkeysRegister,
  list: passkeysList,
  remove: passkeysRemove,
};

// ============ UNIFIED CREDENTIALS CHANGE ============
//
// `tarn.account.changeCredentials(newUsername, newPassword, opts)` takes both
// username and password as inputs in a single SDK call and re-wraps the DEK
// chain (the cryptographic reality: master_key = KDF(username, password) —
// changing either input rotates everything). This wrapper hides the
// orchestration:
//   1. Verify the current password app-side and fetch the 24-word account-key
//      phrase via `client.accountKey.view({ password })`. The SDK has no
//      `oldPassword` parameter — trust comes from the session AND the phrase
//      requirement (the new gen needs a recovery wrapping).
//   2. Compute effective new credentials. Omitted fields fall back to current
//      values so the caller can change just one half.
//   3. Call `client.account.changeCredentials(newUsername, newPassword, opts)`
//      with the retrieved phrase + an optional `passkeyTapHandler`.
//   4. On success, refresh the cached email if username changed.
//
// `acceptRecoveryGap: true` is deliberately NEVER set — silently breaking
// recovery for new data is contra Bookish's product stance.

/**
 * Change the user's username (email) and/or password atomically. Either
 * field can be omitted to keep the current value (the SDK still does a full
 * re-wrap; cryptographically there's no "change just one half").
 *
 * Verifies the current password app-side via `accountKey.view` (this is the
 * step-up that BOTH proves the password AND retrieves the phrase the SDK
 * needs for the new generation's recovery wrapping). If the account is in
 * Model A (`no_account_key_stored`), the view fails — caller should surface
 * the model-A error from `humanizeCredentialChangeError`.
 *
 * If the account has registered passkeys, the SDK invokes
 * `passkeyTapHandler` per credential during the change. The handler must
 * return true (proceed → SDK invokes WebAuthn) or false / throw (skip → that
 * credential becomes stale on the new gen and will trigger the stale-repair
 * flow on next passkey sign-in). The wrapper does NOT pass
 * `acceptRecoveryGap: true`.
 *
 * @param {{
 *   currentPassword: string,
 *   newUsername?: string,
 *   newPassword?: string,
 *   passkeyTapHandler?: (cred: { credentialId: string, deviceLabel: string | null }) => Promise<boolean>,
 * }} opts
 * @returns {Promise<unknown>} The SDK return value (opaque; success-only).
 */
export async function changeCredentials({
  currentPassword,
  newUsername,
  newPassword,
  passkeyTapHandler,
} = {}) {
  if (!currentPassword) {
    throw new Error('changeCredentials: currentPassword is required');
  }
  const client = await getClient();

  // Step-up + phrase fetch. Throws on wrong password / Model A / network.
  const { accountKey: phrase } = await client.accountKey.view({ password: currentPassword });

  const currentEmail = localStorage.getItem(STORAGE_KEYS.EMAIL) || '';
  const effectiveUsername =
    typeof newUsername === 'string' && newUsername.length > 0 ? newUsername : currentEmail;
  const effectivePassword =
    typeof newPassword === 'string' && newPassword.length > 0 ? newPassword : currentPassword;

  if (!effectiveUsername) {
    throw new Error('changeCredentials: no current username available — cannot compute effective new username');
  }

  const sdkOpts = { phrase };
  if (typeof passkeyTapHandler === 'function') {
    sdkOpts.passkeyTapHandler = passkeyTapHandler;
  }

  const result = await client.account.changeCredentials(
    effectiveUsername,
    effectivePassword,
    sdkOpts,
  );

  // Refresh the cached email if username changed. The SDK's session-resume
  // path doesn't write back to localStorage; we own this cache.
  if (effectiveUsername !== currentEmail) {
    localStorage.setItem(STORAGE_KEYS.EMAIL, effectiveUsername);
  }

  return result;
}

/** Storage keys used by this service (for external cleanup). */
export { STORAGE_KEYS };
