// account_ui.js - Clean account management UI orchestrator
// Coordinates between: account_creation, credential_core, credential_mapping, account_arweave
// Clear separation: creation → email+password auth → persistence on funding

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import { resetKeyState } from './app.js';
import { uploadAccountMetadata, downloadAccountMetadata } from './core/account_arweave.js';
import { deriveAndStoreSymmetricKey, hexToBytes, storeSessionEncryptedSeed, getSessionEncryptedSeed, clearSessionEncryptedSeed, importAesKey, bytesToBase64, base64ToBytes } from './core/crypto_core.js';
import { ACCOUNT_STORAGE_KEY, SEED_SHOWN_KEY, CREDENTIAL_STORAGE_KEY, PENDING_CREDENTIAL_MAPPING_KEY } from './core/storage_constants.js';
import * as storageManager from './core/storage_manager.js';
import { openOnrampWidget, isCoinbaseOnrampConfigured } from './core/coinbase_onramp.js';
import { formatBalanceAsBooks, getBalanceStatus } from './core/balance_display.js';
import { requestFaucetFunding, isEligibleForFaucet } from './core/faucet_client.js';
import { deriveCredentialKeys, normalizeUsername, encryptCredentialPayload, decryptCredentialPayload, assessPasswordStrength, isValidEmail } from './core/credential_core.js';
import { uploadCredentialMapping, downloadCredentialMapping, credentialMappingExists } from './core/credential_mapping.js';

// Global state
let currentBalanceETH = null;

// Transient state for UI status manager
const transientState = {
  justSignedIn: false,
  signInTime: 0,
  justCreated: false,
  createdTime: 0,
  faucetResult: null, // 'funded', 'failed', 'skipped', or null
  faucetTxHash: null,
  faucetSkipped: false
};



/**
 * Get account status for UI status manager
 * @returns {Object} { isLoggedIn, isPersisted, justSignedIn, signInTime, justCreated, createdTime }
 */
export function getAccountStatus() {
  const isLoggedIn = storageManager.isLoggedIn();
  const isPersisted = storageManager.isAccountPersisted();

  return {
    isLoggedIn,
    isPersisted,
    justSignedIn: transientState.justSignedIn,
    signInTime: transientState.signInTime,
    justCreated: transientState.justCreated,
    createdTime: transientState.createdTime
  };
}

/**
 * Initialize account UI on page load
 */
export async function initAccountUI() {
  console.log('[Bookish:AccountUI] Initializing...');

  // If user is currently logged in, mark that they've had an account
  // (persists across logout to suppress first-timer nudges)
  if (storageManager.isLoggedIn()) {
    localStorage.setItem('bookish.hasHadAccount', 'true');
  }

  // Coinbase Pay requires no configuration - always available via direct link

  // Setup modal event listeners
  setupAccountModalListeners();

}

/**
 * Open account modal
 */
export async function openAccountModal() {
  const modal = document.getElementById('accountModal');
  const content = document.getElementById('accountModalContent');
  if (!modal || !content) {
    console.warn('[Bookish:AccountUI] Account modal not found', { modal: !!modal, content: !!content });
    return;
  }

  // Prevent backdrop clicks for a short time after opening
  modal.dataset.allowClose = 'false';

  try {
    console.log('[Bookish:AccountUI] Opening account modal...');

    // Render content (await since it's async)
    await renderAccountModalContent(content);
    console.log('[Bookish:AccountUI] Content rendered, innerHTML length:', content.innerHTML.length);

    // Show modal
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Ensure modal content is visible
    const modalContent = modal.querySelector('.account-modal');
    if (modalContent) {
      modalContent.style.visibility = 'visible';
      modalContent.style.opacity = '1';
      modalContent.style.display = 'block';
    }

    // Force a reflow to ensure display:flex is applied
    void modal.offsetHeight;

    // Animate in
    requestAnimationFrame(() => {
      modal.classList.add('open');
      console.log('[Bookish:AccountUI] Modal opened, classList:', modal.classList.toString());
      console.log('[Bookish:AccountUI] Modal content element:', modalContent, 'display:', modalContent?.style.display, 'visibility:', modalContent?.style.visibility);

      // Allow backdrop clicks after animation starts
      setTimeout(() => {
        modal.dataset.allowClose = 'true';
      }, 100);
    });
  } catch (error) {
    console.error('[Bookish:AccountUI] Error opening account modal:', error);
    console.error('[Bookish:AccountUI] Error stack:', error.stack);
    // Close modal on error
    modal.style.display = 'none';
    document.body.style.overflow = '';
    modal.dataset.allowClose = 'true';
  }
}

/**
 * Close account modal
 */
export function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  console.log('[Bookish:AccountUI] Closing account modal');
  modal.classList.remove('open');
  document.body.style.overflow = '';

  // Wait for animation before hiding
  setTimeout(() => {
    modal.style.display = 'none';
    // Clear backdrop listener flag so it can be reattached next time
    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.dataset.listenerAttached = '';
    }
  }, 200);
}

/**
 * Render account modal content
 */
async function renderAccountModalContent(container) {
  try {
    const isLoggedIn = storageManager.isLoggedIn();
    console.log('[Bookish:AccountUI] Rendering modal content, isLoggedIn:', isLoggedIn);

    if (isLoggedIn) {
      let walletInfo, persistenceState, persistenceIndicator;

      try {
        walletInfo = await getStoredWalletInfo();
        console.log('[Bookish:AccountUI] Got wallet info:', !!walletInfo);
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting wallet info:', e);
        walletInfo = null;
      }

      const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
      let displayName = 'Anonymous';
      if (accountData) {
        try {
          const accountObj = JSON.parse(accountData);
          displayName = accountObj.displayName || 'Anonymous';
        } catch (e) {
          console.error('[Bookish:AccountUI] Failed to parse account data:', e);
        }
      }

      const address = walletInfo?.address || '';
      const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
      const fullAddress = address || '';

      // Get balance - use cached value from sync_manager for instant display
      let balanceText = 'Loading...';
      let balanceStatus = 'ok';
      let isFunded = false;
      const cachedBalance = window.bookishSyncManager?.getSyncStatus?.()?.currentBalanceETH;
      if (cachedBalance !== null && cachedBalance !== undefined) {
        const balance = parseFloat(cachedBalance);
        isFunded = balance >= 0.00002;
        balanceText = formatBalanceAsBooks(cachedBalance);
        balanceStatus = getBalanceStatus(cachedBalance);
      } else if (address) {
        // No cached balance - fetch in background, show Loading for now
        // Don't await - let modal open immediately
        import('./core/wallet_core.js').then(m => m.getWalletBalance(address)).then(result => {
          const el = document.getElementById('accountBalanceDisplay');
          if (el) {
            const balanceETH = result.balanceETH || '0';
            el.textContent = formatBalanceAsBooks(balanceETH);
            el.className = `balance-display balance-${getBalanceStatus(balanceETH)}`;
          }
        }).catch(e => {
          console.error('[Bookish:AccountUI] Error getting balance:', e);
          const el = document.getElementById('accountBalanceDisplay');
          if (el) el.textContent = 'Error';
        });
      }

      const accountObj = JSON.parse(accountData);
      const accountEmail = accountObj.email || '';

      // Check if account is backed up
      try {
        persistenceState = determineAccountPersistenceState();
        persistenceIndicator = getPersistenceIndicatorHTML(persistenceState);
        console.log('[Bookish:AccountUI] Got persistence state:', persistenceState);
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting persistence state:', e);
        persistenceState = 'local';
        persistenceIndicator = '';
      }
      const isBackedUp = persistenceState === 'confirmed';

      const displayNameSafe = (str) => (str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    container.innerHTML = `
      <h2>Your Account ${persistenceIndicator}</h2>

      <div class="account-info">
        <div class="account-name-row" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span>👤</span>
          <span id="accountDisplayNameText">${displayNameSafe(displayName)}</span>
          <button id="editDisplayNameBtn" type="button" aria-label="Edit name" style="background: none; border: none; color: #94a3b8; cursor: pointer; padding: 4px; font-size: 0.9rem;">✏️</button>
        </div>
        ${accountEmail ? `
          <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">${accountEmail}</div>
        ` : ''}
        <div class="account-balance" style="margin-top: 12px; font-size: 0.85rem;">
          Balance: <span id="accountBalanceDisplay" class="balance-display balance-${balanceStatus}">${balanceText}</span>
        </div>
      </div>

      <div class="account-actions" style="margin-top: 24px;">
        ${!isFunded ? `<p style="font-size: 0.8rem; color: #94a3b8; margin: 0 0 12px 0; line-height: 1.5;">Back up your books permanently. A penny a book, no subscription.</p>` : ''}
        ${(() => {
          const buttonText = !isFunded ? 'Add Cloud Credit' : 'Add Credit';
          return `<button id="enableBackupBtn" class="btn primary" style="width: 100%; margin-bottom: 12px;">${buttonText}</button>`;
        })()}
        <div style="display: flex; justify-content: center; gap: 16px; margin-top: 16px; font-size: 0.8rem;">
          <button id="viewRecoveryBtn" style="background: transparent; border: none; color: #64748b; cursor: pointer; text-decoration: underline; font-size: 0.8rem; padding: 4px;">Recovery Phrase</button>
          <button id="logoutBtn" style="background: transparent; border: none; color: #64748b; cursor: pointer; text-decoration: underline; font-size: 0.8rem; padding: 4px;">Sign Out</button>
        </div>
      </div>

      <div class="account-data-section" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #334155;">
        <h3 style="margin: 0 0 12px 0; font-size: 0.9rem; color: #94a3b8;">Your Data</h3>
        <button id="exportBooksBtn" type="button" class="btn secondary" style="width: 100%; margin-bottom: 8px;">📥 Export my books</button>
        <p style="font-size: 0.75rem; color: #64748b; margin: 4px 0 0 0; line-height: 1.5;">Export books from this device as CSV.</p>
        <a href="/forever.html" target="_blank" rel="noopener" style="font-size: 0.75rem; color: #60a5fa; display: inline-block; margin-top: 6px;">Export from cloud →</a>
      </div>
    `;

    // Setup event listeners for logged-in state
    document.getElementById('enableBackupBtn')?.addEventListener('click', () => {
      // DO NOT close account modal - open funding dialog on top
      handleBuyStorage();
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => {
      // Logout can close the modal (terminal action)
      closeAccountModal();
      handleLogout();
    });

    document.getElementById('viewRecoveryBtn')?.addEventListener('click', () => {
      // DO NOT close account modal - open recovery phrase view on top
      handleViewSeed();
    });

    setupDisplayNameEdit(displayName);
    setupExportBooksBtn();
  } else {
    container.innerHTML = `
      <h2>Account</h2>

      <p style="margin: 0 0 24px 0; line-height: 1.6; opacity: 0.9;">
        Your books, your data, on any device.
      </p>

      <div class="account-actions">
        <button id="createAccountBtn" class="btn primary" style="width: 100%;">Create Account</button>
      </div>

      <div class="auth-footer" style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #334155;">
        <div>Already have an account? <button class="link-btn" id="loginBtn">Sign in</button></div>
      </div>

      <div class="account-data-section" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #334155;">
        <h3 style="margin: 0 0 12px 0; font-size: 0.9rem; color: #94a3b8;">Your Data</h3>
        <button id="exportBooksBtn" type="button" class="btn secondary" style="width: 100%; margin-bottom: 8px;">📥 Export my books</button>
        <p style="font-size: 0.75rem; color: #64748b; margin: 4px 0 0 0; line-height: 1.5;">Export books from this device as CSV.</p>
      </div>
    `;

    // Setup event listeners for logged-out state
    document.getElementById('createAccountBtn')?.addEventListener('click', () => {
      closeAccountModal();
      handleCreateAccount();
    });

    document.getElementById('loginBtn')?.addEventListener('click', () => {
      closeAccountModal();
      handleSignIn();
    });

    setupExportBooksBtn();
  }
  } catch (error) {
    console.error('[Bookish:AccountUI] Error in renderAccountModalContent:', error);
    console.error('[Bookish:AccountUI] Error stack:', error.stack);
    // Render error state
    container.innerHTML = `
      <h2>Account</h2>
      <p style="color: #ef4444;">Error loading account information. Please try again.</p>
      <button onclick="window.location.reload()" class="btn primary">Reload Page</button>
    `;
    throw error; // Re-throw so openAccountModal can handle it
  }
}

/**
 * Setup account modal event listeners
 */
function setupAccountModalListeners() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  // Setup backdrop click handler (only once, use flag to prevent duplicates)
  const backdrop = modal.querySelector('.modal-backdrop');
  if (backdrop && !backdrop.dataset.listenerAttached) {
    backdrop.dataset.listenerAttached = 'true';
    backdrop.addEventListener('click', (e) => {
      // Only close if clicking the backdrop itself, not children, and if allowed
      const modal = document.getElementById('accountModal');
      if (modal && modal.dataset.allowClose === 'true' && e.target === backdrop) {
        console.log('[Bookish:AccountUI] Backdrop clicked, closing modal');
        e.stopPropagation();
        closeAccountModal();
      } else {
        console.log('[Bookish:AccountUI] Backdrop click ignored', { allowClose: modal?.dataset.allowClose, target: e.target, backdrop });
      }
    });
  }

  // Close on close button click
  const closeBtn = document.getElementById('accountModalClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeAccountModal);
  }

  // Close on Escape key (remove old handler first)
  const escHandler = (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeAccountModal();
    }
  };
  // Remove any existing handler
  document.removeEventListener('keydown', escHandler);
  document.addEventListener('keydown', escHandler);
}


