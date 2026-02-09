// ui_status_manager.js - Centralized UI status coordination
// Pull-based architecture: queries current state from other modules, decides what to display
// Handles both status text and account persistence indicators (colored dots)

/**
 * Status priority levels (lower number = higher priority)
 */
export const PRIORITY = {
  CRITICAL: 0,  // Blocking errors (wallet failures, network errors)
  WARNING: 1,   // Non-blocking issues (account not backed up)
  OPERATION: 2, // In-progress actions (syncing, uploading)
  SUCCESS: 3,   // Temporary confirmations (signed in, saved)
  AMBIENT: 4    // Default background state (synced, ready)
};

/**
 * UI Status Manager
 * Coordinates status text and visual indicators across the app
 */
class UIStatusManager {
  constructor() {
    this.currentMessage = null;
    this.currentPriority = PRIORITY.AMBIENT;
    this.messageSetAt = 0;
    this.maxDisplayTime = 0;
    this.pendingRefresh = null;
    this.autoRecalcTimer = null;
    this.refreshDebounceMs = 100;

    // Status provider functions (set by init())
    this.getAccountStatus = null;
    this.getSyncStatus = null;
    this.getBalanceStatus = null;
  }

  /**
   * Initialize with status provider functions
   * @param {Object} providers - { getAccountStatus, getSyncStatus, getBalanceStatus }
   */
  init(providers) {
    this.getAccountStatus = providers.getAccountStatus || (() => ({}));
    this.getSyncStatus = providers.getSyncStatus || (() => ({}));
    this.getBalanceStatus = providers.getBalanceStatus || (() => ({}));

    // Initial status calculation
    this._recalculateStatus();

    // Status updates are event-driven via refresh() calls
    // No need for ambient polling - all state changes call refresh()
  }

  /**
   * Request a status refresh
   * Called by any module when its state changes
   * Debounced to prevent thrashing
   */
  refresh() {
    if (this.pendingRefresh) return;

    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null;
      this._recalculateStatus();
    }, this.refreshDebounceMs);
  }

  /**
   * Recalculate status by querying all providers
   * Applies priority-based decision tree
   */
  _recalculateStatus() {
    // Query current state from all providers (with null safety)
    const account = this.getAccountStatus ? this.getAccountStatus() : {};
    const sync = this.getSyncStatus ? this.getSyncStatus() : {};
    const balance = this.getBalanceStatus ? this.getBalanceStatus() : {};

    // Decision tree: evaluate in priority order
    const status = this._determineStatus(account, sync, balance);

    // Apply the new status
    this._setMessage(status.message, status.priority, status.maxDisplay);
  }

  /**
   * Status decision tree
   * Returns { message, priority, maxDisplay }
   */
  _determineStatus(account, sync, balance) {
    // ═══════════════════════════════════════════════════════════════
    // CRITICAL ERRORS (Priority 0)
    // ═══════════════════════════════════════════════════════════════
    if (balance.error) {
      return {
        message: `Wallet error: ${balance.error}`,
        priority: PRIORITY.CRITICAL,
        maxDisplay: 10000 // Show for 10s, then recalc
      };
    }

    if (sync.error) {
      return {
        message: `Sync error: ${sync.error}`,
        priority: PRIORITY.CRITICAL,
        maxDisplay: 10000
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // WARNINGS (Priority 1)
    // ═══════════════════════════════════════════════════════════════
    if (account.isLoggedIn && !account.isPersisted && !sync.isSyncing) {
      return {
        message: 'Account not yet saved',
        priority: PRIORITY.WARNING,
        maxDisplay: 0 // Stays until state changes
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // OPERATIONS (Priority 2)
    // ═══════════════════════════════════════════════════════════════
    if (sync.isSyncing) {
      return {
        message: 'Syncing…',
        priority: PRIORITY.OPERATION,
        maxDisplay: 0 // Stays until operation completes
      };
    }

    if (sync.pendingBooks > 0) {
      return {
        message: `Uploading ${sync.pendingBooks} book${sync.pendingBooks === 1 ? '' : 's'}…`,
        priority: PRIORITY.OPERATION,
        maxDisplay: 0
      };
    }

    if (sync.isRefreshing) {
      return {
        message: 'Refreshing…',
        priority: PRIORITY.OPERATION,
        maxDisplay: 0
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // SUCCESS MESSAGES (Priority 3)
    // Temporary confirmations with auto-timeout
    // ═══════════════════════════════════════════════════════════════
    if (account.justSignedIn && Date.now() - account.signInTime < 3000) {
      return {
        message: 'Signed in successfully',
        priority: PRIORITY.SUCCESS,
        maxDisplay: 3000 // Auto-clear after 3s
      };
    }

    if (account.justCreated && Date.now() - account.createdTime < 3000) {
      return {
        message: 'Account created',
        priority: PRIORITY.SUCCESS,
        maxDisplay: 3000
      };
    }

    if (sync.justCompleted && Date.now() - sync.completedTime < 2000) {
      return {
        message: 'Sync completed',
        priority: PRIORITY.SUCCESS,
        maxDisplay: 2000
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // AMBIENT STATUS (Priority 4)
    // Default states when nothing special is happening
    // ═══════════════════════════════════════════════════════════════
    if (!account.isLoggedIn) {
      return {
        message: '',
        priority: PRIORITY.AMBIENT,
        maxDisplay: 0
      };
    }

    if (account.isLoggedIn && account.isPersisted) {
      return {
        message: 'Synced',
        priority: PRIORITY.AMBIENT,
        maxDisplay: 0
      };
    }

    // Fallback
    return {
      message: 'Ready',
      priority: PRIORITY.AMBIENT,
      maxDisplay: 0
    };
  }

  /**
   * Set status message and schedule auto-recalc if needed
   */
  _setMessage(message, priority, maxDisplay) {
    // Only update if message changed
    if (message !== this.currentMessage) {
      this.currentMessage = message;
      this.currentPriority = priority;
      this.messageSetAt = Date.now();
      this.maxDisplayTime = maxDisplay;

      // Update DOM
      const statusEl = document.getElementById('status');
      if (statusEl) {
        statusEl.textContent = message;
        // Add warning class for warning messages
        if (priority === PRIORITY.WARNING) {
          statusEl.classList.add('warning');
        } else {
          statusEl.classList.remove('warning');
        }
      }

      // Clear any pending auto-recalc
      if (this.autoRecalcTimer) {
        clearTimeout(this.autoRecalcTimer);
        this.autoRecalcTimer = null;
      }

      // Schedule auto-recalc when max display time expires
      if (maxDisplay > 0) {
        this.autoRecalcTimer = setTimeout(() => {
          this.autoRecalcTimer = null;
          this._recalculateStatus();
        }, maxDisplay);
      }
    }
  }

  /**
   * Get current status (for debugging)
   */
  getCurrentStatus() {
    return {
      message: this.currentMessage,
      priority: this.currentPriority,
      age: Date.now() - this.messageSetAt,
      maxDisplay: this.maxDisplayTime
    };
  }
}

// Create singleton instance
const uiStatusManager = new UIStatusManager();

// Export singleton and class for testing
export { uiStatusManager as default, UIStatusManager };
