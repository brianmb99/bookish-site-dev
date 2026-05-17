// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import * as subscription from './core/subscription.js';
import { pushOverlayState, popOverlayState } from './core/overlay_history.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';
import { attachKeyboardHandler } from './core/keyboard_viewport.js';
import { msToDateInputUtc } from './core/id_core.js';
import * as friends from './core/friends.js';
import * as friendsRouter from './core/friends_router.js';
import * as accountKeyReminder from './core/account_key_reminder.js';
import { debugLog } from './core/debug_log.js';
import {
  isFriendsHiddenFromHeader,
  setHideFriendsFromHeader,
  FRIENDS_VISIBILITY_EVENT,
} from './components/friend_glyph_trigger.js';
import { renderAccountHub } from './components/account_hub_view.js';
import { renderAccountSecurityView as renderAccountSecurityAccountView } from './components/account_security_view.js';
import { renderArchiveView as renderArchiveAccountView } from './components/account_archive_view.js';
import { renderFriendsView as renderFriendsAccountView } from './components/account_friends_view.js';
import { renderExportView as renderExportAccountView } from './components/account_export_view.js';
import {
  humanizePasskeySigninError,
  promptStalePasskeyRepair,
  renderCreateAccountForm as renderCreateAccountAuthForm,
  renderSignInForm as renderSignInAuthForm,
} from './components/account_auth_flows.js';
import {
  renderAccountKeyView as renderAccountKeyReveal,
  startReplaceAccountKeyFlow as startReplaceAccountKeyFlowModule,
  startViewAccountKeyFlow as startViewAccountKeyFlowModule,
} from './components/account_key_flows.js';
import {
  createPasskeySupportProbe,
  humanizePasskeyDate,
  hydratePasskeysSection as hydratePasskeySettingsSection,
  showPasskeyAddedAffirmation,
  suggestDeviceLabel,
  truncateCredentialId,
} from './components/account_passkey_settings.js';
import {
  humanizeCredentialChangeError,
  startChangeCredentialsFlow as startChangeCredentialsFlowModule,
} from './components/account_credentials_flow.js';

// Track the swipe-dismiss cleanup so we can detach on close.
let _accountResetSwipe = null;
let _accountDetachKeyboard = null;

// SVG icons for auth forms
const SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const passkeySupportProbe = createPasskeySupportProbe({
  isSupported: () => tarnService.passkeys.isSupported(),
  onWarn: (...args) => console.warn(...args),
});

/**
 * Full logout: stop sync, clear Tarn session, clear IndexedDB cache,
 * clear in-memory book entries, refresh UI.
 */
async function performLogout() {
  stopSync();
  await tarnService.logout();
  subscription.resetStatus();

  // Clear the account-key reminder counter + flags so a different user
  // signing in on the same browser is evaluated freshly. The reminder's
  // localStorage state is per-device; the previous user's "saved" flag
  // shouldn't suppress the new user's reminder. (Phase 5)
  try { accountKeyReminder.reset(); } catch {}

  // Clear IndexedDB cache so next user doesn't see stale books
  try {
    if (window.bookishCache?.clearAll) await window.bookishCache.clearAll();
  } catch {}

  // Clear in-memory book entries so the UI redraws immediately
  if (window.bookishApp?.clearBooks) window.bookishApp.clearBooks();

  uiStatusManager.refresh();
}

const BOOKISH_API = window.BOOKISH_API_URL || 'https://bookish-api.bookish.workers.dev';

// Transient state for UI status manager
const transientState = {
  justSignedIn: false,
  signInTime: 0,
  justCreated: false,
  createdTime: 0,
};

export function getAccountStatus() {
  return {
    isLoggedIn: tarnService.isLoggedIn(),
    isPersisted: tarnService.isLoggedIn(), // Always true with Tarn
    justSignedIn: transientState.justSignedIn,
    signInTime: transientState.signInTime,
    justCreated: transientState.justCreated,
    createdTime: transientState.createdTime,
  };
}

