// account_credentials_flow.js - Unified username/password credential-change UI.

import { truncateCredentialId } from './account_passkey_settings.js';

const SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function noop() {}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function defaultCreateOverlay(extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'security-overlay';
  if (extraClass) overlay.classList.add(extraClass);
  return overlay;
}

/**
 * Start the Change credentials flow. Renders a modal with current-password,
 * new-username (pre-filled), new-password, and confirm-new-password fields.
 * Save is disabled until at least one field differs from initial values.
 *
 * On success: clears password inputs, closes the modal, toasts, and re-renders
 * the Account panel so the header reflects any new email.
 *
 * @param {HTMLElement} content - The Account panel container.
 */
export async function startChangeCredentialsFlow(content, deps = {}) {
  const {
    getCurrentEmail = () => '',
    renderAccountPanel = noop,
    onWarn = noop,
  } = deps;
  const currentEmail = getCurrentEmail() || '';
  await openChangeCredentialsDialog({
    currentEmail,
    onSuccess: async () => {
      try { renderAccountPanel(content); } catch (err) {
        onWarn('[AccountUI] panel refresh after credentials change failed:', err?.message || err);
      }
      showChangeCredentialsToast(content, 'Sign-in credentials updated.', deps);
    },
  }, deps);
}

/**
 * Open the Change-credentials modal. Returns when the user dismisses
 * (cancel / backdrop / success). On success, `onSuccess` is awaited before
 * the overlay tears down so the panel re-render lands before the modal
 * disappears.
 *
 * @param {{
 *   currentEmail: string,
 *   onSuccess: () => Promise<void> | void,
 * }} opts
 * @returns {Promise<void>}
 */
