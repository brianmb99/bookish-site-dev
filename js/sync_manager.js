// sync_manager.js - Unified sync coordination for books and account metadata
// Manages: balance checking, auto-persistence, book sync, and global sync status

import { getWalletBalance } from './core/wallet_core.js';
import * as storageManager from './core/storage_manager.js';

// Sync state
let syncInterval = null;
let isSyncing = false;
let initialSynced = false;
let currentBalanceETH = null;
let previousFundingState = false;
let autoPersistenceTriggered = false;

// Configuration
const SYNC_DELAY_MS = 30000; // 30 seconds delay after each cycle completes
const MIN_FUNDING_ETH = 0.00002;

// Callbacks for external modules
let statusCallback = null;
let bookSyncCallback = null;
let accountPersistenceCallback = null;
let getWalletInfoCallback = null;
let updateBalanceCallback = null;

// Transient state for UI status manager
let transientSyncState = {
  justCompleted: false,
  completedTime: 0,
  pendingBooks: 0,
  isRefreshing: false,
  error: null
};

// Export status getter for external use
window.bookishSyncManager = {
  getSyncStatus: () => ({
    isSyncing,
    initialSynced,
    currentBalanceETH,
    accountState: getAccountPersistenceState()
  })
};

/**
 * Initialize sync manager
 * @param {Object} config - Configuration object
 * @param {Function} config.onStatusChange - Callback for status updates (status: string) => void
 * @param {Function} config.onBookSync - Callback to trigger book sync () => Promise<{entries, tombstones}>
 * @param {Function} config.onAccountPersistence - Callback to trigger account persistence (isAutoTrigger: boolean) => Promise<void>
 * @param {Function} config.getWalletInfo - Callback to get wallet info () => {address, privateKey} | null
 * @param {Function} config.updateBalance - Callback to update balance display (balanceETH: string) => void
 */
export function initSyncManager(config) {
  statusCallback = config.onStatusChange;
  bookSyncCallback = config.onBookSync;
  accountPersistenceCallback = config.onAccountPersistence;
  getWalletInfoCallback = config.getWalletInfo;
  updateBalanceCallback = config.updateBalance;

  console.log('[Bookish:SyncManager] Initialized');
}

/**
 * Start unified sync loop - runs continuously with 30s delay between cycles
 */
export function startSync() {
  if (syncInterval) {
    console.log('[Bookish:SyncManager] Sync already running');
    return;
  }

  console.log('[Bookish:SyncManager] Starting sync loop');

  // Start the recursive sync loop
  async function syncLoop() {
    await runSyncCycle();
    // Schedule next cycle 30s after this one completes
    syncInterval = setTimeout(syncLoop, SYNC_DELAY_MS);
  }

  // Run first cycle immediately (0 delay)
  syncLoop();
}

/**
 * Stop sync loop
 */
export function stopSync() {
  if (syncInterval) {
    clearTimeout(syncInterval);
    syncInterval = null;
    console.log('[Bookish:SyncManager] Sync stopped');
  }
}

/**
 * Run a complete sync cycle
 * 1. Check balance (auto-persist if needed)
 * 2. Sync books
 * 3. Update status based on combined state
 */
async function runSyncCycle() {
  console.log('[Bookish:SyncManager] runSyncCycle called, isSyncing:', isSyncing);

  if (isSyncing) {
    console.log('[Bookish:SyncManager] Sync already in progress, skipping');
    return;
  }

  isSyncing = true;
  transientSyncState.isRefreshing = false; // No more manual sync
  transientSyncState.error = null; // Clear previous errors
  if (statusCallback) statusCallback(); // Trigger UI refresh

  try {
    // Step 1: Check balance and trigger auto-persistence if needed
    await checkBalanceAndAutoPersist();

    // Step 2: Sync books (if callback provided)
    let booksSynced = false;
    if (bookSyncCallback) {
      try {
        await bookSyncCallback();
        booksSynced = true;
      } catch (error) {
        console.error('[Bookish:SyncManager] Book sync failed:', error);
        transientSyncState.error = error.message || 'Sync failed';
      }
    }

    // Step 3: Mark sync as completed (only if no errors)
    if (!transientSyncState.error) {
      initialSynced = true;
      transientSyncState.isRefreshing = false;
      transientSyncState.justCompleted = true;
      transientSyncState.completedTime = Date.now();

      // Clear success flag after 2 seconds
      setTimeout(() => {
        transientSyncState.justCompleted = false;
        if (statusCallback) statusCallback(); // Refresh UI after transient state expires
      }, 2000);
    } else {
      transientSyncState.isRefreshing = false;
    }

  } catch (error) {
    console.error('[Bookish:SyncManager] Sync cycle failed:', error);
    transientSyncState.error = error.message || 'Sync failed';
    transientSyncState.isRefreshing = false;
  } finally {
    isSyncing = false;
    if (statusCallback) statusCallback(); // Trigger UI refresh

    // Update book status dots and geek panel after sync completes
    if (typeof window.updateBookDots === 'function') {
      window.updateBookDots();
    }
    if (typeof window.updateGeekPanel === 'function') {
      const geekPanel = document.getElementById('geekPanel');
      if (geekPanel && geekPanel.style.display !== 'none') {
        window.updateGeekPanel();
      }
    }
  }
}

