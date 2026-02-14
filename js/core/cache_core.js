// cache_core.js - Pure cache logic extracted from cache.js
// Testable functions for content hashing, duplicate detection, and remote merge

/**
 * Compute SHA-256 based content hash for an entry
 * @param {Object} entry - Entry object with title, author, edition, format, dateRead
 * @returns {Promise<string>} - Hash in format "sha256-<hex>"
 */
export async function computeContentHash(entry) {
  const base = (entry.title || '') + '|' + (entry.author || '') + '|' + (entry.edition || '') + '|' + (entry.format || '') + '|' + (entry.dateRead || '');
  const enc = new TextEncoder().encode(base);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'sha256-' + hex;
}

/**
 * Detect if an entry is a duplicate of existing entries
 * @param {Object} payload - Entry to check for duplication
 * @param {Array<Object>} existingEntries - Local entries to check against
 * @returns {Promise<Object|null>} - Existing entry if duplicate found (non-tombstoned), null otherwise
 */
export async function detectDuplicate(payload, existingEntries) {
  const hash = await computeContentHash(payload);
  const existing = existingEntries.find(e => e.contentHash === hash && e.status !== 'tombstoned');
  return existing || null;
}

/**
 * Merge remote entries with local entries, respecting tombstones
 * @param {Array<Object>} remoteList - Remote entries from server
 * @param {Array<Object>} tombstones - Array of {txid, ref} indicating deleted entries
 * @param {Array<Object>} localEntries - Current local entries
 * @returns {Promise<Object>} - { toAdd: [], toUpdate: [], toTombstone: [], toReplace: [] }
 */
export async function applyRemote(remoteList, tombstones, localEntries) {
  const tombRefs = new Set((tombstones || []).map(t => t.ref).filter(Boolean));
  const localMapByTx = new Map(localEntries.filter(e => e.txid).map(e => [e.txid, e]));

  const toAdd = [];
  const toUpdate = [];
  const toTombstone = [];
  const toReplace = [];

  // Process remote entries
  for (const r of remoteList) {
    if (tombRefs.has(r.txid)) continue; // Skip tombstoned entries

    const existing = localMapByTx.get(r.txid);
    if (existing) {
      let changed = false;
      const updates = {};

      if (existing.status === 'pending') {
        updates.status = 'confirmed';
        if (existing.pending) {
          updates.pending = false;
        }
        changed = true;
      }
      if (!existing.seenRemote) {
        updates.seenRemote = true;
        changed = true;
      }

      if (changed) {
        toUpdate.push({ ...existing, ...updates });
      }
    } else {
      // New remote entry - check if it supersedes a local entry (edit race: sync saw new txid before replaceProvisional)
      const prevTxid = r.prevTxid;
      const supersededLocal = prevTxid ? localMapByTx.get(prevTxid) : null;

      const contentHash = await computeContentHash({
        title: r.title,
        author: r.author,
        edition: r.edition,
        format: r.format,
        dateRead: r.dateRead
      });

      const newEntry = {
        id: r.txid,
        txid: r.txid,
        title: r.title,
        author: r.author,
        edition: r.edition,
        format: r.format,
        dateRead: r.dateRead,
        coverImage: r.coverImage,
        mimeType: r.mimeType,
        contentHash,
        createdAt: Date.now(),
        status: 'confirmed',
        seenRemote: true,
        onArweave: false
      };

      if (supersededLocal) {
        toReplace.push({ prevTxid, entry: newEntry });
      } else {
        toAdd.push(newEntry);
      }
    }
  }

  // Mark tombstoned entries
  for (const e of localEntries) {
    if (e.txid && tombRefs.has(e.txid) && e.status !== 'tombstoned') {
      toTombstone.push({
        ...e,
        status: 'tombstoned',
        tombstonedAt: Date.now()
      });
    }
  }

  return { toAdd, toUpdate, toTombstone, toReplace };
}

/**
 * Compact duplicate entries, keeping the best one
 * @param {Array<Object>} entries - All entries to check for duplicates
 * @returns {Object} - { toKeep: [], toDelete: [] }
 */
export function compactDuplicates(entries) {
  const seenTx = new Map();
  const toDelete = [];

  // Handle same-txid duplicates
  for (const e of entries) {
    if (e.txid) {
      if (!seenTx.has(e.txid)) {
        seenTx.set(e.txid, e);
      } else {
        // Duplicate same txid: keep confirmed or latest
        const prev = seenTx.get(e.txid);
        let keep, drop;

        if (prev.status === 'confirmed' && e.status !== 'confirmed') {
          keep = prev;
          drop = e;
        } else if (e.status === 'confirmed' && prev.status !== 'confirmed') {
          keep = e;
          drop = prev;
        } else {
          // Both same status - keep latest
          if ((e.createdAt || 0) > (prev.createdAt || 0)) {
            keep = e;
            drop = prev;
          } else {
            keep = prev;
            drop = e;
          }
        }

        if (drop.id !== keep.id) {
          toDelete.push(drop.id);
        }
        seenTx.set(e.txid, keep);
      }
    }
  }

  // Remove pending duplicates by contentHash if a confirmed exists
  const confirmedByHash = new Set(
    entries
      .filter(e => e.status === 'confirmed')
      .map(e => e.contentHash)
  );

  for (const e of entries) {
    if (e.status !== 'confirmed' && confirmedByHash.has(e.contentHash)) {
      if (!toDelete.includes(e.id)) {
        toDelete.push(e.id);
      }
    }
  }

  const toKeep = entries.filter(e => !toDelete.includes(e.id));

  return { toKeep, toDelete };
}
