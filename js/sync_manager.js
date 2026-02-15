// sync_manager.js - Unified sync coordination for books and account metadata
// Manages: balance checking, auto-persistence, book sync, and global sync status
// Uses adaptive intervals: Active (30s) → Cooling (60s) → Idle (5min)

import { getWalletBalance } from './core/wallet_core.js';
import * as storageManager from './core/storage_manager.js';

// Sync state
let syncInterval = null;
let isSyncing = false;
let initialSynced = false;
let currentBalanceETH = null;
let previousFundingState = false;
let autoPersistenceTriggered = false;
let syncCycleCount = 0;

// Adaptive interval state
let lastWriteAt = 0;        // Timestamp of last local book write
let dirtyFlag = false;       // Set on write, cleared after next sync
let forceBalanceCheck = false; // Force balance check on next cycle (Sync Now)

// Balance throttle state
let lastBalanceCheckAt = 0;

// Configuration — adaptive intervals
const INTERVAL_ACTIVE_MS  = 30000;   // 30s — after a local write or login
const INTERVAL_COOLING_MS = 60000;   // 60s — 2min since last write
const INTERVAL_IDLE_MS    = 300000;  // 5min — no writes for 5+ min
const ACTIVE_WINDOW_MS    = 120000;  // 2min — how long Active lasts after a write
const COOLING_WINDOW_MS   = 300000;  // 5min — how long Cooling lasts
const BALANCE_THROTTLE_MS = 300000;  // 5min — skip balance RPC when confirmed
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
 * Compute the current sync interval based on activity state.
 * @returns {number} delay in ms before next sync cycle
 */
function computeSyncInterval() {
  const elapsed = Date.now() - lastWriteAt;

  // If a write happened recently or the dirty flag is set, stay in Active
  if (dirtyFlag || (lastWriteAt > 0 && elapsed < ACTIVE_WINDOW_MS)) {
    return INTERVAL_ACTIVE_MS;
  }

  // Cooling period: 2–5 min since last write
  if (lastWriteAt > 0 && elapsed < COOLING_WINDOW_MS) {
    return INTERVAL_COOLING_MS;
  }

  // Idle: no recent writes (or no writes ever)
  return INTERVAL_IDLE_MS;
}

/**
 * Initialize sync manager
 * @param {Object} config - Configuration object
 * @param {Function} config.onStatusChange - Callback for status updates
 * @param {Function} config.onBookSync - Callback to trigger book sync
 * @param {Function} config.onAccountPersistence - Callback to trigger account persistence
 * @param {Function} config.getWalletInfo - Callback to get wallet info
 * @param {Function} config.updateBalance - Callback to update balance display
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
 * Start unified sync loop with adaptive interval
 */
