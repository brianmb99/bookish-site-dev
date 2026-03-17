// account_ui_v2.js - User interface for v2 PRF-based account management
// Handles UI interactions for creating PRF-encrypted accounts

import { isPRFSupported, hasPasskeyV2, generateUniqueUserId, clearPasskeyV2 } from './core/passkey_core_v2.js';
import { createAccountV2, hasAccountV2 as hasAccountV2Original, markSeedAsShownV2, wasSeedShownV2, getAccountV2Metadata, clearAccountV2, setArweaveTxId } from './core/seed_core_v2.js';
import { formatAddress, copyAddressToClipboard, getWalletBalance } from './core/wallet_core.js';
import { encryptWithPassword, decryptWithPassword } from './core/crypto_utils.js';

// Balance polling configuration (AC1)
const BALANCE_POLL_INTERVAL_MS = 30000; // 30 seconds
const DUST_THRESHOLD_USDC = 0.001; // $0.001 USDC

/**
 * Derive bookish.sym from seed phrase using PBKDF2
 * This key is used for both account metadata AND book encryption (unified encryption)
 * @param {string} mnemonic - BIP39 seed phrase
 * @returns {Promise<string>} - 64-char hex string (32 bytes)
 */
async function deriveBookishSymFromSeed(mnemonic) {
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(mnemonic);

  // Import seed as PBKDF2 key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seedBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-256 key using PBKDF2 with "bookish" salt (unified architecture)
  const salt = encoder.encode('bookish');
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000, // 100k iterations for security
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // Export as raw bytes and convert to hex string
  const keyBytes = await crypto.subtle.exportKey('raw', derivedKey);
  const keyArray = new Uint8Array(keyBytes);
  const hexString = Array.from(keyArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return hexString;
}

// Global state for balance polling
let balancePollingInterval = null;
let currentBalanceETH = null;
let isBalanceRefreshing = false;

// Phase 1c: Account persistence state
let persistenceState = 'local'; // 'local' | 'syncing' | 'confirmed'
let hasTriggeredAutoPersist = false; // Track if we've already triggered auto-persist to avoid duplicates

/**
 * Persistence Status Indicators (Phase 1c Foundation)
 * AC1: Three-state indicator for account persistence (⚪ local-only, 🟡 syncing, 🟢 on Arweave)
 * AC3: Tooltip on hover explains state
 * AC4: Indicator updates when account state changes
 */

/**
 * Determine current persistence state of account
 * @returns {string} 'local' | 'syncing' | 'confirmed'
 *
 * Phase 1c Implementation: Check localStorage for arweave tx status
 *
 * State transitions:
 * - 'local': Not persisted to Arweave (no arweaveTxId found)
 * - 'syncing': Account uploaded to Arweave, transaction pending confirmation
 * - 'confirmed': Account transaction confirmed on Arweave (simplified: assume confirmed after upload)
 */
function determineAccountPersistenceState() {
  // Check manual seed account metadata for arweave transaction
  const manualSeedData = localStorage.getItem('bookish.seed.manual');
  if (manualSeedData) {
    try {
      const seedObj = JSON.parse(manualSeedData);
      if (seedObj.arweaveTxId) {
        return 'confirmed';
      }
    } catch (e) {
      console.error('Failed to parse manual seed metadata:', e);
    }
  }

  return 'local';
}

/**
 * Render persistence indicator with emoji and tooltip
 * @param {string} state - 'local' | 'syncing' | 'confirmed'
 * @returns {string} HTML string for indicator
 *
 * AC1: Three-state indicator (⚪ local-only, 🟡 syncing, 🟢 on Arweave)
 * AC2: Appears next to wallet address in Account panel
 * AC3: Tooltip on hover explains state
 */
function renderPersistenceIndicator(state = 'local') {
  const stateConfig = {
    local: {
      emoji: '⚪',
      tooltip: 'Local only—fund wallet to enable cross-device access'
    },
    syncing: {
      emoji: '🟡',
      tooltip: 'Syncing to Arweave...'
    },
    confirmed: {
      emoji: '🟢',
      tooltip: 'Backed up to Arweave—accessible from any device'
    }
  };

  const config = stateConfig[state] || stateConfig.local;
  return `<span class="persistence-indicator" title="${config.tooltip}" style="margin-left:4px;cursor:help;">${config.emoji}</span>`;
}

/**
 * FIX Problem 5: Check for BOTH passkey-based account AND manual seed
 * Wrapper around hasAccountV2() to support both workflows
 */
function hasAccountV2() {
  // Check for v2 passkey-encrypted account OR manual seed (passkey-free)
  return hasAccountV2Original() || !!localStorage.getItem('bookish.seed.manual');
}

/**
 * Initialize v2 account management UI
 */
export async function initAccountUIV2() {
  // Check PRF support
  const prfSupported = await isPRFSupported();

  // Add account management section to account panel
  await addAccountManagementSection(prfSupported);

  // Create account modal
  createAccountModal();

  // Show PRF warning if not supported
  if (!prfSupported) {
    showPRFWarningBanner();
  }

  // FIX Issue #1: Hide legacy Seed Phrase section (v1) to prevent duplicate buttons
  hideLegacySeedSection();

  // AC7: Listen for storage changes to update UI across tabs
  window.addEventListener('storage', async (e) => {
    if (e.key === 'bookish.account.v2' || e.key === 'bookish.passkey.v2') {
      const section = document.getElementById('accountManagementSectionV2');
      if (section) {
        const prfSupported = await isPRFSupported();
        await updateAccountSection(section, prfSupported);
      }
      // Also update legacy section visibility
      hideLegacySeedSection();
    }
  });
}

/**
 * Add account management section to account panel
 */
async function addAccountManagementSection(prfSupported) {
  const accountPanel = document.getElementById('accountPanel');
  if (!accountPanel) return;

  // Find or create account section
  let accountSection = document.getElementById('accountManagementSectionV2');
  if (!accountSection) {
    accountSection = document.createElement('div');
    accountSection.id = 'accountManagementSectionV2';
    accountSection.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #334155;';
    accountPanel.querySelector('div[style*="grid"]')?.after(accountSection);
  }

  // Update content based on account status
  await updateAccountSection(accountSection, prfSupported);
}

/**
 * Update account section based on current state
 */
async function updateAccountSection(section, prfSupported) {
  const hasAccount = hasAccountV2(); // AC1: Check account existence

  section.innerHTML = '';

  const title = document.createElement('strong');
  title.textContent = 'Account (v2)';
  section.appendChild(title);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';

  if (!hasAccount) {
    // AC4, AC5: Logged-out state - show Create Account and Advanced options
    if (prfSupported) {
      // FIX: Add Log In button alongside Create Account
      const loginBtn = document.createElement('button');
      loginBtn.className = 'btn secondary';
      loginBtn.textContent = 'Log In';
      loginBtn.style.cssText = 'padding:8px 16px;font-size:.875rem;';
      loginBtn.onclick = () => handleLoginV2();
      actions.appendChild(loginBtn);

      const createBtn = document.createElement('button');
      createBtn.className = 'btn';
      createBtn.textContent = 'Create Account';
      createBtn.style.cssText = 'padding:8px 16px;font-size:.875rem;';
      createBtn.onclick = () => handleCreateAccountV2();
      actions.appendChild(createBtn);

      // FIX Issue #2: AC5: Advanced section for power users - collapsible, hidden by default
      const advancedSection = document.createElement('div');
      advancedSection.style.cssText = 'width:100%;margin-top:12px;';

      // Toggle link for expanding/collapsing advanced options
      // FIX: Improved text color for visibility
      const advancedToggle = document.createElement('a');
      advancedToggle.href = '#';
      advancedToggle.style.cssText = 'font-size:.75rem;color:#e2e8f0;text-decoration:none;display:inline-block;';
      advancedToggle.textContent = '▸ Show Advanced Options';
      advancedToggle.onclick = (e) => {
        e.preventDefault();
        const content = document.getElementById('advancedOptionsContentV2');
        if (content.style.display === 'none') {
          content.style.display = 'block';
          advancedToggle.textContent = '▾ Hide Advanced Options';
        } else {
          content.style.display = 'none';
          advancedToggle.textContent = '▸ Show Advanced Options';
        }
      };

      advancedSection.appendChild(advancedToggle);

      // Advanced options content - hidden by default
      const advancedContent = document.createElement('div');
      advancedContent.id = 'advancedOptionsContentV2';
      advancedContent.style.cssText = 'display:none;padding-top:12px;border-top:1px solid #334155;margin-top:8px;';
      advancedContent.innerHTML = `
        <div style="font-size:.75rem;opacity:.7;margin-bottom:8px;">Advanced Options:</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="createNewSeedBtnV2" class="btn secondary" style="padding:6px 12px;font-size:.75rem;">Create New Seed</button>
          <button id="importSeedBtnV2" class="btn secondary" style="padding:6px 12px;font-size:.75rem;">Import Seed</button>
        </div>
      `;
      advancedSection.appendChild(advancedContent);

      section.appendChild(actions);
      section.appendChild(advancedSection);

      // Add handlers for advanced buttons (placeholders for now)
      setTimeout(() => {
        document.getElementById('createNewSeedBtnV2')?.addEventListener('click', handleCreateNewSeedV2);
        document.getElementById('importSeedBtnV2')?.addEventListener('click', handleImportSeedV2);
      }, 0);
    } else {
      // PRF not supported - show warning
      const warning = document.createElement('div');
      warning.style.cssText = 'color:#f59e0b;font-size:.75rem;padding:8px;background:#78350f1a;border-radius:4px;';
      warning.innerHTML = `
        <strong>⚠ PRF not supported</strong><br/>
        Your browser doesn't support the PRF extension required for cross-device account sync.
        <br/>Please use Chrome 108+, Edge 108+, or Safari 17+.
      `;
      section.appendChild(warning);
    }
  } else {
    // AC2, AC3: Logged-in state - show wallet info and logout button
    const metadata = getAccountV2Metadata();
    const info = document.createElement('div');
    info.style.cssText = 'font-size:.75rem;opacity:.9;margin-top:8px;';

    // Get wallet address from localStorage (we'll store it during creation)
    const walletInfo = getStoredWalletInfo();
    // AC4: Determine current persistence state (needed for persist button logic below)
    const persistenceState = determineAccountPersistenceState();

    if (walletInfo) {
      // Check if manual seed is password-protected (for lock icon)
      let lockIcon = '';
      try {
        const manualSeedData = localStorage.getItem('bookish.seed.manual');
        if (manualSeedData) {
          const seedObj = JSON.parse(manualSeedData);
          if (seedObj.encrypted) {
            lockIcon = ' 🔒';
          }
        }
      } catch (e) {
        // Legacy format or passkey account - no lock icon
      }

      // AC4: Render persistence indicator
      const persistenceIndicator = renderPersistenceIndicator(persistenceState);

      info.innerHTML = `
        <div style="margin-bottom:4px;">
          <strong>Wallet:</strong> <span id="walletAddressDisplay">${formatAddress(walletInfo.address)}</span>${persistenceIndicator}${lockIcon}
          <button id="copyAddressBtn" style="margin-left:4px;padding:2px 6px;font-size:.7rem;cursor:pointer;">Copy</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div>
            <strong>Balance:</strong> <span id="walletBalanceDisplay">Loading...</span>
          </div>
          <button id="refreshBalanceBtn" class="btn secondary" style="padding:2px 8px;font-size:.7rem;">↻ Refresh</button>
        </div>
      `;
    }
    section.appendChild(info);

    // AC2: Add logout button and optional seed viewing button
    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';

    // Phase 1c: Persist to Arweave button (manual seed accounts only, when local-only)
    if (persistenceState === 'local') {
      const manualSeedData = localStorage.getItem('bookish.seed.manual');
      if (manualSeedData) {
        const persistBtn = document.createElement('button');
        persistBtn.id = 'persistToArweaveBtn';
        persistBtn.className = 'btn primary';
        persistBtn.textContent = 'Persist Account to Arweave';
        persistBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
        persistBtn.title = 'Persist your account metadata to Arweave for cross-device access';
        persistBtn.onclick = handlePersistAccountToArweave;
        buttonRow.appendChild(persistBtn);
      }
    }

    // Optional: View Seed button (FIX Issue #5)
    const viewSeedBtn = document.createElement('button');
    viewSeedBtn.className = 'btn secondary';
    viewSeedBtn.textContent = 'View Seed Phrase';
    viewSeedBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    viewSeedBtn.title = 'View your 12-word seed phrase';
    viewSeedBtn.onclick = handleViewSeedPhrase;
    buttonRow.appendChild(viewSeedBtn);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn danger';
    logoutBtn.textContent = 'Log Out';
    logoutBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    logoutBtn.onclick = handleLogoutV2;
    buttonRow.appendChild(logoutBtn);

    section.appendChild(buttonRow);

    // Add copy handler and start balance polling (AC1, AC2, AC3)
    setTimeout(() => {
      const copyBtn = document.getElementById('copyAddressBtn');
      if (copyBtn && walletInfo) {
        copyBtn.onclick = async () => {
          try {
            await copyAddressToClipboard(walletInfo.address);
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => {copyBtn.textContent = 'Copy';}, 2000);
          } catch (error) {
            copyBtn.textContent = '✗ Failed';
            setTimeout(() => {copyBtn.textContent = 'Copy';}, 2000);
          }
        };
      }

      // AC2: Add refresh button handler
      const refreshBtn = document.getElementById('refreshBalanceBtn');
      if (refreshBtn) {
        refreshBtn.onclick = handleRefreshBalance;
      }

      // AC1: Start balance polling when logged in
      startBalancePolling();
    }, 0);
  }

  // Stop balance polling when logged out
  if (!hasAccount) {
    stopBalancePolling();
  } else {
    // AC3: Initialize persistence state from metadata
    initializePersistenceState();
  }

  if (!hasAccount && !prfSupported) {
    // Don't add actions if PRF not supported (already added warning)
  } else if (!hasAccount) {
    // Already appended actions above with Advanced section
  } else {
    // Don't append actions for logged-in (already added logout button)
  }
}

