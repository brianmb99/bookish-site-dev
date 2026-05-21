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
import { debugLog } from './debug_log.js';

export const READING_STATUS = {
  WANT_TO_READ: 'want_to_read',
  READING: 'reading',
  READ: 'read'
};

const DEFAULT_EDIT_UPLOAD_DEBOUNCE_MS = 2500;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

export function normalizeReadingStatus(entry) {
  const s = entry?.readingStatus;
  if (s === READING_STATUS.WANT_TO_READ || s === READING_STATUS.READING || s === READING_STATUS.READ) return s;
  return READING_STATUS.READ;
}

function addUnset(unset, field) {
  if (!unset.includes(field)) unset.push(field);
}

/**
 * Build the wire-shape payload for `tarn.books.create()` / `update()`.
 * Filters out local-only fields and undefined values; includes only what's
 * declared in bookish_schema.js (the SDK rejects unknown fields).
 *
 * For update calls, Tarn supports a separate `{ unset: [...] }` option.
 * Bookish uses that option whenever the local state means "clear this
 * optional field" instead of sending empty sentinels that would remain on
 * the remote record forever.
 */
function buildPayloadFromEntry(entry, { forUpdate = false } = {}) {
  const unset = [];
  const payload = {
    bookId: entry.bookId,
    title: entry.title,
    format: entry.format,
    readingStatus: entry.readingStatus || READING_STATUS.READ,
  };
  if (hasOwn(entry, 'author') && entry.author != null) payload.author = entry.author;
  if (entry.dateRead != null && entry.dateRead !== '') payload.dateRead = entry.dateRead;
  else if (forUpdate && hasOwn(entry, 'dateRead')) addUnset(unset, 'dateRead');
  if (hasOwn(entry, 'coverImage')) {
    if (entry.coverImage) {
      payload.coverImage = entry.coverImage;
      if (hasOwn(entry, 'mimeType') && entry.mimeType) payload.mimeType = entry.mimeType;
      if (hasOwn(entry, 'coverFit') && entry.coverFit) payload.coverFit = entry.coverFit;
    } else if (forUpdate) {
      addUnset(unset, 'coverImage');
      addUnset(unset, 'mimeType');
      addUnset(unset, 'coverFit');
    }
  }
  if (hasOwn(entry, 'notes')) {
    if (entry.notes != null && entry.notes !== '') payload.notes = entry.notes;
    else if (forUpdate) addUnset(unset, 'notes');
  }
  if (hasOwn(entry, 'rating')) {
    if (entry.rating != null && entry.rating !== '' && Number(entry.rating) > 0) payload.rating = entry.rating;
    else if (forUpdate) addUnset(unset, 'rating');
  }
  if (hasOwn(entry, 'tags')) {
    const emptyTags = entry.tags == null || entry.tags === '' || (Array.isArray(entry.tags) && entry.tags.length === 0);
    if (!emptyTags) payload.tags = entry.tags;
    else if (forUpdate) addUnset(unset, 'tags');
  }
  if (hasOwn(entry, 'owned') && typeof entry.owned === 'boolean') payload.owned = entry.owned;
  if (entry.readingStartedAt) payload.readingStartedAt = entry.readingStartedAt;
  else if (forUpdate && hasOwn(entry, 'readingStartedAt')) addUnset(unset, 'readingStartedAt');
  if (entry.createdAt) payload.createdAt = entry.createdAt;
  if (entry.modifiedAt) payload.modifiedAt = entry.modifiedAt;
  if (entry.wtrPosition != null) payload.wtrPosition = entry.wtrPosition;
  if (entry.work_key) payload.work_key = entry.work_key;
  if (entry.isbn13) payload.isbn13 = entry.isbn13;
  // Always include is_private when the caller has an opinion (true OR false).
  // Old behavior emitted only on `true`, which broke private→public toggles:
  // `tarn.books.update(bookId, patch)` does partial-merge, so an omitted field
  // means the previous `true` survives. Friends would never see the book even
  // after the user toggled it back to public.
  if (typeof entry.is_private === 'boolean') payload.is_private = entry.is_private;

  if (forUpdate) {
    if (payload.readingStatus !== READING_STATUS.READ) addUnset(unset, 'dateRead');
    if (payload.readingStatus === READING_STATUS.WANT_TO_READ) addUnset(unset, 'readingStartedAt');
    return { payload, unset };
  }
  return payload;
}

