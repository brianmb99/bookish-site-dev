// book_repository.js — Single-responsibility module for all book data operations
//
// Owns the entries array, ops queue, and remote sync via the schema-first
// Tarn SDK. Local-first: writes go to IndexedDB immediately, then sync to
// Tarn's `tarn.books.*` typed namespace.
//
// Addressing model: every record is identified end-to-end by its `bookId`
// (the schema's primary key). Arweave txids are an implementation detail
// of the SDK's Eid-chain machinery and never surface in this layer or
// above. The previous version used txid as the primary in-memory id; the
// migration to the new SDK consolidates on bookId.
//
// Publish-on-save: after a successful save where `is_private` is false/
// absent, we call `tarn.books.shareWithAll(bookId)` to fan out to every
// non-muted connection. After delete, we iterate connections and call
// `tarn.books.unshare(connection, bookId)`. Privacy toggles fire the
// matching share/unshare-with-all. The SDK manages the shareKey internally
// — no monkey-patching needed.

import { pickWinner } from './cache_core.js';
import * as friends from './friends.js';

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

/**
 * Build the wire-shape payload for `tarn.books.create()` / `update()`.
 * Filters out local-only fields and undefined values; includes only what's
 * declared in bookish-schema.js (the SDK rejects unknown fields).
 */
function buildPayloadFromEntry(entry) {
  const payload = {
    bookId: entry.bookId,
    title: entry.title,
    format: entry.format,
    readingStatus: entry.readingStatus || READING_STATUS.READ,
  };
  if (entry.author) payload.author = entry.author;
  if (entry.dateRead != null && entry.dateRead !== '') payload.dateRead = entry.dateRead;
  if (entry.coverImage) {
    payload.coverImage = entry.coverImage;
    if (entry.mimeType) payload.mimeType = entry.mimeType;
    if (entry.coverFit) payload.coverFit = entry.coverFit;
  }
  if (entry.notes) payload.notes = entry.notes;
  if (entry.rating != null) payload.rating = entry.rating;
  if (entry.tags) payload.tags = entry.tags;
  if (entry.owned === true) payload.owned = true;
  if (entry.readingStartedAt) payload.readingStartedAt = entry.readingStartedAt;
  if (entry.createdAt) payload.createdAt = entry.createdAt;
  if (entry.modifiedAt) payload.modifiedAt = entry.modifiedAt;
  if (entry.wtrPosition != null) payload.wtrPosition = entry.wtrPosition;
  if (entry.work_key) payload.work_key = entry.work_key;
  if (entry.isbn13) payload.isbn13 = entry.isbn13;
  if (entry.is_private === true) payload.is_private = true;
  return payload;
}

/**
 * Best-effort share-on-save: publish to every non-muted connection.
 * Fire-and-forget; the SDK returns per-connection failures but we don't
 * surface share errors as save errors.
 */
async function shareToFriends(client, bookId) {
  try {
    const result = await client.books.shareWithAll(bookId);
    if (result && result.failed && result.failed.length) {
      for (const f of result.failed) {
        console.warn('[BookRepository] share failed for', f.connection?.share_pub?.slice(0, 8), '—', f.error);
      }
    }
  } catch (err) {
    console.warn('[BookRepository] shareWithAll failed:', err.message);
  }
}

/**
 * Best-effort unshare from every connection. Used on delete and on
 * public→private toggle. Idempotent on the SDK side.
 */