/**
 * AC3: Initialize persistence state from account metadata
 * Called when loading account UI
 */
function initializePersistenceState() {
  const metadata = getAccountV2Metadata();
  if (metadata?.arweaveTxId) {
    // We have a tx ID - check if it's confirmed
    checkArweaveAvailability(metadata.arweaveTxId).then(confirmed => {
      if (confirmed) {
        persistenceState = 'confirmed';
        hasTriggeredAutoPersist = true;
        updatePersistenceIndicatorInUI();
      } else {
        // Still syncing
        persistenceState = 'syncing';
        hasTriggeredAutoPersist = true;
        updatePersistenceIndicatorInUI();
        // Continue probing for confirmation
        startConfirmationProbing(metadata.arweaveTxId);
      }
    }).catch(error => {
      console.error('[Bookish:Phase1c] Failed to check persistence state:', error);
    });
  } else {
    // No tx ID - local only
    persistenceState = 'local';
    hasTriggeredAutoPersist = false;
  }
}

/**
 * Create account modal UI
 */
function createAccountModal() {
  // Check if modal already exists
  if (document.getElementById('accountModalV2')) return;

  const modal = document.createElement('div');
  modal.id = 'accountModalV2';
  modal.className = 'modal';
  modal.style.display = 'none';

  modal.innerHTML = `
    <div class="modal-inner" style="max-width:600px;">
      <button class="close" id="closeAccountModalV2">×</button>
      <div id="accountModalContentV2"></div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document.getElementById('closeAccountModalV2').onclick = closeAccountModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeAccountModal();
  };
}

/**
 * Show account modal with content
 */
function showAccountModal(content) {
  const modal = document.getElementById('accountModalV2');
  const contentDiv = document.getElementById('accountModalContentV2');

  if (!modal || !contentDiv) return;

  contentDiv.innerHTML = content;
  modal.style.display = 'flex';
}

/**
 * Close account modal
 */
function closeAccountModal() {
  const modal = document.getElementById('accountModalV2');
  if (modal) modal.style.display = 'none';
}

async function handleLoginV2() {
  // Check what type of account exists
  const hasManualSeed = !!localStorage.getItem('bookish.seed.manual');
  const hasPasskeyMetadata = !!localStorage.getItem('bookish.passkey.v2');

  // Manual seed workflow (passkey-free)
  if (hasManualSeed) {
    try {
      const manualSeedData = localStorage.getItem('bookish.seed.manual');
      const seedObj = JSON.parse(manualSeedData);

      if (seedObj.encrypted) {
        // AC4: Encrypted manual seed - prompt for password to login
        await promptForPasswordToLogin();
        return;
      } else {
        // Plaintext manual seed - login directly
        const mnemonic = seedObj.seed;

        // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
        const bookishSym = await deriveBookishSymFromSeed(mnemonic);
        localStorage.setItem('bookish.sym', bookishSym);

        // Initialize bookishWallet with the new symmetric key
        await window.bookishWallet?.ensure();

        // Derive wallet address for display
        const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
        const { address } = await deriveWalletFromSeed(mnemonic);
        storeWalletInfo(address);

        // Update account panel to show logged-in state
        const section = document.getElementById('accountManagementSectionV2');
        if (section) {
          await updateAccountSection(section, true);
        }

        return; // No modal needed for plaintext manual seed login
      }
    } catch (e) {
      // Legacy format (plain string) - backward compatible
      try {
        const mnemonic = localStorage.getItem('bookish.seed.manual');

        // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
        const bookishSym = await deriveBookishSymFromSeed(mnemonic);
        localStorage.setItem('bookish.sym', bookishSym);

        // Initialize bookishWallet with the new symmetric key
        await window.bookishWallet?.ensure();

        // Derive wallet address for display
        const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
        const { address } = await deriveWalletFromSeed(mnemonic);
        storeWalletInfo(address);

        // Update account panel to show logged-in state
        const section = document.getElementById('accountManagementSectionV2');
        if (section) {
          await updateAccountSection(section, true);
        }

        return;
      } catch (error) {
        console.error('Failed to load manual seed:', error);
        alert(`Error loading manual seed: ${error.message}`);
        return;
      }
    }
  }

  // Passkey workflow (v2 PRF) - requires authentication
  // Check for passkey METADATA (bookish.passkey.v2), not encrypted account data
  // After logout, account data is cleared but passkey metadata persists
  if (hasPasskeyMetadata) {
    showAccountModal(`
      <h3>Log In</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        Authenticate with your passkey to access your existing account.
        <br/><br/>
        Your passkey syncs via Google/Apple, so you can log in on any of your synced devices.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <button id="confirmLoginBtn" class="btn">Authenticate with Passkey</button>
      </div>
      <div id="loginStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
    `);

    document.getElementById('confirmLoginBtn').onclick = async () => {
      const statusDiv = document.getElementById('loginStatus');
      const btn = document.getElementById('confirmLoginBtn');

      try {
        btn.disabled = true;
        btn.textContent = 'Authenticating...';
        statusDiv.textContent = 'Authenticating with passkey...';

        // Authenticate with PRF to get encryption key
        const { authenticateWithPRF } = await import('./core/passkey_core_v2.js');
        const { encryptionKey, credentialId } = await authenticateWithPRF();

        statusDiv.textContent = 'Restoring account...';

        // Verify we can retrieve the seed (validates encryption key works)
        const { retrieveSeedV2 } = await import('./core/seed_core_v2.js');
        const mnemonic = await retrieveSeedV2();

        // Derive wallet address for display
        const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
        const { address } = await deriveWalletFromSeed(mnemonic);

        // Store wallet info for display
        storeWalletInfo(address);

        statusDiv.innerHTML = '<span style="color:#10b981;">✓ Logged in successfully!</span>';

        // Close modal after short delay
        setTimeout(() => {
          closeAccountModal();

          // Update account panel to show logged-in state
          const section = document.getElementById('accountManagementSectionV2');
          if (section) {
            updateAccountSection(section, true); // prfSupported = true (we just authenticated)
          }
        }, 1000);

      } catch (error) {
        console.error('Login failed:', error);

        let errorMessage = error.message;

        // Provide helpful error messages
        if (error.message.includes('No PRF passkey registered')) {
          errorMessage = 'No passkey found. Please create an account first.';
        } else if (error.message.includes('cancelled') || error.message.includes('timed out')) {
          errorMessage = 'Authentication was cancelled. Please try again.';
        } else if (error.message.includes('No account found')) {
          errorMessage = 'No account found on this device. Please create an account or use "Import Seed" to restore your account.';
        }

        statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${errorMessage}</span>`;
        btn.disabled = false;
        btn.textContent = 'Authenticate with Passkey';
      }
    };

    return;
  }

  // UAT Round 5 Issue #2 Fix: No account found - show Phase 1b explanation (not confusing error)
  showAccountModal(`
    <h3>Sign In Not Yet Available</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Cross-device sign-in will be available in Phase 1d after implementing Arweave account persistence.
      <br/><br/>
      <strong>Current Phase (1b):</strong> Accounts are local-only. After logout, you cannot recover your account unless you've written down your seed phrase.
      <br/><br/>
      <strong>For now:</strong>
      <ul style="margin:12px 0;padding-left:20px;">
        <li>To restore an existing account, use "Advanced Options → Import Seed"</li>
        <li>To create a new account, use "Create Account"</li>
      </ul>
    </p>
    <div style="text-align:center;margin:24px 0;">
      <button id="closeLoginNotAvailableBtn" class="btn">Close</button>
    </div>
  `);

  document.getElementById('closeLoginNotAvailableBtn').onclick = closeAccountModal;
}

