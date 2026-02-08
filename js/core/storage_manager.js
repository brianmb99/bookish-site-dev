// storage_manager.js - Centralized localStorage management
// Single source of truth for all app storage keys and operations
// Prevents bugs like missing cleanup during logout

/**
 * Storage keys used by the application
 */
export const STORAGE_KEYS = {
  // Account & Authentication
  ACCOUNT: 'bookish.account',              // Account metadata (address, derivation, displayName, created, arweaveTxId)
  SYM_KEY: 'bookish.sym',                  // Symmetric encryption key (hex string)
  SESSION_SEED: 'bookish.account.sessionEnc', // Session-encrypted seed
  MANUAL_SEED: 'bookish.seed.manual',      // Manual seed (legacy)
  SEED_SHOWN: 'bookish.seed.shown',        // Flag: seed phrase has been shown to user

  // Wallet
  EVM_WALLET: 'bookish.evmWallet.v1',       // Encrypted EVM wallet (Base)

  // Credential-based auth (email+password)
  CREDENTIAL: 'bookish.credential',          // Credential metadata: {lookupKey, hasEscrow}

  // Pending credential mapping (survives page reload until uploaded to Arweave)
  PENDING_CREDENTIAL_MAPPING: 'bookish.credential.pending'  // Base64 encrypted payload + lookupKey
};

// ============================================================================
// GETTERS (Read with type safety and parsing)
// ============================================================================

/**
 * Get account metadata
 * @returns {Object|null} Parsed account object or null
 */
export function getAccount() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.ACCOUNT);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse account:', error);
    return null;
  }
}

/**
 * Get symmetric encryption key
 * @returns {string|null} Hex string or null
 */
export function getSymKey() {
  return localStorage.getItem(STORAGE_KEYS.SYM_KEY);
}

/**
 * Get session-encrypted seed
 * @returns {string|null} Seed string or null
 */
export function getSessionSeed() {
  return localStorage.getItem(STORAGE_KEYS.SESSION_SEED);
}

/**
 * Get manual seed (legacy)
 * @returns {string|null} Seed string or null
 */
export function getManualSeed() {
  return localStorage.getItem(STORAGE_KEYS.MANUAL_SEED);
}

/**
 * Get EVM wallet record
 * @returns {Object|null} Parsed wallet record or null
 */
export function getWalletRecord() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.EVM_WALLET);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse wallet record:', error);
    return null;
  }
}

/**
 * Get credential metadata (email+password auth)
 * @returns {Object|null} Parsed credential object or null
 */
export function getCredential() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.CREDENTIAL);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse credential:', error);
    return null;
  }
}

/**
 * Get pending credential mapping (awaiting Arweave upload)
 * @returns {Object|null} Parsed pending mapping {lookupKey, encryptedPayloadB64} or null
 */
export function getPendingCredentialMapping() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.PENDING_CREDENTIAL_MAPPING);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse pending credential mapping:', error);
    return null;
  }
}

/**
 * Check if seed has been shown to user
 * @returns {boolean}
 */
export function getSeedShown() {
  return localStorage.getItem(STORAGE_KEYS.SEED_SHOWN) === 'true';
}

// ============================================================================
// SETTERS (Write with validation)
// ============================================================================

/**
 * Set account metadata
 * @param {Object} accountData - Account object
 */
export function setAccount(accountData) {
  if (!accountData || typeof accountData !== 'object') {
    throw new Error('Invalid account data');
  }
  localStorage.setItem(STORAGE_KEYS.ACCOUNT, JSON.stringify(accountData));
}

/**
 * Set symmetric encryption key
 * @param {string} hexString - Hex-encoded key
 */
export function setSymKey(hexString) {
  if (!hexString || typeof hexString !== 'string') {
    throw new Error('Invalid symmetric key');
  }
  localStorage.setItem(STORAGE_KEYS.SYM_KEY, hexString);
}

/**
 * Set session-encrypted seed
 * @param {string} seed - Seed phrase
 */
