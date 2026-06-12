// sync_manager.js — Sync coordination for Bookish + Tarn
// Manages: periodic remote sync, pending operation replay, adaptive intervals.
// No longer manages: balance checking, wallet info, auto-persistence.

import * as tarnService from './core/tarn_service.js';
import { debugLog } from './core/debug_log.js';

// Sync state
let syncInterval = null;
let isSyncing = false;
let initialSynced = false;
let syncCycleCount = 0;

// Adaptive interval state
let lastWriteAt = 0;
let dirtyFlag = false;

// Configuration
const INTERVAL_ACTIVE_MS  = 30000;   // 30s — after a local write or login
const INTERVAL_COOLING_MS = 60000;   // 60s — 2min since last write
const INTERVAL_IDLE_MS    = 300000;  // 5min — no writes for 5+ min
const ACTIVE_WINDOW_MS    = 120000;  // 2min
const COOLING_WINDOW_MS   = 300000;  // 5min

// Callbacks
let statusCallback = null;
let bookSyncCallback = null;
let connectionPollCallback = null;

// Transient state for UI status manager
let transientSyncState = {
  justCompleted: false,
  completedTime: 0,
  pendingBooks: 0,
  isRefreshing: false,
  error: null,
  // Consecutive failed cycles. The error banner (#237) gates on >= 2 so a
  // single blip that recovers next cycle never surfaces.
  failureCount: 0
};

// Global reference for external modules
window.bookishSyncManager = {
  getSyncStatus: () => ({ isSyncing, initialSynced })
};

function computeSyncInterval() {
  const elapsed = Date.now() - lastWriteAt;
  if (dirtyFlag || (lastWriteAt > 0 && elapsed < ACTIVE_WINDOW_MS)) return INTERVAL_ACTIVE_MS;
  if (lastWriteAt > 0 && elapsed < COOLING_WINDOW_MS) return INTERVAL_COOLING_MS;
  return INTERVAL_IDLE_MS;
}

/**
 * Initialize sync manager.
 * @param {Object} config
 * @param {Function} config.onStatusChange — UI refresh callback
 * @param {Function} config.onBookSync — callback to sync books from Tarn
 * @param {Function} [config.onConnectionPoll] — friend-handshake heartbeat,
 *   piggybacked on each sync cycle. The callback owns its own cadence
 *   gating; failures are logged and never surface in the sync error banner.
 */
export function initSyncManager(config) {
  statusCallback = config.onStatusChange;
  bookSyncCallback = config.onBookSync;
  connectionPollCallback = config.onConnectionPoll || null;
  debugLog('[Bookish:SyncManager] Initialized');
}

export function startSync() {
  if (syncInterval) return;
  debugLog('[Bookish:SyncManager] Starting sync loop');
  lastWriteAt = Date.now();

  async function syncLoop() {
    await runSyncCycle();
    const delay = computeSyncInterval();
    window.bookishNextSyncAt = Date.now() + delay;
    syncInterval = setTimeout(syncLoop, delay);
  }

  syncLoop();
}

export function stopSync() {
  if (syncInterval) {
    clearTimeout(syncInterval);
    syncInterval = null;
    debugLog('[Bookish:SyncManager] Sync stopped');
  }
  initialSynced = false;
}

export function markDirty() {
  dirtyFlag = true;
  lastWriteAt = Date.now();
}

export async function triggerSyncNow() {
  debugLog('[Bookish:SyncManager] Sync Now triggered');
  lastWriteAt = Date.now();
  dirtyFlag = true;

  if (isSyncing) return;

  if (syncInterval) {
    clearTimeout(syncInterval);
    syncInterval = null;
  }

  await runSyncCycle();

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

async function runSyncCycle() {
  syncCycleCount++;
  if (isSyncing) return;
  if (!tarnService.isLoggedIn()) return;

  isSyncing = true;
  dirtyFlag = false;
  transientSyncState.isRefreshing = false;
  // NOTE: error is NOT cleared here — it clears on success below. Clearing
  // at cycle start made the failure banner flicker on every retry (#237).
  if (statusCallback) statusCallback();

  try {
    if (bookSyncCallback) {
      await bookSyncCallback();
    }

    // Friend-handshake heartbeat. Own try/catch: a failed poll must never
    // count as a failed sync cycle (#237 banner) — books synced fine.
    if (connectionPollCallback) {
      try {
        await connectionPollCallback();
      } catch (err) {
        debugLog('[Bookish:SyncManager] connection poll failed:', err?.message || err);
      }
    }

    initialSynced = true;
    transientSyncState.error = null;
    transientSyncState.failureCount = 0;
    transientSyncState.isRefreshing = false;
    transientSyncState.justCompleted = true;
    transientSyncState.completedTime = Date.now();

    setTimeout(() => {
      transientSyncState.justCompleted = false;
      if (statusCallback) statusCallback();
    }, 2000);

  } catch (error) {
    console.error('[Bookish:SyncManager] Sync cycle failed:', error);
    transientSyncState.error = error.message || 'Sync failed';
    transientSyncState.failureCount += 1;
    transientSyncState.isRefreshing = false;
    initialSynced = true; // Don't block UI on error
  } finally {
    isSyncing = false;
    if (statusCallback) statusCallback();
    if (typeof window.updateBookDots === 'function') window.updateBookDots();
  }
}

export function getSyncStatus() {
  return { isSyncing, initialSynced };
}

export function getSyncStatusForUI() {
  return {
    isSyncing,
    initialSynced,
    pendingBooks: transientSyncState.pendingBooks,
    isRefreshing: transientSyncState.isRefreshing,
    justCompleted: transientSyncState.justCompleted,
    completedTime: transientSyncState.completedTime,
    error: transientSyncState.error,
    failureCount: transientSyncState.failureCount
  };
}

export function markInitialSyncDone() {
  initialSynced = true;
}

export function resetForTesting() {
  stopSync();
  isSyncing = false;
  initialSynced = false;
  syncCycleCount = 0;
  lastWriteAt = 0;
  dirtyFlag = false;
  transientSyncState = {
    justCompleted: false,
    completedTime: 0,
    pendingBooks: 0,
    isRefreshing: false,
    error: null,
    failureCount: 0
  };
}
