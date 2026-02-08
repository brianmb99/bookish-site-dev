// credential_mapping.js - Arweave credential mapping operations
// Handles upload/download of credential-mapping entries on Arweave
// Uses Irys GraphQL as primary search (instant indexing) with arweave.net fallback

import { bytesToBase64, base64ToBytes, encryptJsonToBytes, decryptBytesToJson } from './crypto_core.js';

// Gateway configuration
// Irys indexes transactions instantly; arweave.net can take minutes–hours to index Irys bundles
const IRYS_GRAPHQL = 'https://node1.irys.xyz/graphql';
const ARWEAVE_GRAPHQL = 'https://arweave.net/graphql';
const IRYS_GATEWAY = 'https://gateway.irys.xyz';
const ARWEAVE_GATEWAY = 'https://arweave.net';

/**
 * Validate that a lookup key is a 64-char hex string (SHA-256 output)
 * Prevents GraphQL injection via unsanitized interpolation
 * @param {string} lookupKey
 * @returns {boolean}
 */
function isValidLookupKey(lookupKey) {
  return typeof lookupKey === 'string' && /^[0-9a-f]{64}$/.test(lookupKey);
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

  if (!window.bookishIrys) {
    throw new Error('Irys uploader not initialized');
  }

  try {
    const result = await window.bookishIrys.upload(encryptedPayload, tags);

    console.log(`[Bookish:CredentialMapping] Mapping uploaded: ${result.id}`);
    return result.id;
  } catch (error) {
    console.error('[Bookish:CredentialMapping] Upload failed:', error);
    throw new Error(`Failed to upload credential mapping: ${error.message}`);
  }
}

/**
 * Search for a credential mapping transaction by lookup key tag.
 * Queries Irys first (instant indexing), then falls back to arweave.net.
 *
 * @param {string} lookupKey - Hex-encoded credential lookup key (64 chars)
 * @returns {Promise<string|null>} - Transaction ID or null if not found
 */
async function findCredentialMappingTx(lookupKey) {
  // Irys GraphQL — does NOT support `sort`, but has instant indexing
  const irysQuery = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["credential-mapping"]},
        {name: "Credential-Lookup-Key", values: ["${lookupKey}"]}
      ],
      first: 1
    ) {
      edges {
        node { id }
      }
    }
  }`;

  // Arweave GraphQL — supports `sort: HEIGHT_DESC`, slower to index Irys bundles
  const arweaveQuery = `query {
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

  // Helper: run a single GraphQL query and extract the first tx ID
  async function queryEndpoint(url, query, label) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!response.ok) {
        console.warn(`[Bookish:CredentialMapping] ${label} query returned ${response.status}`);
        return null;
      }
      const result = await response.json();
      const edges = result.data?.transactions?.edges || [];
      if (edges.length > 0) {
        console.log(`[Bookish:CredentialMapping] Found mapping on ${label}: ${edges[0].node.id}`);
        return edges[0].node.id;
      }
      return null;
    } catch (err) {
      console.warn(`[Bookish:CredentialMapping] ${label} query failed:`, err.message);
      return null;
    }
  }

  // 1. Try Irys first (always has latest data)
  const irysResult = await queryEndpoint(IRYS_GRAPHQL, irysQuery, 'Irys');
  if (irysResult) return irysResult;

  // 2. Fall back to Arweave (for older data or if Irys is down)
  console.log('[Bookish:CredentialMapping] Not found on Irys, trying arweave.net...');
  const arweaveResult = await queryEndpoint(ARWEAVE_GRAPHQL, arweaveQuery, 'Arweave');
  return arweaveResult;
}

/**
 * Download raw data for a transaction, trying Irys gateway first.
 *
 * @param {string} txId - Transaction ID
 * @returns {Promise<Uint8Array>} - Raw bytes
 */
async function downloadTxData(txId) {
  // Try Irys gateway first (instant for Irys-uploaded data)
  const gateways = [
    { url: `${IRYS_GATEWAY}/${txId}`, label: 'Irys' },
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
 * Download encrypted credential mapping from Arweave/Irys
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
    // Search across both gateways
    const txId = await findCredentialMappingTx(lookupKey);

    if (!txId) {
      console.log('[Bookish:CredentialMapping] No mapping found on any gateway');
      return null;
    }

    console.log(`[Bookish:CredentialMapping] Found mapping: ${txId}, downloading...`);

    // Download raw encrypted payload (tries Irys, then Arweave)
    const encryptedPayload = await downloadTxData(txId);

    console.log('[Bookish:CredentialMapping] Mapping downloaded successfully');

    return {
      encryptedPayload,
      txId
    };
  } catch (error) {
    // Distinguish network errors from "not found"
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error(`Network error: ${error.message}`);
    }
    console.error('[Bookish:CredentialMapping] Download failed:', error);
    throw error;
  }
}

/**
 * Check if a credential mapping exists for the given lookup key.
 * Uses the same dual-gateway search (Irys first, then Arweave).
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
