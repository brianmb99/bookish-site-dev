// account_arweave.js - Arweave account metadata operations
// Handles upload/download of encrypted account metadata on Arweave
// Separated from account_ui.js for cleaner architecture

import { encryptJsonToBytes, decryptBytesToJson, hexToBytes } from './crypto_core.js';
import { registerPendingTxByKey, fetchPendingTxIdsByKey } from './pending_tx_bridge.js';

const TX_CACHE_PREFIX = 'bookish.txcache.acct.';

// Derive a bridge key that won't collide with the book sync bridge key.
// Books use SHA-256(wallet + 'bookish'); we namespace account metadata
// so its tx IDs don't appear in book sync results.
async function acctBridgeKey(hashedLookupKey) {
  const input = hashedLookupKey + 'acctmeta';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cacheTxId(hashedLookupKey, txId) {
  try { localStorage.setItem(TX_CACHE_PREFIX + hashedLookupKey, txId); } catch {}
}

function getCachedTxId(hashedLookupKey) {
  try { return localStorage.getItem(TX_CACHE_PREFIX + hashedLookupKey); } catch { return null; }
}

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

  console.log('[Bookish:AccountArweave] Uploading to Arweave via Turbo...');

  if (!window.bookishUpload) try { await import('../turbo_client.js'); } catch {}
  if (!window.bookishUpload) {
    throw new Error('Upload client not initialized');
  }

  const result = await window.bookishUpload.upload(encryptedPayload, tags, { skipFee: true });
  const txId = result.id;

  console.log('[Bookish:AccountArweave] Account metadata uploaded:', txId);
  cacheTxId(hashedLookupKey, txId);
  acctBridgeKey(hashedLookupKey).then(bk => registerPendingTxByKey(bk, txId)).catch(() => {});
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
    // Check local tx ID cache first (instant, avoids GraphQL indexing delay)
    let txId = getCachedTxId(hashedLookupKey);
    if (txId) {
      console.log(`[Bookish:AccountArweave] Using cached tx: ${txId}`);
    }
    if (!txId) {
      try {
        const bk = await acctBridgeKey(hashedLookupKey);
        const bridgeIds = await fetchPendingTxIdsByKey(bk);
        if (bridgeIds.length > 0) {
          txId = bridgeIds[bridgeIds.length - 1];
          console.log(`[Bookish:AccountArweave] Found via bridge: ${txId}`);
          cacheTxId(hashedLookupKey, txId);
        }
      } catch { /* bridge unavailable — fall through to GraphQL */ }
    }
    if (!txId) {
      try {
        const response = await fetch('https://arweave.net/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query })
        });

        if (!response.ok) {
          console.warn(`[Bookish:AccountArweave] GraphQL returned ${response.status}`);
          return null;
        }

        const result = await response.json();
        const edges = result.data?.transactions?.edges || [];

        if (edges.length === 0) {
          console.log('[Bookish:AccountArweave] No account metadata found');
          return null;
        }

        txId = edges[0].node.id;
        cacheTxId(hashedLookupKey, txId);
      } catch (gqlErr) {
        console.warn('[Bookish:AccountArweave] GraphQL query failed:', gqlErr.message);
        return null;
      }
    }
    console.log(`[Bookish:AccountArweave] Found metadata: ${txId}`);

    // Download encrypted payload — Turbo first (immediate for recent uploads), Arweave fallback
    const gateways = [
      { url: `https://turbo-gateway.com/${txId}`, label: 'Turbo' },
      { url: `https://arweave.net/${txId}`, label: 'Arweave' }
    ];
    let encryptedBytes = null;
    for (const gw of gateways) {
      try {
        const dataResponse = await fetch(gw.url);
        if (dataResponse.ok) {
          encryptedBytes = new Uint8Array(await dataResponse.arrayBuffer());
          console.log(`[Bookish:AccountArweave] Downloaded from ${gw.label} (${encryptedBytes.length} bytes)`);
          break;
        }
        console.warn(`[Bookish:AccountArweave] ${gw.label} returned ${dataResponse.status} for ${txId}`);
      } catch (err) {
        console.warn(`[Bookish:AccountArweave] ${gw.label} fetch failed:`, err.message);
      }
    }
    if (!encryptedBytes) {
      throw new Error(`Failed to download metadata from any gateway: ${txId}`);
    }

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