export async function initAccountUI() {
  debugLog('[Bookish:AccountUI] Initializing...');
  if (tarnService.isLoggedIn()) {
    localStorage.setItem('bookish.hasHadAccount', 'true');
  }
  setupAccountModalListeners();
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

export async function openAccountModal(mode) {
  const modal = document.getElementById('accountModal');
  const content = document.getElementById('accountModalContent');
  if (!modal || !content) return;

  modal.dataset.allowClose = 'false';
  await renderAccountModalContent(content, mode);
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.body.classList.add('modal-open');

  const modalContent = modal.querySelector('.account-modal');
  if (modalContent) {
    modalContent.style.visibility = 'visible';
    modalContent.style.opacity = '1';
    modalContent.classList.remove('sheet-dismissing');
    // On touch devices: add a drag handle and wire swipe-to-dismiss (#104 followup).
    // Matches the book edit modal pattern for visual consistency.
    if (window.matchMedia('(pointer: coarse)').matches) {
      if (!modalContent.querySelector('.sheet-handle')) {
        const handle = document.createElement('div');
        handle.className = 'sheet-handle';
        modalContent.insertBefore(handle, modalContent.firstChild);
      }
      const handle = modalContent.querySelector('.sheet-handle');
      if (handle && !_accountResetSwipe) {
        _accountResetSwipe = attachSwipeDismiss({
          sheet: modalContent,
          handles: [handle],
          onDismiss: () => closeAccountModal(),
        });
      }
      if (!_accountDetachKeyboard) {
        _accountDetachKeyboard = attachKeyboardHandler({ sheet: modalContent });
      }
    }
  }

  pushOverlayState('account');

  requestAnimationFrame(() => {
    modal.dataset.allowClose = 'true';
    // Auto-focus the first input on desktop only. On mobile, popping the
    // keyboard immediately covers the form before the user has seen it
    // and creates layout churn with the keyboard-aware sheet handler.
    if (!window.matchMedia('(pointer: coarse)').matches) {
      const firstInput = content.querySelector('input:not([type=hidden])');
      if (firstInput) firstInput.focus({ preventScroll: true });
    }
  });
}

export function closeAccountModal(fromPopstate = false) {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  // Clean up swipe-dismiss listeners and inline transform from the gesture.
  if (_accountResetSwipe) { _accountResetSwipe(); _accountResetSwipe = null; }
  if (_accountDetachKeyboard) { _accountDetachKeyboard(); _accountDetachKeyboard = null; }
  modal.style.display = 'none';
  const modalContent = modal.querySelector('.account-modal');
  if (modalContent) modalContent.classList.remove('sheet-dismissing');
  document.body.style.overflow = '';
  document.body.classList.remove('modal-open');
  if (!fromPopstate) popOverlayState();
}

function setupAccountModalListeners() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  const closeBtn = document.getElementById('accountModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeAccountModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal && modal.dataset.allowClose === 'true') {
      closeAccountModal();
    }
  });

  // Header account button opens modal
  const accountBtn = document.getElementById('accountBtn');
  if (accountBtn) {
    accountBtn.addEventListener('click', () => openAccountModal());
  }
}

// ============================================================================
// CONTENT RENDERING
// ============================================================================

async function renderAccountModalContent(content, mode) {
  if (tarnService.isLoggedIn()) {
    renderAccountPanel(content);
  } else if (mode === 'signin') {
    renderSignInForm(content);
  } else {
    renderCreateAccountForm(content);
  }
}

// ============================================================================
// CREATE ACCOUNT FORM
// ============================================================================

function renderCreateAccountForm(content) {
  renderCreateAccountAuthForm(content, {
    tarnService,
    bookishApiUrl: BOOKISH_API,
    onCreated: ({ email, accountKey }) => completePostCreateAccount(content, { email, accountKey }),
    onSwitchToSignIn: () => renderSignInForm(content),
    onWarn: (...args) => console.warn(...args),
    onError: (...args) => console.error(...args),
  });
}

