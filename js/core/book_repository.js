// book_repository.js — Single-responsibility module for all book data operations
//
// Owns the entries array, ops queue, and remote sync via TarnClient.
// Local-first: writes go to IndexedDB immediately, then sync to Tarn.
//
// Usage:
//   const repo = new BookRepository({ cache, tarnService, ... });
//   repo.on('change', (entries) => render());
//   repo.on('error', ({ code, message }) => showError(message));
//   await repo.loadFromCache();

import { pickWinner } from './cache_core.js';
import { dateStringToMsNoonUtc } from './id_core.js';
import * as friends from './friends.js';

/**
 * Coerce a remote payload from any pre-v0.3.0 shape into the v0.3.0 in-memory
 * shape. We do not rewrite Arweave — the canonical bytes stay as the user
 * originally wrote them. The only goal here is to keep render + sort + dedup
 * code on a single shape, so legacy entries don't break newer code paths.
 *
 * Pre-v0.3.0 differences handled (issue #112):
 *   - dateRead used to be a YYYY-MM-DD string; v0.3.0 made it a noon-UTC
 *     ms-epoch number. Coerce strings via dateStringToMsNoonUtc; drop the
 *     field if the string is unparseable (better than crashing the sort).
 *   - edition was a required string; v0.3.0 dropped the field entirely.
 *     Strip it so it doesn't pollute renders or the cache_core content-hash
 *     (which now intentionally hashes without it).
 *
 * Schema/version strings are left as-is — those describe the on-Arweave
 * bytes, which we are not rewriting. This shim is a read-time view only.
 *
 * @param {Object|undefined} data
 * @returns {Object|undefined}
 */
export function normalizeLegacyEntry(data) {
  if (!data || typeof data !== 'object') return data;
  let touched = false;
  const out = { ...data };
  if (typeof out.dateRead === 'string') {
    const ms = dateStringToMsNoonUtc(out.dateRead);
    if (ms != null) out.dateRead = ms;
    else delete out.dateRead;
    touched = true;
  }
  if ('edition' in out) {
    delete out.edition;
    touched = true;
  }
  return touched ? out : data;
}

export const READING_STATUS = {
  WANT_TO_READ: 'want_to_read',
  READING: 'reading',
  READ: 'read'
};

export function normalizeReadingStatus(entry) {
  const s = entry?.readingStatus;
  if (s === READING_STATUS.WANT_TO_READ || s === READING_STATUS.READING || s === READING_STATUS.READ) return s;
  return READING_STATUS.READ;
}

function buildPayloadFromEntry(entry) {
  const payload = {
    title: entry.title,
    author: entry.author,
    format: entry.format,
    readingStatus: entry.readingStatus || READING_STATUS.READ,
    bookId: entry.bookId
  };
  // dateRead is now an optional ms-epoch number (schema v0.3.0). Only forward
  // it when present so we don't write empty strings (which would fail the
  // schema's `type: number`) for entries that aren't on the read shelf.
  if (entry.dateRead != null && entry.dateRead !== '') payload.dateRead = entry.dateRead;
  if (entry.coverImage) { payload.coverImage = entry.coverImage; if (entry.mimeType) payload.mimeType = entry.mimeType; }
  if (entry.notes) payload.notes = entry.notes;
  if (entry.rating) payload.rating = entry.rating;
  if (entry.owned) payload.owned = entry.owned;
  if (entry.tags) payload.tags = entry.tags;
  if (entry.readingStartedAt) payload.readingStartedAt = entry.readingStartedAt;
  if (entry.createdAt) payload.createdAt = entry.createdAt;
  if (entry.modifiedAt) payload.modifiedAt = entry.modifiedAt;
  if (entry.wtrPosition != null) payload.wtrPosition = entry.wtrPosition;
  // Friend-matching identifiers (issue #111). Optional — only present when the
  // book was added via search and the source supplied them. Pre-existing books
  // and manual entries simply don't carry these.
  if (entry.work_key) payload.work_key = entry.work_key;
  if (entry.isbn13) payload.isbn13 = entry.isbn13;
  // Per-book privacy (issue #129 / FRIENDS.md Surface 7). Only forward when
  // truthy so absent/false stay equivalent on Arweave (smaller blobs, schema-
  // backward-compatible). The publish-on-save path (createWithPublish /
  // updateWithPublish in BookRepository) gates share-log publication on this
  // exact field.
  if (entry.is_private === true) payload.is_private = true;
  return payload;
}

