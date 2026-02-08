// account_arweave.js - Arweave account metadata operations
// Handles upload/download of encrypted account metadata on Arweave
// Separated from account_ui.js for cleaner architecture

import { encryptJsonToBytes, decryptBytesToJson, hexToBytes } from './crypto_core.js';

/**
 * Upload encrypted account metadata to Arweave (profile only, NO SEED)
 * @param {Object} params
 * @param {string} params.address - Ethereum wallet address
 * @param {string} params.displayName - User display name
 * @param {CryptoKey} params.symKey - bookish.sym encryption key (pre-derived from seed)
 * @param {number} [params.createdAt] - Account creation timestamp
 * @returns {Promise<string>} - Arweave transaction ID
 */
export async function uploadAccountMetadata({ address, displayName, symKey, createdAt }) {
  if (!address || !symKey) {
    throw new Error('address and symKey are required');
  }

  console.log('[Bookish:AccountArweave] Starting account metadata upload...');

  // Prepare account metadata (profile only, NO SEED)
  const accountMetadata = {
    displayName: displayName || 'Bookish User',
    settings: {},
    bookmarks: [],
    createdAt: createdAt || Date.now()
  };

  console.log('[Bookish:AccountArweave] Encrypting account metadata...');
  const encryptedPayload = await encryptJsonToBytes(symKey, accountMetadata);
  console.log('[Bookish:AccountArweave] Metadata encrypted, payload size:', encryptedPayload.length, 'bytes');

  // Generate lookup key: SHA-256(walletAddress + 'bookish')
  const lookupInput = address.toLowerCase() + 'bookish';
  const lookupHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lookupInput));
  const hashedLookupKey = Array.from(new Uint8Array(lookupHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const tags = [
    { name: 'App-Name', value: 'Bookish' },
    { name: 'Type', value: 'account-metadata' },
    { name: 'Account-Lookup-Key', value: hashedLookupKey },
    { name: 'Enc', value: 'aes-256-gcm' },
    { name: 'Schema-Version', value: '0.1.0' }
  ];

  console.log('[Bookish:AccountArweave] Uploading to Arweave via Irys...');

  if (!window.bookishIrys) {
    throw new Error('Irys uploader not initialized');
  }

  const result = await window.bookishIrys.upload(encryptedPayload, tags);
  const txId = result.id;

  console.log('[Bookish:AccountArweave] Account metadata uploaded:', txId);
  return txId;
}

/**
 * Download and decrypt account metadata from Arweave by wallet address
 * @param {string} walletAddress - Ethereum wallet address
 * @param {CryptoKey} symKey - Symmetric decryption key (bookish.sym)
 * @returns {Promise<Object|null>} - Decrypted account metadata or null if not found
 */
export async function downloadAccountMetadata(walletAddress, symKey) {
  if (!walletAddress || !symKey) {
    throw new Error('walletAddress and symKey are required');
  }

  console.log(`[Bookish:AccountArweave] Querying account metadata for ${walletAddress}...`);

  // Generate lookup key: SHA-256(walletAddress + 'bookish')
  const lookupInput = walletAddress.toLowerCase() + 'bookish';
  const lookupHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lookupInput));
  const hashedLookupKey = Array.from(new Uint8Array(lookupHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const query = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["account-metadata"]},
        {name: "Account-Lookup-Key", values: ["${hashedLookupKey}"]}
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

    const result = await response.json();
    const edges = result.data?.transactions?.edges || [];

    if (edges.length === 0) {
      console.log('[Bookish:AccountArweave] No account metadata found');
      return null;
    }

    const txId = edges[0].node.id;
    console.log(`[Bookish:AccountArweave] Found metadata: ${txId}`);

    // Download encrypted payload
    const dataResponse = await fetch(`https://arweave.net/${txId}`);
    if (!dataResponse.ok) {
      throw new Error(`Failed to download metadata: ${dataResponse.status}`);
    }

    const encryptedBytes = new Uint8Array(await dataResponse.arrayBuffer());
    console.log('[Bookish:AccountArweave] Downloaded encrypted payload, size:', encryptedBytes.length, 'bytes');

    // Decrypt
    const decrypted = await decryptBytesToJson(symKey, encryptedBytes);
    console.log('[Bookish:AccountArweave] Account metadata decrypted successfully');

    return decrypted;
  } catch (error) {
    console.error('[Bookish:AccountArweave] Download/decrypt failed:', error);
    throw new Error(`Failed to retrieve account metadata: ${error.message}`);
  }
}

/**
 * Check if account metadata exists on Arweave for given wallet
 * @param {string} walletAddress - Ethereum wallet address
 * @returns {Promise<boolean>}
 */
export async function accountMetadataExists(walletAddress) {
  try {
    // Generate lookup key
    const lookupInput = walletAddress.toLowerCase() + 'bookish';
    const lookupHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lookupInput));
    const hashedLookupKey = Array.from(new Uint8Array(lookupHash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const query = `query {
      transactions(
        tags: [
          {name: "App-Name", values: ["Bookish"]},
          {name: "Type", values: ["account-metadata"]},
          {name: "Account-Lookup-Key", values: ["${hashedLookupKey}"]}
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

    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    return (result.data?.transactions?.edges || []).length > 0;
  } catch (error) {
    console.error('[Bookish:AccountPersistence] Existence check failed:', error);
    return false;
  }
}