function completePostCreateAccount(content, { email, accountKey }) {
  tarnService.displayName(email.split('@')[0]);
  localStorage.setItem('bookish.hasHadAccount', 'true');

  transientState.justCreated = true;
  transientState.createdTime = Date.now();
  markInitialSyncDone(); // New account - no books to sync

  subscription.resetStatus();
  subscription.fetchStatus().catch(() => {});

  renderAccountKeyView(content, {
    accountKey,
    onContinue: () => {
      closeAccountModal();
      startSync();
      uiStatusManager.refresh();
      if (typeof window.updateBookDots === 'function') window.updateBookDots();
      friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
        console.warn('[Bookish:AccountUI] friends invite handler failed:', err?.message || err)
      );
    },
  });
}

// ============================================================================
// ACCOUNT KEY VIEW (post-register)
// ============================================================================

function renderAccountKeyView(content, opts) {
  renderAccountKeyReveal(content, opts);
}

// ============================================================================
// SIGN IN FORM
// ============================================================================

function renderSignInForm(content) {
  renderSignInAuthForm(content, {
    tarnService,
    getPasskeysSupported,
    onSignedIn: () => completePostSignIn(),
    onSwitchToCreate: () => renderCreateAccountForm(content),
    onError: (...args) => console.error(...args),
  });
}

/**
 * Run the post-sign-in handoff used by both the password and passkey
 * paths. Sets transient state, kicks off subscription fetch, and (after
 * a 500ms delay matching the original UX) closes the modal, starts sync,
 * refreshes status, updates book dots, and runs the friends-invite
 * redemption check.
 *
 * The 500ms delay lets the "Signed in!" progress text be visible briefly
 * before the modal closes.
 */
function completePostSignIn() {
  transientState.justSignedIn = true;
  transientState.signInTime = Date.now();

  // Fresh subscription state for the signed-in user (#74).
  subscription.resetStatus();
  subscription.fetchStatus().catch(() => {});

  setTimeout(() => {
    closeAccountModal();
    startSync();
    uiStatusManager.refresh();
    if (typeof window.updateBookDots === 'function') window.updateBookDots();
    // Friends invite redemption (#118). If the user signed in to redeem
    // an invite they clicked while logged out, fire the accept modal
    // now that auth is ready.
    friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
      console.warn('[Bookish:AccountUI] friends invite handler failed:', err?.message || err)
    );
    // Phase 5: engagement-milestone reminder. init() is idempotent
    // within a page life — the session counter only increments on the
    // first call. Banner is rendered only when shouldShow() returns
    // true (Model B + ≥2 sessions + ≥5 books + not already saved).
    try { accountKeyReminder.init(); } catch (err) {
      console.warn('[Bookish:AccountUI] accountKeyReminder.init failed:', err?.message || err);
    }
  }, 500);
}

// ============================================================================
// ACCOUNT PANEL (logged-in view)
// ============================================================================

function renderAccountPanel(content) {
  renderAccountHub(content, accountHubViewDeps(content));
}

function getAccountIdentity() {
  const email = tarnService.getEmail() || '';
  const displayName = tarnService.displayName() || email.split('@')[0] || 'User';
  const initial = (displayName[0] || 'U').toUpperCase();
  return { email, displayName, initial };
}

function showAccountSecurityView(content) {
  renderAccountSecurityAccountView(content, {
    onBack: () => renderAccountPanel(content),
    onAfterRender: wireAccountSecuritySection,
  });
}

function showArchiveView(content) {
  renderArchiveAccountView(content, {
    onBack: () => renderAccountPanel(content),
  });
}

function showFriendsView(content) {
  renderFriendsAccountView(content, {
    onBack: () => renderAccountPanel(content),
    sectionDeps: accountFriendsSectionDeps(),
  });
}

function showExportView(content) {
  renderExportAccountView(content, {
    onBack: () => renderAccountPanel(content),
    onExportCsv: exportBooksToCSV,
  });
}

function accountHubViewDeps(content) {
  return {
    identity: getAccountIdentity(),
    subscription,
    activeEntryCount: window.bookishApp?.getActiveEntryCount?.() || 0,
    onView: view => {
      if (view === 'security') showAccountSecurityView(content);
      else if (view === 'friends') showFriendsView(content);
      else if (view === 'archive') showArchiveView(content);
      else if (view === 'export') showExportView(content);
    },
    onLogout: async () => {
      closeAccountModal();
      await performLogout();
    },
    getEmail: () => tarnService.getEmail() || '',
    setDisplayName: name => tarnService.displayName(name),
    onError: (...args) => console.error(...args),
    setTimeoutRef: setTimeout,
  }
}