export function openChangeCredentialsDialog({ currentEmail, onSuccess }, deps = {}) {
  const {
    changeCredentials,
    createOverlay = defaultCreateOverlay,
    requestAnimationFrameImpl = globalThis.requestAnimationFrame,
    showPasskeyTapPrompt = showPasskeyTapPromptOverlay,
    onWarn = noop,
  } = deps;
  return new Promise((resolve) => {
    const overlay = createOverlay('change-credentials-overlay');
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true" aria-labelledby="changeCredentialsTitle">
        <h2 class="security-overlay-title" id="changeCredentialsTitle">Change username or password</h2>
        <p class="security-overlay-body">Your username and password together let you sign in. Change either field, or both &mdash; leave anything you don&rsquo;t want to change as-is.</p>
        <div class="form-group">
          <label for="ccCurrentPassword">Current password</label>
          <div class="password-field">
            <input type="password" id="ccCurrentPassword" autocomplete="current-password" placeholder="Your current password" />
            <button type="button" class="password-toggle" data-toggle-for="ccCurrentPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="form-group">
          <label for="ccNewUsername">New username</label>
          <input type="email" id="ccNewUsername" autocomplete="email" />
          <p class="form-hint" id="ccPasskeyOnlyHint" style="display:none;">Passkey sessions don&rsquo;t have a cached username. Enter one to change credentials.</p>
        </div>
        <div class="form-group">
          <label for="ccNewPassword">New password</label>
          <div class="password-field">
            <input type="password" id="ccNewPassword" autocomplete="new-password" placeholder="Leave blank to keep current" />
            <button type="button" class="password-toggle" data-toggle-for="ccNewPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="form-group" id="ccConfirmGroup" style="display:none;">
          <label for="ccConfirmPassword">Confirm new password</label>
          <div class="password-field">
            <input type="password" id="ccConfirmPassword" autocomplete="new-password" />
            <button type="button" class="password-toggle" data-toggle-for="ccConfirmPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="security-overlay-error" data-error style="display:none;"></div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm disabled>Save changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.querySelector('.security-overlay-card');
    const currentPwInput = overlay.querySelector('#ccCurrentPassword');
    const newUsernameInput = overlay.querySelector('#ccNewUsername');
    const newPwInput = overlay.querySelector('#ccNewPassword');
    const confirmPwInput = overlay.querySelector('#ccConfirmPassword');
    const confirmGroup = overlay.querySelector('#ccConfirmGroup');
    const errorEl = overlay.querySelector('[data-error]');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    // Passkey-only sessions (#224) land here with `currentEmail === ''`. Pre-
    // filling an empty value leaves Save disabled with no UI hint, which
    // looks broken. Switch to a placeholder + inline note so the user knows
    // why the field is empty and what they need to do.
    const passkeyOnly = !currentEmail;
    if (passkeyOnly) {
      newUsernameInput.placeholder = 'Enter a username';
      const hint = overlay.querySelector('#ccPasskeyOnlyHint');
      if (hint) hint.style.display = '';
    } else {
      newUsernameInput.value = currentEmail;
    }
    const initialUsername = currentEmail;

    const clearPasswordsFromDom = () => {
      currentPwInput.value = '';
      newPwInput.value = '';
      confirmPwInput.value = '';
    };

    const cleanup = () => {
      clearPasswordsFromDom();
      overlay.remove();
      resolve();
    };

    const recomputeEnable = () => {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      const newPwHasContent = newPwInput.value.length > 0;
      confirmGroup.style.display = newPwHasContent ? '' : 'none';
      if (!newPwHasContent) confirmPwInput.value = '';

      const usernameChanged = newUsernameInput.value !== initialUsername;
      const passwordChanged = newPwHasContent;
      const anyChange = usernameChanged || passwordChanged;
      const haveCurrentPw = currentPwInput.value.length > 0;
      confirmBtn.disabled = !(anyChange && haveCurrentPw);
    };

    [currentPwInput, newUsernameInput, newPwInput, confirmPwInput].forEach(el => {
      el.addEventListener('input', recomputeEnable);
    });

    overlay.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-toggle-for');
        const target = overlay.querySelector('#' + targetId);
        if (!target) return;
        const showing = target.type === 'text';
        target.type = showing ? 'password' : 'text';
        btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
      });
    });

    cancelBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    card.addEventListener('click', (e) => e.stopPropagation());

    [currentPwInput, newUsernameInput, newPwInput, confirmPwInput].forEach(el => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) {
          e.preventDefault();
          confirmBtn.click();
        }
      });
    });

    confirmBtn.addEventListener('click', async () => {
      const currentPassword = currentPwInput.value;
      const newUsernameRaw = newUsernameInput.value.trim();
      const newPasswordRaw = newPwInput.value;
      const confirmPasswordRaw = confirmPwInput.value;

      if (newPasswordRaw && newPasswordRaw !== confirmPasswordRaw) {
        errorEl.textContent = "New passwords don't match.";
        errorEl.style.display = 'block';
        return;
      }

      const usernameChanged = newUsernameRaw !== initialUsername;
      const passwordChanged = newPasswordRaw.length > 0;
      if (!usernameChanged && !passwordChanged) {
        errorEl.textContent = 'Nothing to change.';
        errorEl.style.display = 'block';
        return;
      }

      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      errorEl.style.display = 'none';
      errorEl.textContent = '';

      let passkeyCancelled = false;
      const passkeyTapHandler = async ({ credentialId, deviceLabel }) => {
        const confirmed = await showPasskeyTapPrompt({
          deviceLabel: deviceLabel || truncateCredentialId(credentialId),
        }, deps);
        if (!confirmed) {
          passkeyCancelled = true;
          throw new Error('User cancelled passkey re-tap');
        }
        return true;
      };

      try {
        await changeCredentials({
          currentPassword,
          newUsername: usernameChanged ? newUsernameRaw : undefined,
          newPassword: passwordChanged ? newPasswordRaw : undefined,
          passkeyTapHandler,
        });
        if (passkeyCancelled) {
          errorEl.textContent = "Couldn't confirm all your passkeys. Try again when you have access to them.";
          errorEl.style.display = 'block';
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          clearPasswordsFromDom();
          try { await onSuccess(); } catch (err) {
            onWarn('[AccountUI] onSuccess after partial passkey re-tap failed:', err?.message || err);
          }
          return;
        }
        clearPasswordsFromDom();
        try { await onSuccess(); } catch (err) {
          onWarn('[AccountUI] onSuccess after credentials change failed:', err?.message || err);
        }
        overlay.remove();
        resolve();
      } catch (err) {
        onWarn('[AccountUI] changeCredentials failed:', err?.message || err);
        errorEl.textContent = humanizeCredentialChangeError(err);
        errorEl.style.display = 'block';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        clearPasswordsFromDom();
      }
    });

    requestAnimationFrameImpl(() => currentPwInput.focus({ preventScroll: true }));
  });
}