function buildUpdateFromEntry(entry) {
  const { payload, unset } = buildPayloadFromEntry(entry, { forUpdate: true });
  const { bookId: _bookId, ...patch } = payload;
  const opts = unset.length ? { unset } : undefined;
  return { patch, opts };
}

async function updateTarnBook(client, bookId, patch, opts) {
  if (opts) return client.books.update(bookId, patch, opts);
  return client.books.update(bookId, patch);
}

function applyStatusDateRules(entry, status) {
  if (!status) return;
  if (status === READING_STATUS.WANT_TO_READ) {
    delete entry.dateRead;
    delete entry.readingStartedAt;
    return;
  }
  if (status === READING_STATUS.READING) {
    delete entry.dateRead;
    if (!entry.readingStartedAt) entry.readingStartedAt = Date.now();
  }
}

function markEntryPending(entry, remoteBacked) {
  entry.pending = true;
  entry.status = 'pending';
  entry.seenRemote = remoteBacked ? true : false;
  if (remoteBacked) entry.remoteBacked = true;
  entry._committed = false;
}

function isRemoteBackedEntry(entry) {
  return !!(
    entry?.bookId &&
    (entry.remoteBacked === true || entry.seenRemote === true || entry.id === entry.bookId)
  );
}

function isAlreadyDeletedError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('no record with primarykey') ||
    message.includes('no record') ||
    message.includes('not found') ||
    message.includes('404');
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
   * @param {number} [deps.editUploadDelayMs] - debounce before uploading edits to Tarn
   */
  constructor({ cache, tarnService, deriveBookId, onDirty, editUploadDelayMs = DEFAULT_EDIT_UPLOAD_DEBOUNCE_MS }) {
    this._cache = cache;
    this._tarnService = tarnService;
    this._deriveBookId = deriveBookId;
    this._onDirty = onDirty || (() => {});
    this._editUploadDelayMs = Math.max(0, Number(editUploadDelayMs) || 0);

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
        rec.pending = false; rec.status = 'confirmed'; rec.seenRemote = true; rec.remoteBacked = true;
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
    const wasRemoteBacked = isRemoteBackedEntry(old);

    const snapshot = { ...old };
    Object.assign(old, payload);
    if (payload.coverImage === '') {
      old.coverImage = '';
      old.mimeType = '';
      old.coverFit = '';
    }
    if (hasOwn(payload, 'readingStatus')) applyStatusDateRules(old, payload.readingStatus);
    old.modifiedAt = Date.now();
    markEntryPending(old, wasRemoteBacked);
    if (this._cache) await this._cache.putEntry(old);
    this._onDirty();
    this._emitChange();

    if (wasRemoteBacked) this._scheduleEditUpload(entryKey, old, snapshot);
  }

  async delete(id) {
    const entry = this.getById(id);
    if (!entry) return;
    const entryKey = entry.bookId || entry.id;
    const remoteBacked = isRemoteBackedEntry(entry);
    this._clearQueuedEdit(entryKey);
    if (entry.bookId && this._cache?.removeEditOp) await this._cache.removeEditOp(entry.bookId);

    entry._deleting = true;
    entry._committed = false;
    this._emitChange();

    // Local-only entry — just remove from cache. No bookId means it never
    // made it to Tarn; nothing to tombstone or unshare.
    if (!entry.bookId || !remoteBacked) {
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

    // Entry on Tarn — hide locally immediately, then send tombstone via the
    // typed namespace. Queue the delete before the network call so refreshes
    // or crashes cannot resurrect the record from stale remote data.
    entry.status = 'tombstoned';
    entry.tombstonedAt = Date.now();
    entry.pending = true;
    entry.seenRemote = true;
    entry.remoteBacked = true;
    entry._deleting = false;
    if (this._cache) {
      await this._cache.putEntry(entry);
      await this._cache.queueOp?.({ type: 'delete', bookId: entry.bookId });
    }
    this._entries = this._entries.filter(e => e !== entry);
    this._onDirty();
    this._emitChange();

    try {
      const client = await this._tarnService.getClient();
      try {
        await client.books.delete(entry.bookId);
      } catch (err) {
        if (!isAlreadyDeletedError(err)) throw err;
      }

      if (this._cache?.removeDeleteOp) await this._cache.removeDeleteOp(entry.bookId);
      this._emitError(null, null);
      // Retroactively unshare from every connection. Idempotent on the SDK
      // side; non-blocking. Private books were never shared, but unshare
      // on a never-shared content_id is a benign no-op for our purposes.
      unshareFromAllFriends(client, entry.bookId).then(() => friends.invalidateFriendLibraryCache());
    } catch (e) {
      console.warn('[BookRepository] books.delete failed:', e.message);
      this._emitError('delete-queued', 'Delete queued — will retry when sync is available');
    }
  }

  async changeStatus(key, newStatus) {
    const entry = this.getById(key);
    if (!entry) return null;

    const previousStatus = normalizeReadingStatus(entry);
    const snapshot = { ...entry };
    const remoteBacked = isRemoteBackedEntry(entry);
    entry.readingStatus = newStatus;
    entry.modifiedAt = Date.now();
    applyStatusDateRules(entry, newStatus);
    if (newStatus === READING_STATUS.READ && !entry.dateRead) {
      const now = new Date();
      entry.dateRead = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0, 0);
    }
    if (remoteBacked) markEntryPending(entry, true);

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    const toastMessage = newStatus === READING_STATUS.READING ? 'Moved to Currently Reading'
      : newStatus === READING_STATUS.READ ? 'Finished! Added to your shelf'
      : 'Moved to Want to Read';

    if (remoteBacked) {
      const entryKey = entry.bookId || entry.id;
      this._scheduleEditUpload(entryKey, entry, snapshot);
    }

    return { entry, previousStatus, toastMessage };
  }

  async applyReadingSnapshot(key, snapshot) {
    const entry = this.getById(key);
    if (!entry) return null;

    const before = { ...entry };
    const remoteBacked = isRemoteBackedEntry(entry);
    entry.readingStatus = snapshot.readingStatus;
    if (snapshot.dateRead) entry.dateRead = snapshot.dateRead;
    else delete entry.dateRead;
    if (snapshot.readingStartedAt != null) entry.readingStartedAt = snapshot.readingStartedAt;
    else delete entry.readingStartedAt;
    entry.modifiedAt = Date.now();
    if (remoteBacked) markEntryPending(entry, true);

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    if (remoteBacked) {
      const entryKey = entry.bookId || entry.id;
      this._scheduleEditUpload(entryKey, entry, before);
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
      if (isRemoteBackedEntry(entry)) markEntryPending(entry, true);
      if (this._cache) await this._cache.putEntry(entry);
      changed.push(entry);
    }

    if (!changed.length) return;
    this._onDirty();
    this._emitChange();

    for (const entry of changed) {
      if (!isRemoteBackedEntry(entry)) continue;
      const entryKey = entry.bookId || entry.id;
      this._scheduleEditUpload(entryKey, entry, { ...entry });
    }
  }

  // --- Sync pipeline ---

  async sync() {
    if (!this._cache) return;

    // clear() is used during logout to empty the in-memory list and keep
    // logged-out cache reads from repopulating the previous user's books.
    // Once a new authenticated session starts, the same repository instance
    // must be allowed to sync again; otherwise logout -> login shows an empty
    // library until a page refresh creates a fresh repository.
    if (this._purged) {
      if (!this._tarnService.isLoggedIn()) return;
      this._purged = false;
    }

    if (!this._tarnService.isLoggedIn()) {
      this._entries = await this._cache.getAllActive();
      this._emitChange();
      return;
    }

    await this.flushPendingEdits();
    await this.replayPending();

    debugLog('[BookRepository] Syncing from Tarn...');
    try {
      const client = await this._tarnService.getClient();
      const pendingOps = this._cache.listOps ? await this._cache.listOps() : [];
      const pendingDeleteBookIds = new Set(pendingOps.filter(op => op.type === 'delete' && op.bookId).map(op => op.bookId));
      const localAll = this._cache.listAllRaw ? await this._cache.listAllRaw() : await this._cache.getAllActive();
      const localTombstoneBookIds = new Set(localAll.filter(e => e.status === 'tombstoned' && e.bookId).map(e => e.bookId));
      const remoteRecords = (await client.books.list()).filter(data =>
        !pendingDeleteBookIds.has(data.bookId) &&
        !localTombstoneBookIds.has(data.bookId)
      );
      debugLog('[BookRepository] Fetched', remoteRecords.length, 'records from Tarn');

      // The SDK returns fully-decoded records validated against the schema.
      // No normalization needed — every record carries the canonical shape.
      const remote = remoteRecords.map(data => ({
        ...data,
        id: data.bookId,
        status: 'confirmed',
        seenRemote: true,
        _committed: true,
        remoteBacked: true,
      }));

      const local = localAll.filter(e => e.status !== 'tombstoned');
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
        if (pending.bookId) {
          const existingIndex = merged.findIndex(e => e.bookId === pending.bookId);
          if (existingIndex >= 0) merged[existingIndex] = pending;
          else merged.push(pending);
        } else {
          merged.push(pending);
        }
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

      let ops = await this._cache.listOps();
      if (!ops.length) return;

      const deleteBookIds = new Set(ops.filter(op => op.type === 'delete' && op.bookId).map(op => op.bookId));
      if (deleteBookIds.size) {
        const supersededEdits = ops.filter(op => op.type === 'edit' && deleteBookIds.has(op.bookId));
        for (const op of supersededEdits) {
          await this._cache.removeOp(op.id);
        }
        ops = ops.filter(op => !(op.type === 'edit' && deleteBookIds.has(op.bookId)));
      }

      debugLog('[BookRepository] Replaying', ops.length, 'pending operations...');
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
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true; local.remoteBacked = true;
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
            const { patch, opts } = buildUpdateFromEntry(local);
            await updateTarnBook(client, local.bookId, patch, opts);
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true; local.remoteBacked = true;
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
        } else if (op.type === 'delete') {
          if (!op.bookId) { await this._cache.removeOp(op.id); continue; }
          try {
            try {
              await client.books.delete(op.bookId);
            } catch (err) {
              if (!isAlreadyDeletedError(err)) throw err;
            }
            await this._cache.removeOp(op.id);
            this._emitError(null, null);
            unshareFromAllFriends(client, op.bookId).then(() => friends.invalidateFriendLibraryCache());
          } catch (e) {
            console.warn('[BookRepository] Replay delete failed:', e.message);
            break;
          }
        }
      }
    } finally {
      this._replaying = false;
    }
  }

  // --- Internal: deferred edit upload chain ---

  _clearQueuedEdit(entryKey) {
    const queueEntry = this._editQueue.get(entryKey);
    if (queueEntry?.timer) clearTimeout(queueEntry.timer);
    this._editQueue.delete(entryKey);
  }

  _scheduleEditUpload(entryKey, entry, snapshot, opts = {}) {
    if (!entry?.bookId) return;

    const existing = this._editQueue.get(entryKey) || {
      uploading: false,
      uploadPromise: null,
      hasPendingEdit: false,
      timer: null,
      snapshot: snapshot ? { ...snapshot } : { ...entry },
      entry,
    };

    if (!existing.snapshot) existing.snapshot = snapshot ? { ...snapshot } : { ...entry };
    existing.entry = entry;
    existing.hasPendingEdit = true;

    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }

    this._editQueue.set(entryKey, existing);

    if (this._cache?.queueOp) {
      this._cache.queueOp({ type: 'edit', bookId: entry.bookId }).catch(err => {
        console.warn('[BookRepository] edit queue marker failed:', err.message);
      });
    }

    if (existing.uploading) return;

    const delay = opts.immediate ? 0 : this._editUploadDelayMs;
    if (delay <= 0) {
      existing.timer = null;
      Promise.resolve().then(() => this._flushEditEntry(entryKey)).catch(() => {});
    } else {
      existing.timer = setTimeout(() => {
        const queued = this._editQueue.get(entryKey);
        if (queued) queued.timer = null;
        this._flushEditEntry(entryKey).catch(() => {});
      }, delay);
    }
  }

  async flushPendingEdits() {
    const keys = [...this._editQueue.keys()];
    for (const key of keys) {
      await this._flushEditEntry(key, { force: true });
    }
  }

  async _flushEditEntry(entryKey, opts = {}) {
    const queueEntry = this._editQueue.get(entryKey);
    if (!queueEntry) return false;

    if (queueEntry.uploading) {
      if (queueEntry.uploadPromise) await queueEntry.uploadPromise;
      if (opts.force && this._editQueue.has(entryKey)) {
        return this._flushEditEntry(entryKey, opts);
      }
      return false;
    }

    if (queueEntry.timer) {
      clearTimeout(queueEntry.timer);
      queueEntry.timer = null;
    }

    const entry = queueEntry.entry || this.getById(entryKey);
    if (!entry?.bookId) {
      this._editQueue.delete(entryKey);
      return false;
    }

    const baselineSnapshot = queueEntry.snapshot || { ...entry };
    const uploadEntry = { ...entry };
    const uploadStartedModifiedAt = entry.modifiedAt;

    queueEntry.uploading = true;
    queueEntry.hasPendingEdit = false;
    queueEntry.uploadPromise = this._uploadEditSnapshot(entryKey, entry, uploadEntry, baselineSnapshot, uploadStartedModifiedAt);
    const uploaded = await queueEntry.uploadPromise;

    const latest = this._editQueue.get(entryKey);
    if (!latest) return uploaded;

    latest.uploading = false;
    latest.uploadPromise = null;

    if (!uploaded) {
      this._editQueue.delete(entryKey);
      return false;
    }

    const changedDuringUpload = latest.hasPendingEdit || entry.modifiedAt !== uploadStartedModifiedAt;
    if (changedDuringUpload) {
      latest.snapshot = uploadEntry;
      latest.entry = entry;
      latest.hasPendingEdit = true;
      if (opts.force) {
        return this._flushEditEntry(entryKey, opts);
      }
      this._scheduleEditUpload(entryKey, entry, uploadEntry);
      return true;
    }

    this._editQueue.delete(entryKey);
    return true;
  }

  async _uploadEditSnapshot(entryKey, liveEntry, uploadEntry, snapshot, uploadStartedModifiedAt) {
    if (!uploadEntry.bookId) return false;

    try {
      if (!this._tarnService.isLoggedIn()) throw new Error('Not logged in');
      const client = await this._tarnService.getClient();
      const { patch, opts } = buildUpdateFromEntry(uploadEntry);
      await updateTarnBook(client, uploadEntry.bookId, patch, opts);

      const queueEntry = this._editQueue.get(entryKey);
      const changedDuringUpload = queueEntry?.hasPendingEdit || liveEntry.modifiedAt !== uploadStartedModifiedAt;
      if (!changedDuringUpload) {
        liveEntry.pending = false;
        liveEntry.status = 'confirmed';
        liveEntry.seenRemote = true;
        // bookId is the canonical id now; align local id.
        liveEntry.id = liveEntry.bookId;

        if (this._cache) await this._cache.replaceProvisional(liveEntry.id, liveEntry);
        this._emitChange();
      }

      if (this._cache?.removeEditOp) await this._cache.removeEditOp(uploadEntry.bookId);

      this._emitError(null, null);

      // Share-log fan-out:
      //   - was public, stays public: re-share (re-publishes new tx_id)
      //   - was public, now private: unshare from all
      //   - was private, now public: share with all (fresh publish)
      //   - was private, stays private: no-op
      const wasPrivate = snapshot && snapshot.is_private === true;
      const isPrivate = uploadEntry.is_private === true;
      if (!wasPrivate && !isPrivate) {
        shareToFriends(client, uploadEntry.bookId).then(() => friends.invalidateFriendLibraryCache());
      } else if (!wasPrivate && isPrivate) {
        unshareFromAllFriends(client, uploadEntry.bookId).then(() => friends.invalidateFriendLibraryCache());
      } else if (wasPrivate && !isPrivate) {
        shareToFriends(client, uploadEntry.bookId).then(() => friends.invalidateFriendLibraryCache());
      }

      return true;
    } catch (e) {
      console.warn('[BookRepository] Edit upload failed:', e.message);

      // Queue for retry. Key on bookId now. Replay reads the latest local
      // snapshot, so the queued op intentionally carries only the book id.
      const pending = { type: 'edit', bookId: uploadEntry.bookId };
      if (this._cache) await this._cache.queueOp(pending);

      this._emitError('save-failed', 'Could not save to cloud — will retry on next sync');
      return false;
    }
  }
}