/**
 * Handle create account flow (AC1-AC8)
 */
async function handleCreateAccountV2() {
  showAccountModal(`
    <h3>Create Account</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Your account will be protected with a <strong>passkey</strong> (fingerprint, face, or PIN).
      <br/><br/>
      <strong>Your seed will be encrypted automatically</strong> — no need to write anything down!
      <br/>Your passkey syncs via Google/Apple, giving you seamless cross-device access.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <button id="confirmCreateAccountBtn" class="btn">Create Account</button>
    </div>
    <div id="createAccountStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  document.getElementById('confirmCreateAccountBtn').onclick = async () => {
    const statusDiv = document.getElementById('createAccountStatus');
    const btn = document.getElementById('confirmCreateAccountBtn');

    try {
      btn.disabled = true;
      btn.textContent = 'Creating...';

      const startTime = performance.now();

      // Generate unique user ID
      const userId = generateUniqueUserId();

      // AC1-AC5: Create PRF passkey, generate seed, encrypt, store, derive wallet
      statusDiv.textContent = 'Authenticating...';
      const result = await createAccountV2(userId, 'Bookish User');

      const duration = (performance.now() - startTime) / 1000;
      console.log(`✓ Account creation: ${duration.toFixed(2)}s (AC7: <2s required)`);

      // AC7: Verify performance requirement
      if (duration >= 2.0) {
        console.warn(`⚠ AC7 VIOLATION: Creation took ${duration.toFixed(2)}s (>2s)`);
      }

      // Store wallet info for display
      storeWalletInfo(result.walletAddress);

      // FIX Issue #5: Skip forced seed phrase display for passkey users
      // Seed is automatically encrypted - no need to force manual backup
      // Users can optionally view seed via "View Backup Seed" button in Account panel

      // Mark seed as shown (user can still view it later)
      markSeedAsShownV2();

      // Close modal and show success message
      closeAccountModal();

      // Update account panel
      const section = document.getElementById('accountManagementSectionV2');
      if (section) {
        const prfSupported = await isPRFSupported();
        await updateAccountSection(section, prfSupported);
      }

      // Show success notification (optional)
      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Account created successfully!</span>';

    } catch (error) {
      console.error('Account creation failed:', error);

      let errorMessage = error.message;

      // Provide helpful error messages
      if (error.message.includes('PRF extension not supported')) {
        errorMessage = 'Your browser does not support PRF. Please use Chrome 108+, Edge 108+, or Safari 17+.';
      } else if (error.message.includes('cancelled')) {
        errorMessage = 'Account creation was cancelled. Please try again.';
      }

      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${errorMessage}</span>`;
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  };
}

/**
 * Show seed phrase modal (for optional viewing)
 * FIX Issue #5: Updated to be less alarming since passkey users don't need manual recording
 */