/**
 * Check wallet balance and trigger auto-persistence if funded
 */
async function checkBalanceAndAutoPersist() {
  console.log('[Bookish:SyncManager] checkBalanceAndAutoPersist - callback exists:', !!getWalletInfoCallback);

  // Get wallet info via callback
  if (!getWalletInfoCallback) return;
  const walletInfo = await getWalletInfoCallback();
  console.log('[Bookish:SyncManager] walletInfo:', walletInfo ? 'found' : 'null');
  if (!walletInfo?.address) return;

  try {
    // Check balance
    const { balanceETH } = await getWalletBalance(walletInfo.address);
    currentBalanceETH = balanceETH;

    // Update UI via callback
    if (updateBalanceCallback) {
      updateBalanceCallback(balanceETH);
    }

    // Check if wallet just became funded (transition from underfunded to funded)
    const isFunded = balanceETH >= MIN_FUNDING_ETH;
    const justFunded = isFunded && !previousFundingState;
    previousFundingState = isFunded;

    console.log('[Bookish:SyncManager] Balance check:', { balanceETH, isFunded, justFunded, autoPersistenceTriggered });

    // Trigger auto-persistence on funding (only once)
    if (justFunded && !autoPersistenceTriggered) {
      const accountState = getAccountPersistenceState();

      console.log('[Bookish:SyncManager] Just funded, account state:', accountState);

      // Update progress modal to "waiting" state (mark step 2 as complete)
      try {
        if (window.__updateFundingProgress) {
          window.__updateFundingProgress('waiting');
        }
      } catch (error) {
        console.error('[Bookish:SyncManager] Failed to update progress modal:', error);
        // Continue with persistence anyway
      }

      if (accountState === 'local') {
        console.log('[Bookish:SyncManager] Wallet funded, triggering auto-persistence...');
        autoPersistenceTriggered = true;

        if (accountPersistenceCallback) {
          try {
            await accountPersistenceCallback(true); // isAutoTrigger = true
            console.log('[Bookish:SyncManager] Auto-persistence completed');
          } catch (error) {
            console.error('[Bookish:SyncManager] Auto-persistence failed:', error);
            autoPersistenceTriggered = false; // Allow retry
          }
        }
      }
    } else if (isFunded && !autoPersistenceTriggered) {
      // Wallet is funded but wasn't a transition - check if we should persist anyway
      const accountState = getAccountPersistenceState();
      console.log('[Bookish:SyncManager] Already funded, account state:', accountState);

      if (accountState === 'local') {
        console.log('[Bookish:SyncManager] Account needs persistence, triggering...');
        autoPersistenceTriggered = true;

        if (accountPersistenceCallback) {
          try {
            await accountPersistenceCallback(true); // isAutoTrigger = true
            console.log('[Bookish:SyncManager] Auto-persistence completed');
          } catch (error) {
            console.error('[Bookish:SyncManager] Auto-persistence failed:', error);
            autoPersistenceTriggered = false; // Allow retry
          }
        }
      }
    }

  } catch (error) {
    console.error('[Bookish:SyncManager] Balance check failed:', error);
  }
}

/**
 * Get account persistence state
 * @returns {string} 'local' | 'syncing' | 'confirmed'
 */
function getAccountPersistenceState() {
  try {
    // Must be logged in to have a meaningful persistence state
    if (!storageManager.isLoggedIn()) {
      return 'local';
    }

    // Check if account is persisted to Arweave
    if (storageManager.isAccountPersisted()) {
      return 'confirmed';
    }

    return 'local';
  } catch (error) {
    console.error('[Bookish:SyncManager] Failed to get account state:', error);
    return 'local';
  }
}

/**
 * Trigger manual sync
 */
// Manual sync removed - sync loop runs automatically when logged in

/**
 * Get current sync status (legacy)
 */
export function getSyncStatus() {
  return {
    isSyncing,
    initialSynced,
    currentBalanceETH,
    accountState: getAccountPersistenceState()
  };
}

/**
 * Get sync status for UI status manager
 * @returns {Object} { isSyncing, pendingBooks, isRefreshing, justCompleted, completedTime, error }
 */
export function getSyncStatusForUI() {
  return {
    isSyncing,
    pendingBooks: transientSyncState.pendingBooks,
    isRefreshing: transientSyncState.isRefreshing,
    justCompleted: transientSyncState.justCompleted,
    completedTime: transientSyncState.completedTime,
    error: transientSyncState.error
  };
}

/**
 * Set status (calls external callback)
 */
function setStatus(status) {
  if (statusCallback) {
    statusCallback(status);
  }
}

/**
 * Trigger persistence check manually (e.g., after account creation)
 * This allows immediate persistence if wallet is already funded
 */
export function triggerPersistenceCheck() {
  console.log('[Bookish:SyncManager] Manual persistence check triggered');
  checkBalanceAndAutoPersist().catch(error => {
    console.error('[Bookish:SyncManager] Manual persistence check failed:', error);
  });
}

/**
 * Reset auto-persistence trigger (for testing)
 */
export function resetAutoPersistenceTrigger() {
  autoPersistenceTriggered = false;
  previousFundingState = false;
}