function accountFriendsSectionDeps() {
  return {
    listConnections: () => friends.listConnections(),
    listIssuedInvites: () => friends.listIssuedInvites(),
    revokeInvite: tokenId => friends.revokeInvite(tokenId),
    isFriendsHiddenFromHeader,
    setHideFriendsFromHeader,
    friendsVisibilityEvent: FRIENDS_VISIBILITY_EVENT,
    onWarn: (...args) => console.warn(...args),
    onError: (...args) => console.error(...args),
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ============================================================================
// ACCOUNT & SECURITY (recovery v2 — phase 2)
// ============================================================================

/**
 * Wire the Account & Security section: View account key, Replace account
 * key, and the passkeys list. Called once after the panel HTML is
 * rendered. The section is statically present in the panel markup; this
 * just attaches handlers and hydrates child blocks.
 *
 * #144: the manual-custody toggle is no longer surfaced in the UI. The
 * SDK wrappers `tarn_service.accountKey.enableKeyStorage` /
 * `disableKeyStorage` remain available for potential future re-exposure
 * as a power-user setting.
 *
 * @param {HTMLElement} content
 */
function wireAccountSecuritySection(content) {
  const viewBtn = content.querySelector('#viewAccountKeyBtn');
  const replaceBtn = content.querySelector('#replaceAccountKeyBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => startViewAccountKeyFlow());
  }
  if (replaceBtn) {
    replaceBtn.addEventListener('click', () => startReplaceAccountKeyFlow());
  }
  // #145: Unified change-credentials affordance. Single modal handles
  // username (email) and/or password changes — matches the SDK's single
  // `changeCredentials` call and the underlying cryptographic reality
  // (master_key = KDF(username, password); change either input and the DEK
  // chain re-wraps).
  const changeCredsBtn = content.querySelector('#changeCredentialsBtn');
  if (changeCredsBtn) {
    changeCredsBtn.addEventListener('click', () => startChangeCredentialsFlow(content));
  }
  // Registered passkeys block. Async because the support probe + initial
  // list() both touch the SDK.
  hydratePasskeysSection(content).catch(err =>
    console.warn('[AccountUI] passkeys hydrate failed:', err?.message || err)
  );
}

// ----------------------------------------------------------------------------
// Passkeys (recovery v2 — phase 3)
// ----------------------------------------------------------------------------

async function getPasskeysSupported() {
  return passkeySupportProbe.getPasskeysSupported();
}

function passkeySettingsDeps() {
  return {
    passkeys: tarnService.passkeys,
    getPasskeysSupported,
    createOverlay,
    confirmDialog,
    requestPasswordConfirmation,
    humanizeAccountKeyError,
    onWarn: (...args) => console.warn(...args),
  };
}

async function hydratePasskeysSection(content) {
  return hydratePasskeySettingsSection(content, passkeySettingsDeps());
}

/**
 * Translate an SDK error into a user-facing string for the Account &
 * Security section. `phraseFlow=true` means the error came from the
 * enable-storage path where the user typed a phrase, so a pinning failure
 * gets a phrase-specific message.
 */
function humanizeAccountKeyError(err, { phraseFlow }) {
  const msg = err?.message || '';
  // AccountKeyPinningError is detectable by name OR by the message text
  // when subclassing trips up the bundler. Be defensive.
  if (err?.name === 'AccountKeyPinningError' || /pinning|pin check|does not match/i.test(msg)) {
    return phraseFlow
      ? "That doesn't look like your account key. Check the spelling and try again."
      : 'Account-key check failed. Please try again.';
  }
  if (/no_account_key_stored/i.test(msg)) {
    return "No account key is stored on our servers right now. Contact support if you need to restore access.";
  }
  if (/step-up|challenge|wrong password|invalid password|credential/i.test(msg)) {
    return 'Wrong password. Please try again.';
  }
  if (/network|fetch|timeout|offline/i.test(msg)) {
    return "Couldn't reach our servers. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

function accountKeyFlowDeps() {
  return {
    tarnService,
    confirmDialog,
    createOverlay,
    requestPasswordConfirmation,
    onWarn: (...args) => console.warn(...args),
  };
}

export async function startViewAccountKeyFlow(opts = {}) {
  return startViewAccountKeyFlowModule(opts, accountKeyFlowDeps());
}

async function startReplaceAccountKeyFlow() {
  return startReplaceAccountKeyFlowModule(accountKeyFlowDeps());
}

// ============================================================================
// CHANGE CREDENTIALS (issue #145 — unified username/password change)
// ============================================================================
//
// The SDK exposes a single `changeCredentials(newUsername, newPassword, opts)`
// call that re-wraps the DEK chain — there's no separate "change email" or
// "change password" path because the master key derives from BOTH inputs. The
// UI mirrors that: one modal, one flow, either or both fields editable.
//
// Step-up: the current password is verified app-side via `accountKey.view`,
// which (a) proves possession of the password and (b) returns the 24-word
// phrase the SDK needs to extend the recovery wrapping to the new gen.
//
// Passkey re-tap: if the account has registered passkeys, the SDK calls our
// per-credential handler during the change. Cancel from the handler surfaces
// as a "couldn't confirm all your passkeys" inline error.
//
// Forbidden: `acceptRecoveryGap: true`. Silently breaking recovery on a
// cancel is contra Bookish's product stance.

async function startChangeCredentialsFlow(content) {
  return startChangeCredentialsFlowModule(content, {
    getCurrentEmail: () => tarnService.getEmail() || '',
    changeCredentials: args => tarnService.changeCredentials(args),
    createOverlay,
    renderAccountPanel: panelContent => showAccountSecurityView(panelContent),
    onWarn: (...args) => console.warn(...args),
  });
}

// ----------------------------------------------------------------------------
// Inline modal helpers — password prompt, confirm/alert dialog, enable-storage
// inputs. Each renders a card on top of an overlay sibling to the account
// modal so the panel stays mounted and visible underneath.
//
// Password handling: the input value is captured into a local variable on
// submit and the input element is cleared (`.value = ''`) before the
// promise resolves. Never logged, never persisted.
// ----------------------------------------------------------------------------

function createOverlay(extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'security-overlay';
  if (extraClass) overlay.classList.add(extraClass);
  return overlay;
}

/**
 * Show a password-prompt modal.
 *
 * Two shapes:
 *   1. With `submit`: the dialog stays open across submit failures. On
 *      success the dialog closes and the promise resolves with whatever
 *      `submit(password)` resolved to. On failure an inline error appears
 *      inside the dialog and the user can edit + retry. Cancel / backdrop
 *      dismiss resolves `null`.
 *   2. Without `submit`: classic prompt — resolves with the password
 *      string on confirm, `null` on cancel.
 *
 * Password handling: the input value is captured into a local on confirm,
 * the input element is cleared before resolving. Never logged, never
 * persisted.
 *
 * @template T
 * @param {{
 *   title: string,
 *   body: string,
 *   confirmLabel?: string,
 *   submit?: (password: string) => Promise<T>,
 * }} opts
 * @returns {Promise<string | T | null>}
 */
function requestPasswordConfirmation({ title, body, confirmLabel = 'Continue', submit }) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">${escapeHtml(title)}</h2>
        <p class="security-overlay-body">${escapeHtml(body)}</p>
        <div class="form-group">
          <label for="securityPasswordInput">Password</label>
          <div class="password-field">
            <input type="password" id="securityPasswordInput" autocomplete="current-password" placeholder="Your password" />
            <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="security-overlay-error" data-error style="display:none;"></div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm disabled>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.querySelector('.security-overlay-card');
    const input = overlay.querySelector('#securityPasswordInput');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const toggleBtn = overlay.querySelector('.password-toggle');
    const errorEl = overlay.querySelector('[data-error]');

    const cleanupAndResolve = (value) => {
      // Clear the input before resolving so the password doesn't sit in
      // the DOM after the overlay is removed.
      if (input) input.value = '';
      overlay.remove();
      resolve(value);
    };

    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value.length === 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    });

    confirmBtn.addEventListener('click', async () => {
      const pw = input.value;
      if (!submit) {
        cleanupAndResolve(pw);
        return;
      }
      // Run the submit handler with the dialog still open. On error,
      // show inline error and keep the dialog mounted so the user can
      // edit and retry without re-opening.
      confirmBtn.disabled = true;
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      try {
        const result = await submit(pw);
        cleanupAndResolve(result);
      } catch (err) {
        console.warn('[AccountUI] password-prompt submit failed:', err?.message || err);
        errorEl.textContent = humanizeAccountKeyError(err, { phraseFlow: false });
        errorEl.style.display = 'block';
        confirmBtn.disabled = input.value.length === 0;
      }
    });
    cancelBtn.addEventListener('click', () => cleanupAndResolve(null));

    toggleBtn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggleBtn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanupAndResolve(null);
    });
    // Click on card stops bubbling so the backdrop handler doesn't fire.
    card.addEventListener('click', (e) => e.stopPropagation());

    // Focus the input on the next frame.
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  });
}

