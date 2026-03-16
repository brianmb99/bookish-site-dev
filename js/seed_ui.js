// seed_ui.js - User interface for seed management
// Handles UI interactions for creating, importing, and viewing seed phrases

import {
  isPasskeySupported,
  createPasskey,
  authenticatePasskey,
  hasPasskey,
  deriveKeyFromPasskey,
  clearPasskey,
} from './core/passkey_core.js';

import {
  generateSeed,
  isValidSeed,
  createNewSeed,
  importSeed,
  retrieveSeed,
  hasSeed,
  markSeedAsShown,
  wasSeedShown,
  getSeedMetadata,
  clearSeed,
} from './core/seed_core.js';

/**
 * Initialize seed management UI
 */
export function initSeedUI() {
  // Check WebAuthn support
  if (!isPasskeySupported()) {
    console.warn('Passkeys not supported in this browser');
    return;
  }

  // Add seed management button to account panel
  addSeedManagementButton();

  // Create seed modal
  createSeedModal();
}

/**
 * Add seed management button to account panel
 */
function addSeedManagementButton() {
  const accountPanel = document.getElementById('accountPanel');
  if (!accountPanel) return;

  // Find or create seed management section
  let seedSection = document.getElementById('seedManagementSection');
  if (!seedSection) {
    seedSection = document.createElement('div');
    seedSection.id = 'seedManagementSection';
    seedSection.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #334155;';
    accountPanel.querySelector('div[style*="grid"]')?.after(seedSection);
  }

  // Update content based on seed status
  updateSeedManagementSection(seedSection);
}

/**
 * Update seed management section based on current state
 */
