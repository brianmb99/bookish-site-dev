// credential_mapping.js - Arweave credential mapping operations
// Handles upload/download of credential-mapping entries on Arweave

import { bytesToBase64, base64ToBytes, encryptJsonToBytes, decryptBytesToJson } from './crypto_core.js';
import { registerPendingTxByKey, fetchPendingTxIdsByKey } from './pending_tx_bridge.js';
import { queryGraphQL, ARWEAVE_GATEWAY, TURBO_GATEWAY } from './arweave_query.js';

/**
 * Validate that a lookup key is a 64-char hex string (SHA-256 output)
 * Prevents GraphQL injection via unsanitized interpolation
 * @param {string} lookupKey
 * @returns {boolean}
 */
function isValidLookupKey(lookupKey) {
  return typeof lookupKey === 'string' && /^[0-9a-f]{64}$/.test(lookupKey);
}

const TX_CACHE_PREFIX = 'bookish.txcache.cred.';

function cacheTxId(lookupKey, txId) {
  try { localStorage.setItem(TX_CACHE_PREFIX + lookupKey, txId); } catch {}
}

function getCachedTxId(lookupKey) {
  try { return localStorage.getItem(TX_CACHE_PREFIX + lookupKey); } catch { return null; }
}

/**
 * Upload credential mapping to Arweave
 * The entire payload (seed + metadata) is encrypted before upload per the spec.
 * On-chain data is opaque — only the lookup key tag is in plaintext.
 *
 * @param {Object} params
 * @param {string} params.lookupKey - Hex-encoded credential lookup key (64 chars)
 * @param {Uint8Array} params.encryptedPayload - Encrypted credential payload bytes
 * @returns {Promise<string>} - Arweave transaction ID
 */
export async function uploadCredentialMapping({ lookupKey, encryptedPayload }) {
  if (!lookupKey || !encryptedPayload) {
    throw new Error('lookupKey and encryptedPayload are required');
  }

  if (!isValidLookupKey(lookupKey)) {
    throw new Error('Invalid lookupKey: must be a 64-character hex string');
  }

  console.log('[Bookish:CredentialMapping] Uploading credential mapping...');

  const tags = [
    { name: 'App-Name', value: 'Bookish' },
    { name: 'Type', value: 'credential-mapping' },
    { name: 'Credential-Lookup-Key', value: lookupKey },
    { name: 'Enc', value: 'aes-256-gcm' },
    { name: 'Schema-Version', value: '0.1.0' }
  ];

  if (!window.bookishUpload) {
    try {
      await import('../turbo_client.js');
    } catch (e) {
      console.error('[Bookish:CredentialMapping] turbo_client import failed', e);
    }
  }
  if (!window.bookishUpload) {
    throw new Error('Upload client not initialized');
  }

  try {
    const result = await window.bookishUpload.upload(encryptedPayload, tags, { skipFee: true });

    console.log(`[Bookish:CredentialMapping] Mapping uploaded: ${result.id}`);
    cacheTxId(lookupKey, result.id);
    registerPendingTxByKey(lookupKey, result.id).catch(() => {});
    return result.id;
  } catch (error) {
    console.error('[Bookish:CredentialMapping] Upload failed:', error);
    throw new Error(`Failed to upload credential mapping: ${error.message}`);
  }
}

/**
 * Search for a credential mapping transaction by lookup key tag.
 *
 * @param {string} lookupKey - Hex-encoded credential lookup key (64 chars)
 * @returns {Promise<string|null>} - Transaction ID or null if not found
 */