function showSeedPhraseModal(mnemonic) {
  const words = mnemonic.split(' ');

  showAccountModal(`
    <h3>Your Seed Phrase</h3>
    <div style="background:#f59e0b1a;border:1px solid #f59e0b;border-radius:6px;padding:16px;margin:16px 0;">
      <p style="font-size:.875rem;line-height:1.6;color:#f59e0b;margin:0;">
        <strong>Keep this private and secure.</strong>
        <br/>This seed can restore your account if you lose passkey access.
        <br/>Your passkey already encrypts this automatically — manual recording is optional.
      </p>
    </div>

    <div style="background:#0b1220;border:1px solid #334155;border-radius:6px;padding:16px;margin:16px 0;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-family:monospace;font-size:.875rem;">
        ${words.map((word, i) => `
          <div style="display:flex;gap:8px;">
            <span style="opacity:.5;">${i + 1}.</span>
            <span style="font-weight:500;">${word}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="text-align:center;margin:24px 0;display:flex;gap:8px;justify-content:center;">
      <button id="copySeedBtn" class="btn secondary">Copy to Clipboard</button>
      <button id="closeSeedDisplayBtn" class="btn">Close</button>
    </div>
  `);

  document.getElementById('copySeedBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      const btn = document.getElementById('copySeedBtn');
      const origText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = origText; }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  document.getElementById('closeSeedDisplayBtn').onclick = () => {
    closeAccountModal();
  };
}

/**
 * Show seed phrase modal for manual seed workflow (passkey-free)
 * For power users who generated/imported seeds without passkeys
 */
function showManualSeedPhrase(mnemonic, isFirstTime) {
  const words = mnemonic.split(' ');

  const warningStyle = isFirstTime
    ? 'background:#dc2626;color:white;padding:12px;border-radius:6px;margin:12px 0;font-weight:bold;'
    : 'background:#f59e0b;color:#1e1e1e;padding:12px;border-radius:6px;margin:12px 0;font-weight:bold;';

  const warningText = isFirstTime
    ? '⚠️ SAVE THIS NOW! You will not see this again. No passkey backup exists.'
    : '⚠️ Keep your seed phrase secret and secure. No passkey backup exists.';

  showAccountModal(`
    <h3>${isFirstTime ? 'Your New Seed Phrase' : 'Your Seed Phrase'}</h3>
    <div style="${warningStyle}">${warningText}</div>
    <div style="background:#0b1220;border:1px solid #334155;border-radius:6px;padding:16px;margin:16px 0;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-family:monospace;font-size:.875rem;">
        ${words.map((word, i) => `
          <div style="display:flex;gap:8px;">
            <span style="opacity:.5;">${i + 1}.</span>
            <span style="font-weight:500;">${word}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="text-align:center;margin:24px 0;display:flex;gap:8px;justify-content:center;">
      <button id="copySeedBtn" class="btn secondary">Copy to Clipboard</button>
      <button id="closeSeedDisplayBtn" class="btn">${isFirstTime ? 'I Have Saved It' : 'Close'}</button>
    </div>
  `);

  document.getElementById('copySeedBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      const btn = document.getElementById('copySeedBtn');
      const origText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = origText; }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  document.getElementById('closeSeedDisplayBtn').onclick = () => {
    closeAccountModal();

    // Update account panel to show logged-in state
    const section = document.getElementById('accountManagementSectionV2');
    if (section) {
      updateAccountSection(section, true);
    }
  };
}

/**
 * Show PRF warning banner
 */
function showPRFWarningBanner() {
  const accountPanel = document.getElementById('accountPanel');
  if (!accountPanel) return;

  const banner = document.createElement('div');
  banner.style.cssText = `
    background:#78350f1a;
    border:1px solid #f59e0b;
    border-radius:6px;
    padding:12px;
    margin-bottom:12px;
    font-size:.75rem;
    color:#f59e0b;
  `;
  banner.innerHTML = `
    <strong>⚠ Cross-device sync unavailable</strong><br/>
    Your browser doesn't support the PRF extension needed for cross-device passkey sync.
    <br/>For full functionality, please use Chrome 108+, Edge 108+, or Safari 17+.
  `;

  accountPanel.insertBefore(banner, accountPanel.firstChild);
}

/**
 * Store wallet info in localStorage (for display purposes)
 */
function storeWalletInfo(address) {
  localStorage.setItem('bookish.wallet.v2', JSON.stringify({
    address,
    created: Date.now(),
  }));
}

/**
 * Get stored wallet info
 */
function getStoredWalletInfo() {
  const info = localStorage.getItem('bookish.wallet.v2');
  if (!info) return null;

  try {
    return JSON.parse(info);
  } catch {
    return null;
  }
}

/**
 * Fetch and update wallet balance (AC1, AC2)
 * @param {boolean} isManualRefresh - Whether this is a manual refresh (for button feedback)
 * @returns {Promise<void>}
 */
async function fetchAndUpdateBalance(isManualRefresh = false) {
  const walletInfo = getStoredWalletInfo();
  if (!walletInfo || !walletInfo.address) {
    return;
  }

  try {
    // Fetch balance from Base Sepolia
    const { balanceETH } = await getWalletBalance(walletInfo.address);
    currentBalanceETH = balanceETH;

    // Update UI
    updateBalanceDisplay(balanceETH);

    // AC1: Check if we should trigger auto-persist
    await checkAndTriggerAutoPersist(balanceETH);
  } catch (error) {
    console.error('Balance fetch failed:', error);
    // On error, show current balance or 0
    updateBalanceDisplay(currentBalanceETH || '0');
  }
}

/**
 * Update balance display in UI (AC1, AC4)
 * @param {string} balanceETH - Balance in ETH
 */
function updateBalanceDisplay(balanceETH) {
  const balanceElement = document.getElementById('walletBalanceDisplay');
  if (!balanceElement) return;

  const balance = parseFloat(balanceETH);
  const isFunded = balance > DUST_THRESHOLD_ETH;

  // Smart formatting: use Gwei for small amounts, ETH for larger amounts
  let formattedBalance;
  if (balance < 0.001) {
    // Convert to Gwei for readability (1 ETH = 1 billion Gwei)
    const balanceGwei = balance * 1e9;
    formattedBalance = `${balanceGwei.toFixed(0)} Gwei`;
  } else {
    // Show in ETH with appropriate precision
    formattedBalance = `${balance.toFixed(4)} ETH`;
  }

  // Format balance display with funding status
  const fundingStatus = isFunded
    ? '<span style="color:#10b981;">✓ funded</span>'
    : '<span style="opacity:.6;">(unfunded)</span>';

  balanceElement.innerHTML = `${formattedBalance} ${fundingStatus}`;
}

/**
 * Handle manual balance refresh (AC2)
 */
async function handleRefreshBalance() {
  if (isBalanceRefreshing) return; // Prevent multiple simultaneous refreshes

  isBalanceRefreshing = true;
  const refreshBtn = document.getElementById('refreshBalanceBtn');

  if (refreshBtn) {
    refreshBtn.textContent = 'Refreshing...';
    refreshBtn.disabled = true;
  }

  try {
    await fetchAndUpdateBalance(true);
  } finally {
    isBalanceRefreshing = false;
    if (refreshBtn) {
      refreshBtn.textContent = '↻ Refresh';
      refreshBtn.disabled = false;
    }
  }
}

/**
 * Start balance polling (AC1)
 */
function startBalancePolling() {
  // Stop existing polling if any
  stopBalancePolling();

  // Fetch immediately
  fetchAndUpdateBalance();

  // Start polling every 30 seconds
  balancePollingInterval = setInterval(() => {
    fetchAndUpdateBalance();
  }, BALANCE_POLL_INTERVAL_MS);
}

/**
 * Stop balance polling (AC1)
 */
function stopBalancePolling() {
  if (balancePollingInterval) {
    clearInterval(balancePollingInterval);
    balancePollingInterval = null;
  }
}

/**
 * AC1: Persist account to Arweave (auto-triggered by funding)
 * Encrypts and uploads seed bundle to Arweave via Irys
 * @returns {Promise<{txId: string}>}
 */
async function persistAccountToArweave() {
  try {
    console.info('[Bookish:Phase1c] Starting account persistence to Arweave...');

    // Determine account type and get appropriate encryption key
    const hasPasskeyAccount = !!localStorage.getItem('bookish.account.v2');
    const hasManualSeed = !!localStorage.getItem('bookish.seed.manual');

    if (!hasPasskeyAccount && !hasManualSeed) {
      throw new Error('No account found. Please create or import an account first.');
    }

    let encryptedPayload;
    let tags = [];
    let mnemonic;

    if (hasPasskeyAccount) {
      // FIX UAT Bug #2: PASSKEY ACCOUNT - Use PRF-derived encryption key
      console.info('[Bookish:Phase1c] Passkey account detected - using PRF encryption');

      // Import required functions
      const { retrieveSeedV2, setArweaveTxId } = await import('./core/seed_core_v2.js');
      const { authenticateWithPRF } = await import('./core/passkey_core_v2.js');
      const { encryptJsonToBytes } = await import('./core/crypto_core.js');

      // Authenticate with PRF to get encryption key
      // Note: retrieveSeedV2 already calls authenticateWithPRF internally,
      // so we get the encryption key from the same authentication
      const { encryptionKey } = await authenticateWithPRF();

      // Get seed (already authenticated, should use cached credential)
      mnemonic = await retrieveSeedV2();

      // Prepare seed bundle
      const seedBundle = {
        mnemonic,
        created: Date.now(),
        version: '0.1.0',
        type: 'bookish-account-backup',
        accountType: 'prf-passkey',
      };

      // FIX: Encrypt with PRF key (NOT bookish.sym!)
      encryptedPayload = await encryptJsonToBytes(encryptionKey, seedBundle);

      // Add account-specific tags
      tags = [
        { name: 'App-Name', value: 'bookish' },
        { name: 'Schema-Name', value: 'account' },
        { name: 'Schema-Version', value: '0.1.0' },
        { name: 'Visibility', value: 'private' },
        { name: 'Account-Type', value: 'prf-passkey' },
        { name: 'Enc', value: 'aes-256-gcm-prf' }, // Indicate PRF encryption
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'Type', value: 'account-backup' },
      ];

      // Upload to Arweave
      if (!window.bookishIrys) {
        throw new Error('Irys client not available. Cannot upload to Arweave.');
      }

      const walletInfo = getStoredWalletInfo();
      if (walletInfo?.address) {
        tags.push({ name: 'Pub-Addr', value: walletInfo.address.toLowerCase() });
      }

      const result = await window.bookishIrys.upload(encryptedPayload, tags);
      const txId = result.id;

      console.info('[Bookish:Phase1c] Passkey account persisted to Arweave', { txId });

      // AC2: Store transaction ID in account metadata
      setArweaveTxId(txId);

      return { txId };

    } else if (hasManualSeed) {
      // FIX UAT Bug #3: MANUAL SEED ACCOUNT - Use seed-derived encryption key
      console.info('[Bookish:Phase1c] Manual seed account detected - using seed-derived encryption');

      const manualSeedData = localStorage.getItem('bookish.seed.manual');
      const seedObj = JSON.parse(manualSeedData);

      if (seedObj.encrypted) {
        // Password-protected manual seed - cannot auto-persist
        throw new Error('Password-protected manual seed accounts cannot auto-persist. Please use passkey account for automatic backup.');
      }

      // Get plaintext seed
      mnemonic = seedObj.seed;

      // Prepare seed bundle
      const seedBundle = {
        mnemonic,
        created: Date.now(),
        version: '0.1.0',
        type: 'bookish-account-backup',
        accountType: 'manual-seed-plaintext',
      };

      // FIX: Derive symmetric key from seed phrase for account encryption
      const { deriveAccountEncryptionKey, encryptJsonToBytes } = await import('./core/crypto_core.js');
      const accountEncKey = await deriveAccountEncryptionKey(mnemonic);

      // Encrypt with seed-derived key
      encryptedPayload = await encryptJsonToBytes(accountEncKey, seedBundle);

      // Add account-specific tags
      tags = [
        { name: 'App-Name', value: 'bookish' },
        { name: 'Schema-Name', value: 'account' },
        { name: 'Schema-Version', value: '0.1.0' },
        { name: 'Visibility', value: 'private' },
        { name: 'Account-Type', value: 'manual-seed' },
        { name: 'Enc', value: 'aes-256-gcm-seed-derived' }, // Indicate seed-derived encryption
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'Type', value: 'account-backup' },
      ];

      // Upload to Arweave
      if (!window.bookishIrys) {
        throw new Error('Irys client not available. Cannot upload to Arweave.');
      }

      const walletInfo = getStoredWalletInfo();
      if (walletInfo?.address) {
        tags.push({ name: 'Pub-Addr', value: walletInfo.address.toLowerCase() });
      }

      const result = await window.bookishIrys.upload(encryptedPayload, tags);
      const txId = result.id;

      console.info('[Bookish:Phase1c] Manual seed account persisted to Arweave', { txId });

      // Store transaction ID in manual seed metadata
      seedObj.arweaveTxId = txId;
      seedObj.persistedAt = Date.now();
      localStorage.setItem('bookish.seed.manual', JSON.stringify(seedObj));

      return { txId };
    }

  } catch (error) {
    console.error('[Bookish:Phase1c] Failed to persist account:', error);
    throw error;
  }
}