function updateSeedManagementSection(section) {
  const hasSeedStored = hasSeed();
  const hasPasskeyRegistered = hasPasskey();

  section.innerHTML = '';

  const title = document.createElement('strong');
  title.textContent = 'Seed Phrase';
  section.appendChild(title);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';

  if (!hasSeedStored) {
    // No seed - show create/import/signin options
    const createBtn = document.createElement('button');
    createBtn.className = 'btn';
    createBtn.textContent = 'Create New Seed';
    createBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    createBtn.onclick = handleCreateSeed;
    actions.appendChild(createBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'btn secondary';
    importBtn.textContent = 'Import Seed';
    importBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    importBtn.onclick = handleImportSeed;
    actions.appendChild(importBtn);

    // Always show sign-in button when no seed exists
    // Enables cross-device passkey sync (Google/Apple/Windows)
    const signinBtn = document.createElement('button');
    signinBtn.className = 'btn secondary';
    signinBtn.textContent = 'Sign In with Passkey';
    signinBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    signinBtn.onclick = handleSignIn;
    actions.appendChild(signinBtn);
  } else {
    // Has seed - show view/export options
    const metadata = getSeedMetadata();
    const info = document.createElement('div');
    info.style.cssText = 'font-size:.75rem;opacity:.7;margin-top:6px;';
    info.textContent = `${metadata?.wordCount || 12}-word seed stored (encrypted)`;
    section.appendChild(info);

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn secondary';
    viewBtn.textContent = 'View Seed';
    viewBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    viewBtn.onclick = handleViewSeed;
    actions.appendChild(viewBtn);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn danger';
    logoutBtn.textContent = 'Log Out';
    logoutBtn.style.cssText = 'padding:6px 12px;font-size:.75rem;';
    logoutBtn.onclick = handleLogout;
    actions.appendChild(logoutBtn);
  }

  section.appendChild(actions);
}

/**
 * Create seed modal UI
 */
function createSeedModal() {
  // Check if modal already exists
  if (document.getElementById('seedModal')) return;

  const modal = document.createElement('div');
  modal.id = 'seedModal';
  modal.className = 'modal';
  modal.style.display = 'none';

  modal.innerHTML = `
    <div class="modal-inner" style="max-width:500px;">
      <button class="close" id="closeSeedModal">×</button>
      <div id="seedModalContent"></div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document.getElementById('closeSeedModal').onclick = closeSeedModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeSeedModal();
  };
}

/**
 * Show seed modal with content
 */
function showSeedModal(content) {
  const modal = document.getElementById('seedModal');
  const contentDiv = document.getElementById('seedModalContent');

  if (!modal || !contentDiv) return;

  contentDiv.innerHTML = content;
  modal.style.display = 'flex';
}

/**
 * Close seed modal
 */
function closeSeedModal() {
  const modal = document.getElementById('seedModal');
  if (modal) modal.style.display = 'none';
}

/**
 * Handle create new seed flow
 */
async function handleCreateSeed() {
  try {
    showSeedModal(`
      <h3>Create New Seed Phrase</h3>
      <p style="font-size:.85rem;line-height:1.5;opacity:.9;margin:12px 0;">
        A 12-word seed phrase will be generated and encrypted with your passkey.
        You will see it <strong>only once</strong> - save it securely!
      </p>
      <div style="text-align:center;margin:20px 0;">
        <button id="confirmCreateBtn" class="btn">Create Passkey & Generate Seed</button>
      </div>
      <div id="createSeedStatus" style="margin-top:12px;font-size:.8rem;"></div>
    `);

    document.getElementById('confirmCreateBtn').onclick = async () => {
      const statusDiv = document.getElementById('createSeedStatus');
      const btn = document.getElementById('confirmCreateBtn');

      try {
        btn.disabled = true;
        btn.textContent = 'Creating passkey...';

        let passkeyCreated = false;

        try {
          // Create passkey
          await createPasskey('Bookish User');
          passkeyCreated = true;

          statusDiv.textContent = 'Passkey created! Generating seed...';

          // Generate and store seed (key derived from credentialId, not signature)
          const mnemonic = await createNewSeed();

          // Show seed phrase
          showSeedPhrase(mnemonic, true);
        } catch (innerError) {
          // If passkey was created but seed generation failed, clean up
          if (passkeyCreated) {
            try {
              clearPasskey();
              statusDiv.innerHTML = `<span style="color:#ef4444;">Error after passkey creation: ${innerError.message}<br/>Passkey was removed. Please try again.</span>`;
            } catch {
              statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${innerError.message}<br/>Please clear browser data and try again.</span>`;
            }
          } else {
            statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${innerError.message}</span>`;
          }
          btn.disabled = false;
          btn.textContent = 'Create Passkey & Generate Seed';
        }
      } catch (error) {
        statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
        btn.disabled = false;
        btn.textContent = 'Create Passkey & Generate Seed';
      }
    };
  } catch (error) {
    alert(`Failed to create seed: ${error.message}`);
  }
}

/**
 * Handle import seed flow
 */
async function handleImportSeed() {
  showSeedModal(`
    <h3>Import Existing Seed</h3>
    <p style="font-size:.85rem;line-height:1.5;opacity:.9;margin:12px 0;">
      Enter your 12-word BIP39 seed phrase. It will be encrypted with a new passkey.
    </p>
    <textarea id="importSeedInput"
      placeholder="word1 word2 word3 ..."
      style="width:100%;min-height:100px;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;font-size:.85rem;font-family:monospace;"
    ></textarea>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmImportBtn" class="btn">Create Passkey & Import</button>
    </div>
    <div id="importSeedStatus" style="margin-top:12px;font-size:.8rem;"></div>
  `);

  document.getElementById('confirmImportBtn').onclick = async () => {
    const input = document.getElementById('importSeedInput');
    const statusDiv = document.getElementById('importSeedStatus');
    const btn = document.getElementById('confirmImportBtn');

    const mnemonic = input.value.trim().toLowerCase().replace(/\s+/g, ' ');

    if (!mnemonic) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a seed phrase</span>';
      return;
    }

    if (!isValidSeed(mnemonic)) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Invalid seed phrase. Please check your words.</span>';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Creating passkey...';

      // Create passkey
      await createPasskey('Bookish User');

      statusDiv.textContent = 'Passkey created! Importing seed...';

      // Import and encrypt seed (key derived from credentialId)
      await importSeed(mnemonic);

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Seed imported successfully!</span>';

      setTimeout(() => {
        closeSeedModal();
        // Refresh account panel
        const section = document.getElementById('seedManagementSection');
        if (section) updateSeedManagementSection(section);
      }, 1500);

    } catch (error) {
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Create Passkey & Import';
    }
  };
}

/**
 * Handle sign-in with existing passkey
 */
async function handleSignIn() {
  showSeedModal(`
    <h3>Sign In with Passkey</h3>
    <p style="font-size:.85rem;line-height:1.5;opacity:.9;margin:12px 0;">
      Authenticate with your passkey to restore your account.
    </p>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmSignInBtn" class="btn">Authenticate</button>
    </div>
    <div id="signInStatus" style="margin-top:12px;font-size:.8rem;"></div>
  `);

  document.getElementById('confirmSignInBtn').onclick = async () => {
    const statusDiv = document.getElementById('signInStatus');
    const btn = document.getElementById('confirmSignInBtn');

    try {
      btn.disabled = true;
      btn.textContent = 'Checking...';

      // Check if seed exists in localStorage
      if (!hasSeed()) {
        // No seed found - cannot sign in without seed data
        statusDiv.innerHTML = '<span style="color:#f59e0b;">⚠️ No account found. Please create or import a seed.</span>';
        btn.textContent = 'Authenticate';
        btn.disabled = false;
        return;
      }

      btn.textContent = 'Authenticating...';

      // Seed exists - retrieve it (authenticates internally)
      const mnemonic = await retrieveSeed();

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Signed in successfully!</span>';

      setTimeout(() => {
        closeSeedModal();
        // Refresh account panel
        const section = document.getElementById('seedManagementSection');
        if (section) updateSeedManagementSection(section);
      }, 1500);

    } catch (error) {
      if (error.message.includes('No passkey registered') || error.message.includes('No seed found')) {
        statusDiv.innerHTML = '<span style="color:#ef4444;">No passkey found. Please create a new account or import your seed.</span>';
      } else if (error.name === 'AbortError' || error.name === 'NotAllowedError' || error.message.includes('cancelled')) {
        statusDiv.innerHTML = '<span style="color:#94a3b8;">Authentication cancelled.</span>';
      } else {
        statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      }
      btn.disabled = false;
      btn.textContent = 'Authenticate';
    }
  };
}

/**
 * Handle view seed flow
 */
async function handleViewSeed() {
  showSeedModal(`
    <h3>View Seed Phrase</h3>
    <p style="font-size:.85rem;line-height:1.5;opacity:.9;margin:12px 0;">
      Authenticate with your passkey to reveal your seed phrase.
    </p>
    <div style="text-align:center;margin:20px 0;">
      <button id="confirmViewBtn" class="btn">Authenticate & View</button>
    </div>
    <div id="viewSeedStatus" style="margin-top:12px;font-size:.8rem;"></div>
  `);

  document.getElementById('confirmViewBtn').onclick = async () => {
    const statusDiv = document.getElementById('viewSeedStatus');
    const btn = document.getElementById('confirmViewBtn');

    try {
      btn.disabled = true;
      btn.textContent = 'Authenticating...';

      const mnemonic = await retrieveSeed();

      showSeedPhrase(mnemonic, false);

    } catch (error) {
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Authenticate & View';
    }
  };
}

/**
 * Show seed phrase to user
 */
function showSeedPhrase(mnemonic, isFirstTime) {
  const words = mnemonic.split(' ');

  const warningStyle = isFirstTime
    ? 'background:#dc2626;color:white;padding:12px;border-radius:6px;margin:12px 0;font-weight:bold;'
    : 'background:#f59e0b;color:#1e1e1e;padding:12px;border-radius:6px;margin:12px 0;font-weight:bold;';

  const warningText = isFirstTime
    ? '⚠️ SAVE THIS NOW! You will not see this again.'
    : '⚠️ Keep your seed phrase secret and secure.';

  showSeedModal(`
    <h3>${isFirstTime ? 'Your New Seed Phrase' : 'Your Seed Phrase'}</h3>
    <div style="${warningStyle}">${warningText}</div>
    <div style="background:#1e293b;padding:16px;border-radius:8px;margin:12px 0;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        ${words.map((word, i) => `
          <div style="font-family:monospace;font-size:.85rem;padding:6px;background:#0b1220;border-radius:4px;border:1px solid #334155;">
            <span style="opacity:.5;margin-right:6px;">${i + 1}.</span>${word}
          </div>
        `).join('')}
      </div>
    </div>
    <div style="text-align:center;margin-top:16px;display:flex;gap:8px;justify-content:center;">
      <button id="copySeedBtn" class="btn secondary">Copy to Clipboard</button>
      <button id="closeSeedDisplayBtn" class="btn">${isFirstTime ? 'I Have Saved It' : 'Close'}</button>
    </div>
  `);

  document.getElementById('copySeedBtn').onclick = () => {
    navigator.clipboard.writeText(mnemonic).then(() => {
      const btn = document.getElementById('copySeedBtn');
      const origText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = origText; }, 2000);
    });
  };

  document.getElementById('closeSeedDisplayBtn').onclick = () => {
    if (isFirstTime) {
      markSeedAsShown();
    }
    closeSeedModal();
    // Refresh account panel
    const section = document.getElementById('seedManagementSection');
    if (section) updateSeedManagementSection(section);
  };
}

