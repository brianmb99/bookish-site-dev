// credential_mapping.js - Arweave credential mapping operations
// Handles upload/download of credential-mapping entries on Arweave

import { bytesToBase64, base64ToBytes, encryptJsonToBytes, decryptBytesToJson } from './crypto_core.js';

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
        node {
          id
        }
      }
    }
  }`;

  try {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      throw new Error(`Arweave query failed: ${response.status}`);
    }

    const result = await response.json();
    const edges = result.data?.transactions?.edges || [];

    if (edges.length === 0) {
      console.log('[Bookish:CredentialMapping] No mapping found');
      return null;
    }

    const txId = edges[0].node.id;
    console.log(`[Bookish:CredentialMapping] Found mapping: ${txId}, downloading...`);

    // Download the raw encrypted payload
    const dataResponse = await fetch(`https://arweave.net/${txId}`);
    if (!dataResponse.ok) {
      throw new Error(`Failed to download mapping: ${dataResponse.status}`);
    }

    // Read as raw bytes — the entire payload is encrypted
    const arrayBuffer = await dataResponse.arrayBuffer();
    const encryptedPayload = new Uint8Array(arrayBuffer);

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
 * Check if a credential mapping exists for the given lookup key
 * @param {string} lookupKey - Hex-encoded credential lookup key
 * @returns {Promise<boolean>}
 */
export async function credentialMappingExists(lookupKey) {
  if (!lookupKey || !isValidLookupKey(lookupKey)) {
    return false;
  }

  const query = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["credential-mapping"]},
        {name: "Credential-Lookup-Key", values: ["${lookupKey}"]}
      ],
      first: 1
    ) {
      edges {
        node {
          id
        }
      }
    }
  }`;

  try {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    return (result.data?.transactions?.edges || []).length > 0;
  } catch (error) {
    console.error('[Bookish:CredentialMapping] Existence check failed:', error);
    return false;
  }
}