/**
 * AC1: Check if balance exceeds dust threshold and trigger auto-persist
 * Called after balance is fetched
 * @param {string} balanceETH - Current balance in ETH
 */
async function checkAndTriggerAutoPersist(balanceETH) {
  const balance = parseFloat(balanceETH);
  const isFunded = balance > DUST_THRESHOLD_ETH;

  // Only trigger once when balance first exceeds threshold
  if (isFunded && !hasTriggeredAutoPersist) {
    // Check if already persisted
    const metadata = getAccountV2Metadata();
    if (metadata?.arweaveTxId) {
      hasTriggeredAutoPersist = true; // Already persisted
      return;
    }

    console.info('[Bookish:Phase1c] Balance exceeds dust threshold. Triggering auto-persist...');
    hasTriggeredAutoPersist = true;

    try {
      // AC3: Update indicator to syncing
      persistenceState = 'syncing';
      updatePersistenceIndicatorInUI();

      // AC1: Persist to Arweave
      const { txId } = await persistAccountToArweave();

      // AC3: Start probing for confirmation
      startConfirmationProbing(txId);

    } catch (error) {
      console.error('[Bookish:Phase1c] Auto-persist failed:', error);

      // Reset state on failure
      persistenceState = 'local';
      hasTriggeredAutoPersist = false;
      updatePersistenceIndicatorInUI();

      // AC4: Show error notification
      showPersistenceErrorBanner(error.message);
    }
  }
}

/**
 * AC3: Update persistence indicator in UI
 */
function updatePersistenceIndicatorInUI() {
  const indicator = document.querySelector('.persistence-indicator');
  if (indicator) {
    const state = determineAccountPersistenceState();
    const stateConfig = {
      local: {
        emoji: '⚪',
        tooltip: 'Local only—fund wallet to enable cross-device access'
      },
      syncing: {
        emoji: '🟡',
        tooltip: 'Syncing to Arweave...'
      },
      confirmed: {
        emoji: '🟢',
        tooltip: 'Backed up to Arweave—accessible from any device'
      }
    };
    const config = stateConfig[state] || stateConfig.local;
    indicator.innerHTML = config.emoji;
    indicator.title = config.tooltip;
  }
}

/**
 * AC3: Start probing Arweave for confirmation
 * @param {string} txId - Arweave transaction ID
 */
function startConfirmationProbing(txId) {
  // Poll every 15 seconds for up to 5 minutes
  const PROBE_INTERVAL_MS = 15000;
  const MAX_PROBE_DURATION_MS = 300000; // 5 minutes
  const startTime = Date.now();

  const probeInterval = setInterval(async () => {
    try {
      // Check if transaction is available on Arweave
      const available = await checkArweaveAvailability(txId);

      if (available) {
        console.info('[Bookish:Phase1c] Account confirmed on Arweave', { txId });

        // AC3: Update indicator to confirmed
        persistenceState = 'confirmed';
        updatePersistenceIndicatorInUI();

        // AC4: Show success banner
        showPersistenceSuccessBanner(txId);

        clearInterval(probeInterval);
      } else if (Date.now() - startTime > MAX_PROBE_DURATION_MS) {
        console.warn('[Bookish:Phase1c] Confirmation polling timed out', { txId });
        clearInterval(probeInterval);

        // Keep syncing state - user can manually check later
      }
    } catch (error) {
      console.error('[Bookish:Phase1c] Confirmation probe error:', error);
    }
  }, PROBE_INTERVAL_MS);
}

/**
 * Check if transaction is available on Arweave gateway
 * @param {string} txId - Transaction ID
 * @returns {Promise<boolean>}
 */
async function checkArweaveAvailability(txId) {
  try {
    // Check Irys gateway first (faster)
    const irysResp = await fetch(`https://gateway.irys.xyz/${txId}`, { method: 'HEAD' });
    if (irysResp.ok) return true;

    // Fallback to Arweave gateway
    const arweaveResp = await fetch(`https://arweave.net/${txId}`, { method: 'HEAD' });
    return arweaveResp.ok;
  } catch {
    return false;
  }
}

/**
 * AC4: Show success banner when account is confirmed on Arweave
 * @param {string} txId - Arweave transaction ID
 */
function showPersistenceSuccessBanner(txId) {
  // Check if banner already exists
  if (document.getElementById('persistenceSuccessBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'persistenceSuccessBanner';
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #10b981;
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10000;
    max-width: 500px;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 12px;
  `;
  banner.innerHTML = `
    <span style="font-size: 1.5rem;">🟢</span>
    <div style="flex: 1;">
      <strong>Account backed up to Arweave</strong>
      <br/>
      Your account is now accessible from any device.
      <br/>
      <a href="https://viewblock.io/arweave/tx/${txId}" target="_blank" style="color: white; text-decoration: underline;">View transaction</a>
    </div>
    <button id="dismissPersistenceBanner" style="background: transparent; border: none; color: white; cursor: pointer; font-size: 1.2rem; padding: 0 8px;">&times;</button>
  `;

  document.body.appendChild(banner);

  // Dismiss handler
  document.getElementById('dismissPersistenceBanner').onclick = () => {
    banner.remove();
  };

  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (banner.parentNode) {
      banner.remove();
    }
  }, 10000);
}

/**
 * Show error banner when persistence fails
 * @param {string} errorMessage - Error message
 */
function showPersistenceErrorBanner(errorMessage) {
  // Check if banner already exists
  if (document.getElementById('persistenceErrorBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'persistenceErrorBanner';
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #ef4444;
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10000;
    max-width: 500px;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 12px;
  `;
  banner.innerHTML = `
    <span style="font-size: 1.5rem;">⚠️</span>
    <div style="flex: 1;">
      <strong>Failed to back up account</strong>
      <br/>
      ${errorMessage}
    </div>
    <button id="dismissErrorBanner" style="background: transparent; border: none; color: white; cursor: pointer; font-size: 1.2rem; padding: 0 8px;">&times;</button>
  `;

  document.body.appendChild(banner);

  // Dismiss handler
  document.getElementById('dismissErrorBanner').onclick = () => {
    banner.remove();
  };

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (banner.parentNode) {
      banner.remove();
    }
  }, 8000);
}

/**
 * FIX Issue #5: Handle optional backup seed viewing
 * Supports BOTH manual seed (no auth) and passkey-encrypted accounts
 * UAT Round 5 Issue #1 Fix: Check for manual seed first
 */
async function handleViewSeedPhrase() {
  // AC4: Check for manual seed (may be encrypted or plaintext)
  const manualSeedData = localStorage.getItem('bookish.seed.manual');
  if (manualSeedData) {
    try {
      const seedObj = JSON.parse(manualSeedData);

      if (seedObj.encrypted) {
        // AC4: Encrypted manual seed - prompt for password
        await promptForPasswordToDecrypt();
        return;
      } else {
        // Plaintext manual seed - show directly
        showSeedPhraseModal(seedObj.seed);
        return;
      }
    } catch (e) {
      // Legacy format (plain string) - backward compatible
      showSeedPhraseModal(manualSeedData);
      return;
    }
  }

  // Passkey-encrypted account - require authentication
  showAccountModal(`
    <h3>View Backup Seed Phrase</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Your seed is automatically encrypted with your passkey.
      <br/>You can view it here for manual backup if desired.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <button id="confirmViewSeedBtn" class="btn">Authenticate & View Seed</button>
    </div>
    <div id="viewSeedStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  document.getElementById('confirmViewSeedBtn').onclick = async () => {
    const statusDiv = document.getElementById('viewSeedStatus');
    const btn = document.getElementById('confirmViewSeedBtn');

    try {
      btn.disabled = true;
      btn.textContent = 'Authenticating...';

      // Import the function to retrieve seed (requires passkey auth)
      const { retrieveSeedV2 } = await import('./core/seed_core_v2.js');
      const mnemonic = await retrieveSeedV2();

      // Show seed phrase modal
      showSeedPhraseModal(mnemonic);

    } catch (error) {
      console.error('Failed to retrieve seed:', error);

      let errorMessage = error.message;

      if (error.message.includes('cancelled')) {
        errorMessage = 'Authentication was cancelled.';
      }

      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${errorMessage}</span>`;
      btn.disabled = false;
      btn.textContent = 'Authenticate & View Seed';
    }
  };
}

