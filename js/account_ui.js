// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import * as subscription from './core/subscription.js';
import { pushOverlayState, popOverlayState } from './core/overlay_history.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';

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
        Your reading list is private — even Bookish can't read it or reset your password. After signup we'll show you a 24-word recovery phrase and email you a PDF copy. Save them both somewhere safe.
      </div>

      <label class="auth-consent">
        <input type="checkbox" id="recoveryConsent" />
        <span>I understand I'll be shown a 24-word recovery phrase and that without it and my password, my data can't be recovered.</span>
      </label>

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
  const consentCheckbox = content.querySelector('#recoveryConsent');
  const createBtn = content.querySelector('#createAccountBtn');
  const switchLink = content.querySelector('#switchToSignIn');

  function validate() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const consent = consentCheckbox.checked;
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const passwordValid = password.length >= 8;
    const confirmMatch = password === confirm && confirm.length > 0;

    createBtn.disabled = !(emailValid && passwordValid && confirmMatch && consent);
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

  consentCheckbox.addEventListener('change', validate);
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
      // Step 1: Register with Tarn. The SDK derives keys, generates a
      // 24-word recovery phrase + PDF, and (by default) forwards the PDF
      // through the recovery-email forwarder.
      progress.textContent = 'Deriving encryption keys...';
      const reg = await tarnService.register(email, password);
      const { dataLookupKey, recoveryPhrase, pdfBytes, emailDelivered } = reg;

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

      // Step 4: Hand off to the recovery-phrase view. The user CANNOT
      // dismiss this until they acknowledge having saved the phrase —
      // that's the whole point of surfacing it. Hold sync until then so
      // the post-modal startSync() runs from the same code path.
      renderRecoveryPhraseView(content, {
        phrase: recoveryPhrase,
        pdfBytes,
        emailDelivered,
        provisioned,
        onContinue: () => {
          closeAccountModal();
          startSync();
          uiStatusManager.refresh();
          if (typeof window.updateBookDots === 'function') window.updateBookDots();
        },
      });

      // Drop the in-memory phrase + PDF reference from this scope. The
      // SDK already doesn't cache them; the recovery view holds its own
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
// RECOVERY PHRASE VIEW (post-register)
// ============================================================================

/**
 * Render the post-register recovery-phrase view. Shows the 24 words in a
 * numbered grid, a Download PDF button, an email-delivery indicator, and
 * an acknowledgment checkbox that gates the Continue button.
 *
 * The user cannot dismiss this except by acknowledging — modal close is
 * also locked while this view is mounted.
 *
 * @param {HTMLElement} content
 * @param {{
 *   phrase: string,
 *   pdfBytes: Uint8Array,
 *   emailDelivered: boolean,
 *   provisioned: boolean,
 *   onContinue: () => void,
 * }} opts
 */
function renderRecoveryPhraseView(content, opts) {
  const { phrase, pdfBytes, emailDelivered, provisioned, onContinue } = opts;
  const words = phrase.trim().split(/\s+/);

  // Lock modal close while this view is mounted — there's no other way
  // for the user to see the phrase.
  const modal = document.getElementById('accountModal');
  if (modal) modal.dataset.allowClose = 'false';

  const wordCells = words.map((w, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<li class="recovery-word"><span class="recovery-word-num">${n}</span><span class="recovery-word-text">${w}</span></li>`;
  }).join('');

  const emailMessage = emailDelivered
    ? `<div class="recovery-email-status recovery-email-ok">We also sent the PDF to your email — save it somewhere safe and delete the email. Inboxes are a common attack target.</div>`
    : `<div class="recovery-email-status recovery-email-warn">Email delivery failed. Please download the PDF before continuing — it's the only copy you'll see.</div>`;

  const provisioningNote = provisioned
    ? ''
    : `<div class="recovery-email-status recovery-email-warn" style="margin-top:8px;">Cloud sync setup will retry shortly — your account is ready, but writes may be delayed by a few seconds.</div>`;

  content.innerHTML = `
    <div class="auth-form recovery-phrase-view">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>Save your recovery phrase</h2>
        <p>These 24 words are the only way to recover your account if you forget your password. Bookish never sees them.</p>
      </div>

      <ol class="recovery-phrase-grid">${wordCells}</ol>

      <div class="recovery-actions-row">
        <button id="recoveryCopyBtn" type="button" class="btn secondary">Copy words</button>
        <button id="recoveryDownloadBtn" type="button" class="btn secondary">${SVG_DOWNLOAD} Download PDF</button>
      </div>

      ${emailMessage}
      ${provisioningNote}

      <label class="auth-consent">
        <input type="checkbox" id="recoverySavedAck" />
        <span>I've saved my recovery phrase. I understand that without it, I cannot recover my account if I forget my password.</span>
      </label>

      <button id="recoveryContinueBtn" class="btn primary auth-submit" disabled>
        Continue to Bookish
      </button>
    </div>
  `;

  const ackCheckbox = content.querySelector('#recoverySavedAck');
  const continueBtn = content.querySelector('#recoveryContinueBtn');
  const copyBtn = content.querySelector('#recoveryCopyBtn');
  const downloadBtn = content.querySelector('#recoveryDownloadBtn');

  ackCheckbox.addEventListener('change', () => {
    continueBtn.disabled = !ackCheckbox.checked;
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    } catch {
      copyBtn.textContent = "Couldn't copy";
      setTimeout(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    }
  });

  downloadBtn.addEventListener('click', () => {
    // pdfBytes is a Uint8Array from the SDK. Wrap in a Blob so the
    // browser triggers a download with the right MIME type.
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bookish-recovery-phrase.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  continueBtn.addEventListener('click', () => {
    if (!ackCheckbox.checked) return;
    if (modal) modal.dataset.allowClose = 'true';
    onContinue();
  });
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
      csvEscape(e.dateRead || ''),
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
