// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import * as subscription from './core/subscription.js';
import { pushOverlayState, popOverlayState } from './core/overlay_history.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';
import { msToDateInputUtc } from './core/id_core.js';
import * as friends from './core/friends.js';
import * as friendsRouter from './core/friends_router.js';
import {
  isFriendsHiddenFromHeader,
  setHideFriendsFromHeader,
  FRIENDS_VISIBILITY_EVENT,
} from './components/friend-glyph-trigger.js';

// Track the swipe-dismiss cleanup so we can detach on close.
let _accountResetSwipe = null;

// SVG icons for auth forms
const SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_SHIELD = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;
const SVG_USER = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const SVG_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const SVG_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

/**
 * Full logout: stop sync, clear Tarn session, clear IndexedDB cache,
 * clear in-memory book entries, refresh UI.
 */
async function performLogout() {
  stopSync();
  await tarnService.logout();
  subscription.resetStatus();

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
  console.log('[Bookish:AccountUI] Initializing...');
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
  content.innerHTML = `
    <div class="auth-form">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>Create Your Account</h2>
        <p>Private. Permanent. Yours.</p>
      </div>

      <div class="form-group">
        <label for="acctEmail">Email</label>
        <input type="email" id="acctEmail" autocomplete="email" placeholder="you@example.com" required />
        <span class="field-hint" id="emailPreview"></span>
      </div>

      <div class="form-group">
        <label for="acctPassword">Password</label>
        <div class="password-field">
          <input type="password" id="acctPassword" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required />
          <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
        </div>
        <div class="password-strength">
          <div class="strength-bar"><div class="strength-fill" id="strengthFill"></div></div>
          <span class="strength-label" id="strengthLabel"></span>
        </div>
      </div>

      <div class="form-group">
        <label for="acctConfirmPassword">Confirm Password</label>
        <div class="password-field">
          <input type="password" id="acctConfirmPassword" autocomplete="new-password" placeholder="Re-enter password" required />
          <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
        </div>
        <span class="field-match" id="confirmHint"></span>
      </div>

      <div class="auth-note">
        Your reading list is private — even Bookish can't read it or reset your password. After signup we'll show you a 24-word account key. You can view it again any time in Settings.
      </div>

      <button id="createAccountBtn" class="btn primary auth-submit" disabled>
        Create Account
      </button>

      <div id="createError" class="auth-error" style="display:none;"></div>
      <div id="createProgress" class="auth-progress" style="display:none;"></div>

      <div class="auth-switch">
        Already have an account?
        <a href="#" id="switchToSignIn">Sign in</a>
      </div>
    </div>
  `;

  const emailInput = content.querySelector('#acctEmail');
  const passwordInput = content.querySelector('#acctPassword');
  const confirmInput = content.querySelector('#acctConfirmPassword');
  const createBtn = content.querySelector('#createAccountBtn');
  const switchLink = content.querySelector('#switchToSignIn');

  function validate() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const passwordValid = password.length >= 8;
    const confirmMatch = password === confirm && confirm.length > 0;

    createBtn.disabled = !(emailValid && passwordValid && confirmMatch);
  }

  // Email preview
  emailInput.addEventListener('blur', () => {
    const preview = content.querySelector('#emailPreview');
    const normalized = emailInput.value.trim().toLowerCase();
    if (normalized && normalized !== emailInput.value.trim()) {
      preview.textContent = `Will be stored as: ${normalized}`;
    } else {
      preview.textContent = '';
    }
  });

  // Password toggles
  content.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });
  });

  // Password strength
  passwordInput.addEventListener('input', () => {
    const pw = passwordInput.value;
    const fill = content.querySelector('#strengthFill');
    const label = content.querySelector('#strengthLabel');
    const strength = assessPasswordStrength(pw);
    fill.style.width = strength.pct + '%';
    fill.className = 'strength-fill ' + strength.cls;
    label.textContent = strength.label;
    label.className = 'strength-label ' + strength.cls;
    validate();
  });

  // Confirm match
  confirmInput.addEventListener('input', () => {
    const hint = content.querySelector('#confirmHint');
    if (confirmInput.value && confirmInput.value !== passwordInput.value) {
      hint.textContent = 'Passwords do not match';
      hint.className = 'field-match match-error';
    } else if (confirmInput.value) {
      hint.textContent = 'Passwords match';
      hint.className = 'field-match match-success';
    } else {
      hint.textContent = '';
      hint.className = 'field-match';
    }
    validate();
  });

  emailInput.addEventListener('input', validate);

  // Create account
  createBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    createBtn.disabled = true;
    const progress = content.querySelector('#createProgress');
    const error = content.querySelector('#createError');
    error.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = 'Creating account...';

    try {
      // Step 1: Register with Tarn. The SDK derives keys and generates a
      // 24-word BIP39 account key. In Model B (the default) the SDK also
      // ships an encrypted wrap of the key to Tarn so the user can view
      // it again later from Settings — no PDF, no email.
      progress.textContent = 'Deriving encryption keys...';
      const reg = await tarnService.register(email, password);
      const { dataLookupKey, accountKey } = reg;

      // Step 2: Set free-tier rules via Bookish API. Critical — without
      // rules, writes are denied. Retry up to 3 times with backoff.
      progress.textContent = 'Setting up your account...';
      let provisioned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`${BOOKISH_API}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, dataLookupKey }),
          });
          if (res.ok) {
            provisioned = true;
            break;
          }
          console.warn(`[AccountUI] Provisioning attempt ${attempt} failed: ${res.status}`);
        } catch (apiErr) {
          console.warn(`[AccountUI] Provisioning attempt ${attempt} failed:`, apiErr.message);
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }

      if (!provisioned) {
        localStorage.setItem('bookish.needsProvisioning', JSON.stringify({ email, dataLookupKey }));
        console.warn('[AccountUI] Provisioning failed after 3 attempts — will retry later');
      }

      // Step 3: Store display info
      tarnService.displayName(email.split('@')[0]);
      localStorage.setItem('bookish.hasHadAccount', 'true');

      transientState.justCreated = true;
      transientState.createdTime = Date.now();
      markInitialSyncDone(); // New account — no books to sync

      subscription.resetStatus();
      subscription.fetchStatus().catch(() => {});

      // Step 4: Hand off to the account-key reveal. The user can dismiss
      // via Continue OR the modal close button — both run the same
      // post-signup handoff. We don't gate the dismiss anymore because
      // the user can re-view the account key from Settings any time.
      renderAccountKeyView(content, {
        accountKey,
        onContinue: () => {
          closeAccountModal();
          startSync();
          uiStatusManager.refresh();
          if (typeof window.updateBookDots === 'function') window.updateBookDots();
          // Friends invite redemption (#118). If the user signed up because
          // they clicked an invite link, fire the accept modal now.
          friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
            console.warn('[Bookish:AccountUI] friends invite handler failed:', err?.message || err)
          );
        },
      });

      // Drop the in-memory account-key reference from this scope. The
      // SDK already doesn't cache it; the reveal view holds its own
      // closure-scoped copy until dismiss.
    } catch (e) {
      console.error('[AccountUI] Registration failed:', e);
      let msg = e.message || 'Registration failed. Please try again.';
      if (e.message?.includes('already in use')) msg = 'An account with this email already exists. Try signing in.';
      error.style.display = 'block';
      error.textContent = msg;
      progress.style.display = 'none';
      createBtn.disabled = false;
    }
  });

  // Switch to sign in
  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    renderSignInForm(content);
  });
}

// ============================================================================
// ACCOUNT KEY VIEW (post-register)
// ============================================================================

/**
 * Build the inner markup for the 24-word account-key grid. Used by signup
 * reveal, Settings → View account key, and Settings → Replace account key
 * (post-rotate). Returns the HTML string for the grid + copy row; the
 * caller wraps it in whatever surrounding chrome it needs (auth-header,
 * action button, etc.) and is responsible for wiring the copy button.
 *
 * @param {string} accountKey 24-word string
 * @returns {string} HTML
 */
function buildAccountKeyGridMarkup(accountKey) {
  const words = accountKey.trim().split(/\s+/);
  const wordCells = words.map((w, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<li class="account-key-word"><span class="account-key-word-num">${n}</span><span class="account-key-word-text">${escapeHtml(w)}</span></li>`;
  }).join('');
  return `
    <ol class="account-key-grid">${wordCells}</ol>
    <div class="account-key-actions-row">
      <button data-account-key-copy type="button" class="btn secondary">Copy words</button>
    </div>
  `;
}