export class BookRepository {
  /**
   * @param {Object} deps
   * @param {Object} deps.cache - IndexedDB cache (window.bookishCache)
   * @param {Object} deps.tarnService - tarn_service module
   * @param {Function} [deps.deriveBookId] - async (payload) => string
   * @param {Function} [deps.onDirty] - () => void; signals sync manager
   */
  constructor({ cache, tarnService, deriveBookId, onDirty }) {
    this._cache = cache;
    this._tarnService = tarnService;
    this._deriveBookId = deriveBookId;
    this._onDirty = onDirty || (() => {});

    this._entries = [];
    this._editQueue = new Map();
    this._replaying = false;
    this._purged = false;
    this._listeners = { change: [], error: [], progress: [] };
  }

  // --- Event system ---

  on(event, fn) {
    if (!this._listeners[event]) return () => {};
    this._listeners[event].push(fn);
    return () => { this._listeners[event] = this._listeners[event].filter(f => f !== fn); };
  }

  _emit(event, data) {
    for (const fn of (this._listeners[event] || [])) {
      try { fn(data); } catch (e) { console.error('[BookRepository] listener error:', e); }
    }
  }

  _emitChange() { this._emit('change', this._entries); }

  _emitError(code, message) {
    this._emit('error', { code, message });
  }

  _emitProgress(items) { this._emit('progress', items); }

  // --- Queries ---

  getAll() { return this._entries; }

  getById(key) {
    return this._entries.find(e => (e.txid || e.id) === key);
  }

  // --- Lifecycle ---

  async loadFromCache() {
    if (!this._cache) return;
    this._purged = false;
    this._entries = await this._cache.getAllActive();
    this._entries.forEach(e => { e._committed = !!(e.status === 'confirmed' && e.seenRemote); });
    this._emitChange();
  }

  clear() {
    this._purged = true;
    this._entries = [];
    this._emitChange();
  }

  // --- Mutations ---

  async create(payload) {
    if (this._cache) {
      const dup = await this._cache.detectDuplicate(payload);
      if (dup) return { entry: dup, isDuplicate: true };
    }

    const localId = 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const createdAt = Date.now();

    if (!payload.bookId && this._deriveBookId) {
      try { payload.bookId = await this._deriveBookId({ ...payload, createdAt }); } catch {}
    }

    const modifiedAt = createdAt;
    const rec = {
      id: localId, txid: null, ...payload, createdAt, modifiedAt,
      status: 'pending', pending: true, seenRemote: false, onArweave: false, _committed: false
    };
    this._entries.push(rec);
    if (this._cache) await this._cache.putEntry(rec);
    this._onDirty();
    this._emitChange();

    // Try to upload to Tarn immediately
    if (this._tarnService.isLoggedIn()) {
      try {
        const client = await this._tarnService.getClient();
        // Capture the per-content CEK during createEntry so we can fan out
        // a share-log publish to friends afterwards (issue #129). The
        // capture is a no-op for legacy v2 blob format and for users with
        // no friends.
        const builtPayload = buildPayloadFromEntry(rec);
        const { result, cek } = await friends._captureCekDuringCall(
          () => client.createEntry('entry', builtPayload),
        );
        const { txid } = result;
        const oldId = rec.id;
        rec.txid = txid; rec.id = txid;
        rec.pending = false; rec.status = 'confirmed'; rec.seenRemote = true;
        if (this._cache) await this._cache.replaceProvisional(oldId, rec);
        this._emitError(null, null);
        this._emitChange();
        // Fire-and-forget the share-log publish. publishBook is a no-op
        // when the book is private, when the user has no friends, or when
        // the SDK call fails for one connection. We don't surface share
        // errors as save errors — the local save already succeeded.
        friends.publishBook(rec, cek).catch(err => {
          console.warn('[BookRepository] publishBook failed:', err.message);
        });
      } catch (e) {
        console.warn('[BookRepository] createEntry failed, queued for retry:', e.message);
        if (this._cache) await this._cache.queueOp({ type: 'create', localId: rec.id, payload });
        this._emitProgress(['Queued for sync']);
      }
    } else {
      // Not logged in — queue for later
      if (this._cache) await this._cache.queueOp({ type: 'create', localId: rec.id, payload });
    }

    return { entry: rec, isDuplicate: false };
  }