export function setSessionSeed(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('Invalid session seed');
  }
  localStorage.setItem(STORAGE_KEYS.SESSION_SEED, seed);
}

/**
 * Set manual seed
 * @param {string} seed - Seed phrase
 */
export function setManualSeed(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('Invalid manual seed');
  }
  localStorage.setItem(STORAGE_KEYS.MANUAL_SEED, seed);
}

/**
 * Set EVM wallet record
 * @param {Object} record - Wallet record object
 */
export function setWalletRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Invalid wallet record');
  }
  localStorage.setItem(STORAGE_KEYS.EVM_WALLET, JSON.stringify(record));
}

/**
 * Set credential metadata (email+password auth)
 * @param {Object} credential - Credential object {lookupKey, hasEscrow}
 */
export function setCredential(credential) {
  if (!credential || typeof credential !== 'object') {
    throw new Error('Invalid credential data');
  }
  localStorage.setItem(STORAGE_KEYS.CREDENTIAL, JSON.stringify(credential));
}

/**
 * Set pending credential mapping (awaiting Arweave upload)
 * Persisted to localStorage so it survives page reloads before funding
 * @param {Object} mapping - {lookupKey: string, encryptedPayloadB64: string}
 */
export function setPendingCredentialMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw new Error('Invalid pending credential mapping');
  }
  localStorage.setItem(STORAGE_KEYS.PENDING_CREDENTIAL_MAPPING, JSON.stringify(mapping));
}

/**
 * Set seed shown flag
 * @param {boolean} shown - Whether seed has been shown
 */
export function setSeedShown(shown) {
  localStorage.setItem(STORAGE_KEYS.SEED_SHOWN, shown ? 'true' : 'false');
}

// ============================================================================
// CHECKERS (Boolean queries)
// ============================================================================

/**
 * Check if account exists
 * @returns {boolean}
 */
export function hasAccount() {
  return !!localStorage.getItem(STORAGE_KEYS.ACCOUNT);
}

/**
 * Check if symmetric key exists
 * @returns {boolean}
 */
export function hasSymKey() {
  return !!localStorage.getItem(STORAGE_KEYS.SYM_KEY);
}

/**
 * Check if session seed exists
 * @returns {boolean}
 */
export function hasSessionSeed() {
  return !!localStorage.getItem(STORAGE_KEYS.SESSION_SEED);
}

/**
 * Check if wallet exists
 * @returns {boolean}
 */
export function hasWallet() {
  return !!localStorage.getItem(STORAGE_KEYS.EVM_WALLET);
}

/**
 * Check if credential metadata exists (email+password auth)
 * @returns {boolean}
 */
export function hasCredential() {
  return !!localStorage.getItem(STORAGE_KEYS.CREDENTIAL);
}

/**
 * Check if pending credential mapping exists
 * @returns {boolean}
 */
export function hasPendingCredentialMapping() {
  return !!localStorage.getItem(STORAGE_KEYS.PENDING_CREDENTIAL_MAPPING);
}

/**
 * Check if user is logged in (has both account and sym key)
 * @returns {boolean}
 */
export function isLoggedIn() {
  return hasAccount() && hasSymKey();
}

/**
 * Check if account is persisted to Arweave
 * @returns {boolean}
 */
export function isAccountPersisted() {
  const account = getAccount();
  return !!(account && account.arweaveTxId);
}

// ============================================================================
// CLEARERS (Granular removal)
// ============================================================================

/**
 * Clear account metadata
 */
export function clearAccount() {
  localStorage.removeItem(STORAGE_KEYS.ACCOUNT);
}

/**
 * Clear authentication data (sym key, session seed)
 */
export function clearAuth() {
  localStorage.removeItem(STORAGE_KEYS.SYM_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_SEED);
}

/**
 * Clear EVM wallet
 */
export function clearWallet() {
  localStorage.removeItem(STORAGE_KEYS.EVM_WALLET);
}

