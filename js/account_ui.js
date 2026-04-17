// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
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
  tarnService.logout();

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
    const firstInput = content.querySelector('input:not([type=hidden])');
    if (firstInput) firstInput.focus();
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
        <p>Your reading list, encrypted and always yours.</p>
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

      <label class="auth-consent">
        <input type="checkbox" id="recoveryConsent" />
        <span>I understand that Bookish cannot recover my password. My data is encrypted with keys derived from my password.</span>
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
      // Step 1: Register with Tarn (PBKDF2 derivation + challenge-response)
      progress.textContent = 'Deriving encryption keys...';
      const { dataLookupKey } = await tarnService.register(email, password);

      // Step 2: Set free-tier rules + send welcome email via Bookish API.
      // This is critical — without rules, writes are denied.
      // Retry up to 3 times with backoff.
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
        // Account exists in Tarn but writes will be denied until provisioned.
        // Store flag so we can retry on next login/sync.
        localStorage.setItem('bookish.needsProvisioning', JSON.stringify({ email, dataLookupKey }));
        console.warn('[AccountUI] Provisioning failed after 3 attempts — will retry later');
      }

      // Step 3: Store display info
      tarnService.displayName(email.split('@')[0]);
      localStorage.setItem('bookish.hasHadAccount', 'true');

      // Step 4: Success
      transientState.justCreated = true;
      transientState.createdTime = Date.now();
      markInitialSyncDone(); // New account — no books to sync

      progress.textContent = provisioned
        ? 'Account created!'
        : 'Account created! Cloud sync setup will retry shortly.';
      setTimeout(() => {
        closeAccountModal();
        startSync();
        uiStatusManager.refresh();
        if (typeof window.updateBookDots === 'function') window.updateBookDots();
      }, provisioned ? 800 : 2000);

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

      <div class="account-actions">
        <button id="exportCsvBtn" class="btn secondary">
          ${SVG_DOWNLOAD} Export Books (CSV)
        </button>
        <button id="logoutBtn" class="btn account-signout">
          Sign Out
        </button>
      </div>
    </div>
  `;

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