/**
 * Confirm dialog (yes/no). Resolves true on confirm, false on cancel.
 *
 * @param {{ title: string, body: string, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">${escapeHtml(title)}</h2>
        <p class="security-overlay-body">${escapeHtml(body)}</p>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn primary" data-confirm>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const card = overlay.querySelector('.security-overlay-card');
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => confirmBtn.focus({ preventScroll: true }));
  });
}

/**
 * Normalize a pasted 24-word phrase. Tolerates:
 *   - Leading/trailing whitespace
 *   - Newlines / mixed whitespace between words
 *   - Numbered prefixes per line ("1. word", "01) word", "(1) word")
 *   - Mixed case
 *
 * Result: lowercase words separated by single spaces. The SDK's own
 * `validateAccountKey` runs a stricter NFKD/lowercase normalization
 * afterwards, so this is purely a friendliness layer for paste UX.
 */
function normalizePastedPhrase(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Strip numbered list prefixes (e.g. "1.", "01)", "(1)") at the start of
  // each whitespace-separated chunk.
  return raw
    .replace(/[ \t]+/g, ' ')                 // tabs / nbsp → space
    .split(/\s+/)
    .map(tok => tok.replace(/^[\(\[]?\d{1,2}[\)\.\]:\-]?$/i, ''))  // pure number tokens → drop
    .map(tok => tok.replace(/^[\(\[]?\d{1,2}[\)\.\]:\-]/, ''))     // "1." / "(1)" prefix → strip
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

// ============================================================================
// CSV EXPORT
// ============================================================================

function exportBooksToCSV() {
  const books = window.bookishCache?.getAllActive?.();
  if (!books || typeof books.then !== 'function') {
    alert('No books to export');
    return;
  }

  books.then(entries => {
    if (!entries.length) { alert('No books to export'); return; }

    const headers = ['Title', 'Author', 'Date Read', 'Rating', 'Format', 'Notes'];
    const rows = entries.map(e => [
      csvEscape(e.title || ''),
      csvEscape(e.author || ''),
      csvEscape(msToDateInputUtc(e.dateRead)),
      e.rating || '',
      csvEscape(e.format || ''),
      csvEscape(e.notes || ''),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bookish-export.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function csvEscape(str) {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Expose for app.js
window.accountUI = {
  openAccountModal,
  handleSignIn: () => {
    openAccountModal('signin');
  },
};

// Testing seam — exposed for unit tests of pure helpers. Not part of the
// public surface; do NOT import from app code.
export const __test__ = {
  humanizePasskeyDate,
  suggestDeviceLabel,
  truncateCredentialId,
  normalizePastedPhrase,
  humanizePasskeySigninError,
  humanizeCredentialChangeError,
  promptStalePasskeyRepair,
  showPasskeyAddedAffirmation,
  resetPasskeysSupportedCache: () => passkeySupportProbe.resetPasskeysSupportedCache(),
};