/**
 * AC4: Helper function to prompt for password and decrypt seed for viewing
 */
async function promptForPasswordToDecrypt() {
  showAccountModal(`
    <h3>Enter Password to View Seed</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Your seed is password-protected. Enter your password to view it.
    </p>
    <div style="margin:16px 0;">
      <label style="display:block;font-size:.875rem;margin-bottom:6px;"><strong>Password:</strong></label>
      <div style="position:relative;">
        <input type="password" id="decryptPasswordInput"
          style="width:100%;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.875rem;"
          placeholder="Enter password" />
        <button id="toggleDecryptPassword" type="button"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;"
          title="Show/hide password">👁️</button>
      </div>
    </div>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmDecryptBtn" class="btn">View Seed</button>
    </div>
    <div id="decryptStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  // Password visibility toggle
  document.getElementById('toggleDecryptPassword').onclick = () => {
    const input = document.getElementById('decryptPasswordInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  document.getElementById('confirmDecryptBtn').onclick = async () => {
    const passwordInput = document.getElementById('decryptPasswordInput');
    const statusDiv = document.getElementById('decryptStatus');
    const btn = document.getElementById('confirmDecryptBtn');

    const password = passwordInput.value;

    if (!password) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a password</span>';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Decrypting...';
      statusDiv.textContent = 'Decrypting seed...';

      // Get encrypted seed from localStorage
      const manualSeedData = localStorage.getItem('bookish.seed.manual');
      const seedObj = JSON.parse(manualSeedData);

      // AC4: Decrypt with password
      const mnemonic = await decryptWithPassword(
        seedObj.iv,
        seedObj.salt,
        seedObj.ciphertext,
        password
      );

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Decrypted successfully!</span>';

      // Show seed phrase modal
      setTimeout(() => {
        showSeedPhraseModal(mnemonic);
      }, 500);

    } catch (error) {
      console.error('Failed to decrypt seed:', error);
      // AC4: On incorrect password, show error and allow retry
      statusDiv.innerHTML = '<span style="color:#ef4444;">❌ Incorrect password. Please try again.</span>';
      btn.disabled = false;
      btn.textContent = 'View Seed';
    }
  };
}

/**
 * AC4: Helper function to prompt for password and login with encrypted seed
 */
async function promptForPasswordToLogin() {
  showAccountModal(`
    <h3>Enter Password to Log In</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Your seed is password-protected. Enter your password to log in.
    </p>
    <div style="margin:16px 0;">
      <label style="display:block;font-size:.875rem;margin-bottom:6px;"><strong>Password:</strong></label>
      <div style="position:relative;">
        <input type="password" id="loginPasswordInput"
          style="width:100%;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.875rem;"
          placeholder="Enter password" />
        <button id="toggleLoginPassword" type="button"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;"
          title="Show/hide password">👁️</button>
      </div>
    </div>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmLoginPasswordBtn" class="btn">Log In</button>
    </div>
    <div id="loginPasswordStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  // Password visibility toggle
  document.getElementById('toggleLoginPassword').onclick = () => {
    const input = document.getElementById('loginPasswordInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  document.getElementById('confirmLoginPasswordBtn').onclick = async () => {
    const passwordInput = document.getElementById('loginPasswordInput');
    const statusDiv = document.getElementById('loginPasswordStatus');
    const btn = document.getElementById('confirmLoginPasswordBtn');

    const password = passwordInput.value;

    if (!password) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a password</span>';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Decrypting...';
      statusDiv.textContent = 'Decrypting seed...';

      // Get encrypted seed from localStorage
      const manualSeedData = localStorage.getItem('bookish.seed.manual');
      const seedObj = JSON.parse(manualSeedData);

      // AC4: Decrypt with password
      const mnemonic = await decryptWithPassword(
        seedObj.iv,
        seedObj.salt,
        seedObj.ciphertext,
        password
      );

      statusDiv.textContent = 'Deriving wallet...';

      // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
      const bookishSym = await deriveBookishSymFromSeed(mnemonic);
      localStorage.setItem('bookish.sym', bookishSym);

      // Initialize bookishWallet with the new symmetric key
      await window.bookishWallet?.ensure();

      // Derive wallet address for display
      const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
      const { address } = await deriveWalletFromSeed(mnemonic);
      storeWalletInfo(address);

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Logged in successfully!</span>';

      // Close modal and refresh UI
      setTimeout(() => {
        closeAccountModal();

        // Update account panel to show logged-in state
        const section = document.getElementById('accountManagementSectionV2');
        if (section) {
          updateAccountSection(section, true);
        }
      }, 1000);

    } catch (error) {
      console.error('Failed to decrypt seed:', error);
      // AC4: On incorrect password, show error and allow retry
      statusDiv.innerHTML = '<span style="color:#ef4444;">❌ Incorrect password. Please try again.</span>';
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  };
}

/**
 * Phase 1c Slice 1a: Handle manual backup of account metadata to Arweave
 * Manual seed accounts only - uses seed-derived encryption
 */
async function handlePersistAccountToArweave() {
  const btn = document.getElementById('persistToArweaveBtn');
  const originalText = btn.textContent;

  try {
    btn.disabled = true;
    btn.textContent = '⏳ Persisting...';

    console.log('[Bookish:Phase1c] Starting manual account persistence to Arweave...');

    // Get manual seed data
    const manualSeedData = localStorage.getItem('bookish.seed.manual');
    if (!manualSeedData) {
      throw new Error('No manual seed account found');
    }

    const seedObj = JSON.parse(manualSeedData);
    let mnemonic;

    // Handle password-protected seeds
    if (seedObj.encrypted) {
      // Prompt for password to decrypt seed
      const password = await promptForPasswordAsync('Enter your password to persist account');
      if (!password) {
        throw new Error('Password required for persistence');
      }

      // Decrypt seed
      const { decryptWithPassword } = await import('./core/crypto_utils.js');
      mnemonic = await decryptWithPassword(
        seedObj.iv,
        seedObj.salt,
        seedObj.ciphertext,
        password
      );
    } else {
      // Plaintext seed
      mnemonic = seedObj.seed;
    }

    // Derive wallet address
    const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
    const { address } = await deriveWalletFromSeed(mnemonic);

    // AC1: Derive hashed address lookup key using unified "bookish" salt
    console.log('[Bookish:Phase1c] Deriving hashed address lookup key...');
    const { hexToBytes, importAesKey } = await import('./core/crypto_core.js');

    // Calculate SHA-256(address + "bookish") for unified lookup
    const encoder = new TextEncoder();
    const lookupData = encoder.encode(address.toLowerCase() + 'bookish');
    const hashBuffer = await crypto.subtle.digest('SHA-256', lookupData);
    const hashArray = new Uint8Array(hashBuffer);
    const hashedLookupKey = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    console.log('[Bookish:Phase1c] Hashed lookup key:', hashedLookupKey.substring(0, 16) + '...');

    // AC2: Use bookish.sym for unified encryption (already derived from seed)
    console.log('[Bookish:Phase1c] Loading bookish.sym for unified encryption...');
    const bookishSymHex = localStorage.getItem('bookish.sym');
    if (!bookishSymHex) {
      throw new Error('bookish.sym not found - please log in again');
    }
    const { encryptJsonToBytes } = await import('./core/crypto_core.js');
    const symKeyBytes = hexToBytes(bookishSymHex);
    const encryptionKey = await importAesKey(symKeyBytes);

    // Create account metadata (schema v0.1.0)
    const accountMetadata = {
      schemaVersion: '0.1.0',
      profile: {
        name: null,
        avatar: null,
        bio: null
      },
      settings: {
        theme: 'auto',
        privacy: 'public'
      },
      bookmarks: [],
      created: seedObj.created || Date.now()
    };

    // Encrypt account metadata
    console.log('[Bookish:Phase1c] Encrypting account metadata...');
    const encryptedPayload = await encryptJsonToBytes(encryptionKey, accountMetadata);

    // AC4: Prepare Arweave tags (unified encryption architecture)
    const tags = [
      { name: 'App-Name', value: 'bookish' },
      { name: 'Type', value: 'account-metadata' },
      { name: 'Account-Lookup-Key', value: hashedLookupKey },
      { name: 'Enc', value: 'aes-256-gcm' },
      { name: 'Schema-Version', value: '0.1.0' },
      { name: 'Pub-Addr', value: address.toLowerCase() }
    ];

    // AC4: Upload to Arweave via Irys
    console.log('[Bookish:Phase1c] Uploading to Arweave via Irys...');
    btn.textContent = '⏳ Uploading to Arweave...';

    const result = await window.bookishIrys.upload(encryptedPayload, tags);
    const txId = result.id;

    console.log('[Bookish:Phase1c] Account persisted to Arweave:', txId);

    // AC5: Store tx ID in bookish.seed.manual metadata
    seedObj.arweaveTxId = txId;
    seedObj.persistedAt = Date.now();
    localStorage.setItem('bookish.seed.manual', JSON.stringify(seedObj));

    // AC5: Update persistence indicator to 'syncing' first
    console.log('[Bookish:Phase1c] Updating persistence indicator: 🟡');
    updateAccountPersistenceIndicator('syncing');

    // Wait a moment then update to 'confirmed'
    setTimeout(() => {
      console.log('[Bookish:Phase1c] Updating persistence indicator: 🟢');
      updateAccountPersistenceIndicator('confirmed');

      // AC5: Show success banner
      showSuccessBanner('Account persisted to Arweave');

      // Refresh account panel to hide persist button
      const section = document.getElementById('accountManagementSectionV2');
      if (section) {
        updateAccountSection(section, true);
      }
    }, 2000);

    btn.textContent = '✓ Persisted!';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 3000);

  } catch (error) {
    console.error('[Bookish:Phase1c] Failed to persist account:', error);
    btn.textContent = '✗ Persist failed';
    btn.disabled = false;

    setTimeout(() => {
      btn.textContent = originalText;
    }, 3000);

    showErrorBanner(`Failed to persist account: ${error.message}`);
  }
}

/**
 * Helper: Prompt for password asynchronously
 * @param {string} message - Prompt message
 * @returns {Promise<string|null>} - Password or null if cancelled
 */
function promptForPasswordAsync(message) {
  return new Promise((resolve) => {
    showAccountModal(`
      <h3>${message}</h3>
      <div style="margin:16px 0;">
        <label style="display:block;font-size:.875rem;margin-bottom:6px;"><strong>Password:</strong></label>
        <div style="position:relative;">
          <input type="password" id="promptPasswordInput"
            style="width:100%;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.875rem;"
            placeholder="Enter password" />
          <button id="togglePromptPassword" type="button"
            style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;"
            title="Show/hide password">👁️</button>
        </div>
      </div>
      <div style="text-align:center;margin:20px 0;display:flex;gap:8px;justify-content:center;">
        <button id="confirmPasswordBtn" class="btn primary">Continue</button>
        <button id="cancelPasswordBtn" class="btn secondary">Cancel</button>
      </div>
    `);

    // Password visibility toggle
    document.getElementById('togglePromptPassword').onclick = () => {
      const input = document.getElementById('promptPasswordInput');
      input.type = input.type === 'password' ? 'text' : 'password';
    };

    // Confirm button
    document.getElementById('confirmPasswordBtn').onclick = () => {
      const password = document.getElementById('promptPasswordInput').value;
      closeAccountModal();
      resolve(password);
    };

    // Cancel button
    document.getElementById('cancelPasswordBtn').onclick = () => {
      closeAccountModal();
      resolve(null);
    };

    // Enter key support
    document.getElementById('promptPasswordInput').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('confirmPasswordBtn').click();
      }
    });
  });
}