/**
 * Clear manual seed
 */
export function clearManualSeed() {
  localStorage.removeItem(STORAGE_KEYS.MANUAL_SEED);
}

/**
 * Clear credential metadata
 */
export function clearCredential() {
  localStorage.removeItem(STORAGE_KEYS.CREDENTIAL);
}

/**
 * Clear pending credential mapping (after successful upload)
 */
export function clearPendingCredentialMapping() {
  localStorage.removeItem(STORAGE_KEYS.PENDING_CREDENTIAL_MAPPING);
}

/**
 * Clear seed shown flag
 */
export function clearSeedShown() {
  localStorage.removeItem(STORAGE_KEYS.SEED_SHOWN);
}

// ============================================================================
// CLEARERS (Bulk operations)
// ============================================================================

/**
 * Clear all session data (logout)
 * Removes everything related to current session
 */
export function clearSession() {
  clearAuth();
  clearAccount();
  clearWallet();
  clearManualSeed();
  clearSeedShown();
  clearCredential();
  clearPendingCredentialMapping();
}

/**
 * Clear all storage (nuclear option)
 * Use with extreme caution - removes ALL Bookish data
 */
export function clearAll() {
  Object.values(STORAGE_KEYS).forEach(key => {
    localStorage.removeItem(key);
  });
}

// ============================================================================
// STATE QUERIES (Debugging & monitoring)
// ============================================================================

/**
 * Get complete storage state (for debugging)
 * @returns {Object} Object with all storage flags
 */
export function getStorageState() {
  return {
    hasAccount: hasAccount(),
    hasSymKey: hasSymKey(),
    hasSessionSeed: hasSessionSeed(),
    hasManualSeed: !!getManualSeed(),
    hasCredential: hasCredential(),
    hasPendingCredentialMapping: hasPendingCredentialMapping(),
    hasWallet: hasWallet(),
    seedShown: getSeedShown(),
    isLoggedIn: isLoggedIn(),
    isAccountPersisted: isAccountPersisted()
  };
}

/**
 * Get all sensitive storage keys (for privacy/logging)
 * @returns {string[]} Array of key names containing sensitive data
 */
export function getSensitiveKeys() {
  return [
    STORAGE_KEYS.SYM_KEY,
    STORAGE_KEYS.SESSION_SEED,
    STORAGE_KEYS.MANUAL_SEED,
    STORAGE_KEYS.EVM_WALLET
  ];
}

/**
 * Mask sensitive data in object (for safe logging)
 * @param {Object} obj - Object to mask
 * @returns {Object} Object with sensitive fields masked
 */
export function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const masked = { ...obj };
  const sensitiveFields = ['seed', 'privateKey', 'enc', 'key'];

  for (const field of sensitiveFields) {
    if (masked[field]) {
      masked[field] = '[REDACTED]';
    }
  }

  return masked;
}

// ============================================================================
// EXPORT/IMPORT (Backup & restore)
// ============================================================================

/**
 * Export all storage data (for backup)
 * @returns {Object} Object containing all storage data
 */
export function exportAllData() {
  const data = {};

  Object.entries(STORAGE_KEYS).forEach(([name, key]) => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      data[key] = value;
    }
  });

  return data;
}

/**
 * Import storage data (for restore)
 * WARNING: Overwrites existing data
 * @param {Object} data - Data object from exportAllData()
 */
export function importAllData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid import data');
  }

  // Validate keys before importing
  const validKeys = Object.values(STORAGE_KEYS);
  const dataKeys = Object.keys(data);

  for (const key of dataKeys) {
    if (!validKeys.includes(key)) {
      console.warn(`[StorageManager] Unknown key in import: ${key}`);
    }
  }

  // Clear existing data first
  clearAll();

  // Import new data
  Object.entries(data).forEach(([key, value]) => {
    if (validKeys.includes(key)) {
      localStorage.setItem(key, value);
    }
  });
}