/**
 * Update account section UI based on state
 * DEPRECATED: This function is no longer used. Account UI is now rendered in the modal via renderAccountModalContent().
 * Kept for backward compatibility but does nothing.
 */
async function updateAccountSection(section, isLoggedIn) {
  // Modal content is rendered dynamically when modal opens
  // No need to update a persistent section anymore
}

/**
 * Handle account creation - Email + Password flow
 * Frame A1: Email + Display Name + Password + Confirm Password form
 */
async function handleCreateAccount() {
  showAccountModal(`
    <div class="modal-content-enter" style="text-align:center;margin-bottom:16px;">
      <h3 style="margin:0;">Create Your Account</h3>
    </div>

    <form id="accountCreateForm" class="auth-form" autocomplete="on" novalidate>
      <div class="form-group">
        <label for="acctEmail">Email</label>
        <input type="email" id="acctEmail" autocomplete="email" placeholder="you@example.com" required>
        <span class="field-hint">This is your sign-in ID — we won't send you any emails.</span>
        <span class="field-preview" id="emailPreview" aria-live="polite"></span>
        <span class="field-error" id="emailError" role="alert"></span>
      </div>

      <div class="form-group">
        <label for="acctDisplayName">Display Name</label>
        <input type="text" id="acctDisplayName" placeholder="Your name" required>
      </div>

      <div class="form-group">
        <label for="acctPassword">Password</label>
        <div class="password-field">
          <input type="password" id="acctPassword" autocomplete="new-password" placeholder="At least 8 characters" required minlength="8">
          <button type="button" class="password-toggle" id="togglePassword1" aria-label="Show password">👁</button>
        </div>
        <div class="password-strength" aria-live="polite">
          <div class="strength-bar"><div class="strength-fill" id="strengthFill"></div></div>
          <span class="strength-label" id="strengthLabel"></span>
        </div>
      </div>

      <div class="form-group">
        <label for="acctConfirmPassword">Confirm Password</label>
        <div class="password-field">
          <input type="password" id="acctConfirmPassword" autocomplete="new-password" placeholder="Re-enter password" required>
          <button type="button" class="password-toggle" id="togglePassword2" aria-label="Show password">👁</button>
        </div>
        <span class="field-match" id="passwordMatch" aria-live="polite"></span>
      </div>

      <button type="submit" id="createAccountSubmitBtn" class="btn primary" style="width:100%;padding:14px 20px;margin-top:16px;" disabled>Create Account</button>
    </form>

    <div class="auth-footer">
      <div>Already have an account? <button class="link-btn" id="switchToSignIn">Sign in</button></div>
    </div>
  `, true);

  // Wire up form logic
  const emailInput = document.getElementById('acctEmail');
  const displayNameInput = document.getElementById('acctDisplayName');
  const passwordInput = document.getElementById('acctPassword');
  const confirmInput = document.getElementById('acctConfirmPassword');
  const submitBtn = document.getElementById('createAccountSubmitBtn');
  const emailPreview = document.getElementById('emailPreview');
  const emailError = document.getElementById('emailError');
  const strengthFill = document.getElementById('strengthFill');
  const strengthLabel = document.getElementById('strengthLabel');
  const passwordMatchEl = document.getElementById('passwordMatch');

  // Validate all fields and update submit button state
  function validateForm() {
    const emailOk = isValidEmail(emailInput.value);
    const nameOk = displayNameInput.value.trim().length > 0;
    const passOk = passwordInput.value.length >= 8;
    const matchOk = confirmInput.value.length > 0 && passwordInput.value === confirmInput.value;
    submitBtn.disabled = !(emailOk && nameOk && passOk && matchOk);
  }

  // Email normalization preview on blur
  emailInput.addEventListener('blur', () => {
    const val = emailInput.value.trim();
    if (val && isValidEmail(val)) {
      const normalized = normalizeUsername(val);
      emailPreview.innerHTML = `<span class="preview-arrow">►</span> Signing in as <strong>${normalized}</strong>`;
      emailError.classList.remove('visible');
      emailInput.classList.remove('field-invalid');
    } else if (val) {
      emailError.textContent = '✗ Please enter a valid email address';
      emailError.classList.add('visible');
      emailInput.classList.add('field-invalid');
      emailPreview.innerHTML = '';
    } else {
      emailPreview.innerHTML = '';
      emailError.classList.remove('visible');
      emailInput.classList.remove('field-invalid');
    }
    validateForm();
  });

  // Display name validation
  displayNameInput.addEventListener('input', validateForm);

  // Password strength indicator
  passwordInput.addEventListener('input', () => {
    const result = assessPasswordStrength(passwordInput.value);
    strengthFill.style.width = result.percent + '%';
    strengthLabel.textContent = result.label;

    // Reset classes
    strengthFill.className = 'strength-fill';
    strengthLabel.className = 'strength-label';

    if (result.score <= 1) {
      strengthFill.classList.add('strength-weak');
      strengthLabel.classList.add('strength-weak');
    } else if (result.score <= 3) {
      strengthFill.classList.add('strength-medium');
      strengthLabel.classList.add('strength-medium');
    } else {
      strengthFill.classList.add('strength-good');
      strengthLabel.classList.add('strength-good');
    }

    // Update confirm match if already typed
    if (confirmInput.value.length > 0) {
      updatePasswordMatch();
    }
    validateForm();
  });

  // Confirm password match
  function updatePasswordMatch() {
    if (confirmInput.value.length === 0) {
      passwordMatchEl.textContent = '';
      passwordMatchEl.className = 'field-match';
      return;
    }
    if (passwordInput.value === confirmInput.value) {
      passwordMatchEl.textContent = '✓ Passwords match';
      passwordMatchEl.className = 'field-match match-success';
    } else {
      passwordMatchEl.textContent = '✗ Passwords don\'t match';
      passwordMatchEl.className = 'field-match match-error';
    }
  }
  confirmInput.addEventListener('input', () => {
    updatePasswordMatch();
    validateForm();
  });
  confirmInput.addEventListener('blur', () => {
    updatePasswordMatch();
    validateForm();
  });

  // Password visibility toggles
  document.getElementById('togglePassword1').addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
    document.getElementById('togglePassword1').setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
  });
  document.getElementById('togglePassword2').addEventListener('click', () => {
    const type = confirmInput.type === 'password' ? 'text' : 'password';
    confirmInput.type = type;
    document.getElementById('togglePassword2').setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
  });

  // Switch to sign-in
  document.getElementById('switchToSignIn').addEventListener('click', () => {
    closeHelperModal();
    handleSignIn();
  });

  // Form submission
  document.getElementById('accountCreateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;

    const email = normalizeUsername(emailInput.value);
    const displayName = displayNameInput.value.trim();
    const password = passwordInput.value;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      await runAccountCreationFlow(email, displayName, password);
    } catch (error) {
      console.error('[Bookish:AccountUI] Account creation failed:', error);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account';
    }
  });

  // Enter key submission
  [emailInput, displayNameInput, passwordInput, confirmInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) {
        e.preventDefault();
        document.getElementById('accountCreateForm').dispatchEvent(new Event('submit'));
      }
    });
  });
}

/**
 * Run the full account creation flow (Frames A2-A6)
 * Called after form validation succeeds
 * @param {string} email - Normalized email
 * @param {string} displayName - User display name
 * @param {string} password - User password
 */