/**
 * Helper: Update persistence indicator in account panel
 * @param {string} state - 'local' | 'syncing' | 'confirmed'
 */
function updateAccountPersistenceIndicator(state) {
  // Force re-render of account section to reflect new persistence state
  const section = document.getElementById('accountManagementSectionV2');
  if (section) {
    // Clear and rebuild section to pick up new state from determineAccountPersistenceState()
    section.innerHTML = '';
    updateAccountSection(section, true);
  }
}

/**
 * Helper: Show success banner
 * @param {string} message - Success message
 */
function showSuccessBanner(message) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#10b981;color:white;padding:12px 24px;border-radius:6px;font-size:.875rem;z-index:10000;box-shadow:0 4px 6px rgba(0,0,0,0.3);';
  banner.textContent = `✓ ${message}`;
  document.body.appendChild(banner);

  setTimeout(() => {
    banner.remove();
  }, 5000);
}

/**
 * Helper: Show error banner
 * @param {string} message - Error message
 */
function showErrorBanner(message) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ef4444;color:white;padding:12px 24px;border-radius:6px;font-size:.875rem;z-index:10000;box-shadow:0 4px 6px rgba(0,0,0,0.3);';
  banner.textContent = `✗ ${message}`;
  document.body.appendChild(banner);

  setTimeout(() => {
    banner.remove();
  }, 5000);
}

/**
 * AC8: Handle logout action
 * Phase 1b (local-only): Warn user about permanent data loss (no Arweave persistence yet)
 */
async function handleLogoutV2() {
  // Show confirmation modal with strong warning for Phase 1b (local-only)
  showAccountModal(`
    <h3>⚠️ Warning: Permanent Data Loss</h3>
    <div style="background:#dc2626;color:white;padding:16px;border-radius:6px;margin:16px 0;font-weight:bold;">
      ⚠️ YOU HAVE NOT PERSISTED YOUR ACCOUNT TO ARWEAVE
    </div>
    <p style="font-size:.875rem;line-height:1.6;margin:12px 0;">
      <strong>After logging out, you will lose this account and all its entries, UNRECOVERABLY.</strong>
      <br/><br/>
      <strong>Phase 1b (Local-Only):</strong> Your account exists only on this device. Cross-device sign-in and Arweave persistence will be available in Phase 1c/1d after funding is implemented.
      <br/><br/>
      <strong>To preserve your account:</strong>
      <ul style="margin:8px 0;padding-left:20px;">
        <li>Use "Advanced Options → View Backup Seed" to write down your 12-word seed phrase</li>
        <li>Store it securely offline</li>
        <li>Later, use "Import Seed" to restore</li>
      </ul>
    </p>
    <p style="font-size:.875rem;line-height:1.6;opacity:.85;margin:12px 0;">
      Are you sure you want to log out and permanently delete your local account?
    </p>
    <div style="text-align:center;margin-top:16px;display:flex;gap:8px;justify-content:center;">
      <button id="cancelLogoutBtnV2" class="btn secondary">Cancel</button>
      <button id="confirmLogoutBtnV2" class="btn danger">Log Out (Permanent)</button>
    </div>
  `);

  document.getElementById('cancelLogoutBtnV2').onclick = () => {
    closeAccountModal();
  };

  document.getElementById('confirmLogoutBtnV2').onclick = () => {
    performLogoutV2();
  };
}

/**
 * AC8: Perform logout - clear account data but preserve passkey metadata
 * FIX Problem 1: Do NOT clear bookish.passkey.v2 so users can log back in
 */
async function performLogoutV2() {
  // Stop balance polling (AC1)
  stopBalancePolling();

  // Clear v2 encrypted account data
  clearAccountV2(); // Clears bookish.account.v2

  // FIX Problem 1: Do NOT clear passkey metadata (bookish.passkey.v2)
  // Users need this metadata to log back in
  // clearPasskeyV2(); // REMOVED - keep passkey metadata

  // Clear manual seed storage (passkey-free workflow)
  localStorage.removeItem('bookish.seed.manual');

  // Clear wallet display info
  localStorage.removeItem('bookish.wallet.v2');

  // Clear seed shown flag
  localStorage.removeItem('bookish.seedShown.v2');

  // Clear balance state
  currentBalanceETH = null;

  // Close modal
  closeAccountModal();

  // AC7: Refresh account panel to show logged-out state
  const section = document.getElementById('accountManagementSectionV2');
  if (section) {
    const prfSupported = await isPRFSupported();
    await updateAccountSection(section, prfSupported);
  }
}

/**
 * AC5: Handle "Create New Seed" button - Passkey-Free Manual Seed Generation
 * FIX Problem 2: Power users want manual seed WITHOUT passkey involvement
 * NO passkey creation, NO Google/Apple sync, just generate 12 words and store locally
 */