export function startSync() {
  if (syncInterval) {
    console.log('[Bookish:SyncManager] Sync already running');
    return;
  }

  console.log('[Bookish:SyncManager] Starting sync loop');

  // Mark as recently active so first cycles run at Active interval
  lastWriteAt = Date.now();

  async function syncLoop() {
    await runSyncCycle();
    const delay = computeSyncInterval();
    // Expose next-sync time for geek panel countdown
    window.bookishNextSyncAt = Date.now() + delay;
    syncInterval = setTimeout(syncLoop, delay);
  }

  // Run first cycle immediately
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
 * Mark data as dirty — resets to Active interval.
 * Call from app.js on create/edit/delete.
 */
export function markDirty() {
  dirtyFlag = true;
  lastWriteAt = Date.now();
}

/**
 * Trigger an immediate sync cycle (Sync Now).
 * Resets to Active interval and forces a fresh balance check.
 * @returns {Promise<void>}
 */
export async function triggerSyncNow() {
  console.log('[Bookish:SyncManager] Sync Now triggered');
  lastWriteAt = Date.now();
  dirtyFlag = true;
  forceBalanceCheck = true;

  // If a sync is already running, just let it finish — the dirty flag
  // ensures the next scheduled cycle will run at Active interval.
  if (isSyncing) {
    console.log('[Bookish:SyncManager] Sync in progress, will run at Active interval next');
    return;
  }

  // Cancel the pending scheduled cycle and run immediately
  if (syncInterval) {
    clearTimeout(syncInterval);
    syncInterval = null;
  }

  await runSyncCycle();

  // Re-enter the loop at Active interval
  const delay = computeSyncInterval();
  window.bookishNextSyncAt = Date.now() + delay;

  async function syncLoop() {
    await runSyncCycle();
    const d = computeSyncInterval();
    window.bookishNextSyncAt = Date.now() + d;
    syncInterval = setTimeout(syncLoop, d);
  }
  syncInterval = setTimeout(syncLoop, delay);
}

/**
 * Run a complete sync cycle
 * 1. Check balance (auto-persist if needed)
 * 2. Sync books
 * 3. Update status based on combined state
 */
async function runSyncCycle() {
  syncCycleCount++;

  if (isSyncing) {
    console.debug('[Bookish:SyncManager] Sync already in progress, skipping');
    return;
  }

  isSyncing = true;
  dirtyFlag = false; // Clear dirty flag at the start of the cycle
  transientSyncState.isRefreshing = false;
  transientSyncState.error = null;
  if (statusCallback) statusCallback();

  try {
    // Step 1: Check balance and trigger auto-persistence if needed
    await checkBalanceAndAutoPersist();

    // Step 2: Sync books (if callback provided)
    if (bookSyncCallback) {
      try {
        await bookSyncCallback();
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
        if (statusCallback) statusCallback();
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
    if (statusCallback) statusCallback();

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
 * Check wallet balance and trigger auto-persistence if funded.
 * Throttles RPC calls when account is already confirmed and no force flag.
 */
async function checkBalanceAndAutoPersist() {
  if (!getWalletInfoCallback) return;
  const walletInfo = await getWalletInfoCallback();
  if (!walletInfo?.address) return;

  try {
    const accountState = getAccountPersistenceState();

    // Balance throttle: skip RPC when confirmed and recently checked
    const now = Date.now();
    const canThrottle = accountState === 'confirmed'
      && !forceBalanceCheck
      && currentBalanceETH !== null
      && (now - lastBalanceCheckAt) < BALANCE_THROTTLE_MS;

    if (canThrottle) {
      // Reuse cached balance — no RPC call
      console.debug(`[Bookish:SyncManager] Balance throttled (cached ${currentBalanceETH}), next check in ${Math.round((BALANCE_THROTTLE_MS - (now - lastBalanceCheckAt)) / 1000)}s`);
    } else {
      // Perform actual balance check
      const { balanceETH } = await getWalletBalance(walletInfo.address);
      const balanceChanged = currentBalanceETH !== null && currentBalanceETH !== balanceETH;
      currentBalanceETH = balanceETH;
      lastBalanceCheckAt = now;
      forceBalanceCheck = false;

      if (updateBalanceCallback) {
        updateBalanceCallback(balanceETH);
      }

      if (balanceChanged) {
        console.log('[Bookish:SyncManager] Balance changed:', balanceETH);
      } else {
        console.debug('[Bookish:SyncManager] Balance:', balanceETH);
      }
    }

    // Check if wallet just became funded (transition from underfunded to funded)
    const isFunded = currentBalanceETH >= MIN_FUNDING_ETH;
    const justFunded = isFunded && !previousFundingState;
    previousFundingState = isFunded;

    // Trigger auto-persistence on funding (only once)
    if (isFunded && !autoPersistenceTriggered && accountState === 'local') {
      // Update progress modal if this is a fresh funding transition
      if (justFunded) {
        try {
          if (window.__updateFundingProgress) {
            window.__updateFundingProgress('waiting');
          }
        } catch (error) {
          console.error('[Bookish:SyncManager] Failed to update progress modal:', error);
        }
        console.log('[Bookish:SyncManager] Just funded, triggering auto-persistence...');
      } else {
        console.log('[Bookish:SyncManager] Already funded, account needs persistence, triggering...');
      }

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
    if (!storageManager.isLoggedIn()) return 'local';
    if (storageManager.isAccountPersisted()) return 'confirmed';
    return 'local';
  } catch (error) {
    console.error('[Bookish:SyncManager] Failed to get account state:', error);
    return 'local';
  }
}

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
 */
export function getSyncStatusForUI() {
  return {
    isSyncing,
    initialSynced,
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
  forceBalanceCheck = true;
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

/**
 * Reset all internal state (for testing only)
 */
export function resetForTesting() {
  stopSync();
  isSyncing = false;
  initialSynced = false;
  currentBalanceETH = null;
  previousFundingState = false;
  autoPersistenceTriggered = false;
  syncCycleCount = 0;
  lastWriteAt = 0;
  dirtyFlag = false;
  forceBalanceCheck = false;
  lastBalanceCheckAt = 0;
  transientSyncState = {
    justCompleted: false,
    completedTime: 0,
    pendingBooks: 0,
    isRefreshing: false,
    error: null
  };
}