async function runAccountCreationFlow(email, displayName, password) {
  // Frame A2: Setting up - Creating account
  showAccountModal(`
    <div class="modal-content-enter" style="text-align:center;padding:20px 0;">
      <div style="font-size:2rem;margin-bottom:16px;">⏳</div>
      <h3 style="margin:0 0 16px 0;">Setting up your account...</h3>
      <div class="progress-steps">
        <div id="createStep1" class="progress-step active">
          <span class="step-icon">◐</span> <span>Creating account...</span>
        </div>
        <div id="createStep2" class="progress-step pending">
          <span class="step-icon">○</span> <span>Activating cloud storage</span>
        </div>
        <div id="createStep3" class="progress-step pending">
          <span class="step-icon">○</span> <span>Syncing to cloud</span>
        </div>
      </div>
      <p style="font-size:.875rem;line-height:1.6;color:var(--color-text-muted);margin:16px 0 0 0;">
        This usually takes just a moment.
      </p>
    </div>
  `, false);

  try {
    // Step 1a: Derive credential keys first (PBKDF2 - 0.5-3s)
    // Done before seed generation so we can check for duplicates
    const { lookupKey, encryptionKey } = await deriveCredentialKeys(email, password);

    // Step 1b: Check if an account already exists with these credentials
    // Same email + same password = same lookup key → would shadow existing account
    try {
      const existingMapping = await credentialMappingExists(lookupKey);
      if (existingMapping) {
        console.log('[Bookish:AccountUI] Credential mapping already exists for these credentials');
        // Show error and offer to sign in instead
        showAccountModal(`
          <div class="modal-content-enter" style="text-align:center;padding:20px 0;">
            <h3 style="margin:0 0 16px 0;">Account Already Exists</h3>
            <p style="font-size:.875rem;line-height:1.6;color:var(--color-text-secondary);margin:0 0 20px 0;">
              An account with this email and password already exists. Would you like to sign in instead?
            </p>
            <button id="goToSignInBtn" class="btn primary" style="width:100%;padding:14px 20px;margin-bottom:12px;">Sign In</button>
            <button id="backToCreateBtn" class="btn secondary" style="width:100%;padding:12px 20px;">Back to Create Account</button>
          </div>
        `);
        document.getElementById('goToSignInBtn').onclick = () => {
          closeHelperModal();
          handleSignIn();
        };
        document.getElementById('backToCreateBtn').onclick = () => {
          closeHelperModal();
          handleCreateAccount();
        };
        return;
      }
    } catch (checkErr) {
      // Network error checking existence — continue with creation
      // (if the mapping truly exists, the user will just end up with a shadowed account,
      // but this is better than blocking creation when Arweave is temporarily unreachable)
      console.warn('[Bookish:AccountUI] Could not check for existing mapping (continuing):', checkErr.message);
    }

    // Step 1c: Create account locally (generate new seed)
    const { createNewAccount } = await import('./core/account_creation.js');
    const account = await createNewAccount();
    console.log('[Bookish:AccountUI] Account created:', account.address);

    // Encrypt entire credential payload (seed + metadata) per spec
    const createdAt = Date.now();
    const encryptedPayload = await encryptCredentialPayload(
      { seed: account.seed, displayName, createdAt },
      encryptionKey
    );

    // Store everything locally
    await deriveAndStoreSymmetricKey(account.seed);
    await window.bookishWallet.ensure();
    await storeSessionEncryptedSeed(account.seed);

    // Store account info
    const accountData = {
      version: 2,
      derivation: 'credential',
      displayName,
      email,
      created: createdAt
    };
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));

    // Store credential metadata
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify({
      lookupKey
    }));

    // Persist pending credential mapping to localStorage (survives page reload)
    const pendingMapping = { lookupKey, encryptedPayloadB64: bytesToBase64(encryptedPayload) };
    localStorage.setItem(PENDING_CREDENTIAL_MAPPING_KEY, JSON.stringify(pendingMapping));

    // Mark step 1 complete
    updateProgressStep('createStep1', 'complete', '✓', 'Account created');
    updateProgressStep('createStep2', 'active', '◐', 'Activating cloud storage...');

    // Show skip button after 2 seconds
    setTimeout(() => {
      const skipBtn = document.getElementById('skipFaucetBtn');
      if (skipBtn) skipBtn.style.display = 'inline';
    }, 2000);

    // Add skip button (hidden initially)
    const progressSteps = document.querySelector('.progress-steps');
    if (progressSteps) {
      progressSteps.insertAdjacentHTML('afterend',
        '<div style="text-align:center;margin-top:12px;"><button id="skipFaucetBtn" class="btn-link" style="display:none;font-size:.875rem;color:var(--color-text-muted);text-decoration:underline;background:none;border:none;cursor:pointer;">Skip this step →</button></div>'
      );
      document.getElementById('skipFaucetBtn')?.addEventListener('click', () => {
        showCreationFallbackSuccess(displayName, email);
      });
    }

    // Step 2: Faucet funding (runs in parallel with fee-exempt uploads, awaited before sync)
    const address = await window.bookishWallet?.getAddress?.();

    const faucetPromise = address
      ? requestFaucetFunding(address, null, 3)
          .then(r => {
            transientState.faucetResult = r.success ? 'funded' : 'failed';
            transientState.faucetTxHash = r.txHash || null;
            console.log('[Bookish:AccountUI] Faucet completed:', r.success ? 'funded' : 'failed');
            return r;
          })
          .catch(e => {
            transientState.faucetResult = 'failed';
            console.warn('[Bookish:AccountUI] Faucet failed (non-fatal):', e.message);
            return { success: false };
          })
      : Promise.resolve({ success: false });

    // Step 3: Upload to Arweave (fee-exempt for account creation — no faucet dependency)
    updateProgressStep('createStep2', 'complete', '✓', 'Cloud storage activated');
    updateProgressStep('createStep3', 'active', '◐', 'Syncing to cloud...');

    // Update heading
    const heading = document.querySelector('#helperModal h3');
    if (heading) heading.textContent = 'Almost there...';

    // Hide skip button
    const skipBtn = document.getElementById('skipFaucetBtn');
    if (skipBtn) skipBtn.style.display = 'none';

    try {
      // Upload credential mapping (encrypted payload)
      const credTxId = await uploadCredentialMapping({
        lookupKey,
        encryptedPayload
      });
      console.log('[Bookish:AccountUI] Credential mapping uploaded:', credTxId);

      // Upload account metadata
      const symKeyHex = localStorage.getItem('bookish.sym');
      const symKeyBytes = hexToBytes(symKeyHex);
      const symKey = await importAesKey(symKeyBytes);
      const metaTxId = await uploadAccountMetadata({
        address,
        displayName,
        symKey,
        createdAt: accountData.created
      });
      console.log('[Bookish:AccountUI] Account metadata uploaded:', metaTxId);

      // Update local state with Arweave tx IDs
      const storedAccount = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY));
      storedAccount.arweaveTxId = metaTxId;
      storedAccount.credentialMappingTxId = credTxId;
      storedAccount.persistedAt = Date.now();
      localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(storedAccount));

      // Clean up pending mappings from localStorage
      localStorage.removeItem(PENDING_CREDENTIAL_MAPPING_KEY);

      // Await faucet confirmation before starting sync (fees require funded wallet)
      try {
        const faucetResult = await Promise.race([
          faucetPromise,
          new Promise(resolve => setTimeout(() => resolve({ success: false, timeout: true }), 20000))
        ]);

        if (faucetResult.success && faucetResult.confirmed) {
          console.log('[Bookish:AccountUI] Faucet confirmed on-chain, txHash:', faucetResult.txHash);
        } else if (faucetResult.success) {
          console.warn('[Bookish:AccountUI] Faucet sent but not confirmed, polling balance...');
          const { getWalletBalance } = await import('./core/wallet_core.js');
          for (let i = 0; i < 5; i++) {
            const { balanceETH, ok } = await getWalletBalance(address);
            if (ok && parseFloat(balanceETH) > 0) {
              console.log('[Bookish:AccountUI] Faucet confirmed via balance:', balanceETH);
              break;
            }
            console.log(`[Bookish:AccountUI] Balance poll ${i + 1}/5: ${balanceETH} (ok=${ok})`);
            await new Promise(r => setTimeout(r, 2000));
          }
        } else {
          console.warn('[Bookish:AccountUI] Faucet failed or timed out:', faucetResult);
        }
      } catch (e) {
        console.warn('[Bookish:AccountUI] Faucet await error (non-fatal):', e.message);
      }

      // Show full success (Frame A6)
      showCreationFullSuccess(displayName, email);
      startSync();

    } catch (uploadError) {
      console.error('[Bookish:AccountUI] Arweave upload failed:', uploadError);
      // Retry once
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const credTxId = await uploadCredentialMapping({ lookupKey, encryptedPayload });
        const symKeyHex = localStorage.getItem('bookish.sym');
        const symKeyBytes = hexToBytes(symKeyHex);
        const symKey = await importAesKey(symKeyBytes);
        const metaTxId = await uploadAccountMetadata({ address, displayName, symKey, createdAt: accountData.created });

        const storedAccount = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY));
        storedAccount.arweaveTxId = metaTxId;
        storedAccount.credentialMappingTxId = credTxId;
        storedAccount.persistedAt = Date.now();
        localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(storedAccount));
        localStorage.removeItem(PENDING_CREDENTIAL_MAPPING_KEY);

        showCreationFullSuccess(displayName, email);
        startSync();
      } catch (retryErr) {
        console.error('[Bookish:AccountUI] Retry failed:', retryErr);
        showCreationFallbackSuccess(displayName, email);
        startSync();
      }
    }

  } catch (error) {
    console.error('[Bookish:AccountUI] Account creation flow failed:', error);
    showAccountModal(`
      <div style="text-align:center;padding:20px 0;">
        <h3 style="margin:0 0 16px 0;">Something Went Wrong</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;">
          ${error.message || 'Account creation failed. Please try again.'}
        </p>
        <button id="retryCreateBtn" class="btn primary" style="width:100%;margin-top:20px;">Try Again</button>
      </div>
    `);
    document.getElementById('retryCreateBtn').onclick = () => {
      closeHelperModal();
      handleCreateAccount();
    };
  }
}

/**
 * Helper: Update a progress step element
 */
function updateProgressStep(stepId, state, icon, text) {
  const step = document.getElementById(stepId);
  if (!step) return;
  step.className = `progress-step ${state}`;
  step.querySelector('.step-icon').textContent = icon;
  step.querySelector('span:last-child').textContent = text;
}

/**
 * Frame A6: Full success - everything uploaded to Arweave
 */
function showCreationFullSuccess(displayName, email) {
  transientState.justCreated = true;
  transientState.createdTime = Date.now();
  setTimeout(() => { transientState.justCreated = false; uiStatusManager.refresh(); }, 3000);

  showAccountModal(`
    <div class="modal-content-enter" style="text-align:center;padding:20px 0;">
      <div class="success-check-animated" style="margin-bottom:16px;">✓</div>
      <h3 style="margin:0 0 12px 0;">You're all set, ${displayName}!</h3>
      <p style="font-size:.875rem;line-height:1.6;color:var(--color-text-secondary);margin:0 0 16px 0;">
        Sign in on any device with your email and password.
      </p>
      <div class="success-status-list">
        <div class="status-item"><span class="status-dot"></span> Your data is private, encrypted, and belongs to you</div>
        <div class="status-item"><span class="status-dot"></span> Cloud backup: Active</div>
        <div class="status-item"><span class="status-dot"></span> Account recovery: On</div>
      </div>
      <button id="startBooksBtn" class="btn primary" style="width:100%;padding:14px 20px;">Start Adding Books →</button>
      <div class="signed-in-as">Signed in as ${email}</div>
    </div>
  `);

  document.getElementById('startBooksBtn').onclick = () => {
    closeHelperModal();
    closeAccountModal();
    markInitialSyncDone();
    uiStatusManager.refresh();
    if(window.bookishApp?.render) window.bookishApp.render();
    startSync();
  };
}

/**
 * Frame A5: Fallback success - faucet failed or skipped
 */