  async update(id, payload) {
    const old = this._entries.find(e => e.txid === id) || this._entries.find(e => e.id === id);
    if (!old) throw new Error('Entry not found');

    const entryKey = old.bookId || old.id;
    const queueEntry = this._editQueue.get(entryKey);

    const snapshot = { ...old };
    Object.assign(old, payload);
    if (payload.coverImage === '') { delete old.coverImage; delete old.mimeType; }
    old.modifiedAt = Date.now();
    old.pending = true;
    old.status = 'pending';
    old.seenRemote = false;
    old._committed = false;
    if (this._cache) await this._cache.putEntry(old);
    this._onDirty();
    this._emitChange();

    if (queueEntry?.uploading) {
      queueEntry.hasPendingEdit = true;
      return;
    }

    this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
    await this._doEditUpload(entryKey, old, id, snapshot);
  }

  async delete(id) {
    const entry = this._entries.find(e => e.txid === id) || this._entries.find(e => e.id === id);
    if (!entry) return;

    entry._deleting = true;
    entry._committed = false;
    this._emitChange();

    // Local-only entry — just remove from cache
    if (!entry.txid) {
      if (this._cache) await this._cache.deleteById(entry.id);
      this._entries = this._entries.filter(e => e !== entry);
      this._emitChange();
      return;
    }

    // Entry on Tarn — send tombstone
    try {
      const client = await this._tarnService.getClient();
      await client.deleteEntry(entry.txid, 'entry');

      entry.status = 'tombstoned';
      entry.tombstonedAt = Date.now();
      if (this._cache) await this._cache.putEntry(entry);
      this._entries = this._entries.filter(e => e.status !== 'tombstoned');
      this._emitError(null, null);
      this._onDirty();
      this._emitChange();
      // Retroactively unshare from every connection (#129). Idempotent on
      // the SDK side; non-blocking. Private books were never shared, but
      // unshareContent on a never-shared content_id is a benign no-op for
      // our purposes (warning is logged, nothing user-visible breaks).
      if (entry.bookId) {
        friends.unpublishBook(entry.bookId).catch(err => {
          console.warn('[BookRepository] unpublishBook (delete) failed:', err.message);
        });
      }
    } catch (e) {
      console.warn('[BookRepository] deleteEntry failed:', e.message);
      entry._deleting = false;
      this._emitChange();
      this._emitError('delete-failed', 'Delete failed — will retry on next sync');
    }
  }

  async changeStatus(key, newStatus) {
    const entry = this.getById(key);
    if (!entry) return null;

    const previousStatus = normalizeReadingStatus(entry);
    entry.readingStatus = newStatus;
    entry.modifiedAt = Date.now();
    if (newStatus === READING_STATUS.READING && previousStatus !== READING_STATUS.READING) {
      entry.readingStartedAt = Date.now();
    }
    if (newStatus === READING_STATUS.READ && !entry.dateRead) {
      // Schema v0.3.0: dateRead is a ms-epoch number at noon UTC.
      const now = new Date();
      entry.dateRead = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0, 0);
    }

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    const toastMessage = newStatus === READING_STATUS.READING ? 'Moved to Currently Reading'
      : newStatus === READING_STATUS.READ ? 'Finished! Added to your shelf'
      : 'Moved to Want to Read';