async function handleCreateNewSeedV2() {
  // AC1: Optional password protection prompt
  showAccountModal(`
    <h3>Create New Seed Phrase</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      A 12-word seed phrase will be generated for you.
      <br/><br/>
      <strong>⚠️ Write it down and keep it safe!</strong>
      <br/>This is the ONLY way to recover your account. No passkey, no automatic sync.
      <br/>You are in full control (and full responsibility).
    </p>
    <div style="margin:20px 0;padding:16px;background:#1e293b;border-radius:6px;border:1px solid #334155;">
      <p style="font-size:.875rem;margin-bottom:12px;"><strong>Protect this seed with a password?</strong> (optional)</p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button id="passwordYesBtn" class="btn secondary" style="padding:8px 16px;">Yes, protect with password</button>
        <button id="passwordNoBtn" class="btn secondary" style="padding:8px 16px;">No, store without password</button>
      </div>
    </div>
    <div id="createSeedStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  const handlePasswordChoice = async (usePassword) => {
    const statusDiv = document.getElementById('createSeedStatus');

    try {
      // Generate 12-word BIP39 seed (NO passkey involved)
      const { generateSeed } = await import('./core/seed_core.js');
      const mnemonic = generateSeed(); // Returns 12 random BIP39 words

      if (usePassword) {
        // Show password input modal
        await promptForPasswordAndStore(mnemonic, 'create');
      } else {
        // Store in plaintext localStorage (passkey-free manual workflow)
        localStorage.setItem('bookish.seed.manual', JSON.stringify({
          encrypted: false,
          seed: mnemonic
        }));

        // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
        const bookishSym = await deriveBookishSymFromSeed(mnemonic);
        localStorage.setItem('bookish.sym', bookishSym);

        // Initialize bookishWallet with the new symmetric key
        await window.bookishWallet?.ensure();

        // Derive wallet address for display
        const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
        const { address } = await deriveWalletFromSeed(mnemonic);
        storeWalletInfo(address);

        statusDiv.innerHTML = '<span style="color:#10b981;">✓ Seed phrase generated!</span>';

        // Show seed phrase to user (they MUST write it down)
        setTimeout(() => {
          showManualSeedPhrase(mnemonic, true);
        }, 800);
      }

    } catch (error) {
      console.error('Failed to create seed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
    }
  };

  document.getElementById('passwordYesBtn').onclick = () => handlePasswordChoice(true);
  document.getElementById('passwordNoBtn').onclick = () => handlePasswordChoice(false);
}

/**
 * AC1, AC2, AC5: Helper function to prompt for password and encrypt seed
 * Shows password input UI with confirmation field and visibility toggle
 */
async function promptForPasswordAndStore(mnemonic, mode) {
  showAccountModal(`
    <h3>${mode === 'create' ? 'Create Password Protection' : 'Import with Password Protection'}</h3>
    <div style="background:#dc2626;color:white;padding:12px;border-radius:6px;margin:16px 0;font-size:.875rem;">
      <strong>⚠️ WARNING:</strong> If you forget this password, your seed will be permanently inaccessible.
      You will need to import your seed again.
    </div>
    <div style="margin:16px 0;">
      <label style="display:block;font-size:.875rem;margin-bottom:6px;"><strong>Enter password:</strong></label>
      <div style="position:relative;">
        <input type="password" id="passwordInput"
          style="width:100%;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.875rem;"
          placeholder="Enter password" />
        <button id="togglePassword1" type="button"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;"
          title="Show/hide password">👁️</button>
      </div>
    </div>
    <div style="margin:16px 0;">
      <label style="display:block;font-size:.875rem;margin-bottom:6px;"><strong>Confirm password:</strong></label>
      <div style="position:relative;">
        <input type="password" id="passwordConfirm"
          style="width:100%;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.875rem;"
          placeholder="Confirm password" />
        <button id="togglePassword2" type="button"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;"
          title="Show/hide password">👁️</button>
      </div>
    </div>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmPasswordBtn" class="btn">Encrypt and Save Seed</button>
    </div>
    <div id="passwordStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  // Password visibility toggles
  const setupToggle = (btnId, inputId) => {
    document.getElementById(btnId).onclick = () => {
      const input = document.getElementById(inputId);
      input.type = input.type === 'password' ? 'text' : 'password';
    };
  };
  setupToggle('togglePassword1', 'passwordInput');
  setupToggle('togglePassword2', 'passwordConfirm');

  document.getElementById('confirmPasswordBtn').onclick = async () => {
    const passwordInput = document.getElementById('passwordInput');
    const passwordConfirm = document.getElementById('passwordConfirm');
    const statusDiv = document.getElementById('passwordStatus');
    const btn = document.getElementById('confirmPasswordBtn');

    const password = passwordInput.value;
    const confirm = passwordConfirm.value;

    if (!password) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a password</span>';
      return;
    }

    if (password !== confirm) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Passwords do not match</span>';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Encrypting...';
      statusDiv.textContent = 'Encrypting seed with password...';

      // AC3: Encrypt seed with PBKDF2 + AES-GCM
      const encrypted = await encryptWithPassword(mnemonic, password);

      // Store encrypted seed in localStorage
      localStorage.setItem('bookish.seed.manual', JSON.stringify({
        encrypted: true,
        iv: encrypted.iv,
        salt: encrypted.salt,
        ciphertext: encrypted.ciphertext
      }));

      // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
      const bookishSym = await deriveBookishSymFromSeed(mnemonic);
      localStorage.setItem('bookish.sym', bookishSym);

      // Initialize bookishWallet with the new symmetric key
      await window.bookishWallet?.ensure();

      // Derive wallet address for display
      const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
      const { address } = await deriveWalletFromSeed(mnemonic);
      storeWalletInfo(address);

      // FIX UAT Bug #1 - Derive and store bookish.sym for book encryption
      const { deriveAndStoreSymmetricKey } = await import('./core/crypto_core.js');
      await deriveAndStoreSymmetricKey(mnemonic);

      // Ensure EVM wallet is created
      await window.bookishWallet.ensure();

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Seed encrypted and saved!</span>';

      // AC1: Show seed phrase for CREATE (user needs to write it down)
      // AC2: Skip seed display for IMPORT (user already has it)
      if (mode === 'create') {
        setTimeout(() => {
          showManualSeedPhrase(mnemonic, true);
        }, 800);
      } else {
        // Import mode: close modal and refresh UI
        setTimeout(() => {
          closeAccountModal();
          const section = document.getElementById('accountManagementSectionV2');
          if (section) {
            updateAccountSection(section, true);
          }
        }, 1000);
      }

    } catch (error) {
      console.error('Failed to encrypt seed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Encrypt and Save Seed';
    }
  };
}

/**
 * AC5: Handle "Import Seed" button - Passkey-Free Manual Seed Import
 * FIX Problem 3: Power users want to import existing seed WITHOUT passkey involvement
 * NO passkey creation, NO Google/Apple sync, just accept 12 words and store locally
 */
async function handleImportSeedV2() {
  // AC2: Optional password protection prompt
  showAccountModal(`
    <h3>Import Existing Seed Phrase</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Enter your 12-word BIP39 seed phrase to restore your account.
      <br/><br/>
      <strong>No passkey required.</strong> Your seed will be stored locally.
      <br/>You are responsible for keeping this device secure.
    </p>
    <textarea id="importSeedInput"
      placeholder="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
      style="width:100%;min-height:100px;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.85rem;font-family:monospace;margin:12px 0;"
    ></textarea>
    <div style="margin:20px 0;padding:16px;background:#1e293b;border-radius:6px;border:1px solid #334155;">
      <p style="font-size:.875rem;margin-bottom:12px;"><strong>Protect this seed with a password?</strong> (optional)</p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button id="importPasswordYesBtn" class="btn secondary" style="padding:8px 16px;">Yes, protect with password</button>
        <button id="importPasswordNoBtn" class="btn secondary" style="padding:8px 16px;">No, store without password</button>
      </div>
    </div>
    <div id="importSeedStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  const handleImportPasswordChoice = async (usePassword) => {
    const input = document.getElementById('importSeedInput');
    const statusDiv = document.getElementById('importSeedStatus');

    const userInput = input.value.trim().toLowerCase().replace(/\s+/g, ' ');

    if (!userInput) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a seed phrase</span>';
      return;
    }

    try {
      statusDiv.textContent = 'Validating seed phrase...';

      // Validate BIP39 seed phrase (NO passkey involved)
      const { isValidSeed } = await import('./core/seed_core.js');
      if (!isValidSeed(userInput)) {
        throw new Error('Invalid seed phrase. Please check your words and try again.');
      }

      if (usePassword) {
        // Show password input modal
        await promptForPasswordAndStore(userInput, 'import');
        // Close and refresh will happen in promptForPasswordAndStore
      } else {
        // Store in plaintext localStorage (passkey-free manual workflow)
        localStorage.setItem('bookish.seed.manual', JSON.stringify({
          encrypted: false,
          seed: userInput
        }));

        // AC1 (Phase 1c): Derive and store bookish.sym for unified encryption
        const bookishSym = await deriveBookishSymFromSeed(userInput);
        localStorage.setItem('bookish.sym', bookishSym);

        // Initialize bookishWallet with the new symmetric key
        await window.bookishWallet?.ensure();

        // Derive wallet address for display
        const { deriveWalletFromSeed } = await import('./core/wallet_core.js');
        const { address } = await deriveWalletFromSeed(userInput);
        storeWalletInfo(address);

        // FIX UAT Bug #1 - Derive and store bookish.sym for book encryption
        const { deriveAndStoreSymmetricKey } = await import('./core/crypto_core.js');
        await deriveAndStoreSymmetricKey(userInput);

        // Ensure EVM wallet is created
        await window.bookishWallet.ensure();

        statusDiv.innerHTML = '<span style="color:#10b981;">✓ Seed phrase imported successfully!</span>';

        // Close modal and refresh UI
        setTimeout(() => {
          closeAccountModal();

          // Update account panel to show logged-in state
          const section = document.getElementById('accountManagementSectionV2');
          if (section) {
            updateAccountSection(section, true);
          }
        }, 1500);
      }

    } catch (error) {
      console.error('Failed to import seed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
    }
  };

  document.getElementById('importPasswordYesBtn').onclick = () => handleImportPasswordChoice(true);
  document.getElementById('importPasswordNoBtn').onclick = () => handleImportPasswordChoice(false);
}

/**
 * FIX Issue #1: Hide legacy "Seed Phrase" section (from seed_ui.js) to prevent duplicate buttons
 * The v2 Account UI supersedes the v1 seed management UI
 */
function hideLegacySeedSection() {
  const legacySection = document.getElementById('seedManagementSection');
  if (legacySection) {
    legacySection.style.display = 'none';
  }
}