function showCreationFallbackSuccess(displayName, email) {
  transientState.justCreated = true;
  transientState.createdTime = Date.now();
  setTimeout(() => { transientState.justCreated = false; uiStatusManager.refresh(); }, 3000);

  showAccountModal(`
    <div class="modal-content-enter" style="text-align:center;padding:20px 0;">
      <div class="success-check-animated" style="margin-bottom:16px;">✓</div>
      <h3 style="margin:0 0 12px 0;">Account Created, ${displayName}!</h3>
      <p style="font-size:.875rem;line-height:1.6;color:var(--color-text-secondary);margin:0 0 16px 0;">
        Your data is private, encrypted, and belongs to you.
      </p>
      <div class="info-box">
        <div style="font-size:.875rem;line-height:1.5;">
          <span class="info-icon">💡</span> <strong>Cloud backup in progress</strong>
        </div>
        <p style="font-size:.8rem;line-height:1.5;color:var(--color-text-secondary);margin:8px 0 0 0;">
          Cloud backup is still finishing up. This usually completes within a few minutes. Your books are safe on this device in the meantime.
        </p>
      </div>
      <button id="startBooksBtn" class="btn primary" style="width:100%;padding:14px 20px;">Start Adding Books →</button>
      <div class="signed-in-as">Signed in as ${email}</div>
    </div>
  `);

  document.getElementById('startBooksBtn').onclick = () => {
    closeHelperModal();
    closeAccountModal();
    markInitialSyncDone();
    uiStatusManager.refresh();
    if(window.bookishApp?.render) window.bookishApp.render();
    startSync();
  };
}

// showManualBackupModal removed — no longer part of the auth flow

// onAccountCreated removed — replaced by runAccountCreationFlow

// showSuccessModal removed — replaced by showCreationFullSuccess / showCreationFallbackSuccess

// storeAccountInfo removed — account storage is now handled inline in creation flow


/**
 * Handle login
 */
async function handleLogin() {
  // Check what type of account exists locally
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);

  if (!accountData) {
    // No local account - show sign-in form
    handleSignIn();
    return;
  }

  const accountObj = JSON.parse(accountData);

  if (accountObj.derivation === 'credential') {
    // Credential-based account - show email+password sign-in
    handleSignIn();
  } else {
    // Manual seed account - require seed entry
    handleManualSeedLogin();
  }
}

/**
 * Handle sign-in with email + password (Frame B1-B5)
 */
function handleSignIn() {
  showAccountModal(`
    <div class="modal-content-enter" style="text-align:center;margin-bottom:16px;">
      <h3 style="margin:0;">Welcome Back</h3>
    </div>

    <form id="signInForm" class="auth-form" autocomplete="on" novalidate>
      <div class="form-group">
        <label for="signInEmail">Email</label>
        <input type="email" id="signInEmail" autocomplete="email" placeholder="you@example.com" required>
        <span class="field-preview" id="signInEmailPreview" aria-live="polite"></span>
      </div>

      <div class="form-group">
        <label for="signInPassword">Password</label>
        <div class="password-field">
          <input type="password" id="signInPassword" autocomplete="current-password" placeholder="Your password" required>
          <button type="button" class="password-toggle" id="toggleSignInPassword" aria-label="Show password">👁</button>
        </div>
      </div>

      <div id="signInError" style="display:none;"></div>

      <button type="submit" id="signInSubmitBtn" class="btn primary" style="width:100%;padding:14px 20px;" disabled>Sign In</button>
    </form>

    <div class="auth-footer">
      <div>Forgot password? <a href="mailto:support@getbookish.app?subject=Bookish%3A%20Password%20Recovery&body=My%20sign-in%20email%3A%20%0AI%20need%20help%20recovering%20my%20account." id="forgotPasswordLink">Contact us</a></div>
      <div class="footer-divider">Don't have an account? <button class="link-btn" id="switchToCreate">Create one</button></div>
    </div>
  `, true);

  const emailInput = document.getElementById('signInEmail');
  const passwordInput = document.getElementById('signInPassword');
  const submitBtn = document.getElementById('signInSubmitBtn');
  const errorDiv = document.getElementById('signInError');

  // Validate form
  function validateSignIn() {
    const emailOk = emailInput.value.trim().length > 0;
    const passOk = passwordInput.value.length > 0;
    submitBtn.disabled = !(emailOk && passOk);
  }

  emailInput.addEventListener('input', validateSignIn);
  passwordInput.addEventListener('input', () => {
    // Clear error when user types
    errorDiv.style.display = 'none';
    validateSignIn();
  });

  // Email normalization preview
  emailInput.addEventListener('blur', () => {
    const val = emailInput.value.trim();
    const preview = document.getElementById('signInEmailPreview');
    if (val && isValidEmail(val)) {
      const normalized = normalizeUsername(val);
      preview.innerHTML = `<span class="preview-arrow">►</span> Signing in as <strong>${normalized}</strong>`;
    } else {
      preview.innerHTML = '';
    }
  });

  // Pre-fill mailto link with email
  emailInput.addEventListener('change', () => {
    const link = document.getElementById('forgotPasswordLink');
    if (link && emailInput.value.trim()) {
      const email = encodeURIComponent(emailInput.value.trim());
      link.href = `mailto:support@getbookish.app?subject=Bookish%3A%20Password%20Recovery&body=My%20sign-in%20email%3A%20${email}%0AI%20need%20help%20recovering%20my%20account.`;
    }
  });

  // Password visibility toggle
  document.getElementById('toggleSignInPassword').addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
    document.getElementById('toggleSignInPassword').setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
  });

  // Switch to create account
  document.getElementById('switchToCreate').addEventListener('click', () => {
    closeHelperModal();
    handleCreateAccount();
  });

  // Form submission
  document.getElementById('signInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // Frame B2: Loading state
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner-inline"></span> Signing in...';
    emailInput.readOnly = true;
    emailInput.style.opacity = '0.7';
    passwordInput.readOnly = true;
    passwordInput.style.opacity = '0.7';
    errorDiv.style.display = 'none';

    try {
      await runSignInFlow(email, password);
    } catch (error) {
      console.error('[Bookish:AccountUI] Sign-in failed:', error);

      // Restore form state
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
      emailInput.readOnly = false;
      emailInput.style.opacity = '1';
      passwordInput.readOnly = false;
      passwordInput.style.opacity = '1';

      // Show inline error (Frame B4 or B5)
      const isNetworkError = error.message.includes('Network error') ||
                             error.message.includes('Failed to fetch') ||
                             error.message.includes('NetworkError');

      if (isNetworkError) {
        errorDiv.innerHTML = `
          <div class="error-box">
            <span class="error-icon">⚠</span>
            <span class="error-text">Something went wrong. Check your internet connection and try again.</span>
          </div>
        `;
      } else {
        errorDiv.innerHTML = `
          <div class="error-box">
            <span class="error-icon">⚠</span>
            <span class="error-text">We couldn't sign you in. Double-check your email and password and try again.</span>
          </div>
        `;
      }
      errorDiv.style.display = 'block';

      // Focus password field
      passwordInput.focus();
    }
  });

  // Enter key submission
  [emailInput, passwordInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) {
        e.preventDefault();
        document.getElementById('signInForm').dispatchEvent(new Event('submit'));
      }
    });
  });
}

/**
 * Run the sign-in flow (Frame B2 onwards)
 * @param {string} email - User email
 * @param {string} password - User password
 */
async function runSignInFlow(email, password) {
  console.log('[Bookish:AccountUI] Starting email+password sign-in...');

  // Step 1: Derive credential keys (PBKDF2 - 0.5-3s)
  const { lookupKey, encryptionKey } = await deriveCredentialKeys(email, password);

  // Step 2: Query Arweave for credential mapping
  const mapping = await downloadCredentialMapping(lookupKey);

  if (!mapping) {
    throw new Error('No account found for these credentials');
  }

  // Step 3: Decrypt credential payload (seed + metadata)
  const credentialPayload = await decryptCredentialPayload(mapping.encryptedPayload, encryptionKey);
  const seed = credentialPayload.seed;
  console.log('[Bookish:AccountUI] Credential payload decrypted successfully');

  // Step 4: Restore local state
  const { deriveWalletFromSeed } = await import('./core/account_creation.js');
  const { address } = await deriveWalletFromSeed(seed);
  console.log('[Bookish:AccountUI] Wallet address:', address);

  await deriveAndStoreSymmetricKey(seed);
  await window.bookishWallet.ensure();
  await storeSessionEncryptedSeed(seed);

  // Step 5: Download account metadata
  const symKeyHex = localStorage.getItem('bookish.sym');
  const symKeyBytes = hexToBytes(symKeyHex);
  const symKey = await importAesKey(symKeyBytes);

  let displayName = credentialPayload.displayName || 'Bookish User';
  let createdAt = credentialPayload.createdAt || Date.now();

  try {
    const metadata = await downloadAccountMetadata(address, symKey);
    if (metadata) {
      displayName = metadata.displayName || displayName;
      createdAt = metadata.createdAt || createdAt;
    }
  } catch (metaErr) {
    console.warn('[Bookish:AccountUI] Could not download account metadata:', metaErr);
  }

  // Store account info
  const normalizedEmail = normalizeUsername(email);
  const accountData = {
    version: 2,
    derivation: 'credential',
    displayName,
    email: normalizedEmail,
    created: createdAt,
    arweaveTxId: 'restored',
    persistedAt: createdAt
  };
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));

  // Store credential metadata
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify({
    lookupKey
  }));

  console.log('[Bookish:AccountUI] Sign-in complete, local state restored');

  // Frame B3: Success - close modal, show toast
  closeHelperModal();
  closeAccountModal();

  // Show welcome toast
  showToast(`✓ Welcome back, ${displayName}!`);

  // Set transient state
  transientState.justSignedIn = true;
  transientState.signInTime = Date.now();
  setTimeout(() => { transientState.justSignedIn = false; uiStatusManager.refresh(); }, 3000);

  uiStatusManager.refresh();
  // Trigger render immediately so "Syncing your books…" loading state shows
  if(window.bookishApp?.render) window.bookishApp.render();
  startSync();
}

/**
 * Escape string for CSV (quotes around fields with comma, quote, or newline)
 */