/**
 * Per-credential passkey-tap prompt. Renders a small overlay above the
 * credentials-change modal asking the user to confirm tapping the specified
 * device's passkey; resolves true on confirm, false on cancel/backdrop.
 *
 * @param {{ deviceLabel: string }} opts
 * @returns {Promise<boolean>}
 */
export function showPasskeyTapPromptOverlay({ deviceLabel }, deps = {}) {
  const {
    createOverlay = defaultCreateOverlay,
    requestAnimationFrameImpl = globalThis.requestAnimationFrame,
  } = deps;
  return new Promise((resolve) => {
    const overlay = createOverlay('passkey-tap-overlay');
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">Confirm your passkey</h2>
        <p class="security-overlay-body">Tap your <strong>${escapeHtml(deviceLabel)}</strong> passkey so it keeps working with your new sign-in.</p>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Skip this passkey</button>
          <button type="button" class="btn primary" data-confirm>Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.security-overlay-card');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrameImpl(() => confirmBtn.focus({ preventScroll: true }));
  });
}

/**
 * Show a transient success toast after a successful credential change.
 * Re-uses the passkey-success affirmation rendering for visual consistency,
 * but as a sibling above the credentials block so it sits in-section.
 */
export function showChangeCredentialsToast(content, message, deps = {}) {
  const {
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = deps;
  const block = content.querySelector('#accountCredentialsBlock');
  if (!block) return;
  let el = content.querySelector('.account-credentials-success');
  if (!el) {
    el = document.createElement('div');
    el.className = 'account-credentials-success account-passkeys-success';
    el.setAttribute('role', 'status');
    block.insertBefore(el, block.firstChild);
  }
  el.textContent = '\u2713 ' + message;
  el.style.display = 'block';
  if (el._dismissTimer) clearTimeoutImpl(el._dismissTimer);
  el._dismissTimer = setTimeoutImpl(() => {
    el.style.display = 'none';
    el._dismissTimer = null;
  }, 3500);
}

/**
 * Translate an SDK error from the unified `changeCredentials` flow into a
 * user-facing string.
 */
export function humanizeCredentialChangeError(err) {
  const msg = err?.message || '';
  if (
    /new_credential_lookup_key.*already in use/i.test(msg) ||
    /credential_lookup_key.*409/i.test(msg) ||
    /409/.test(msg) && /lookup/i.test(msg) ||
    /credential.*conflict|lookup.*conflict|combination.*in use|conflict.*credential/i.test(msg)
  ) {
    return 'That username and password combination is already in use. Try a different password.';
  }
  if (/no_account_key_stored/i.test(msg)) {
    return "Your account key isn't stored on our servers. Contact support if you need to change credentials.";
  }
  if (/passkeyTapHandler/i.test(msg)) {
    return "Couldn't confirm all your passkeys. Try again when you have access to them.";
  }
  if (/step-up|challenge|wrong password|invalid password|credential/i.test(msg)) {
    return 'Current password is incorrect.';
  }
  if (/network|fetch|timeout|offline/i.test(msg)) {
    return "Couldn't reach our servers. Check your connection and try again.";
  }
  return "Couldn't update credentials. Try again.";
}