/**
 * Handle logout action
 */
async function handleLogout() {
  // Show confirmation modal
  showSeedModal(`
    <h3>Log Out</h3>
    <div style="background:#f59e0b;color:#1e1e1e;padding:12px;border-radius:6px;margin:12px 0;font-weight:bold;">
      ⚠️ Sign back in with your passkey, or use your 12-word seed phrase to restore on a different device.
    </div>
    <p style="margin:12px 0;opacity:.85;">
      Are you sure you want to log out? This will clear all stored credentials from this device.
    </p>
    <div style="text-align:center;margin-top:16px;display:flex;gap:8px;justify-content:center;">
      <button id="cancelLogoutBtn" class="btn secondary">Cancel</button>
      <button id="confirmLogoutBtn" class="btn danger">Log Out</button>
    </div>
  `);

  document.getElementById('cancelLogoutBtn').onclick = () => {
    closeSeedModal();
  };

  document.getElementById('confirmLogoutBtn').onclick = () => {
    performLogout();
  };
}

/**
 * Perform logout - clear all storage and reset state
 */
function performLogout() {
  // Clear passkey and seed
  clearPasskey();
  clearSeed();

  // Clear legacy symmetric key
  localStorage.removeItem('bookish.sym');

  // Close modal
  closeSeedModal();

  // Refresh account panel to show create/import options
  const section = document.getElementById('seedManagementSection');
  if (section) {
    updateSeedManagementSection(section);
  }

  // Show feedback
  const accountPanel = document.getElementById('accountPanel');
  if (accountPanel && accountPanel.style.display !== 'none') {
    // Panel is open, user will see the updated state
    console.log('Logged out successfully');
  } else {
    // Panel is closed, could optionally show a toast
    console.log('Logged out successfully');
  }
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSeedUI);
} else {
  initSeedUI();
}
