// storage_constants.js - Centralized localStorage key constants
// Single source of truth for all storage keys used across the app

// Account and authentication
export const ACCOUNT_STORAGE_KEY = 'bookish.account';
export const SEED_SHOWN_KEY = 'bookish.seed.shown';

// Session and encryption
export const SYM_KEY_STORAGE_KEY = 'bookish.sym';
export const SESSION_ENC_STORAGE_KEY = 'bookish.account.sessionEnc';

// Wallet
export const WALLET_STORAGE_KEY = 'bookish.wallet';
export const EVM_WALLET_STORAGE_KEY = 'bookish.evmWallet.v1';

// Manual seed
export const MANUAL_SEED_STORAGE_KEY = 'bookish.seed.manual';

// Credential-based auth (email+password)
export const CREDENTIAL_STORAGE_KEY = 'bookish.credential';

// Pending credential mapping (survives page reload until uploaded to Arweave)
export const PENDING_CREDENTIAL_MAPPING_KEY = 'bookish.credential.pending';