async function unshareFromAllFriends(client, bookId) {
  try {
    const conns = await client.connections.list();
    for (const conn of conns) {
      try {
        await client.books.unshare(conn, bookId);
      } catch (err) {
        // unshare on a never-shared content_id is a benign no-op for our
        // purposes (e.g., a friend who joined after the book was already
        // private). Quiet warn.
        console.warn('[BookRepository] unshare failed for', conn.share_pub?.slice(0, 8), '—', err.message);
      }
    }
  } catch (err) {
    console.warn('[BookRepository] unshareFromAllFriends failed:', err.message);
  }
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
    // Address by bookId end-to-end now. Fall back to the legacy `id` field
    // for entries that haven't been re-keyed yet (in-memory only — once
    // persisted via the new SDK they always carry bookId).
    return this._entries.find(e => e.bookId === key) || this._entries.find(e => e.id === key);
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
      id: localId, ...payload, createdAt, modifiedAt,
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
        const builtPayload = buildPayloadFromEntry(rec);
        // Fresh create — no Eid mapping yet, the SDK derives one.
        await client.books.create(builtPayload);
        const oldId = rec.id;
        // bookId is now the canonical id; drop the local-id sentinel.
        rec.id = rec.bookId;
        rec.pending = false; rec.status = 'confirmed'; rec.seenRemote = true;
        if (this._cache) await this._cache.replaceProvisional(oldId, rec);
        this._emitError(null, null);
        this._emitChange();
        // Share to friends if public. Fire-and-forget — share failures
        // don't fail the local save.
        if (rec.is_private !== true) {
          shareToFriends(client, rec.bookId).then(() => friends.invalidateFriendLibraryCache());
        }
      } catch (e) {
        console.warn('[BookRepository] books.create failed, queued for retry:', e.message);
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
    const old = this.getById(id);
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
    await this._doEditUpload(entryKey, old, snapshot);
  }

  async delete(id) {
    const entry = this.getById(id);
    if (!entry) return;

    entry._deleting = true;
    entry._committed = false;
    this._emitChange();

    // Local-only entry — just remove from cache. No bookId means it never
    // made it to Tarn; nothing to tombstone or unshare.
    if (!entry.bookId || entry.status === 'pending' && !entry.seenRemote) {
      if (this._cache) await this._cache.deleteById(entry.id);
      this._entries = this._entries.filter(e => e !== entry);
      this._emitChange();
      // Even local-only entries may have had a confirmed sync race; try
      // unshare best-effort if we have a bookId.
      if (entry.bookId && this._tarnService.isLoggedIn()) {
        try {
          const client = await this._tarnService.getClient();
          unshareFromAllFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
        } catch { /* ignore */ }
      }
      return;
    }

    // Entry on Tarn — send tombstone via the typed namespace.
    try {
      const client = await this._tarnService.getClient();
      await client.books.delete(entry.bookId);

      entry.status = 'tombstoned';
      entry.tombstonedAt = Date.now();
      if (this._cache) await this._cache.putEntry(entry);
      this._entries = this._entries.filter(e => e.status !== 'tombstoned');
      this._emitError(null, null);
      this._onDirty();
      this._emitChange();
      // Retroactively unshare from every connection. Idempotent on the SDK
      // side; non-blocking. Private books were never shared, but unshare
      // on a never-shared content_id is a benign no-op for our purposes.
      unshareFromAllFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
    } catch (e) {
      console.warn('[BookRepository] books.delete failed:', e.message);
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
      const now = new Date();
      entry.dateRead = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0, 0);
    }

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    const toastMessage = newStatus === READING_STATUS.READING ? 'Moved to Currently Reading'
      : newStatus === READING_STATUS.READ ? 'Finished! Added to your shelf'
      : 'Moved to Want to Read';

    if (entry.bookId && entry.seenRemote) {
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshot = { ...entry };
        this._doEditUpload(entryKey, entry, snapshot).catch(() => {
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

    if (entry.bookId && entry.seenRemote) {
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshotEntry = { ...entry };
        this._doEditUpload(entryKey, entry, snapshotEntry).catch(() => {
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
      if (!entry.bookId || !entry.seenRemote) continue;
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);
      if (queueEntry?.uploading) {
        queueEntry.hasPendingEdit = true;
      } else {
        this._editQueue.set(entryKey, { uploading: true, hasPendingEdit: false });
        const snapshot = { ...entry };
        this._doEditUpload(entryKey, entry, snapshot).catch(() => {});
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
      const remoteRecords = await client.books.list();
      console.log('[BookRepository] Fetched', remoteRecords.length, 'records from Tarn');

      // The SDK returns fully-decoded records validated against the schema.
      // No normalization needed — every record carries the canonical shape.
      const remote = remoteRecords.map(data => ({
        ...data,
        id: data.bookId,
        status: 'confirmed',
        seenRemote: true,
        _committed: true,
      }));

      const local = await this._cache.getAllActive();
      const localPending = local.filter(e => !e.seenRemote || e.status === 'pending');

      // Deduplicate by bookId; remote wins.
      const byBookId = new Map();
      for (const entry of remote) {
        if (!entry.bookId) continue;
        const existing = byBookId.get(entry.bookId);
        if (!existing || pickWinner(entry, existing) === entry) {
          byBookId.set(entry.bookId, entry);
        }
      }

      const merged = [...byBookId.values()];

      // Add local pending entries that aren't yet on remote.
      for (const pending of localPending) {
        const alreadyRemote = pending.bookId && merged.some(e => e.bookId === pending.bookId);
        if (!alreadyRemote) merged.push(pending);
      }

      // Sort: newest first (by dateRead, then createdAt).
      merged.sort((a, b) => {
        const da = typeof a.dateRead === 'number' ? a.dateRead : 0;
        const db = typeof b.dateRead === 'number' ? b.dateRead : 0;
        if (da !== db) return db - da;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      // Update cache.
      for (const entry of merged) {
        await this._cache.putEntry(entry);
      }

      // Remove stale entries from IndexedDB that aren't in the merged set.
      const mergedIds = new Set(merged.map(e => e.id));
      for (const entry of local) {
        if (!mergedIds.has(entry.id) && entry.seenRemote && entry.status !== 'pending') {
          await this._cache.deleteById(entry.id);
        }
      }

      this._entries = merged;
      this._emitChange();
    } catch (e) {
      console.error('[BookRepository] Sync failed:', e.message);
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
          if (local.seenRemote) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            await client.books.create(payload);
            const oldId = local.id;
            local.id = local.bookId;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(oldId, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
            if (local.is_private !== true) {
              shareToFriends(client, local.bookId).then(() => friends.invalidateFriendLibraryCache());
            }
          } catch (e) {
            console.warn('[BookRepository] Replay create failed:', e.message);
            break;
          }
        } else if (op.type === 'edit') {
          // The legacy edit op carried `priorTxid`; the new path keys on bookId.
          const local = this._entries.find(e => e.bookId === op.bookId)
            || this._entries.find(e => e.bookId === op.priorTxid)
            || this._entries.find(e => e.id === op.priorTxid);
          if (!local || !local.bookId) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            // Partial-merge path: pass the full payload minus the primary key.
            const { bookId: _bookId, ...patch } = payload;
            await client.books.update(local.bookId, patch);
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(local.id, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
            // Replay-side fan-out: stay-public → re-share (publishes the new
            // tx_id). Private → unshare. Both paths idempotent on the SDK.
            if (local.is_private !== true) {
              shareToFriends(client, local.bookId).then(() => friends.invalidateFriendLibraryCache());
            } else {
              unshareFromAllFriends(client, local.bookId).then(() => friends.invalidateFriendLibraryCache());
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

  async _doEditUpload(entryKey, entry, snapshot) {
    if (!entry.bookId) {
      this._editQueue.delete(entryKey);
      return;
    }

    try {
      const client = await this._tarnService.getClient();
      const payload = buildPayloadFromEntry(entry);
      const { bookId: _bookId, ...patch } = payload;
      await client.books.update(entry.bookId, patch);

      entry.pending = false; entry.status = 'confirmed'; entry.seenRemote = true;
      // bookId is the canonical id now; align local id.
      entry.id = entry.bookId;

      if (this._cache) await this._cache.replaceProvisional(entry.id, entry);
      this._emitError(null, null);
      this._emitChange();

      // Share-log fan-out:
      //   - was public, stays public: re-share (re-publishes new tx_id)
      //   - was public, now private: unshare from all
      //   - was private, now public: share with all (fresh publish)
      //   - was private, stays private: no-op
      const wasPrivate = snapshot && snapshot.is_private === true;
      const isPrivate = entry.is_private === true;
      if (!wasPrivate && !isPrivate) {
        shareToFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
      } else if (!wasPrivate && isPrivate) {
        unshareFromAllFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
      } else if (wasPrivate && !isPrivate) {
        shareToFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
      }

      const queueEntry = this._editQueue.get(entryKey);
      if (queueEntry?.hasPendingEdit) {
        queueEntry.hasPendingEdit = false;
        await this._doEditUpload(entryKey, entry, snapshot);
      } else {
        this._editQueue.delete(entryKey);
      }
    } catch (e) {
      console.warn('[BookRepository] Edit upload failed:', e.message);
      this._editQueue.delete(entryKey);

      // Queue for retry. Key on bookId now.
      const pending = { type: 'edit', bookId: entry.bookId };
      if (this._cache) await this._cache.queueOp(pending);

      this._emitError('save-failed', 'Could not save to cloud — will retry on next sync');
    }
  }
}