    if (entry.txid) {
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshot = { ...entry };
        this._doEditUpload(entryKey, entry, entry.txid, snapshot).catch(() => {
          this._emitError('status-update-failed', 'Status update failed');
        });
      }
    }

    return { entry, previousStatus, toastMessage };
  }

  async applyReadingSnapshot(key, snapshot) {
    const entry = this.getById(key);
    if (!entry) return null;

    entry.readingStatus = snapshot.readingStatus;
    if (snapshot.dateRead) entry.dateRead = snapshot.dateRead;
    else delete entry.dateRead;
    if (snapshot.readingStartedAt != null) entry.readingStartedAt = snapshot.readingStartedAt;
    else delete entry.readingStartedAt;

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    if (entry.txid) {
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshotEntry = { ...entry };
        this._doEditUpload(entryKey, entry, entry.txid, snapshotEntry).catch(() => {
          this._emitError('status-update-failed', 'Status update failed');
        });
      }
    }

    return { entry };
  }

  async reorderWtr(orderedKeys) {
    const changed = [];
    for (let i = 0; i < orderedKeys.length; i++) {
      const entry = this.getById(orderedKeys[i]);
      if (!entry) continue;
      if (entry.wtrPosition === i) continue;
      entry.wtrPosition = i;
      entry.modifiedAt = Date.now();
      if (this._cache) await this._cache.putEntry(entry);
      changed.push(entry);
    }

    if (!changed.length) return;
    this._onDirty();
    this._emitChange();

    for (const entry of changed) {
      if (!entry.txid) continue;
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);
      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshot = { ...entry };
        this._doEditUpload(entryKey, entry, entry.txid, snapshot).catch(() => {});
      }
    }
  }

  // --- Sync pipeline ---

  async sync() {
    if (!this._cache || this._purged) return;

    await this.replayPending();

    if (!this._tarnService.isLoggedIn()) {
      this._entries = await this._cache.getAllActive();
      this._emitChange();
      return;
    }

    console.log('[BookRepository] Syncing from Tarn...');
    try {
      const client = await this._tarnService.getClient();
      const remoteEntries = await client.getEntries('entry');
      console.log('[BookRepository] Fetched', remoteEntries.length, 'entries from Tarn');

      // Build remote entries in cache format. normalizeLegacyEntry coerces
      // any pre-v0.3.0 shape (string dateRead, edition field) into the
      // current shape so the rest of the pipeline can assume one schema.
      const remote = remoteEntries.map(e => ({
        ...normalizeLegacyEntry(e.data),
        txid: e.txid,
        id: e.txid,
        status: 'confirmed',
        seenRemote: true,
        _committed: true,
      }));

      // Merge with local cache (preserving local-only pending entries)
      const local = await this._cache.getAllActive();
      const localPending = local.filter(e => !e.txid || e.status === 'pending');
      const remoteTxids = new Set(remote.map(e => e.txid));

      // Deduplicate by bookId
      const byBookId = new Map();
      for (const entry of remote) {
        if (!entry.bookId) { byBookId.set(entry.txid, entry); continue; }
        const existing = byBookId.get(entry.bookId);
        if (!existing || pickWinner(entry, existing) === entry) {
          byBookId.set(entry.bookId, entry);
        }
      }

      const merged = [...byBookId.values()];

      // Add local pending entries that aren't yet on remote
      for (const pending of localPending) {
        const alreadyRemote = pending.bookId && merged.some(e => e.bookId === pending.bookId);
        if (!alreadyRemote) merged.push(pending);
      }

      // Sort: newest first. Schema v0.3.0 made dateRead a ms-epoch number;
      // legacy entries have already been coerced by normalizeLegacyEntry, so
      // a numeric subtraction is safe here. Missing/non-numeric dateRead
      // sorts to the bottom (treated as 0).
      merged.sort((a, b) => {
        const da = typeof a.dateRead === 'number' ? a.dateRead : 0;
        const db = typeof b.dateRead === 'number' ? b.dateRead : 0;
        if (da !== db) return db - da;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      // Update cache
      for (const entry of merged) {
        await this._cache.putEntry(entry);
      }

      // Remove stale entries from IndexedDB that are no longer in the merged set
      // (e.g. old txid superseded by an edit on another device)
      const mergedIds = new Set(merged.map(e => e.id));
      for (const entry of local) {
        if (!mergedIds.has(entry.id) && entry.txid && entry.status !== 'pending') {
          await this._cache.deleteById(entry.id);
        }
      }

      this._entries = merged;
      this._emitChange();
    } catch (e) {
      console.error('[BookRepository] Sync failed:', e.message);
      // Fall back to cached entries
      this._entries = await this._cache.getAllActive();
      this._emitChange();
      throw e;
    }
  }

  async replayPending() {
    if (this._replaying || this._purged) return;
    this._replaying = true;
    try {
      if (!this._cache) return;
      if (!this._tarnService.isLoggedIn()) return;

      const ops = await this._cache.listOps();
      if (!ops.length) return;

      console.log('[BookRepository] Replaying', ops.length, 'pending operations...');
      const client = await this._tarnService.getClient();

      for (const op of ops) {
        if (op.type === 'create') {
          const local = this._entries.find(e => e.id === op.localId);
          if (!local) { await this._cache.removeOp(op.id); continue; }
          if (local.txid) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            const { result, cek } = await friends._captureCekDuringCall(
              () => client.createEntry('entry', payload),
            );
            const { txid } = result;
            const oldId = local.id;
            local.txid = txid; local.id = txid;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(oldId, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
            // Replay-side publish (#129) — same fan-out as the live path.
            friends.publishBook(local, cek).catch(err => {
              console.warn('[BookRepository] Replay publishBook failed:', err.message);
            });
          } catch (e) {
            console.warn('[BookRepository] Replay create failed:', e.message);
            break; // Stop replaying on first failure
          }
        } else if (op.type === 'edit') {
          const local = this._entries.find(e => e.txid === op.priorTxid) || this._entries.find(e => e.id === op.priorTxid);
          if (!local) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            const { result } = await friends._captureCekDuringCall(
              () => client.updateEntry(op.priorTxid, 'entry', payload),
            );
            const { txid } = result;
            local.txid = txid; local.id = txid;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(op.priorTxid, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
            // Replay-side fan-out: we don't have a snapshot of the previous
            // is_private state here (the queued op stores only priorTxid),
            // so we treat replay edits as "stay-public" and call republish.
            // Private books skip the call inside republishBook; transitions
            // would have been handled in the live edit path that originally
            // queued, with the queued retry only covering the network-failure
            // case for the *last* edit's payload.
            if (local.is_private !== true) {
              friends.republishBook(local).catch(err => {
                console.warn('[BookRepository] Replay republishBook failed:', err.message);
              });
            } else {
              friends.unpublishBook(local.bookId).catch(err => {
                console.warn('[BookRepository] Replay unpublishBook failed:', err.message);
              });
            }
          } catch (e) {
            console.warn('[BookRepository] Replay edit failed:', e.message);
            break;
          }
        }
      }
    } finally {
      this._replaying = false;
    }
  }

  // --- Internal: edit upload chain ---

  async _doEditUpload(entryKey, entry, prevTxid, snapshot) {
    if (!entry.txid && !prevTxid) {
      this._editQueue.delete(entryKey);
      return;
    }

    try {
      const client = await this._tarnService.getClient();
      const payload = buildPayloadFromEntry(entry);
      // Capture CEK on edit too — needed if this edit transitions the book
      // from private → public (we'd then call publishBook, not republishBook,
      // because the friend-side share log has no entry yet for this content).
      // Captured CEK is unused on a stable-public edit (we use updateShareContent
      // which preserves the existing CEK), but capturing it cheaply keeps the
      // public-toggle path uniform.
      const { result, cek } = await friends._captureCekDuringCall(
        () => client.updateEntry(prevTxid, 'entry', payload),
      );
      const { txid } = result;

      entry.txid = txid; entry.id = txid;
      entry.pending = false; entry.status = 'confirmed'; entry.seenRemote = true;

      if (this._cache) await this._cache.replaceProvisional(prevTxid, entry);
      this._emitError(null, null);
      this._emitChange();

      // Share-log fan-out (#129). Three transitions to handle:
      //   - public → public: updateShareContent (swap tx_id, keep CEK)
      //   - public → private: unshareContent (retroactive revoke)
      //   - private → public: shareContent (fresh publish with new CEK)
      //   - private → private: no-op
      // The snapshot captured before _doEditUpload was called holds the
      // pre-edit `is_private` so we can detect transitions.
      const wasPrivate = snapshot && snapshot.is_private === true;
      const isPrivate = entry.is_private === true;
      // Fire-and-forget — share errors don't fail the edit.
      if (!wasPrivate && !isPrivate) {
        friends.republishBook(entry).catch(err => {
          console.warn('[BookRepository] republishBook failed:', err.message);
        });
      } else if (!wasPrivate && isPrivate) {
        friends.unpublishBook(entry.bookId).catch(err => {
          console.warn('[BookRepository] unpublishBook failed:', err.message);
        });
      } else if (wasPrivate && !isPrivate) {
        friends.publishBook(entry, cek).catch(err => {
          console.warn('[BookRepository] publishBook (toggle to public) failed:', err.message);
        });
      }

      const queueEntry = this._editQueue.get(entryKey);
      if (queueEntry?.hasPendingEdit) {
        queueEntry.hasPendingEdit = false;
        await this._doEditUpload(entryKey, entry, txid, snapshot);
      } else {
        this._editQueue.delete(entryKey);
      }
    } catch (e) {
      console.warn('[BookRepository] Edit upload failed:', e.message);
      this._editQueue.delete(entryKey);

      // Queue for retry
      const pending = { type: 'edit', priorTxid: prevTxid };
      if (this._cache) await this._cache.queueOp(pending);

      this._emitError('save-failed', 'Could not save to cloud — will retry on next sync');
    }
  }
}