async function findCredentialMappingTx(lookupKey) {
  const cached = getCachedTxId(lookupKey);
  if (cached) {
    console.log(`[Bookish:CredentialMapping] Using cached tx: ${cached}`);
    return cached;
  }

  // Check bridge for recently uploaded mappings (before Arweave indexes them)
  try {
    const bridgeIds = await fetchPendingTxIdsByKey(lookupKey);
    if (bridgeIds.length > 0) {
      const txId = bridgeIds[bridgeIds.length - 1]; // newest
      console.log(`[Bookish:CredentialMapping] Found via bridge: ${txId}`);
      cacheTxId(lookupKey, txId);
      return txId;
    }
  } catch { /* bridge unavailable — fall through to GraphQL */ }

  const query = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["credential-mapping"]},
        {name: "Credential-Lookup-Key", values: ["${lookupKey}"]}
      ],
      first: 1,
      sort: HEIGHT_DESC
    ) {
      edges {
        node { id }
      }
    }
  }`;

  const { data, error } = await queryGraphQL(query);
  if (error) {
    console.warn('[Bookish:CredentialMapping] Arweave query failed:', error);
    return null;
  }
  const edges = data?.transactions?.edges || [];
  if (edges.length > 0) {
    const txId = edges[0].node.id;
    console.log(`[Bookish:CredentialMapping] Found mapping: ${txId}`);
    cacheTxId(lookupKey, txId);
    return txId;
  }
  return null;
}

/**
 * Download raw data for a transaction.
 * Tries Turbo first (immediate availability for recent uploads), then Arweave L1.
 *
 * @param {string} txId - Transaction ID
 * @returns {Promise<Uint8Array>} - Raw bytes
 */
async function downloadTxData(txId) {
  const gateways = [
    { url: `${TURBO_GATEWAY}/${txId}`, label: 'Turbo' },
    { url: `${ARWEAVE_GATEWAY}/${txId}`, label: 'Arweave' }
  ];

  let lastError = null;
  for (const gw of gateways) {
    try {
      const response = await fetch(gw.url);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        console.log(`[Bookish:CredentialMapping] Downloaded from ${gw.label} (${arrayBuffer.byteLength} bytes)`);
        return new Uint8Array(arrayBuffer);
      }
      console.warn(`[Bookish:CredentialMapping] ${gw.label} returned ${response.status} for ${txId}`);
    } catch (err) {
      console.warn(`[Bookish:CredentialMapping] ${gw.label} fetch failed:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to download data for tx ${txId}`);
}

/**
 * Download encrypted credential mapping from Arweave
 * Returns raw encrypted bytes — caller must decrypt with credential_encryption_key
 *
 * @param {string} lookupKey - Hex-encoded credential lookup key
 * @returns {Promise<{encryptedPayload: Uint8Array, txId: string}|null>}
 *   Returns null if no mapping found
 */
export async function downloadCredentialMapping(lookupKey) {
  if (!lookupKey) {
    throw new Error('lookupKey is required');
  }

  if (!isValidLookupKey(lookupKey)) {
    throw new Error('Invalid lookupKey: must be a 64-character hex string');
  }

  console.log('[Bookish:CredentialMapping] Querying credential mapping...');

  try {
    const txId = await findCredentialMappingTx(lookupKey);

    if (!txId) {
      console.log('[Bookish:CredentialMapping] No mapping found');
      return null;
    }

    console.log(`[Bookish:CredentialMapping] Found mapping: ${txId}, downloading...`);

    const encryptedPayload = await downloadTxData(txId);

    console.log('[Bookish:CredentialMapping] Mapping downloaded successfully');

    return {
      encryptedPayload,
      txId
    };
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error(`Network error: ${error.message}`);
    }
    console.error('[Bookish:CredentialMapping] Download failed:', error);
    throw error;
  }
}

/**
 * Check if a credential mapping exists for the given lookup key.
 *
 * @param {string} lookupKey - Hex-encoded credential lookup key
 * @returns {Promise<boolean>}
 */
export async function credentialMappingExists(lookupKey) {
  if (!lookupKey || !isValidLookupKey(lookupKey)) {
    return false;
  }

  try {
    const txId = await findCredentialMappingTx(lookupKey);
    return txId !== null;
  } catch (error) {
    console.error('[Bookish:CredentialMapping] Existence check failed:', error);
    return false;
  }
}
