// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';

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

  uiStatusManager.refresh();
  // updateBookDots triggers render() which will show empty state
  if (typeof window.updateBookDots === 'function') window.updateBookDots();
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

export async function openAccountModal() {
  const modal = document.getElementById('accountModal');
  const content = document.getElementById('accountModalContent');
  if (!modal || !content) return;

  modal.dataset.allowClose = 'false';
  await renderAccountModalContent(content);
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const modalContent = modal.querySelector('.account-modal');
  if (modalContent) {
    modalContent.style.visibility = 'visible';
    modalContent.style.opacity = '1';
  }

  requestAnimationFrame(() => {
    modal.dataset.allowClose = 'true';
    const firstInput = content.querySelector('input:not([type=hidden])');
    if (firstInput) firstInput.focus();
  });
}

function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
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

async function renderAccountModalContent(content) {
  if (tarnService.isLoggedIn()) {
    renderAccountPanel(content);
  } else {
    renderCreateAccountForm(content);
  }
}

// ============================================================================
// CREATE ACCOUNT FORM
// ============================================================================

function renderCreateAccountForm(content) {
  content.innerHTML = `
    <div class="account-form">
      <h2 style="margin:0 0 24px 0;font-size:1.5rem;font-weight:600;">Create Account</h2>

      <label class="form-label" for="acctEmail">Email</label>
      <input type="email" id="acctEmail" class="form-input" autocomplete="email" required />
      <div id="emailPreview" class="field-hint" style="min-height:18px;margin-bottom:12px;"></div>

      <label class="form-label" for="acctPassword">Password</label>
      <input type="password" id="acctPassword" class="form-input" minlength="8" autocomplete="new-password" required />
      <div id="strengthBar" class="strength-bar" style="margin:6px 0;height:4px;border-radius:2px;background:#333;">
        <div id="strengthFill" style="height:100%;border-radius:2px;width:0;transition:width .3s,background .3s;"></div>
      </div>
      <div id="strengthLabel" class="field-hint" style="min-height:18px;margin-bottom:12px;"></div>

      <label class="form-label" for="acctConfirmPassword">Confirm Password</label>
      <input type="password" id="acctConfirmPassword" class="form-input" autocomplete="new-password" required />
      <div id="confirmHint" class="field-hint" style="min-height:18px;margin-bottom:16px;"></div>

      <label class="consent-label" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:20px;cursor:pointer;">
        <input type="checkbox" id="recoveryConsent" style="margin-top:3px;" />
        <span style="font-size:.875rem;line-height:1.4;opacity:.85;">
          I understand that Bookish cannot recover my password. My data is encrypted with keys derived from my password.
        </span>
      </label>

      <button id="createAccountBtn" class="btn btn-primary" disabled style="width:100%;padding:12px;font-size:1rem;">
        Create Account
      </button>

      <div id="createError" class="error-message" style="margin-top:12px;display:none;"></div>
      <div id="createProgress" style="margin-top:12px;display:none;text-align:center;opacity:.7;"></div>

      <p style="margin-top:20px;text-align:center;font-size:.875rem;opacity:.7;">
        Already have an account?
        <a href="#" id="switchToSignIn" style="color:var(--accent,#3b82f6);text-decoration:none;">Sign in</a>
      </p>
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

  // Password strength
  passwordInput.addEventListener('input', () => {
    const pw = passwordInput.value;
    const fill = content.querySelector('#strengthFill');
    const label = content.querySelector('#strengthLabel');
    const strength = assessPasswordStrength(pw);
    fill.style.width = strength.pct + '%';
    fill.style.background = strength.color;
    label.textContent = strength.label;
    validate();
  });

  // Confirm match
  confirmInput.addEventListener('input', () => {
    const hint = content.querySelector('#confirmHint');
    if (confirmInput.value && confirmInput.value !== passwordInput.value) {
      hint.textContent = 'Passwords do not match';
      hint.style.color = '#ef4444';
    } else if (confirmInput.value) {
      hint.textContent = 'Passwords match';
      hint.style.color = '#22c55e';
    } else {
      hint.textContent = '';
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
    <div class="account-form">
      <h2 style="margin:0 0 24px 0;font-size:1.5rem;font-weight:600;">Sign In</h2>

      <label class="form-label" for="signInEmail">Email</label>
      <input type="email" id="signInEmail" class="form-input" autocomplete="email" required />

      <label class="form-label" for="signInPassword" style="margin-top:12px;">Password</label>
      <input type="password" id="signInPassword" class="form-input" autocomplete="current-password" required />

      <button id="signInBtn" class="btn btn-primary" disabled style="width:100%;padding:12px;font-size:1rem;margin-top:20px;">
        Sign In
      </button>

      <div id="signInError" class="error-message" style="margin-top:12px;display:none;"></div>
      <div id="signInProgress" style="margin-top:12px;display:none;text-align:center;opacity:.7;"></div>

      <p style="margin-top:20px;text-align:center;font-size:.875rem;opacity:.7;">
        Don't have an account?
        <a href="#" id="switchToCreate" style="color:var(--accent,#3b82f6);text-decoration:none;">Create one</a>
      </p>
    </div>
  `;

  const emailInput = content.querySelector('#signInEmail');
  const passwordInput = content.querySelector('#signInPassword');
  const signInBtn = content.querySelector('#signInBtn');
  const switchLink = content.querySelector('#switchToCreate');

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

  content.innerHTML = `
    <div class="account-panel">
      <h2 style="margin:0 0 24px 0;font-size:1.5rem;font-weight:600;">Account</h2>

      <div class="account-info" style="margin-bottom:24px;">
        <div class="info-row" style="margin-bottom:12px;">
          <span class="info-label" style="opacity:.6;font-size:.875rem;">Email</span>
          <span class="info-value">${email}</span>
        </div>
        <div class="info-row" style="margin-bottom:12px;">
          <span class="info-label" style="opacity:.6;font-size:.875rem;">Display Name</span>
          <span id="displayNameValue" class="info-value">${displayName}</span>
          <button id="editDisplayNameBtn" class="btn-link" style="font-size:.875rem;margin-left:8px;">Edit</button>
        </div>
      </div>

      <div style="border-top:1px solid rgba(255,255,255,.1);padding-top:16px;margin-bottom:16px;">
        <button id="exportCsvBtn" class="btn btn-secondary" style="width:100%;margin-bottom:8px;">
          Export Books (CSV)
        </button>
        <button id="logoutBtn" class="btn btn-danger" style="width:100%;">
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

    valueEl.innerHTML = `<input type="text" id="displayNameInput" class="form-input" value="${current}" style="width:160px;padding:4px 8px;" />`;
    editBtn.textContent = 'Save';

    const input = content.querySelector('#displayNameInput');
    input.focus();
    input.select();

    const save = () => {
      const newName = input.value.trim() || current;
      tarnService.displayName(newName);
      valueEl.textContent = newName;
      editBtn.textContent = 'Edit';
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
  if (!password) return { pct: 0, label: '', color: '#333' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score <= 1) return { pct: 20, label: 'Weak', color: '#ef4444' };
  if (score === 2) return { pct: 40, label: 'Fair', color: '#f59e0b' };
  if (score === 3) return { pct: 60, label: 'Good', color: '#eab308' };
  if (score === 4) return { pct: 80, label: 'Strong', color: '#22c55e' };
  return { pct: 100, label: 'Very Strong', color: '#10b981' };
}

// Expose for app.js
window.accountUI = {
  openAccountModal,
  handleSignIn: () => {
    const content = document.getElementById('accountModalContent');
    if (content) renderSignInForm(content);
    openAccountModal();
  },
};