/**
 * Wire the copy button (`[data-account-key-copy]`) inside `root` to copy
 * `accountKey` to the clipboard, with transient feedback on the button.
 */
function wireAccountKeyCopyButton(root, accountKey) {
  const copyBtn = root.querySelector('[data-account-key-copy]');
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(accountKey);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    } catch {
      copyBtn.textContent = "Couldn't copy";
      setTimeout(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    }
  });
}

/**
 * Render the post-register account-key reveal. Shows the 24 words in a
 * numbered grid plus a copy button. The Continue button is enabled by
 * default; the user can also dismiss the modal via the normal close
 * affordance — both paths run the same post-signup handoff.
 *
 * No save-proof gate: the user can view this key again any time from
 * Settings (recovery v2, Model B by default). Type-back or checkbox
 * gating at signup is security theater that retrieval-from-Settings
 * solves more cleanly.
 *
 * @param {HTMLElement} content
 * @param {{
 *   accountKey: string,
 *   onContinue: () => void,
 * }} opts
 */
function renderAccountKeyView(content, opts) {
  const { accountKey, onContinue } = opts;

  content.innerHTML = `
    <div class="auth-form account-key-view">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>Your account key</h2>
        <p>Save these 24 words somewhere safe — a password manager works well. We can't reset your account for you, but you can view this key again any time in Settings → Account &amp; Security.</p>
      </div>

      ${buildAccountKeyGridMarkup(accountKey)}

      <button id="accountKeyContinueBtn" class="btn primary auth-submit">
        Continue to Bookish
      </button>
    </div>
  `;

  const continueBtn = content.querySelector('#accountKeyContinueBtn');
  wireAccountKeyCopyButton(content, accountKey);

  // Both Continue and the modal's normal close paths (X button, backdrop
  // click, swipe-to-dismiss) should run the same post-signup handoff —
  // there's no save-proof gate to preserve, and the user can re-view the
  // account key from Settings any time. We guard with `fired` so a
  // double-tap doesn't run the handoff twice.
  let fired = false;
  const runHandoff = () => {
    if (fired) return;
    fired = true;
    // Detach our own backdrop listener so it doesn't leak past this view.
    if (modal) modal.removeEventListener('click', backdropHandler);
    onContinue();
  };

  continueBtn.addEventListener('click', runHandoff);

  // Wire close-via-X and backdrop. These already call closeAccountModal
  // (which tears down the UI); piggyback on them to run the handoff first.
  // The existing init-time listener on the close button still runs after
  // ours and will close the modal — runHandoff calls closeAccountModal()
  // via onContinue too, but closeAccountModal is idempotent.
  const modal = document.getElementById('accountModal');
  const closeBtn = document.getElementById('accountModalClose');
  if (closeBtn) closeBtn.addEventListener('click', runHandoff, { once: true });
  const backdropHandler = (e) => {
    if (e.target === modal) runHandoff();
  };
  if (modal) modal.addEventListener('click', backdropHandler);
}

// ============================================================================
// SIGN IN FORM
// ============================================================================

function renderSignInForm(content) {
  content.innerHTML = `
    <div class="auth-form">
      <div class="auth-header">
        <div class="auth-icon">${SVG_USER}</div>
        <h2>Welcome Back</h2>
        <p>Sign in to access your reading list.</p>
      </div>

      <div class="form-group">
        <label for="signInEmail">Email</label>
        <input type="email" id="signInEmail" autocomplete="email" placeholder="you@example.com" required />
      </div>

      <div class="form-group">
        <label for="signInPassword">Password</label>
        <div class="password-field">
          <input type="password" id="signInPassword" autocomplete="current-password" placeholder="Your password" required />
          <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
        </div>
      </div>

      <button id="signInBtn" class="btn primary auth-submit" disabled>
        Sign In
      </button>

      <div id="signInError" class="auth-error" style="display:none;"></div>
      <div id="signInProgress" class="auth-progress" style="display:none;"></div>

      <div class="auth-switch">
        Don't have an account?
        <a href="#" id="switchToCreate">Create one</a>
      </div>
    </div>
  `;

  const emailInput = content.querySelector('#signInEmail');
  const passwordInput = content.querySelector('#signInPassword');
  const signInBtn = content.querySelector('#signInBtn');
  const switchLink = content.querySelector('#switchToCreate');

  // Password toggle
  content.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });
  });

  function validate() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    signInBtn.disabled = !(email && password.length >= 1);
  }

  emailInput.addEventListener('input', validate);
  passwordInput.addEventListener('input', validate);

  signInBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    signInBtn.disabled = true;
    const progress = content.querySelector('#signInProgress');
    const error = content.querySelector('#signInError');
    error.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = 'Signing in...';

    try {
      progress.textContent = 'Deriving encryption keys...';
      await tarnService.login(email, password);
      tarnService.displayName(email.split('@')[0]);

      transientState.justSignedIn = true;
      transientState.signInTime = Date.now();

      // Fresh subscription state for the signed-in user (#74).
      subscription.resetStatus();
      subscription.fetchStatus().catch(() => {});

      progress.textContent = 'Signed in!';
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
      }, 500);

    } catch (e) {
      console.error('[AccountUI] Sign in failed:', e);
      let msg = 'Sign in failed. Please check your email and password.';
      if (e.message?.includes('not found')) msg = 'Account not found. Check your email address.';
      error.style.display = 'block';
      error.textContent = msg;
      progress.style.display = 'none';
      signInBtn.disabled = false;
    }
  });

  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    renderCreateAccountForm(content);
  });
}

