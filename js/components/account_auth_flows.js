// account_auth_flows.js - Signed-out account auth form rendering and wiring.

const SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_SHIELD = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;
const SVG_USER = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const SVG_FINGERPRINT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.44-.05 2"/></svg>`;

const DEFAULT_BOOKISH_API = globalThis.window?.BOOKISH_API_URL || 'https://bookish-api.bookish.workers.dev';

function noop() {}

function wirePasswordToggles(root) {
  root.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });
  });
}

function cleanDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function optionalMethod(obj, name) {
  return Object.prototype.hasOwnProperty.call(obj || {}, name) && typeof obj[name] === 'function'
    ? obj[name]
    : null;
}

async function hydrateSignedInDisplayName(tarnService, fallback) {
  const hydrateDisplayName = optionalMethod(tarnService, 'hydrateDisplayName');
  const setDisplayName = optionalMethod(tarnService, 'displayName');
  if (hydrateDisplayName) {
    await hydrateDisplayName(fallback ? { fallback } : {});
    return;
  }
  if (fallback && setDisplayName) {
    setDisplayName(fallback);
  }
}

const NEEDS_PROVISIONING_KEY = 'bookish.needsProvisioning';

// Heal accounts whose free-tier rule provisioning failed at signup: the signup
// flow stashes {email, dataLookupKey} under NEEDS_PROVISIONING_KEY when all
// three /api/register attempts fail. Called fire-and-forget at app boot for
// signed-in users; clears the stash only once provisioning succeeds.
export async function retryPendingProvisioning({
  bookishApiUrl = DEFAULT_BOOKISH_API,
  fetchImpl = globalThis.fetch,
  onWarn = noop,
  storage = globalThis.localStorage,
  delay = undefined,
} = {}) {
  let pending = null;
  try {
    pending = JSON.parse(storage?.getItem(NEEDS_PROVISIONING_KEY) || 'null');
  } catch {
    return false;
  }
  if (!pending?.email || !pending?.dataLookupKey) return false;

  const ok = await provisionBookishAccount({
    email: pending.email,
    dataLookupKey: pending.dataLookupKey,
    bookishApiUrl,
    fetchImpl,
    onWarn,
    ...(delay ? { delay } : {}),
  });
  if (ok) {
    try { storage?.removeItem(NEEDS_PROVISIONING_KEY); } catch { /* ignore */ }
    onWarn('[AccountUI] Deferred provisioning succeeded');
  }
  return ok;
}

export async function provisionBookishAccount({
  email,
  dataLookupKey,
  bookishApiUrl = DEFAULT_BOOKISH_API,
  fetchImpl = globalThis.fetch,
  onWarn = noop,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${bookishApiUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, dataLookupKey }),
      });
      if (res.ok) return true;
      onWarn(`[AccountUI] Provisioning attempt ${attempt} failed: ${res.status}`);
    } catch (apiErr) {
      onWarn(`[AccountUI] Provisioning attempt ${attempt} failed:`, apiErr.message);
    }
    if (attempt < 3) await delay(1000 * attempt);
  }
  return false;
}