function escapeCSV(str) {
  if (str == null || str === '') return '';
  const s = String(str);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Map internal reading status to Goodreads Exclusive Shelf format
 */
function statusToGoodreads(s) {
  const st = (s || '').toLowerCase();
  if (st === 'want_to_read') return 'to-read';
  if (st === 'reading') return 'currently-reading';
  if (st === 'read') return 'read';
  return st || '';
}

/**
 * Format createdAt timestamp as YYYY-MM-DD for CSV
 */
function formatDateAdded(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Export all books to CSV and trigger download
 */
async function exportBooksToCSV() {
  const btn = document.getElementById('exportBooksBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting...';
  }
  try {
    const cache = window.bookishCache;
    if (!cache) {
      showToast('Export not available');
      return;
    }
    const entries = await cache.getAllActive();
    if (entries.length === 0) {
      showToast('No books to export yet');
      return;
    }
    const headers = ['Title', 'Author', 'ISBN', 'Date Added', 'Date Read', 'Rating', 'Status', 'Notes'];
    const rows = entries.map((e) => {
      const status = e.readingStatus || e.status || '';
      const dateRead = e.dateRead || '';
      const dateAdded = formatDateAdded(e.createdAt || e.created);
      const rating = (e.rating >= 1 && e.rating <= 5) ? String(e.rating) : '';
      return [
        escapeCSV(e.title || ''),
        escapeCSV(e.author || ''),
        escapeCSV(e.isbn || e.isbn13 || ''),
        dateAdded,
        dateRead,
        rating,
        statusToGoodreads(status),
        escapeCSV(e.notes || '')
      ];
    });
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bookish-export.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${entries.length} books to bookish-export.csv`);
  } catch (err) {
    console.error('[Bookish:AccountUI] Export failed:', err);
    showToast('Export failed. Please try again.');
  } finally {
    const b = document.getElementById('exportBooksBtn');
    if (b) {
      b.disabled = false;
      b.textContent = '📥 Export my books';
    }
  }
}

/**
 * Update display name: validate, save locally, optionally persist to Arweave
 */
async function updateDisplayName(newName) {
  let trimmed = (newName || '').trim();
  if (!trimmed) trimmed = 'Bookish User';
  if (trimmed.length > 50) {
    showToast('Name must be 50 characters or less');
    return;
  }
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountData) return;
  let accountObj;
  try {
    accountObj = JSON.parse(accountData);
  } catch {
    return;
  }
  accountObj.displayName = trimmed;
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountObj));
  const textEl = document.getElementById('accountDisplayNameText');
  if (textEl) textEl.textContent = trimmed;
  showToast('Name updated');
  try {
    const walletInfo = await getStoredWalletInfo();
    const cachedBalance = window.bookishSyncManager?.getSyncStatus?.()?.currentBalanceETH;
    const isFunded = cachedBalance != null && parseFloat(cachedBalance) >= 0.00002;
    if (walletInfo?.address && isFunded) {
      const symKeyHex = localStorage.getItem('bookish.sym');
      if (symKeyHex) {
        const symKeyBytes = hexToBytes(symKeyHex);
        const symKey = await importAesKey(symKeyBytes);
        await uploadAccountMetadata({
          address: walletInfo.address,
          displayName: trimmed,
          symKey,
          createdAt: accountObj.created
        });
      }
    }
  } catch (err) {
    console.warn('[Bookish:AccountUI] Arweave persist skipped:', err.message);
  }
}

/**
 * Setup display name edit: toggle between view and edit mode
 */
function setupDisplayNameEdit(currentName) {
  const editBtn = document.getElementById('editDisplayNameBtn');
  const textEl = document.getElementById('accountDisplayNameText');
  const row = document.querySelector('.account-name-row');
  if (!editBtn || !textEl || !row) return;
  editBtn.addEventListener('click', () => {
    const name = textEl.textContent || currentName || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.maxLength = 50;
    input.style.cssText = 'flex:1;min-width:80px;max-width:200px;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:6px 10px;color:#e2e8f0;font-size:0.95rem;';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '✓';
    saveBtn.setAttribute('aria-label', 'Save name');
    saveBtn.style.cssText = 'background:none;border:none;color:#10b981;cursor:pointer;padding:4px;font-size:1rem;';
    const doSave = () => {
      updateDisplayName(input.value);
      row.replaceChildren(document.createTextNode('👤 '), textEl, editBtn);
      textEl.textContent = (input.value || '').trim() || 'Bookish User';
    };
    saveBtn.addEventListener('click', doSave);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        row.replaceChildren(document.createTextNode('👤 '), textEl, editBtn);
      }
    });
    row.replaceChildren(document.createTextNode('👤 '), input, saveBtn);
    input.focus();
    input.select();
  });
}

/**
 * Setup Export my books button
 */
function setupExportBooksBtn() {
  document.getElementById('exportBooksBtn')?.addEventListener('click', () => exportBooksToCSV());
}

/**
 * Show a temporary toast notification
 * @param {string} message - Toast message
 * @param {number} duration - Duration in ms (default 3000)
 */
function showToast(message, duration = 3000) {
  // Remove existing toast if any
  const existing = document.getElementById('bookishToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'bookishToast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--color-bg-elevated, #1e293b); color: var(--color-text-primary, #e2e8f0);
    border: 1px solid var(--color-success, #10b981); border-left: 4px solid var(--color-success, #10b981);
    padding: 12px 20px; border-radius: 8px; font-size: 0.875rem;
    z-index: 10000; animation: contentFadeIn 0.2s ease-out;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Handle manual seed login (for manual seed accounts)
 */
function handleManualSeedLogin() {
  showAccountModal(`
    <h3>Enter Your Recovery Phrase</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Enter your 12-word recovery phrase to unlock your account.
    </p>
    <textarea id="manualSeedInput" style="width:100%;min-height:100px;font-family:monospace;padding:12px;background:#0b1220;border:1px solid #334155;border-radius:6px;color:#fff;" placeholder="word1 word2 word3 ..."></textarea>
    <div style="text-align:center;margin:24px 0;">
      <button id="confirmManualLoginBtn" class="btn">Sign In with Recovery Phrase</button>
    </div>
    <div id="manualLoginStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  document.getElementById('confirmManualLoginBtn').onclick = async () => {
    const statusDiv = document.getElementById('manualLoginStatus');
    const btn = document.getElementById('confirmManualLoginBtn');
    const seedInput = document.getElementById('manualSeedInput').value.trim();

    try {
      btn.disabled = true;
      btn.textContent = 'Verifying...';

      const { restoreAccountFromSeed } = await import('./core/account_creation.js');
      const account = await restoreAccountFromSeed(seedInput);

      // Derive symmetric key first (needed for metadata decryption)
      await deriveAndStoreSymmetricKey(account.seed);
      await window.bookishWallet.ensure();
      await storeSessionEncryptedSeed(account.seed);

      // Try to download account metadata from Arweave if it exists
      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Recovery phrase verified, checking storage...</span>';

      let accountData = {
        version: 1,
        derivation: 'manual',
        created: account.createdAt
      };

      try {
        const symKeyHex = localStorage.getItem('bookish.sym');
        const symKeyBytes = hexToBytes(symKeyHex);
        const symKey = await crypto.subtle.importKey('raw', symKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

        const metadata = await downloadAccountMetadata(account.address, symKey);
        if (metadata) {
          console.log('[Bookish:AccountUI] Account metadata restored from Arweave');
          accountData.displayName = metadata.displayName;
          accountData.arweaveTxId = 'restored'; // Mark as having been backed up
          accountData.persistedAt = metadata.createdAt;
        }
      } catch (metadataError) {
        console.log('[Bookish:AccountUI] No account metadata found on Arweave (new account or not yet backed up)');
      }

      // Store account info locally
      localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));

      // Store seed for manual accounts
      const { MANUAL_SEED_STORAGE_KEY } = await import('./core/storage_constants.js');
      localStorage.setItem(MANUAL_SEED_STORAGE_KEY, account.seed);

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Logged in!</span>';

      // Start sync loop now that user is logged in
      console.log('[Bookish:AccountUI] Manual seed login successful, starting sync loop');
      // Trigger render immediately so "Syncing your books…" loading state shows
      if(window.bookishApp?.render) window.bookishApp.render();
      startSync();

      setTimeout(() => {
        closeAccountModal();
      }, 1000);

    } catch (error) {
      console.error('[Bookish:AccountUI] Manual login failed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Sign In with Recovery Phrase';
    }
  };
}

/**
 * Handle logout
 */
async function handleLogout() {
  // Check for unsynced data before logout
  const persistenceState = determineAccountPersistenceState();
  const hasUnsyncedAccount = persistenceState === 'local';

  let unsyncedBooks = 0;
  if (window.bookishCache) {
    try {
      const entries = await window.bookishCache.getAllActive();
      // Count entries that don't have a txid or are still pending
      unsyncedBooks = entries.filter(e => !e.txid || e.status === 'pending').length;
    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to check unsynced books:', error);
    }
  }

  // Show warning if there's unsynced data
  if (hasUnsyncedAccount || unsyncedBooks > 0) {
    // Contextual messaging based on actual state
    const headerMessage = hasUnsyncedAccount 
      ? "Your account hasn't been backed up yet."
      : `${unsyncedBooks} book${unsyncedBooks > 1 ? 's are' : ' is'} still syncing.`;
    
    const bodyText = hasUnsyncedAccount
      ? "Add funds now to back up your account before logging out."
      : "Wait a moment for your books to finish syncing, then try again.";
    
    const primaryButtonText = hasUnsyncedAccount 
      ? "Add Cloud Credit & Stay"
      : "Stay Logged In";

    showAccountModal(`
      <h3>⚠️ You May Lose Access</h3>
      <p style="font-size:.875rem;line-height:1.6;margin:16px 0;">
        ${headerMessage} If you log out now:
      </p>
      <div style="background:#2d1f1f;border:1px solid #7f1d1d;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <div style="font-size:.85rem;line-height:1.7;">
          ${hasUnsyncedAccount ? '<div>❌ You won\'t be able to sign back in on other devices</div>' : ''}
          <div>❌ ${unsyncedBooks > 0 ? `${unsyncedBooks} book${unsyncedBooks > 1 ? 's' : ''} will be lost` : 'Your books will be lost'} unless you have your recovery phrase saved</div>
        </div>
      </div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        ${bodyText}
      </p>
      <button id="addFundsStayLoggedInBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;margin-bottom:12px;">${primaryButtonText}</button>
      <button id="haveRecoveryPhraseBtn" class="btn secondary" style="width:100%;padding:12px 20px;margin-bottom:16px;">I have my recovery phrase saved</button>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <button id="cancelLogoutBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Cancel</button>
        <button id="logoutWithoutSavingBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Sign out without saving</button>
      </div>
    `);

    // Primary action - depends on state
    document.getElementById('addFundsStayLoggedInBtn').onclick = () => {
      if (hasUnsyncedAccount) {
        // Account not persisted - open funding flow
        closeAccountModal();
        handleBuyStorage();
      } else {
        // Account persisted, just books syncing - close and stay logged in
        closeHelperModal();
      }
    };

    // I have my recovery phrase saved - proceed with logout
    document.getElementById('haveRecoveryPhraseBtn').onclick = () => {
      closeHelperModal(); // Close the warning dialog (helperModal)
      performLogout();
    };

    // Cancel - return to app
    document.getElementById('cancelLogoutBtn').onclick = closeHelperModal;

    // Log out without saving - proceed with logout (for users who accept data loss)
    document.getElementById('logoutWithoutSavingBtn').onclick = () => {
      closeHelperModal(); // Close the warning dialog (helperModal)
      performLogout();
    };
    return;
  }

  // Account is synced — still confirm before logging out
  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <h3 style="margin:0 0 16px 0;">Sign Out?</h3>
      <p style="font-size:.875rem;line-height:1.6;color:var(--color-text-secondary);margin:0 0 20px 0;">
        You can sign back in anytime with your email and password.
      </p>
      <button id="confirmLogoutBtn" class="btn primary" style="width:100%;padding:14px 20px;margin-bottom:12px;">Sign Out</button>
      <button id="cancelLogoutBtn" class="btn secondary" style="width:100%;padding:12px 20px;">Cancel</button>
    </div>
  `);

  document.getElementById('confirmLogoutBtn').onclick = () => {
    closeHelperModal();
    performLogout();
  };

  document.getElementById('cancelLogoutBtn').onclick = closeHelperModal;
}

/**
 * Perform actual logout (clear all data)
 */
async function performLogout() {
  // Ensure modal is closed
  closeAccountModal();

  // Stop sync manager
  stopSync();

  // Reset key state
  resetKeyState();

  // Remember that this user has had an account (survives logout)
  localStorage.setItem('bookish.hasHadAccount', 'true');

  // Clear all session data using centralized storage manager
  storageManager.clearSession();

  // Clear cache and books
  if (window.bookishCache) {
    await window.bookishCache.clearAll();
  }
  if (window.bookishApp) {
    window.bookishApp.clearBooks();
  }

  // Refresh UI to logged-out state
  initAccountUI();

  console.log('[Bookish:AccountUI] Logged out');
}

/**
 * Handle view seed
 * NOTE: Does NOT close account modal - opens recovery phrase view on top
 */
async function handleViewSeed() {
  try {
    const seed = await getSessionEncryptedSeed();
    if (seed) {
      showSeedPhraseModal(seed);
    } else {
      showAccountModal(`
        <h3>View Recovery Phrase</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          Your recovery phrase is only stored in memory during this session. Please sign in again to view it.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <button onclick="window.accountUI.closeHelperModal()" class="btn">Close</button>
        </div>
      `);
    }
  } catch (error) {
    console.error('[Bookish:AccountUI] Failed to retrieve seed:', error);
    uiStatusManager.refresh();
  }
}

/**
 * Show seed phrase modal
 */
function showSeedPhraseModal(seed) {
  const words = seed.split(' ');

  showAccountModal(`
    <h3>Your Recovery Phrase</h3>
    <div style="background:#4a90e21a;border:1px solid #4a90e2;border-radius:6px;padding:16px;margin:16px 0;">
      <p style="font-size:.875rem;line-height:1.6;color:#93c5fd;margin:0;">
        Your recovery phrase is a master key to your account. If you ever forget your email or password and can't reach us for help, you can use these 12 words to regain access on any device.
      </p>
      <p style="font-size:.8rem;line-height:1.5;color:#93c5fd;margin:10px 0 0 0;opacity:.85;">
        Most users won't need this — you can always sign in with your email and password, and we can help if you forget.
      </p>
    </div>

    <div style="background:#f59e0b1a;border:1px solid #f59e0b;border-radius:6px;padding:12px 16px;margin:0 0 16px 0;">
      <p style="font-size:.8rem;line-height:1.5;color:#f59e0b;margin:0;">
        <strong>Keep this private and secure.</strong> Anyone with these words can access your account.
      </p>
    </div>

    <div style="background:#0b1220;border:1px solid #334155;border-radius:6px;padding:16px;margin:0 0 16px 0;">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;font-family:monospace;font-size:.875rem;">
        ${words.map((word, i) => `
          <div style="display:flex;gap:8px;">
            <span style="opacity:.5;">${i + 1}.</span>
            <span style="font-weight:500;">${word}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <p style="font-size:.75rem;color:#64748b;margin:0 0 16px 0;">
      You can export your books anytime at <a href="/forever.html" target="_blank" rel="noopener">getbookish.app/forever</a> using your recovery phrase.
    </p>

    <div style="text-align:center;margin:24px 0;display:flex;gap:8px;justify-content:center;">
      <button id="copySeedBtn" class="btn secondary">Copy to Clipboard</button>
      <button id="closeSeedBtn" class="btn">Close</button>
    </div>
  `);

  document.getElementById('copySeedBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(seed);
      const btn = document.getElementById('copySeedBtn');
      const origText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = origText; }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  document.getElementById('closeSeedBtn').onclick = closeHelperModal;
}

/**
 * Handle "Buy with Transak" button click - shows coming soon message
 */
function handleBuyTransak() {
  showAccountModal(`
    <h3>Transak Coming Soon</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Transak integration is coming soon! For now, please use Coinbase to add funds.
    </p>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Transak will offer guest checkout, allowing you to purchase crypto without creating an account.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <button id="closeComingSoonBtn" class="btn">Got it</button>
    </div>
  `);
  document.getElementById('closeComingSoonBtn').onclick = closeHelperModal;
}

/**
 * Phase 3: Show value explanation modal before payment
 * @param {string} address - Wallet address for funding
 * @param {boolean} isFunded - Whether account already has credit
 */
function showFundingValueModal(address, isFunded = false) {
  let advancedExpanded = false;

  // Adapt messaging based on funding status
  const title = isFunded ? 'Add Credit' : 'Make Your Books Permanent';
  const paymentPrompt = isFunded ? 'How would you like to add credit?' : 'How would you like to pay?';

  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <h3 style="margin:0 0 16px 0;">${title}</h3>
      ${!isFunded ? `
      <div style="font-size:2.5rem;margin:16px 0;opacity:.9;">☁️ + 🔒 = ♾️</div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;text-align:left;">
        Right now, your books only exist on this device. Add cloud credit to:
      </p>
      <div style="text-align:left;margin:0 0 24px 0;">
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Access from any device</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Never lose your reading history</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Keep your data forever</div>
      </div>
      <div style="background:#1e3a5f;border:1px solid #2563eb;border-radius:8px;padding:12px 16px;margin:0 0 24px 0;">
        <div style="font-size:.85rem;line-height:1.5;">
          <strong>A penny a book</strong><br>
          <span style="opacity:.8;">no subscription · free to get started</span>
        </div>
      </div>
      <div style="margin:0 0 16px 0;">
        <a href="/faq.html#cost" target="_blank" rel="noopener" style="color:#94a3b8;font-size:.8rem;text-decoration:none;transition:color .2s;" onmouseover="this.style.color='#60a5fa'" onmouseout="this.style.color='#94a3b8'">Have questions about pricing? &rarr;</a>
      </div>
      ` : `
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;text-align:left;">
        Add funds to keep your books backed up. Your balance covers storage for years — a little goes a long way.
      </p>
      `}
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 16px 0;">${paymentPrompt}</p>
      <button id="payWithCoinbaseBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;margin-bottom:12px;">Pay with Coinbase</button>
      <button id="payWithCardBtn" class="btn secondary" style="width:100%;padding:12px 20px;margin-bottom:12px;opacity:.6;cursor:not-allowed;" disabled>Pay with Card (Coming Soon)</button>
      <div style="margin:16px 0;">
        <button id="toggleAdvancedBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.8rem;cursor:pointer;padding:0;">▸ Advanced: Send funds directly</button>
      </div>
      <div id="advancedSection" style="display:none;text-align:left;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <div style="font-size:.8rem;opacity:.9;margin-bottom:8px;">Send funds to this address (Base network, ETH):</div>
        <div style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 12px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;">
          <code style="font-size:.75rem;word-break:break-all;flex:1;">${address}</code>
          <button id="copyAddressBtn" class="btn secondary copy-btn" style="margin-left:8px;padding:4px 8px;font-size:.7rem;">Copy</button>
        </div>
        <div style="font-size:.75rem;opacity:.8;margin-top:8px;line-height:1.5;">
          <div>Minimum: 0.00003 ETH (~$0.10)</div>
          <div>Recommended: 0.002 ETH (~$5)</div>
          <div style="margin-top:8px;">The app checks your balance every 30 seconds.</div>
        </div>
      </div>
      <div style="margin-top:16px;">
        <button id="maybeLaterBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Maybe Later</button>
      </div>
    </div>
  `);

  // Pay with Coinbase
  document.getElementById('payWithCoinbaseBtn').onclick = () => {
    closeHelperModal();
    showFundingProgress(address, isFunded);
    openCoinbaseOnrampWithInstructions(address);
  };

  // Toggle advanced section (close FAQ if open)
  document.getElementById('toggleAdvancedBtn').onclick = () => {
    advancedExpanded = !advancedExpanded;
    const advancedSection = document.getElementById('advancedSection');
    const toggleBtn = document.getElementById('toggleAdvancedBtn');
    if (advancedExpanded) {
      advancedSection.style.display = 'block';
      toggleBtn.textContent = '▾ Advanced: Send funds directly';
    } else {
      advancedSection.style.display = 'none';
      toggleBtn.textContent = '▸ Advanced: Send funds directly';
    }
  };

  // Copy address
  document.getElementById('copyAddressBtn').onclick = async () => {
    try {
      const { copyAddressToClipboard } = await import('./core/wallet_core.js');
      await copyAddressToClipboard(address);
      const btn = document.getElementById('copyAddressBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // Maybe Later — close the helper modal (funding dialog) and the account modal behind it
  document.getElementById('maybeLaterBtn').onclick = () => {
    closeHelperModal();
    closeAccountModal();
  };
}

/**
 * Phase 3: Show progress modal during funding
 * @param {string} address - Wallet address
 */
function showFundingProgress(address, isFunded) {
  let progressState = 'initiated'; // initiated, waiting, setting-up
  window.__fundingIsFunded = isFunded; // Store for success callback

  const title = isFunded ? 'Adding Credit...' : 'Setting Up Cloud Backup...';
  const body = isFunded
    ? 'Your credit will be added once payment is confirmed.'
    : 'We\u2019ll automatically set up your permanent storage once payment is confirmed.';
  const step3 = isFunded ? 'Adding credit' : 'Setting up storage';

  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <h3 style="margin:0 0 16px 0;">${title}</h3>
      <div style="font-size:3rem;margin:16px 0;opacity:.9;">⏳</div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        Complete your purchase in the Coinbase window.
      </p>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        ${body}
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:0 0 24px 0;text-align:left;">
        <div id="progressStep1" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:1;">
          <span>○</span> <span>Payment initiated</span>
        </div>
        <div id="progressStep2" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:.5;">
          <span>○</span> <span>Waiting for confirmation...</span>
        </div>
        <div id="progressStep3" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:.5;">
          <span>○</span> <span>${step3}</span>
        </div>
      </div>
      <button id="cancelFundingBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Cancel</button>
    </div>
  `);

  // Cancel button
  document.getElementById('cancelFundingBtn').onclick = () => {
    // Clear timeout check
    if (window.__fundingTimeoutCheck) {
      clearInterval(window.__fundingTimeoutCheck);
      window.__fundingTimeoutCheck = null;
    }
    // Stop fast balance polling
    if (window.__fastPollInterval) {
      clearInterval(window.__fastPollInterval);
      window.__fastPollInterval = null;
    }
    closeHelperModal();
    // Reset button state
    const buyBtn = document.getElementById('buyCoinbaseBtn');
    if (buyBtn) {
      buyBtn.textContent = '☁️ Enable Cloud Backup';
      buyBtn.disabled = false;
    }
    // Clear progress state
    window.__fundingProgressState = null;
    window.__updateFundingProgress = null;
    window.__fundingStartedAt = null;
    window.__fundingIsFunded = null;
  };

  // Store progress state updater globally so Coinbase callbacks can update it
  window.__fundingProgressState = progressState;
  window.__fundingStartedAt = Date.now();

  // Phase 3: Handle timeout for long funding waits (>5 minutes)
  const timeoutCheck = setInterval(() => {
    const elapsed = Date.now() - window.__fundingStartedAt;
    if (elapsed > 5 * 60 * 1000) { // 5 minutes
      // Show reassurance message if cancel button is still visible
      const cancelBtn = document.getElementById('cancelFundingBtn');
      if (cancelBtn && !document.getElementById('timeoutMessage')) {
        cancelBtn.insertAdjacentHTML('beforebegin', `
          <p id="timeoutMessage" style="font-size:.8rem;opacity:.8;margin:16px 0;line-height:1.5;">
            This can take a few minutes. We'll notify you when ready. You can close this and continue using the app.
          </p>
        `);
      }
    }
  }, 60000); // Check every minute

  // Store timeout ID for cleanup
  window.__fundingTimeoutCheck = timeoutCheck;

  window.__updateFundingProgress = (state) => {
    progressState = state;
    window.__fundingProgressState = state;

    const step1 = document.getElementById('progressStep1');
    const step2 = document.getElementById('progressStep2');
    const step3 = document.getElementById('progressStep3');

    if (state === 'initiated') {
      if (step1) {
        step1.style.opacity = '1';
        step1.querySelector('span').textContent = '○';
      }
      if (step2) step2.style.opacity = '.5';
      if (step3) step3.style.opacity = '.5';
    } else if (state === 'waiting') {
      if (step1) {
        step1.style.opacity = '1';
        step1.style.color = '#10b981';
        step1.querySelector('span').textContent = '✓';
      }
      if (step2) step2.style.opacity = '1';
      if (step3) step3.style.opacity = '.5';
    } else if (state === 'setting-up') {
      if (step1) {
        step1.style.opacity = '1';
        step1.style.color = '#10b981';
        step1.querySelector('span').textContent = '✓';
      }
      if (step2) {
        step2.style.opacity = '1';
        step2.style.color = '#10b981';
        step2.querySelector('span').textContent = '✓';
      }
      if (step3) step3.style.opacity = '1';
    }
  };
}

/**
 * Phase 3: Show success modal after funding completes
 */
function showFundingSuccess(isFunded) {
  const title = isFunded ? 'Credit Added!' : 'Cloud Backup Enabled!';
  const body = isFunded
    ? 'Your cloud storage balance has been topped up.'
    : 'Your books are now saved permanently and accessible from any device.';

  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <div class="success-checkmark" style="font-size:3rem;margin-bottom:16px;animation:scaleIn .3s ease-out;color:#10b981;">✓</div>
      <h3 style="margin:0 0 12px 0;">${title}</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        ${body}
      </p>
      <button id="backToBooksBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;">Back to My Books</button>
    </div>
  `);

  document.getElementById('backToBooksBtn').onclick = () => {
    closeHelperModal();
  };
}

/**
 * Handle "Enable Cloud Backup" button click - shows value explanation modal first
 */
async function handleBuyStorage() {
  try {
    const walletInfo = await getStoredWalletInfo();
    if (!walletInfo?.address) {
      showAccountModal(`
        <h3>Wallet Not Found</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          Unable to find your wallet address. Please try logging out and logging back in.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <button id="closeErrorBtn" class="btn">OK</button>
        </div>
      `);
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
      return;
    }

    // Use cached balance, fall back to on-chain fetch if unavailable
    let cachedBalance = window.bookishSyncManager?.getSyncStatus?.()?.currentBalanceETH;
    if (cachedBalance === null || cachedBalance === undefined) {
      try {
        const { getWalletBalance } = await import('./core/wallet_core.js');
        const { balanceETH } = await getWalletBalance(walletInfo.address);
        cachedBalance = balanceETH;
      } catch (err) {
        console.warn('[Bookish:AccountUI] Could not fetch balance for isFunded check:', err);
      }
    }
    const isFunded = cachedBalance !== null && cachedBalance !== undefined && parseFloat(cachedBalance) >= 0.00002;

    // Show modal immediately with cached state
    showFundingValueModal(walletInfo.address, isFunded);

  } catch (error) {
    console.error('[Bookish:AccountUI] Failed to open funding flow:', error);
    showAccountModal(`
      <h3>Error</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        ${error.message || 'Failed to open funding flow. Please try again.'}
      </p>
      <div style="text-align:center;margin:24px 0;">
        <button id="closeErrorBtn" class="btn">OK</button>
      </div>
    `);
    document.getElementById('closeErrorBtn').onclick = closeHelperModal;
  }
}

/**
 * Open Coinbase Onramp widget with clear instructions for user
 */
async function openCoinbaseOnrampWithInstructions(address) {
  // Show loading state
  const buyBtn = document.getElementById('buyCoinbaseBtn');
  if (buyBtn) {
    buyBtn.disabled = true;
    buyBtn.textContent = 'Loading...';
  }

  // Phase 3: Update progress modal to "waiting" state
  if (window.__updateFundingProgress) {
    window.__updateFundingProgress('waiting');
  }

  // Fetch the actual on-chain balance as baseline (don't trust cached value which may be '0')
  let initialBalance = '0';
  try {
    const { getWalletBalance } = await import('./core/wallet_core.js');
    const { balanceETH } = await getWalletBalance(address);
    initialBalance = balanceETH || '0';
  } catch (err) {
    // Fall back to cached value if on-chain check fails
    initialBalance = window.bookishSyncManager?.getSyncStatus?.()?.currentBalanceETH || '0';
    console.warn('[Bookish:AccountUI] Could not fetch initial balance, using cached:', initialBalance);
  }

  // Start fast balance polling (every 5 seconds) while Coinbase widget is open
  const startTime = Date.now();
  const FAST_POLL_INTERVAL = 5000; // 5 seconds
  const MAX_POLL_DURATION = 5 * 60 * 1000; // 5 minutes
  let fundsDetected = false;

  console.log('[Bookish:AccountUI] Starting fast balance polling, initial balance:', initialBalance);

  const fastPollInterval = setInterval(async () => {
    // Stop if max duration exceeded
    if (Date.now() - startTime > MAX_POLL_DURATION) {
      console.log('[Bookish:AccountUI] Fast polling timeout (5 min), stopping');
      clearInterval(fastPollInterval);
      window.__fastPollInterval = null;
      return;
    }

    // Stop if funds already detected
    if (fundsDetected) {
      clearInterval(fastPollInterval);
      window.__fastPollInterval = null;
      return;
    }

    try {
      const { getWalletBalance } = await import('./core/wallet_core.js');
      const { balanceETH } = await getWalletBalance(address);
      console.log('[Bookish:AccountUI] Fast poll balance check:', balanceETH);

      if (parseFloat(balanceETH) > parseFloat(initialBalance)) {
        fundsDetected = true;
        console.log('[Bookish:AccountUI] Funds detected! Balance increased from', initialBalance, 'to', balanceETH);
        clearInterval(fastPollInterval);
        window.__fastPollInterval = null;
        
        // Close progress modal and show simple confirmation
        closeHelperModal();
        setTimeout(() => {
          const isFunded = window.__fundingIsFunded;
          showAccountModal(`
            <div style="text-align:center;padding:20px 0;">
              <div style="font-size:2.5rem;margin:16px 0;">✓</div>
              <h3 style="margin:0 0 16px 0;">${isFunded ? 'Credit Added!' : 'Funds Added'}</h3>
              <p style="font-size:.875rem;opacity:.9;margin:0 0 24px 0;">
                Your balance has been updated.
              </p>
              <button id="fundingDoneBtn" class="btn" style="min-width:120px;">Done</button>
            </div>
          `);
          document.getElementById('fundingDoneBtn').onclick = closeHelperModal;
        }, 300);

        // Trigger a sync to update the cached balance
        if (window.bookishSyncManager?.triggerPersistenceCheck) {
          window.bookishSyncManager.triggerPersistenceCheck();
        }
      }
    } catch (err) {
      console.warn('[Bookish:AccountUI] Fast poll balance check failed:', err.message);
    }
  }, FAST_POLL_INTERVAL);

  // Store interval ID for cleanup
  window.__fastPollInterval = fastPollInterval;
  window.__fastPollFundsDetected = () => fundsDetected;

  // Open widget directly
  openOnrampWidget(address, {
    onSuccess: () => {
      console.log('[Bookish:AccountUI] Coinbase Onramp widget opened');
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }
      // Progress modal should already be showing - update to waiting state
      if (window.__updateFundingProgress) {
        window.__updateFundingProgress('waiting');
      }
    },
    onError: (error) => {
      console.error('[Bookish:AccountUI] Coinbase Onramp failed:', error);
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }

      // Check if it's a server configuration error
      let errorMessage = error.message || 'Failed to open Coinbase Onramp. Please try again.';
      let showManualOption = true;

      if (errorMessage.includes('not configured') || errorMessage.includes('credentials')) {
        errorMessage = 'Coinbase integration is not configured on the server. Please contact support or add funds manually.';
        showManualOption = true;
      } else if (errorMessage.includes('Popup blocked')) {
        errorMessage = 'Your browser blocked the popup. Please allow popups for this site and try again.';
        showManualOption = false;
      }

      showAccountModal(`
        <h3>Couldn't Open Coinbase Onramp</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          ${errorMessage}
        </p>
        ${showManualOption ? `
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          <strong>Manual option:</strong> Copy your address and send funds directly (Base network, ETH):
        </p>
        <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px;margin:16px 0;">
          <div style="font-size:.75rem;opacity:.7;margin-bottom:4px;">Your wallet address:</div>
          <code style="font-size:.8rem;word-break:break-all;">${address}</code>
          <button id="copyAddressManualBtn" class="btn secondary" style="margin-top:8px;width:100%;font-size:.75rem;">Copy Address</button>
        </div>
        ` : ''}
        <div style="text-align:center;margin:24px 0;">
          <button id="closeErrorBtn" class="btn">OK</button>
        </div>
      `);
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
      if (showManualOption) {
        document.getElementById('copyAddressManualBtn').onclick = async () => {
          try {
            const { copyAddressToClipboard } = await import('./core/wallet_core.js');
            await copyAddressToClipboard(address);
            const btn = document.getElementById('copyAddressManualBtn');
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = 'Copy Address'; }, 2000);
          } catch (err) {
            console.error('Copy failed:', err);
          }
        };
      }
    },
    onClose: async () => {
      // Widget was closed (user may have cancelled or completed purchase)
      console.log('[Bookish:AccountUI] Coinbase Onramp widget closed');
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }

      // If funds were already detected by fast polling, we're done
      if (window.__fastPollFundsDetected?.()) {
        console.log('[Bookish:AccountUI] Funds already detected, nothing more to do');
        return;
      }

      // Do one final balance check immediately
      console.log('[Bookish:AccountUI] Doing final balance check...');
      try {
        const { getWalletBalance } = await import('./core/wallet_core.js');
        const { balanceETH } = await getWalletBalance(address);

        if (parseFloat(balanceETH) > parseFloat(initialBalance)) {
          fundsDetected = true;
          console.log('[Bookish:AccountUI] Funds detected on close! Balance increased from', initialBalance, 'to', balanceETH);
          // Stop fast polling
          if (window.__fastPollInterval) {
            clearInterval(window.__fastPollInterval);
            window.__fastPollInterval = null;
          }
          // Show confirmation
          closeHelperModal();
          setTimeout(() => {
            const isFunded = window.__fundingIsFunded;
            showAccountModal(`
              <div style="text-align:center;padding:20px 0;">
                <div style="font-size:2.5rem;margin:16px 0;">✓</div>
                <h3 style="margin:0 0 16px 0;">${isFunded ? 'Credit Added!' : 'Funds Added'}</h3>
                <p style="font-size:.875rem;opacity:.9;margin:0 0 24px 0;">
                  Your balance has been updated.
                </p>
                <button id="fundingDoneBtn" class="btn" style="min-width:120px;">Done</button>
              </div>
            `);
            document.getElementById('fundingDoneBtn').onclick = closeHelperModal;
          }, 300);

          // Trigger sync to update cached balance
          if (window.bookishSyncManager?.triggerPersistenceCheck) {
            window.bookishSyncManager.triggerPersistenceCheck();
          }
        } else {
          // Funds not detected yet — keep fast polling as backup (don't clear it)
          // The fast poll will auto-close the modal when funds arrive, or timeout after 5 min
          console.log('[Bookish:AccountUI] No balance change yet, fast poll continues in background');
        }
      } catch (err) {
        console.error('[Bookish:AccountUI] Final balance check failed:', err);
        // Keep fast polling as fallback
      }
    }
  });
}

/**
 * Handle persistence to Arweave (triggered by funding automatically)
 */
/**
 * Handle persisting account to Arweave (auto-triggered on funding)
 * Exported for sync_manager to call
 */
export async function handlePersistAccountToArweave(isAutoTrigger = false) {
  // This should only be called by auto-persistence on funding detection
  if (!isAutoTrigger) {
    console.warn('[Bookish:AccountUI] Manual persistence called - should only be auto-triggered');
    return;
  }

  try {
    const triggerType = isAutoTrigger ? 'automatic (funding detected)' : 'manual';
    console.log(`[Bookish:AccountUI] Starting ${triggerType} account persistence...`);

    // Get account data
    const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (!accountData) {
      throw new Error('No account found');
    }

    const accountObj = JSON.parse(accountData);

    // Get seed from session storage
    let seed = await getSessionEncryptedSeed();
    if (!seed) {
      // Fallback: Get seed from localStorage (manual accounts)
      const { MANUAL_SEED_STORAGE_KEY } = await import('./core/storage_constants.js');
      seed = localStorage.getItem(MANUAL_SEED_STORAGE_KEY);
      if (!seed) {
        throw new Error('Seed not found in storage');
      }
      // Store in session for future operations
      await storeSessionEncryptedSeed(seed);
    }

    // Derive wallet address
    const { deriveWalletFromSeed } = await import('./core/account_creation.js');
    const { address } = await deriveWalletFromSeed(seed);

    // Get bookish.sym key for encrypting account metadata
    const symKeyHex = localStorage.getItem('bookish.sym');
    if (!symKeyHex) {
      throw new Error('Encryption key not available');
    }
    const symKeyBytes = hexToBytes(symKeyHex);
    const symKey = await crypto.subtle.importKey('raw', symKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    // Get display name from account data
    const displayName = accountObj.displayName || 'User';

    // Upload account metadata (profile only, NO SEED)
    const accountTxId = await uploadAccountMetadata({
      address,
      displayName,
      symKey,
      createdAt: accountObj.created
    });

    console.log('[Bookish:AccountUI] Account metadata uploaded:', accountTxId);

    // Upload credential mapping to Arweave
    let mappingTxId = null;

    if (accountObj.derivation === 'credential') {
      // Credential-based account: upload credential mapping if pending
      const pendingRaw = localStorage.getItem(PENDING_CREDENTIAL_MAPPING_KEY);
      if (pendingRaw) {
        try {
          const pending = JSON.parse(pendingRaw);
          if (pending.lookupKey && pending.encryptedPayloadB64) {
            console.log('[Bookish:AccountUI] Uploading pending credential mapping...');
            const encryptedPayload = base64ToBytes(pending.encryptedPayloadB64);
            mappingTxId = await uploadCredentialMapping({
              lookupKey: pending.lookupKey,
              encryptedPayload
            });
            console.log('[Bookish:AccountUI] Credential mapping uploaded:', mappingTxId);
            localStorage.removeItem(PENDING_CREDENTIAL_MAPPING_KEY);
          }
        } catch (parseErr) {
          console.error('[Bookish:AccountUI] Failed to parse pending credential mapping:', parseErr);
          localStorage.removeItem(PENDING_CREDENTIAL_MAPPING_KEY);
        }
      }

    }

    // Update account storage with tx IDs
    accountObj.arweaveTxId = accountTxId;
    accountObj.persistedAt = Date.now();
    if (mappingTxId) {
      accountObj.credentialMappingTxId = mappingTxId;
    }

    // Phase 3: Update progress to "setting-up" state
    // First ensure step 2 is marked complete, then update to "setting-up"
    try {
      if (window.__updateFundingProgress) {
        // First ensure step 2 is marked complete
        if (window.__fundingProgressState !== 'waiting' && window.__fundingProgressState !== 'setting-up') {
          window.__updateFundingProgress('waiting');
        }
        // Then update to "setting-up"
        window.__updateFundingProgress('setting-up');
      }
    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to update progress modal:', error);
      // Continue with persistence completion anyway
    }
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountObj));

    // Update UI
    updateAccountPersistenceIndicator('syncing');

    setTimeout(() => {
      updateAccountPersistenceIndicator('confirmed');

      uiStatusManager.refresh();

      // UI will refresh when modal is reopened

      // Phase 3: Show success modal if progress modal was showing
      if (window.__fundingProgressState) {
        // Clear timeout check
        if (window.__fundingTimeoutCheck) {
          clearInterval(window.__fundingTimeoutCheck);
          window.__fundingTimeoutCheck = null;
        }
        // Close progress modal and show success
        closeHelperModal();
        const wasFunded = window.__fundingIsFunded;
        setTimeout(() => {
          showFundingSuccess(wasFunded);
        }, 300);
        // Clear progress state
        window.__fundingProgressState = null;
        window.__updateFundingProgress = null;
        window.__fundingStartedAt = null;
        window.__fundingIsFunded = null;
      }
    }, 2000);

  } catch (error) {
    console.error('[Bookish:AccountUI] Failed to persist account:', error);
    uiStatusManager.refresh();
  }
}

/**
 * Store session encryption (seed encrypted with bookish.sym)
 */
/**
 * Determine account persistence state for UI indicator
 */

/**
 * Determine account persistence state
 */
function determineAccountPersistenceState() {
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountData) return 'local';

  try {
    const accountObj = JSON.parse(accountData);
    // Check if account metadata has been uploaded to Arweave
    if (accountObj.arweaveTxId && accountObj.arweaveTxId !== 'restored') {
      return 'confirmed'; // Account was uploaded from this device
    }
    if (accountObj.arweaveTxId === 'restored') {
      return 'confirmed'; // Account was restored from Arweave
    }
  } catch (e) {
    console.error('Failed to parse account data:', e);
  }

  return 'local';
}

/**
 * Get persistence indicator HTML
 */
function getPersistenceIndicatorHTML(state) {
  // Use same status dot styling as books
  const classes = {
    local: 'local',      // yellow/orange
    syncing: 'syncing',  // green
    confirmed: 'arweave' // dark green
  };
  const titles = {
    local: 'Account stored locally only',
    syncing: 'Syncing to Arweave...',
    confirmed: 'Saved to Arweave'
  };
  const cls = classes[state] || 'local';
  const title = titles[state] || titles.local;
  return `<span class="status-dot ${cls}" style="position:relative;display:inline-block;width:10px;height:10px;top:0;right:0;margin-left:6px;vertical-align:middle;" title="${title}"></span>`;
}

/**
 * Update persistence indicator
 */
function updateAccountPersistenceIndicator(state) {
  // Modal content is rendered fresh each time it opens, so no need to update here
  // This function is kept for backward compatibility but does nothing
}

/**
 * Store wallet info
 */
/**
 * Get stored wallet info from window.bookishWallet
 */
export async function getStoredWalletInfo() {
  try {
    const address = await window.bookishWallet?.getAddress();
    if (!address) return null;
    return { address };
  } catch {
    return null;
  }
}

/**
 * Update balance display with current value
 * Exported for sync_manager to use
 */
export function updateBalanceDisplay(balanceETH) {
  currentBalanceETH = balanceETH;
  const balanceElement = document.getElementById('accountBalanceDisplay');
  if (!balanceElement) return;

  const balance = parseFloat(balanceETH);
  const isFunded = balance > 0.00002;

  const formattedBalance = formatBalanceAsBooks(balanceETH);
  const status = getBalanceStatus(balanceETH);

  balanceElement.textContent = formattedBalance;
  balanceElement.className = `balance-display balance-${status}`;

  // Update "Buy Storage" buttons visibility based on funding status
  updateBuyStorageButtonVisibility(isFunded).catch(err => {
    console.error('[Bookish:AccountUI] Failed to update buy storage button:', err);
  });
}

/**
 * Update "Buy Storage" buttons visibility based on funding status
 * Buttons always show when logged in (users can add more funds anytime)
 */
async function updateBuyStorageButtonVisibility(isFunded) {
  const buyCoinbaseBtn = document.getElementById('buyCoinbaseBtn');
  const buyTransakBtn = document.getElementById('buyTransakBtn');

  // Always show buttons when wallet is available (Coinbase Onramp available via server)
  const walletInfo = await getStoredWalletInfo();
  if (walletInfo && isCoinbaseOnrampConfigured()) {
    if (buyCoinbaseBtn) buyCoinbaseBtn.style.display = 'inline-flex';
    if (buyTransakBtn) buyTransakBtn.style.display = 'inline-flex';
  } else {
    if (buyCoinbaseBtn) buyCoinbaseBtn.style.display = 'none';
    if (buyTransakBtn) buyTransakBtn.style.display = 'none';
  }
}

/**
 * Modal helpers
 */
function showAccountModal(content, showClose = true) {
  // Create helper modal for various account-related modals (recovery phrase, success, etc.)
  // This is separate from the main account panel modal
  // When account modal is open, this should appear ON TOP with higher z-index
  const accountModal = document.getElementById('accountModal');
  const isAccountModalOpen = accountModal && accountModal.style.display === 'flex';

  let helperModal = document.getElementById('helperModal');
  if (!helperModal) {
    helperModal = document.createElement('div');
    helperModal.id = 'helperModal';
    helperModal.className = 'modal';
    document.body.appendChild(helperModal);
  }

  // If account modal is open, use higher z-index to appear on top
  if (isAccountModalOpen) {
    helperModal.style.zIndex = '1002'; // Higher than account modal (1000)
  } else {
    helperModal.style.zIndex = '5000'; // Default z-index
  }

  helperModal.innerHTML = `
    <div class="modal-content">
      ${showClose ? '<button class="modal-close-btn" onclick="window.accountUI.closeHelperModal()" aria-label="Close">×</button>' : ''}
      ${content}
    </div>
  `;
  helperModal.style.display = 'flex';
}

function closeHelperModal() {
  const modal = document.getElementById('helperModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Export for use in HTML onclick handlers
window.accountUI = {
  closeAccountModal,
  closeHelperModal,
  handlePersistAccountToArweave,
  updateBalanceDisplay,
  handleSignIn
};

// Note: initAccountUI() is called from app.js — no auto-init here to avoid double initialization