// ============================================================================
// ACCOUNT PANEL (logged-in view)
// ============================================================================

function renderAccountPanel(content) {
  const email = tarnService.getEmail() || '';
  const displayName = tarnService.displayName() || email.split('@')[0] || 'User';
  const initial = (displayName[0] || 'U').toUpperCase();

  // Subscription section (#74). All three states get a block: free users
  // see their count + proactive Subscribe CTA; lapsed users see an
  // expired status + Renew; subscribed users see their renewal date + a
  // Manage subscription link that opens the Stripe Billing Portal.
  const subStatus = subscription.getStatus();
  const count = window.bookishApp?.getActiveEntryCount?.() || 0;
  let subSectionHtml = '';
  if (subStatus === 'free') {
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Trial \u2014 ${count} of ${subscription.FREE_LIMIT} books used</div>
        <div class="account-panel-sub-pitch">Add unlimited books: <strong>$10/year</strong> \u00B7 cancel anytime</div>
        <button type="button" id="accountSubscribeBtn" class="account-panel-sub-btn" data-subscribe-action="subscribe">Subscribe \u2014 $10/year</button>
      </div>
    `;
  } else if (subStatus === 'lapsed') {
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Expired \u2014 renew to keep adding books</div>
        <button type="button" id="accountSubscribeBtn" class="account-panel-sub-btn" data-subscribe-action="renew">Renew \u2014 $10/year</button>
      </div>
    `;
  } else if (subStatus === 'subscribed') {
    const periodEndIso = subscription.getCurrentPeriodEnd();
    let renewLine = 'Subscribed';
    if (periodEndIso) {
      try {
        const d = new Date(periodEndIso);
        renewLine = `Subscribed \u2014 renews ${d.toLocaleDateString('en-US', { dateStyle: 'long' })}`;
      } catch { /* fall back to plain label */ }
    }
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">${renewLine}</div>
        <button type="button" id="accountManageBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Manage subscription <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>
    `;
  }

  content.innerHTML = `
    <div class="auth-form">
      <div class="account-panel-header">
        <div class="account-avatar">${initial}</div>
        <div class="account-panel-info">
          <div class="account-panel-name">
            <span id="displayNameValue">${displayName}</span>
            <button id="editDisplayNameBtn" class="btn-link" title="Edit name">${SVG_EDIT}</button>
          </div>
          <div class="account-panel-email">${email}</div>
        </div>
      </div>

      <div class="account-panel-tagline">Private. Permanent. Yours.</div>

      ${subSectionHtml}

      <div class="account-panel-archive">
        <div class="account-panel-sub-label">Your Permanent Archive</div>
        <a class="account-panel-archive-url" href="#" target="_blank" rel="noopener noreferrer" data-archive-link>arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ</a>
        <div class="account-panel-archive-note">Works without Bookish. Private, permanent, and yours regardless of subscription.</div>
        <button type="button" id="accountArchiveBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Open archive <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>

      <div class="account-panel-security" id="accountPanelSecurity">
        <div class="account-panel-sub-label">Account &amp; Security</div>

        <div class="account-security-block">
          <div class="account-security-subtitle">Account key</div>
          <div class="account-security-desc">A 24-word phrase that's the only way to recover your account if you forget your password.</div>
          <div class="account-security-actions">
            <button type="button" id="viewAccountKeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">View account key</button>
            <button type="button" id="replaceAccountKeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Replace account key</button>
          </div>
        </div>

        <div class="account-security-block">
          <div class="account-security-subtitle">Manual account-key custody</div>
          <div class="account-security-desc">When on, your account key isn't stored on our servers. You'll need your saved key to recover your account if you forget your password. More private, less safe if you lose both.</div>
          <label class="account-friends-toggle" for="accountCustodyToggle">
            <span class="account-friends-toggle-label" id="accountCustodyToggleLabel">Manual custody</span>
            <input type="checkbox" id="accountCustodyToggle" />
          </label>
          <div class="account-security-error" id="accountCustodyError" style="display:none;"></div>
        </div>

        <div class="account-security-block" id="accountPasskeysBlock">
          <!-- Phase 3: passkey list. Populated by wirePasskeysSection() once
               isSupported() resolves: either the full block (subtitle, desc,
               list placeholder, Add button) when supported, or a single
               muted "not supported" line when not. -->
        </div>
      </div>

      <div class="account-panel-friends" id="accountPanelFriends">
        <div class="account-panel-sub-label">Friends</div>
        <!-- #122: "+ Add a friend" entry moved to the Friends drawer (header glyph).
             Account keeps the read-only Connections + Pending invites lists for
             power-user verification. To invite someone, open the Friends drawer
             from the header and tap "+ Add".
             #124: added the "Show in header" toggle so users who hid the glyph
             from the drawer have a clear path to re-enable it. -->
        <label class="account-friends-toggle" for="accountFriendsShowToggle">
          <span class="account-friends-toggle-label">Show in header</span>
          <input type="checkbox" id="accountFriendsShowToggle" />
        </label>
        <div class="account-friends-section" id="accountConnectionsSection" style="display:none;">
          <div class="account-friends-heading">Connections</div>
          <ul class="account-friends-list" id="accountConnectionsList"></ul>
        </div>
        <div class="account-friends-section" id="accountPendingInvitesSection" style="display:none;">
          <div class="account-friends-heading">Pending invites</div>
          <ul class="account-friends-list" id="accountPendingInvitesList"></ul>
        </div>
        <div class="account-friends-status" id="accountFriendsStatus" style="display:none;"></div>
      </div>

      <div class="account-actions">
        <button id="exportCsvBtn" class="btn secondary account-csv-btn">
          ${SVG_DOWNLOAD} Export CSV
        </button>
        <button id="logoutBtn" class="btn account-signout">
          Sign Out
        </button>
      </div>
    </div>
  `;

  // Subscribe / Renew (#74)
  const subscribeBtn = content.querySelector('#accountSubscribeBtn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', async () => {
      subscribeBtn.disabled = true;
      try {
        await subscription.startCheckout();
        // Success redirects via window.location.assign; below only runs on failure.
      } catch (err) {
        console.error('[AccountUI] Checkout failed:', err?.message || err);
        subscribeBtn.disabled = false;
        subscribeBtn.textContent = "Couldn't start checkout \u2014 try again";
      }
    });
  }

  // Manage subscription (#74 — opens Stripe Billing Portal in new tab)
  const manageBtn = content.querySelector('#accountManageBtn');
  if (manageBtn) {
    manageBtn.addEventListener('click', async () => {
      manageBtn.disabled = true;
      try {
        await subscription.openPortal();
      } catch (err) {
        console.error('[AccountUI] Portal open failed:', err?.message || err);
        manageBtn.textContent = "Couldn't open portal \u2014 try again";
      } finally {
        // Re-enable after a beat so a slow new-tab open doesn't lock the button.
        setTimeout(() => { manageBtn.disabled = false; }, 1500);
      }
    });
  }

  // Open Archive (perma-export page on Arweave — #12). Dummy URL for now,
  // swap to the real TX URL once the page is uploaded. Both the text link
  // and the button navigate to the same place.
  const ARCHIVE_URL = 'https://arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ';
  const archiveLink = content.querySelector('[data-archive-link]');
  if (archiveLink) archiveLink.href = ARCHIVE_URL;
  const archiveBtn = content.querySelector('#accountArchiveBtn');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      window.open(ARCHIVE_URL, '_blank', 'noopener,noreferrer');
    });
  }

  // Account & Security section — View / Replace / custody toggle (recovery v2 phase 2).
  wireAccountSecuritySection(content);

  // Friends section (#118 → #122). The "+ Add a friend" entry now lives in
  // the Friends drawer (header glyph). Account keeps the read-only
  // Connections + Pending invites lists for power-user verification.
  // Hydrate async — listConnections / listIssuedInvites hit Tarn.
  refreshFriendsSection(content).catch(err =>
    console.warn('[AccountUI] friends hydrate failed:', err?.message || err)
  );

  // "Show in header" toggle (#124). Reflects the per-device localStorage
  // flag and writes back through setHideFriendsFromHeader, which dispatches
  // FRIENDS_VISIBILITY_EVENT so the header glyph updates live without a
  // reload. This is the canonical re-enable path for users who hid the
  // glyph via the drawer link.
  const showInHeaderToggle = content.querySelector('#accountFriendsShowToggle');
  if (showInHeaderToggle) {
    // checked = visible (i.e. NOT hidden). Default = visible.
    showInHeaderToggle.checked = !isFriendsHiddenFromHeader();
    showInHeaderToggle.addEventListener('change', () => {
      setHideFriendsFromHeader(!showInHeaderToggle.checked);
    });
    // Keep the toggle in sync if the preference changes elsewhere (e.g. the
    // drawer's hide link fires while Account is open in another tab — rare
    // but cheap to handle, and keeps the surfaces consistent).
    const onVisibilityChange = (e) => {
      const hidden = !!(e?.detail?.hidden);
      showInHeaderToggle.checked = !hidden;
    };
    window.addEventListener(FRIENDS_VISIBILITY_EVENT, onVisibilityChange);
    // Detach when the modal closes — the next render() rebuilds the panel
    // and re-binds, so a stale listener would just leak. Hook it via the
    // existing modal close path: a one-shot listener on the modal's hide.
    const accountModal = document.getElementById('accountModal');
    if (accountModal) {
      const cleanup = () => {
        window.removeEventListener(FRIENDS_VISIBILITY_EVENT, onVisibilityChange);
      };
      // MutationObserver on display:none is overkill; just clean up on the
      // close button + backdrop click paths the modal already uses.
      const closeBtn = document.getElementById('accountModalClose');
      if (closeBtn) closeBtn.addEventListener('click', cleanup, { once: true });
      accountModal.addEventListener('click', (e) => {
        if (e.target === accountModal) cleanup();
      }, { once: true });
    }
  }

  // Logout
  content.querySelector('#logoutBtn').addEventListener('click', async () => {
    closeAccountModal();
    await performLogout();
  });

  // Export CSV
  content.querySelector('#exportCsvBtn').addEventListener('click', () => {
    exportBooksToCSV();
  });

  // Edit display name
  content.querySelector('#editDisplayNameBtn').addEventListener('click', () => {
    const valueEl = content.querySelector('#displayNameValue');
    const editBtn = content.querySelector('#editDisplayNameBtn');
    const current = valueEl.textContent;

    valueEl.innerHTML = `<input type="text" id="displayNameInput" value="${current}" />`;
    editBtn.innerHTML = 'Save';
    editBtn.classList.add('save-active');

    const input = content.querySelector('#displayNameInput');
    input.focus();
    input.select();

    const save = () => {
      const newName = input.value.trim() || current;
      tarnService.displayName(newName);
      valueEl.textContent = newName;
      editBtn.innerHTML = SVG_EDIT;
      editBtn.classList.remove('save-active');
      // Update avatar initial
      const avatar = content.querySelector('.account-avatar');
      if (avatar) avatar.textContent = (newName[0] || 'U').toUpperCase();
    };

    editBtn.onclick = save;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  });
}

// ============================================================================
// FRIENDS SECTION (#118 — issue 2 of the Friends rollout)
// ============================================================================

/**
 * Hydrate the Account → Friends section: list connections by label and list
 * outstanding issued invites with revoke buttons. Both are temporary
 * verification surfaces for issue 2; the proper drawer ships in issue 3.
 *
 * @param {HTMLElement} content
 */
async function refreshFriendsSection(content) {
  const connSection = content.querySelector('#accountConnectionsSection');
  const connList = content.querySelector('#accountConnectionsList');
  const invSection = content.querySelector('#accountPendingInvitesSection');
  const invList = content.querySelector('#accountPendingInvitesList');
  const status = content.querySelector('#accountFriendsStatus');
  if (!connSection || !connList || !invSection || !invList || !status) return;

  let connections = [];
  let invites = [];
  try {
    [connections, invites] = await Promise.all([
      friends.listConnections(),
      friends.listIssuedInvites(),
    ]);
  } catch (err) {
    status.style.display = 'block';
    status.textContent = "Couldn't load friends — try reopening Account.";
    console.warn('[AccountUI] friends fetch failed:', err.message);
    return;
  }
  status.style.display = 'none';

  // Connections list
  if (connections.length > 0) {
    connSection.style.display = 'block';
    connList.innerHTML = connections
      .map(c => {
        const label = (c.label && c.label.trim()) || (c.email ? c.email : c.share_pub.slice(0, 8));
        return `<li class="account-friend-row"><span class="account-friend-label">${escapeHtml(label)}</span></li>`;
      })
      .join('');
  } else {
    connSection.style.display = 'none';
    connList.innerHTML = '';
  }

  // Pending invites list
  const outstanding = invites.filter(i => !i.redeemed_at);

  // Note on zero-friends discoverability: the Account-screen "+ Add a friend"
  // button was REMOVED in #122 per the issue spec — the drawer is now the
  // canonical entry point. However, the drawer trigger is hidden when
  // zero friends, which creates a bootstrap chicken-and-egg problem for
  // first-time users. The parent FRIENDS.md spec calls out "Account → Add
  // a friend" as the zero-state discovery path; reconciling that with the
  // issue 3 removal is left to a follow-up surface (likely a dedicated
  // education sheet in #9 / #122 follow-up). For now we leave the section
  // empty in the zero-friends state — first invites can be sent via a
  // direct `/invite/...` link from a friend OR by opening the dev console
  // (alpha-cohort only). Document the gap so a reviewer doesn't think it
  // was an oversight.
  if (outstanding.length > 0) {
    invSection.style.display = 'block';
    invList.innerHTML = outstanding
      .map(inv => {
        const expires = inv.expires_at
          ? new Date(inv.expires_at * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })
          : '';
        const namePart = inv.display_name?.trim()
          ? `for ${escapeHtml(inv.display_name)}`
          : 'unnamed';
        return `
          <li class="account-friend-row" data-pending-token="${escapeHtml(inv.token_id)}">
            <span class="account-friend-label">Invite ${namePart}</span>
            <span class="account-friend-meta">${expires ? 'Expires ' + escapeHtml(expires) : ''}</span>
            <button type="button" class="btn-link account-friend-revoke" data-revoke-token="${escapeHtml(inv.token_id)}">Revoke</button>
          </li>
        `;
      })
      .join('');
    invList.querySelectorAll('[data-revoke-token]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tokenId = btn.dataset.revokeToken;
        btn.disabled = true;
        btn.textContent = 'Revoking…';
        try {
          await friends.revokeInvite(tokenId);
          await refreshFriendsSection(content);
        } catch (err) {
          console.error('[AccountUI] revoke failed:', err);
          btn.disabled = false;
          btn.textContent = 'Try again';
        }
      });
    });
  } else {
    invSection.style.display = 'none';
    invList.innerHTML = '';
  }
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
 * key, and the manual-custody toggle. Called once after the panel HTML is
 * rendered. The section is statically present in the panel markup; this
 * just attaches handlers and hydrates the toggle's initial state.
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
  hydrateCustodyToggle(content);
  // Phase 3: registered passkeys block. Sits under the custody toggle.
  // Async because the support probe + initial list() both touch the SDK.
  hydratePasskeysSection(content).catch(err =>
    console.warn('[AccountUI] passkeys hydrate failed:', err?.message || err)
  );
}

/**
 * Reflect the SDK's `accountKey.isStored()` state on the custody toggle.
 *
 * - `true`  (Model B, server-stored) → toggle UNCHECKED (manual custody off)
 * - `false` (Model A, not stored)    → toggle CHECKED (manual custody on)
 * - `null`  (no auth round trip yet) → toggle disabled, label "Loading…",
 *                                       retry once on a 100ms timer.
 */
function hydrateCustodyToggle(content) {
  const toggle = content.querySelector('#accountCustodyToggle');
  const label = content.querySelector('#accountCustodyToggleLabel');
  const errorEl = content.querySelector('#accountCustodyError');
  if (!toggle || !label) return;

  const stored = tarnService.accountKey.isStored();
  if (stored === null) {
    toggle.disabled = true;
    toggle.checked = false;
    label.textContent = 'Loading…';
    setTimeout(() => {
      // The panel may have been torn down by then; bail if so.
      if (!document.body.contains(toggle)) return;
      hydrateCustodyToggle(content);
    }, 100);
    return;
  }

  toggle.disabled = false;
  label.textContent = 'Manual custody';
  // checked = Model A (not stored). unchecked = Model B (stored).
  toggle.checked = stored === false;
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  // Replace any existing change listener by cloning the node.
  // We can't easily remove the previous anonymous handler, so on every
  // hydrate we install one that internally guards against re-entrancy.
  if (!toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.addEventListener('change', async () => {
      const wantsManualCustody = toggle.checked;
      // Disable while the flow runs to prevent a double-click landing two
      // step-up calls in flight at once.
      toggle.disabled = true;
      try {
        if (wantsManualCustody) {
          // OFF → ON (B → A): disable storage. Confirmation + password.
          await runDisableStorageFlow();
        } else {
          // ON → OFF (A → B): enable storage. Password + 24-word phrase.
          await runEnableStorageFlow();
        }
      } finally {
        // Always re-hydrate from authoritative state — handles success
        // (toggle reflects new state), cancel (toggle reverts), and error
        // (toggle reverts; inline error already shown by the flow).
        hydrateCustodyToggle(content);
      }
    });
  }
}

/**
 * Off → On (B → A) flow: confirmation dialog, then password prompt with
 * inline-error retry, calls `disableKeyStorage` on submit. The dialog
 * stays open across wrong-password attempts; cancel/backdrop dismiss
 * aborts the flow.
 */
async function runDisableStorageFlow() {
  const errorEl = document.getElementById('accountCustodyError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const confirmed = await confirmDialog({
    title: 'Stop storing your account key?',
    body: "Stop storing the wrapped account key on our servers? Make sure you've saved your 24 words first — we won't be able to give them to you again.",
    confirmLabel: 'Continue',
  });
  if (!confirmed) return;

  await requestPasswordConfirmation({
    title: 'Confirm your password',
    body: 'Re-enter your password to turn off server-side storage of your account key.',
    confirmLabel: 'Turn on manual custody',
    submit: async (password) => {
      await tarnService.accountKey.disableKeyStorage({ password });
    },
  });
}

/**
 * On → Off (A → B) flow: dialog with password + 24-word phrase, then
 * `enableKeyStorage`. AccountKeyPinningError surfaces a dedicated message
 * inside the dialog and keeps it open for retry; other errors do the same.
 */
async function runEnableStorageFlow() {
  const errorEl = document.getElementById('accountCustodyError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  await openEnableStorageDialog(async ({ password, accountKey: phrase }) => {
    await tarnService.accountKey.enableKeyStorage({ password, accountKey: phrase });
  });
}

// ----------------------------------------------------------------------------
// Passkeys (recovery v2 — phase 3)
// ----------------------------------------------------------------------------

/**
 * Module-level cache for `tarnService.passkeys.isSupported()`. The probe
 * is cheap but not free (it walks `PublicKeyCredential` and platform-
 * authenticator availability), and the answer is stable for the page
 * lifetime — so cache it the first time the panel mounts and reuse on
 * subsequent renders.
 *
 * `null` means "not yet probed". `true` / `false` are settled values.
 *
 * @type {boolean | null}
 */
let _passkeysSupportedCache = null;
/** @type {Promise<boolean> | null} — in-flight probe, deduped */
let _passkeysSupportedProbe = null;

async function getPasskeysSupported() {
  if (_passkeysSupportedCache !== null) return _passkeysSupportedCache;
  if (!_passkeysSupportedProbe) {
    _passkeysSupportedProbe = (async () => {
      try {
        const ok = await tarnService.passkeys.isSupported();
        _passkeysSupportedCache = !!ok;
        return _passkeysSupportedCache;
      } catch (err) {
        console.warn('[AccountUI] passkeys.isSupported probe failed:', err?.message || err);
        _passkeysSupportedCache = false;
        return false;
      }
    })();
  }
  return _passkeysSupportedProbe;
}

/**
 * Render the Registered passkeys block. Two paths:
 *   - `isSupported()` resolves false → render a single muted line.
 *   - `isSupported()` resolves true  → render subtitle + desc + list
 *     placeholder + Add button, then asynchronously fetch and render the
 *     list.
 *
 * Idempotent: safe to call multiple times against the same panel; later
 * calls re-render the block in place.
 */
async function hydratePasskeysSection(content) {
  const block = content.querySelector('#accountPasskeysBlock');
  if (!block) return;

  const supported = await getPasskeysSupported();
  if (!supported) {
    block.innerHTML = `
      <div class="account-security-desc account-passkeys-unsupported">Passkeys aren't supported on this browser. Try a recent Chrome, Safari, or Edge.</div>
    `;
    return;
  }

  block.innerHTML = `
    <div class="account-security-subtitle">Registered passkeys</div>
    <div class="account-security-desc">Sign in with Touch ID, Face ID, or Windows Hello instead of typing your password. Each device you register here can sign in independently.</div>
    <ul class="account-passkeys-list" id="accountPasskeysList" aria-live="polite">
      <li class="account-passkeys-loading">Loading passkeys&hellip;</li>
    </ul>
    <div class="account-security-error" id="accountPasskeysError" style="display:none;"></div>
    <div class="account-security-actions">
      <button type="button" id="addPasskeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Add passkey</button>
    </div>
  `;

  const addBtn = block.querySelector('#addPasskeyBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => startAddPasskeyFlow(content));
  }

  // Initial fetch + render. Errors are surfaced inline via the error slot.
  await refreshPasskeysList(content);
}

/**
 * Fetch the latest passkey list from the SDK and re-render the list rows.
 * Keeps the loading placeholder up while the request is in flight. On
 * error, replaces the list with an empty-state and surfaces the message
 * in the inline error slot so retries are visible.
 */
async function refreshPasskeysList(content) {
  const listEl = content.querySelector('#accountPasskeysList');
  const errorEl = content.querySelector('#accountPasskeysError');
  if (!listEl) return;
  // Don't blow away the placeholder if we already have rows — show a
  // minimal "Refreshing…" hint instead so the list doesn't visibly flash
  // empty between fetches.
  const hasRows = !!listEl.querySelector('[data-credential-id]');
  if (!hasRows) {
    listEl.innerHTML = `<li class="account-passkeys-loading">Loading passkeys&hellip;</li>`;
  }

  let entries;
  try {
    entries = await tarnService.passkeys.list();
  } catch (err) {
    console.warn('[AccountUI] passkeys.list failed:', err?.message || err);
    listEl.innerHTML = '';
    if (errorEl) {
      errorEl.textContent = humanizeAccountKeyError(err, { phraseFlow: false });
      errorEl.style.display = 'block';
    }
    return;
  }
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  if (!Array.isArray(entries) || entries.length === 0) {
    listEl.innerHTML = `<li class="account-passkeys-empty">No passkeys registered yet.</li>`;
    return;
  }

  // Per ACCOUNT_SECURITY_PLAN.md: deliberately do NOT surface the `stale`
  // flag. Just-in-time repair handles staleness transparently at sign-in.
  // The flag is read off the entry but never used to decorate the row.
  listEl.innerHTML = entries.map(entry => {
    const labelText = entry.deviceLabel
      ? entry.deviceLabel
      : truncateCredentialId(entry.credentialId);
    const lastUsed = humanizePasskeyDate(entry.lastUsedAt, { neverText: 'Never used' });
    const created = humanizePasskeyDate(entry.createdAt, { neverText: '' });
    const createdText = created ? `Added ${created}` : '';
    return `
      <li class="account-passkeys-row" data-credential-id="${escapeHtml(entry.credentialId)}">
        <div class="account-passkeys-row-main">
          <div class="account-passkeys-row-label">${escapeHtml(labelText)}</div>
          <div class="account-passkeys-row-last">${escapeHtml(lastUsed)}</div>
          ${createdText ? `<div class="account-passkeys-row-created">${escapeHtml(createdText)}</div>` : ''}
        </div>
        <button type="button" class="account-panel-sub-btn account-panel-sub-btn-secondary account-passkeys-remove" data-action="remove-passkey">Remove</button>
      </li>
    `;
  }).join('');

  // Wire Remove buttons. Each row owns its credentialId via data-attr so
  // we don't need a closure per row.
  listEl.querySelectorAll('[data-action="remove-passkey"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-credential-id]');
      if (!row) return;
      const credentialId = row.getAttribute('data-credential-id');
      const labelEl = row.querySelector('.account-passkeys-row-label');
      const deviceLabel = labelEl ? labelEl.textContent : credentialId;
      startRemovePasskeyFlow(content, { credentialId, deviceLabel });
    });
  });
}

function truncateCredentialId(id) {
  if (!id || typeof id !== 'string') return 'Unnamed passkey';
  return id.slice(0, 8) + '…';
}

/**
 * Humanize a millisecond timestamp into a relative or short-date string.
 *
 * Buckets:
 *   - null / 0 / falsy → opts.neverText (default 'Never')
 *   - < 1 minute       → 'Just now'
 *   - < 1 hour         → 'N min ago'
 *   - < 1 day          → 'N hour(s) ago'
 *   - < 2 days         → 'Yesterday'
 *   - < 1 year         → short month-day, e.g. 'May 4'
 *   - older            → short month-day-year, e.g. 'May 4, 2025'
 *
 * Exported via the testing seam in tests/passkeys_settings.test.js (see
 * the helper export at the bottom of this file).
 *
 * @param {number | null | undefined} ts
 * @param {{ neverText?: string, now?: number }} [opts]
 * @returns {string}
 */
function humanizePasskeyDate(ts, opts = {}) {
  const neverText = opts.neverText !== undefined ? opts.neverText : 'Never';
  if (ts == null || ts === 0) return neverText;
  const now = opts.now != null ? opts.now : Date.now();
  const delta = now - ts;
  if (delta < 60 * 1000) return 'Just now';
  if (delta < 60 * 60 * 1000) {
    const m = Math.floor(delta / (60 * 1000));
    return `${m} min ago`;
  }
  if (delta < 24 * 60 * 60 * 1000) {
    const h = Math.floor(delta / (60 * 60 * 1000));
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  if (delta < 2 * 24 * 60 * 60 * 1000) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (sameYear && delta < 365 * 24 * 60 * 60 * 1000) return monthDay;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Suggest a default device label based on platform hints. Prefers
 * `navigator.userAgentData.platform` (modern UA Client Hints), falls back
 * to a small UA-string parse. Intentionally short — no UA-parser
 * dependency. Returns one of: "iPhone", "iPad", "Mac", "Windows PC",
 * "Android", "This device".
 */
function suggestDeviceLabel() {
  try {
    const uad = typeof navigator !== 'undefined' && navigator.userAgentData;
    const platform = (uad && typeof uad.platform === 'string' ? uad.platform : '') || '';
    if (/^macOS$/i.test(platform)) return 'Mac';
    if (/^Windows$/i.test(platform)) return 'Windows PC';
    if (/^Android$/i.test(platform)) return 'Android';
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone|iPod/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    return 'This device';
  } catch {
    return 'This device';
  }
}

/**
 * Start the Add-passkey flow. Opens the dialog with a UA-suggested
 * device-label pre-fill; on submit calls `passkeys.register` (which
 * triggers the WebAuthn prompt). On success, re-renders the list. On
 * failure (user-cancel, hardware unavailable, etc.) closes the dialog
 * and shows an inline error in the section.
 */
async function startAddPasskeyFlow(content) {
  const errorEl = content.querySelector('#accountPasskeysError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const result = await openAddPasskeyDialog({
    suggestion: suggestDeviceLabel(),
  });
  if (!result || !result.deviceLabel) return; // cancelled

  try {
    await tarnService.passkeys.register({ deviceLabel: result.deviceLabel });
  } catch (err) {
    console.warn('[AccountUI] passkeys.register failed:', err?.message || err);
    if (errorEl) {
      errorEl.textContent = humanizePasskeyError(err);
      errorEl.style.display = 'block';
    }
    return;
  }
  await refreshPasskeysList(content);
}

/**
 * Start the Remove-passkey flow. Confirmation dialog → password prompt
 * (reuses `requestPasswordConfirmation` from Phase 2) → SDK call →
 * re-render. Wrong-password / step-up errors stay in the password
 * dialog (per the existing helper); other errors surface inline in the
 * section.
 */
async function startRemovePasskeyFlow(content, { credentialId, deviceLabel }) {
  const errorEl = content.querySelector('#accountPasskeysError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const confirmed = await confirmDialog({
    title: 'Remove this passkey?',
    body: `Remove "${deviceLabel}"? You won't be able to sign in with this passkey on this device anymore.`,
    confirmLabel: 'Remove',
  });
  if (!confirmed) return;

  const ok = await requestPasswordConfirmation({
    title: 'Confirm your password',
    body: 'Re-enter your password to remove this passkey.',
    confirmLabel: 'Remove passkey',
    submit: async (password) => {
      await tarnService.passkeys.remove({ credentialId, password });
      return true;
    },
  });
  if (!ok) return;
  await refreshPasskeysList(content);
}