export function renderCreateAccountForm(content, deps = {}) {
  const {
    tarnService,
    bookishApiUrl = DEFAULT_BOOKISH_API,
    fetchImpl = globalThis.fetch,
    onCreated = noop,
    onSwitchToSignIn = noop,
    onWarn = noop,
    onError = noop,
    provisionAccount = provisionBookishAccount,
  } = deps;

  content.innerHTML = `
    <div class="auth-form auth-form-create">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>Create Your Account</h2>
        <p>Private, permanent, yours.</p>
      </div>

      <div class="form-group">
        <label for="acctEmail">Email</label>
        <input type="email" id="acctEmail" autocomplete="email" placeholder="you@example.com" required />
        <span class="field-hint" id="emailPreview"></span>
      </div>

      <div class="form-group">
        <label for="acctDisplayName">Display name</label>
        <input type="text" id="acctDisplayName" autocomplete="name" maxlength="64" placeholder="What friends will see" />
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
        Your reading list is private \u2014 even Bookish can't read it or reset your password. After signup we'll show you a 24-word account key. You can view it again any time in Settings.
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
  const displayNameInput = content.querySelector('#acctDisplayName');
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

  emailInput.addEventListener('blur', () => {
    const preview = content.querySelector('#emailPreview');
    const normalized = emailInput.value.trim().toLowerCase();
    if (normalized && normalized !== emailInput.value.trim()) {
      preview.textContent = `Will be stored as: ${normalized}`;
    } else {
      preview.textContent = '';
    }
  });

  wirePasswordToggles(content);

  passwordInput.addEventListener('input', () => {
    const fill = content.querySelector('#strengthFill');
    const label = content.querySelector('#strengthLabel');
    const strength = assessPasswordStrength(passwordInput.value);
    fill.style.width = strength.pct + '%';
    fill.className = 'strength-fill ' + strength.cls;
    label.textContent = strength.label;
    label.className = 'strength-label ' + strength.cls;
    validate();
  });

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

  createBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();
    const displayName = cleanDisplayName(displayNameInput.value);
    const password = passwordInput.value;

    createBtn.disabled = true;
    const progress = content.querySelector('#createProgress');
    const error = content.querySelector('#createError');
    error.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = 'Creating account...';

    try {
      progress.textContent = 'Deriving encryption keys...';
      const reg = await tarnService.register(email, password);
      const { dataLookupKey, accountKey } = reg;

      progress.textContent = 'Setting up your account...';
      const provisioned = await provisionAccount({
        email,
        dataLookupKey,
        bookishApiUrl,
        fetchImpl,
        onWarn,
      });

      if (!provisioned) {
        globalThis.localStorage?.setItem(NEEDS_PROVISIONING_KEY, JSON.stringify({ email, dataLookupKey }));
        onWarn('[AccountUI] Provisioning failed after 3 attempts - will retry later');
      }

      await onCreated({ email, displayName, dataLookupKey, accountKey, provisioned });
    } catch (e) {
      onError('[AccountUI] Registration failed:', e);
      let msg = e.message || 'Registration failed. Please try again.';
      if (e.message?.includes('already in use')) msg = 'An account with this email already exists. Try signing in.';
      error.style.display = 'block';
      error.textContent = msg;
      progress.style.display = 'none';
      createBtn.disabled = false;
    }
  });

  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    onSwitchToSignIn();
  });
}

export function renderSignInForm(content, deps = {}) {
  const {
    tarnService,
    getPasskeysSupported = async () => false,
    onSignedIn = noop,
    onSwitchToCreate = noop,
    onError = noop,
  } = deps;

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

      <div class="auth-or-divider" id="signInOrDivider" style="display:none;"><span>or</span></div>

      <button id="signInPasskeyBtn" class="btn secondary auth-submit auth-passkey-btn" type="button" style="display:none;">
        ${SVG_FINGERPRINT}<span>Sign in with passkey</span>
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
  const passkeyBtn = content.querySelector('#signInPasskeyBtn');
  const switchLink = content.querySelector('#switchToCreate');

  wirePasswordToggles(content);

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
    if (passkeyBtn) passkeyBtn.disabled = true;
    const progress = content.querySelector('#signInProgress');
    const error = content.querySelector('#signInError');
    error.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = 'Signing in...';

    try {
      progress.textContent = 'Deriving encryption keys...';
      await tarnService.login(email, password);
      await hydrateSignedInDisplayName(tarnService, email.split('@')[0]);
      progress.textContent = 'Signed in!';
      onSignedIn();
    } catch (e) {
      onError('[AccountUI] Sign in failed:', e);
      let msg = 'Sign in failed. Please check your email and password.';
      if (e.message?.includes('not found')) msg = 'Account not found. Check your email address.';
      else if (e instanceof TypeError || /fetch|network|load failed/i.test(e.message || '')) {
        msg = 'Couldn’t reach the server. Check your connection and try again.';
      }
      error.style.display = 'block';
      error.textContent = msg;
      progress.style.display = 'none';
      signInBtn.disabled = false;
      if (passkeyBtn) passkeyBtn.disabled = false;
    }
  });

  passkeyBtn.addEventListener('click', async () => {
    const progress = content.querySelector('#signInProgress');
    const error = content.querySelector('#signInError');
    error.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = 'Authenticating\u2026';
    passkeyBtn.disabled = true;
    signInBtn.disabled = true;

    const typedEmail = emailInput.value.trim().toLowerCase();

    try {
      await tarnService.authenticateWithPasskey({
        stalePasskeyHandler: () => promptStalePasskeyRepair(content),
      });

      if (typedEmail && typedEmail.includes('@')) {
        await hydrateSignedInDisplayName(tarnService, typedEmail.split('@')[0]);
      } else {
        await hydrateSignedInDisplayName(tarnService);
      }

      progress.textContent = 'Signed in!';
      onSignedIn();
    } catch (e) {
      onError('[AccountUI] Passkey sign-in failed:', e);
      renderSignInForm(content, deps);
      const errEl = content.querySelector('#signInError');
      if (errEl) {
        errEl.style.display = 'block';
        errEl.textContent = humanizePasskeySigninError(e);
      }
    }
  });

  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    onSwitchToCreate();
  });

  getPasskeysSupported().then((supported) => {
    if (!supported) return;
    const btn = content.querySelector('#signInPasskeyBtn');
    const div = content.querySelector('#signInOrDivider');
    if (btn) btn.style.display = '';
    if (div) div.style.display = '';
  }).catch(() => {});
}

export function promptStalePasskeyRepair(content) {
  return new Promise((resolve) => {
    content.innerHTML = `
      <div class="auth-form">
        <div class="auth-header">
          <div class="auth-icon">${SVG_SHIELD}</div>
          <h2>Just a moment</h2>
          <p>We need to confirm it's you to keep this device signed in. Enter your email and password \u2014 this only happens occasionally.</p>
        </div>

        <div class="form-group">
          <label for="staleRepairEmail">Email</label>
          <input type="email" id="staleRepairEmail" autocomplete="email" placeholder="you@example.com" required />
        </div>

        <div class="form-group">
          <label for="staleRepairPassword">Password</label>
          <div class="password-field">
            <input type="password" id="staleRepairPassword" autocomplete="current-password" placeholder="Your password" required />
            <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>

        <button id="staleRepairBtn" class="btn primary auth-submit" disabled>
          Continue
        </button>

        <div class="auth-switch">
          <button type="button" class="btn-link" id="staleRepairCancel">Cancel</button>
        </div>
      </div>
    `;

    const emailInput = content.querySelector('#staleRepairEmail');
    const pwInput = content.querySelector('#staleRepairPassword');
    const btn = content.querySelector('#staleRepairBtn');
    const cancelLink = content.querySelector('#staleRepairCancel');

    wirePasswordToggles(content);

    const validate = () => {
      btn.disabled = !(emailInput.value.trim() && pwInput.value.length >= 1);
    };
    emailInput.addEventListener('input', validate);
    pwInput.addEventListener('input', validate);

    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      try { pwInput.value = ''; } catch {}
      resolve(val);
    };

    btn.addEventListener('click', () => {
      const username = emailInput.value.trim().toLowerCase();
      const password = pwInput.value;
      if (!username || !password) return;
      finish({ username, password });
    });

    cancelLink.addEventListener('click', () => {
      finish(null);
    });
  });
}

export function humanizePasskeySigninError(err) {
  const msg = err?.message || '';
  const name = err?.name || '';

  if (name === 'StalePasskeyError' || /StalePasskeyError/i.test(msg)) {
    return 'Sign-in cancelled.';
  }

  if (name === 'NotAllowedError' || /not allowed|user cancelled|user canceled|cancelled by user/i.test(msg)) {
    return 'Passkey sign-in was cancelled. Try again or sign in with your password.';
  }

  if (
    /no credentials|no passkey|no registered|credential not found|no_credentials_found|options failed/i.test(msg)
  ) {
    return "We couldn't find a passkey on this device. Sign in with your password to add one.";
  }

  if (
    name === 'TypeError' && /failed to fetch|network|load failed/i.test(msg) ||
    /network|fetch|offline/i.test(msg)
  ) {
    return "We couldn't reach the server. Check your connection and try again.";
  }

  return "Passkey sign-in didn't work. Try again or sign in with your password.";
}

export function assessPasswordStrength(password) {
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
