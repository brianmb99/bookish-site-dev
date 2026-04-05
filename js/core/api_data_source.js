// api_data_source.js — Thin client for the bookish-api read-only cache layer.
//
// Returns the same shape as BookRepository._fetchRemoteEntries():
//   { entries: Array<decrypted entry>, tombstones: Array<{txid, ref}>, partial: boolean }
//
// Tombstones and Prev-chain/Eid resolution are handled server-side.
// The API returns metadata only (txids + tags); this module fetches encrypted
// bytes from the gateway and decrypts them client-side.

const API_BASE = window.BOOKISH_API_BASE || 'https://api.getbookish.app';
const BATCH_SIZE = 10;

/**
 * Fetch resolved entries from the bookish-api and decrypt them.
 *
 * @param {string} addr - Wallet address
 * @param {Object} opts
 * @param {string} [opts.app='bookish'] - App tag value
 * @param {string} [opts.type='entry'] - Type tag value
 * @param {Function} opts.decryptFn - async (txid) => decrypted object (same as browserClient.decryptTx)
 * @returns {Promise<{entries: Array, tombstones: Array, partial: boolean}>}
 */
export async function fetchEntriesFromAPI(addr, { app = 'bookish', type = 'entry', decryptFn }) {
  if (!addr) return { entries: [], tombstones: [], partial: false };
  if (!decryptFn) throw new Error('decryptFn is required');

  const allApiEntries = [];
  let cursor = null;
  let partial = false;
  let pages = 0;

  try {
    // Paginate through all entries
    for (;;) {
      const params = new URLSearchParams({ app, type, addr: addr.toLowerCase(), limit: '100' });
      if (cursor) params.set('cursor', cursor);

      const url = `${API_BASE}/api/v1/entries?${params}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!resp.ok) {
        console.warn('[Bookish:APIDataSource] API returned', resp.status);
        partial = true;
        break;
      }

      const json = await resp.json();
      allApiEntries.push(...json.entries);
      pages++;

      if (!json.pagination.hasMore) break;
      cursor = json.pagination.cursor;
      if (pages > 50) break; // safety
    }
  } catch (err) {
    console.warn('[Bookish:APIDataSource] Fetch failed:', err.message);
    partial = true;
  }

  console.log('[Bookish:APIDataSource] Got', allApiEntries.length, 'resolved entries from API in', pages, 'page(s)');

  // Decrypt in batches — same pattern as BookRepository._decryptEdges
  const entries = [];
  const t0 = Date.now();

  for (let i = 0; i < allApiEntries.length; i += BATCH_SIZE) {
    const batch = allApiEntries.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (apiEntry) => {
        const dec = await decryptFn(apiEntry.txid);
        return {
          txid: apiEntry.txid,
          ...dec,
          block: apiEntry.confirmed ? {} : null,
        };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === 'fulfilled') {
        entries.push(settled[j].value);
      } else {
        console.warn('[Bookish:APIDataSource] Decrypt failed for', batch[j].txid, settled[j].reason);
      }
    }
  }

  console.log('[Bookish:APIDataSource] Decrypted', entries.length, '/', allApiEntries.length, 'in', Date.now() - t0, 'ms');

  // Tombstones already resolved server-side — return empty
  return { entries, tombstones: [], partial };
}