/**
 * Translate a passkey-side error into a user-facing string. Reuses the
 * step-up / wrong-password / network mappings from
 * `humanizeAccountKeyError` and adds passkey-specific cases (user
 * cancelled the WebAuthn prompt, no platform authenticator available).
 */
function humanizePasskeyError(err) {
  const msg = err?.message || '';
  const name = err?.name || '';
  // WebAuthn user-cancel: NotAllowedError on most browsers.
  if (name === 'NotAllowedError' || /not allowed|user cancelled|user canceled|cancelled by user/i.test(msg)) {
    return 'The passkey prompt was cancelled. Try again when ready.';
  }
  if (name === 'InvalidStateError' || /already registered|excluded/i.test(msg)) {
    return 'This device already has a passkey registered. Try a different label or remove the existing one first.';
  }
  if (name === 'NotSupportedError' || /not supported|no authenticator|prf/i.test(msg)) {
    return "This device can't register a passkey right now. Make sure your platform authenticator (Touch ID / Windows Hello / security key) is set up.";
  }
  // Fall through to the shared mapping for step-up / network / generic.
  return humanizeAccountKeyError(err, { phraseFlow: false });
}

/**
 * Open the Add-passkey dialog. Resolves with `{ deviceLabel }` on
 * confirm, `null` on cancel/backdrop dismiss. The returned label is
 * trimmed; an empty trimmed value blocks the confirm button.
 *
 * @param {{ suggestion: string }} opts
 * @returns {Promise<{ deviceLabel: string } | null>}
 */
function openAddPasskeyDialog({ suggestion }) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">Add a passkey</h2>
        <p class="security-overlay-body">You'll see a system prompt next — Touch ID, Face ID, or Windows Hello — to confirm.</p>
        <div class="form-group">
          <label for="addPasskeyLabel">Name this device</label>
          <input type="text" id="addPasskeyLabel" autocomplete="off" maxlength="64" />
        </div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm>Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.security-overlay-card');
    const input = overlay.querySelector('#addPasskeyLabel');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    input.value = suggestion || '';
    const validate = () => {
      confirmBtn.disabled = input.value.trim().length === 0;
    };
    validate();
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    input.addEventListener('input', validate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    });
    confirmBtn.addEventListener('click', () => {
      const label = input.value.trim();
      if (!label) return;
      cleanup({ deviceLabel: label });
    });
    cancelBtn.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  });
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
    return 'No account key is stored on our servers right now. Toggle manual custody off to start storing one.';
  }
  if (/step-up|challenge|wrong password|invalid password|credential/i.test(msg)) {
    return 'Wrong password. Please try again.';
  }
  if (/network|fetch|timeout|offline/i.test(msg)) {
    return "Couldn't reach our servers. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

/**
 * Start the View account key flow: password prompt (with inline-error
 * retry) → SDK call → grid overlay. The password dialog stays open on
 * wrong-password attempts; cancel aborts the flow.
 */
async function startViewAccountKeyFlow() {
  const result = await requestPasswordConfirmation({
    title: 'View your account key',
    body: 'Re-enter your password to see your 24-word account key.',
    confirmLabel: 'Show account key',
    submit: async (password) => tarnService.accountKey.view({ password }),
  });
  if (!result || !result.accountKey) return;
  showAccountKeyResultOverlay({
    heading: 'Your account key',
    body: "Save these 24 words somewhere safe — a password manager works well. We won't be able to give them to you again if you lose them.",
    accountKey: result.accountKey,
  });
}

/**
 * Start the Replace account key flow: confirmation → password (with
 * inline-error retry) → rotate → new grid. The confirmation copy spells
 * out that the saved 24 words stop working.
 */
async function startReplaceAccountKeyFlow() {
  const confirmed = await confirmDialog({
    title: 'Replace your account key?',
    body: "Your saved 24 words will stop working. We'll show you a new account key — save it somewhere safe before continuing.",
    confirmLabel: 'Continue',
  });
  if (!confirmed) return;

  const result = await requestPasswordConfirmation({
    title: 'Confirm your password',
    body: 'Re-enter your password to replace your account key.',
    confirmLabel: 'Replace account key',
    submit: async (password) => tarnService.accountKey.rotate({ password }),
  });
  if (!result || !result.accountKey) return;
  showAccountKeyResultOverlay({
    heading: 'Your new account key',
    body: 'Your old 24 words no longer work. Save these new 24 words somewhere safe before closing this screen.',
    accountKey: result.accountKey,
  });
}

// ----------------------------------------------------------------------------
// Account-key result overlay (View / Replace shared)
// ----------------------------------------------------------------------------

/**
 * Show the 24-word grid in a full overlay above the account panel. The
 * Done button removes the overlay and returns the user to the panel.
 *
 * @param {{ heading: string, body: string, accountKey: string }} opts
 */
function showAccountKeyResultOverlay(opts) {
  const overlay = createOverlay('account-key-result-overlay');
  overlay.innerHTML = `
    <div class="security-overlay-card">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>${escapeHtml(opts.heading)}</h2>
        <p>${escapeHtml(opts.body)}</p>
      </div>
      ${buildAccountKeyGridMarkup(opts.accountKey)}
      <button type="button" data-overlay-done class="btn primary auth-submit">Done</button>
    </div>
  `;
  document.body.appendChild(overlay);
  wireAccountKeyCopyButton(overlay, opts.accountKey);
  const done = overlay.querySelector('[data-overlay-done]');
  if (done) {
    done.addEventListener('click', () => {
      overlay.remove();
    });
  }
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
 * Open the enable-storage dialog (password + 24-word phrase). The dialog
 * stays open across submit failures — `submit({password, accountKey})` is
 * awaited; if it throws, an inline error is shown inside the dialog and
 * the user can edit and try again. The dialog only closes on a successful
 * submit (resolves), or cancel / backdrop dismiss.
 *
 * The pasted phrase is normalized client-side (strip leading numbers like
 * "1." or "1)", collapse whitespace, lowercase) before being passed to
 * `submit`. The SDK normalizes again internally — this is purely a
 * friendliness layer for password-manager paste UX.
 *
 * @param {(args: { password: string, accountKey: string }) => Promise<void>} submit
 * @returns {Promise<void>} resolves when the dialog closes
 */
function openEnableStorageDialog(submit) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">Turn off manual custody</h2>
        <p class="security-overlay-body">To start storing your account key, enter your password and paste your saved 24 words.</p>
        <div class="form-group">
          <label for="securityEnablePassword">Password</label>
          <div class="password-field">
            <input type="password" id="securityEnablePassword" autocomplete="current-password" placeholder="Your password" />
            <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="form-group">
          <label for="securityEnablePhrase">Account key</label>
          <textarea id="securityEnablePhrase" rows="4" placeholder="Paste your saved 24 words"></textarea>
        </div>
        <div class="security-overlay-error" data-error style="display:none;"></div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm disabled>Turn off manual custody</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.security-overlay-card');
    const passwordInput = overlay.querySelector('#securityEnablePassword');
    const phraseInput = overlay.querySelector('#securityEnablePhrase');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const toggleBtn = overlay.querySelector('.password-toggle');
    const errorEl = overlay.querySelector('[data-error]');

    const closeAndResolve = () => {
      // Clear sensitive values from the DOM before tearing down.
      if (passwordInput) passwordInput.value = '';
      if (phraseInput) phraseInput.value = '';
      overlay.remove();
      resolve();
    };

    const validate = () => {
      const pwOk = passwordInput.value.length > 0;
      const phraseOk = normalizePastedPhrase(phraseInput.value).split(' ').filter(Boolean).length === 24;
      confirmBtn.disabled = !(pwOk && phraseOk);
    };

    passwordInput.addEventListener('input', validate);
    phraseInput.addEventListener('input', validate);

    confirmBtn.addEventListener('click', async () => {
      const password = passwordInput.value;
      const accountKey = normalizePastedPhrase(phraseInput.value);
      confirmBtn.disabled = true;
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      try {
        await submit({ password, accountKey });
        closeAndResolve();
      } catch (err) {
        console.warn('[AccountUI] enableKeyStorage submit failed:', err?.message || err);
        errorEl.textContent = humanizeAccountKeyError(err, { phraseFlow: true });
        errorEl.style.display = 'block';
        // Re-enable based on current input validity — keep dialog open.
        validate();
      }
    });
    cancelBtn.addEventListener('click', () => closeAndResolve());
    toggleBtn.addEventListener('click', () => {
      const showing = passwordInput.type === 'text';
      passwordInput.type = showing ? 'password' : 'text';
      toggleBtn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndResolve(); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => passwordInput.focus({ preventScroll: true }));
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

// ============================================================================
// PASSWORD STRENGTH
// ============================================================================

function assessPasswordStrength(password) {
  if (!password) return { pct: 0, label: '', cls: '' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score <= 1) return { pct: 20, label: 'Weak', cls: 'strength-weak' };
  if (score === 2) return { pct: 40, label: 'Fair', cls: 'strength-weak' };
  if (score === 3) return { pct: 60, label: 'Good', cls: 'strength-medium' };
  if (score === 4) return { pct: 80, label: 'Strong', cls: 'strength-good' };
  return { pct: 100, label: 'Very Strong', cls: 'strength-good' };
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
  resetPasskeysSupportedCache: () => {
    _passkeysSupportedCache = null;
    _passkeysSupportedProbe = null;
  },
};
