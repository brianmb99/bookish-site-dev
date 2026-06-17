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

import * as friends from './friends.js';
import { debugLog } from './debug_log.js';
import { normalizeCoverCrop } from './cover_crop.js';
import { deleteTarnSdkLocalDbs } from './local_db_reset.js';

export const READING_STATUS = {
  WANT_TO_READ: 'want_to_read',
  READING: 'reading',
  READ: 'read'
};

const DEFAULT_EDIT_UPLOAD_DEBOUNCE_MS = 2500;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

/**
 * Derive a STABLE idempotency key for a book create, keyed on the record's
 * persistent identity (`bookId` — a UUID minted once at create time and stored
 * on the entry/op in IndexedDB). The SAME key is used for the initial optimistic
 * `books.create()` and for every replay of that record's create — same-session
 * retry, cross-restart replay, or lost-response requeue — so the Tarn API's 24h
 * `X-Idempotency-Key` dedup collapses the duplicate instead of writing a SECOND
 * remote entry (bookish#225 / seam S-2).
 *
 * The `book-create:` prefix namespaces the key (no collision with other op
 * types for the same account) and keeps it well within the API's 16–128
 * printable-ASCII constraint (prefix + 36-char UUID = 48 chars). Returns
 * undefined when no bookId is available — the SDK then falls back to its
 * default per-call key, i.e. today's behavior (no regression, just no dedup).
 *
 * @param {string|undefined|null} bookId
 * @returns {string|undefined}
 */
function bookCreateIdempotencyKey(bookId) {
  return bookId ? `book-create:${bookId}` : undefined;
}

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
      if (hasOwn(entry, 'coverFit')) {
        if (entry.coverFit) payload.coverFit = entry.coverFit;
        else if (forUpdate) addUnset(unset, 'coverFit');
      }
      if (hasOwn(entry, 'coverCrop')) {
        const coverCrop = normalizeCoverCrop(entry.coverCrop);
        if (coverCrop) payload.coverCrop = coverCrop;
        else if (forUpdate) addUnset(unset, 'coverCrop');
      }
    } else if (forUpdate) {
      addUnset(unset, 'coverImage');
      addUnset(unset, 'mimeType');
      addUnset(unset, 'coverFit');
      addUnset(unset, 'coverCrop');
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
 * The SDK returns per-connection failures (logged but tolerated). A thrown
 * error — e.g. `TarnPasskeyOnlyError` on a passkey-only session post-Tarn#32,
 * or a transient network failure — propagates to the caller so the share
 * path can surface it instead of silently dropping it (see BK-4). The
 * success path stays fire-and-forget at the call site: failing here never
 * fails the local save.
 */
async function shareToFriends(client, bookId) {
  const result = await client.books.shareWithAll(bookId);
  if (result && result.failed && result.failed.length) {
    for (const f of result.failed) {
      console.warn('[BookRepository] share failed for', f.connection?.share_pub?.slice(0, 8), '—', f.error);
    }
  }
}

// Name-based detection avoids importing the error class from the Tarn bundle
// (matches the existing `err?.name === 'AccountKeyPinningError'` pattern in
// account_ui.js). The bundle sets `this.name = 'TarnPasskeyOnlyError'`.
function isPasskeyOnlyError(err) {
  return err?.name === 'TarnPasskeyOnlyError';
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
    // Maps a Tarn Eid (deterministic hash of appId+collection+primaryKey) to
    // the local cache entry it represents. Populated lazily from the cache on
    // sync; used to resolve delete events emitted by getEntriesSince(), which
    // identify the removed record by Eid rather than bookId.
    this._eidIndex = new Map();
    this._listeners = { change: [], error: [], progress: [], syncProgress: [] };
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

  // Emits structured sync-lifecycle events for UI progress indicators.
  // Payload shape:
  //   { phase: 'fetching' }                                    — before the network call
  //   { phase: 'applying', loaded, total, deleted }            — during the apply loop
  //   { phase: 'complete', total, deleted }                    — after success
  //   { phase: 'error', error }                                — after failure
  // First-sync on a new device (large library) is the only phase where the
  // user is likely to wait long enough to notice; warm syncs return empty
  // arrays and complete in one HTTP round trip.
  _emitSyncProgress(payload) { this._emit('syncProgress', payload); }

  /**
   * Fire-and-forget share fan-out with observable failures (BK-4).
   *
   * The local save has already succeeded by the time this runs; sharing is a
   * best-effort follow-up, so the SUCCESS path never blocks. But failures are
   * no longer swallowed:
   *   - `TarnPasskeyOnlyError` (expected on a passkey-only session post-Tarn#32):
   *     not a crash — the book is saved, sharing just needs a password session.
   *     Surfaced as a non-alarming notice via the existing `error` event.
   *   - Any other (transient/network) error: surfaced as a recoverable error so
   *     it isn't lost to a silent console.warn. The next privacy-toggle or edit
   *     re-runs the share fan-out (idempotent on the SDK side).
   * On success the friend-library cache is invalidated as before.
   */
  _shareAndRefresh(client, bookId) {
    return shareToFriends(client, bookId)
      .then(() => friends.invalidateFriendLibraryCache())
      .catch((err) => {
        if (isPasskeyOnlyError(err)) {
          console.warn('[BookRepository] share skipped — passkey-only session:', bookId);
          this._emitError(
            'share-needs-password',
            'Book saved. Sharing to friends needs signing in with your password.',
          );
        } else {
          console.warn('[BookRepository] shareWithAll failed:', err?.message || err);
          this._emitError(
            'share-failed',
            'Book saved, but couldn’t share to friends — will retry on your next change.',
          );
        }
      });
  }

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
    // Next authenticated sync must re-run the cursor/cache parity check —
    // the account may have changed, and the new account's first delta must
    // not run against an orphaned cursor (#230 invariant).
    this._cursorParityChecked = false;
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

    // Stable idempotency key tied to this record's identity. Used for BOTH the
    // optimistic create below AND any later replay of the same create, so a
    // retry (crash between create() and removeOp(), or a lost response) is
    // deduped server-side instead of double-writing (bookish#225 / seam S-2).
    // Persisted on the queued op so it survives an app restart.
    const idempotencyKey = bookCreateIdempotencyKey(rec.bookId);

    // Try to upload to Tarn immediately
    if (this._tarnService.isLoggedIn()) {
      try {
        const client = await this._tarnService.getClient();
        const builtPayload = buildPayloadFromEntry(rec);
        // Fresh create — no Eid mapping yet, the SDK derives one. The stable
        // idempotency key makes a later replay of this same create a no-op
        // server-side rather than a second remote entry.
        await client.books.create(builtPayload, { idempotencyKey });
        const oldId = rec.id;
        // bookId is now the canonical id; drop the local-id sentinel.
        rec.id = rec.bookId;
        rec.pending = false; rec.status = 'confirmed'; rec.seenRemote = true; rec.remoteBacked = true;
        if (this._cache) await this._cache.replaceProvisional(oldId, rec);
        this._emitError(null, null);
        this._emitChange();
        // Share to friends if public. Fire-and-forget — share failures
        // don't fail the local save, but are surfaced (not swallowed).
        if (rec.is_private !== true) {
          this._shareAndRefresh(client, rec.bookId);
        }
      } catch (e) {
        console.warn('[BookRepository] books.create failed, queued for retry:', e.message);
        // Persist the stable key on the op so the replay (this session or a
        // later restart) sends the SAME X-Idempotency-Key — the create above
        // may have reached the wire before the failure (lost response), so
        // dedup is what prevents a double-write.
        if (this._cache) await this._cache.queueOp({ type: 'create', localId: rec.id, payload, idempotencyKey });
        this._emitProgress(['Queued for sync']);
      }
    } else {
      // Not logged in — queue for later (with the stable key for replay dedup).
      if (this._cache) await this._cache.queueOp({ type: 'create', localId: rec.id, payload, idempotencyKey });
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
      old.coverCrop = '';
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

    // Flush any debounced edits to the ops queue, then replay every queued
    // op (create / edit / delete) against the remote. After this returns
    // every successful local mutation has been written to Tarn; only failures
    // remain pending. Doing this BEFORE pulling the delta ensures we never
    // overwrite an in-flight local change with stale remote state.
    await this.flushPendingEdits();
    await this.replayPending();

    debugLog('[BookRepository] Syncing from Tarn (delta)...');
    this._emitSyncProgress({ phase: 'fetching' });
    try {
      const client = await this._tarnService.getClient();

      // #230-class invariant, enforced at the read site: a delta cursor
      // must never outlive the cached entries it accounts for. If the
      // active scope has NO remote-backed entries locally, a surviving
      // cursor would make the delta below return only recent events and
      // the library would render as "one recent book". Whatever wipe-path
      // gap produced the divergence (e.g. a blocked deleteDatabase from a
      // second tab), reset the SDK's local DBs here so this read returns
      // the full library. Checked once per page life / per re-auth — not
      // every cycle, so an empty-library account doesn't repeatedly nuke
      // the blob cache that friend-shelf reads lean on.
      if (!this._cursorParityChecked) {
        this._cursorParityChecked = true;
        const active = await this._cache.getAllActive();
        const hasRemoteBacked = active.some(e => isRemoteBackedEntry(e));
        if (!hasRemoteBacked) {
          debugLog('[BookRepository] No remote-backed local entries — resetting SDK cursor/blob DBs before delta sync (#230 parity)');
          await deleteTarnSdkLocalDbs();
        }
      }

      // Delta sync: returns only entries created/updated since the last
      // call and the Eids of entries deleted on other devices. Cursor is
      // persisted inside the SDK (per appId+dlk+type). First call after
      // login on a fresh device — or after clearing site data — returns
      // the full library since the cursor is absent.
      const { entries, deleted } = await client.books.getEntriesSince();
      debugLog('[BookRepository] Delta: +', entries.length, ' −', deleted.length);
      this._emitSyncProgress({ phase: 'applying', loaded: 0, total: entries.length, deleted: deleted.length });

      // Build / refresh the Eid → cache-entry index from current cache state.
      // First post-upgrade sync runs against entries that don't yet carry an
      // _eid field, but the delta also returns the full library on that
      // first call (cursor absent), so every entry gets _eid populated below
      // — subsequent delete events resolve correctly.
      const localAll = await this._cache.listAllRaw();
      this._eidIndex.clear();
      for (const e of localAll) {
        if (e._eid) this._eidIndex.set(e._eid, e);
      }

      // Build the set of bookIds with local protection against upsert:
      //   - Queued delete ops (replayPending() above tried and failed, e.g.
      //     offline). The local intent is "this is gone"; a stale delta
      //     that still includes the bookId must not resurrect it.
      //   - Cache rows already marked tombstoned. Same reason — local
      //     intent overrides stale remote state until the tombstone is
      //     confirmed by the server (at which point the bookId will
      //     surface in `deleted` and we'll remove the tombstone row).
      //   - Queued edit ops (BK-3). A still-queued `edit` marker means the
      //     user has an offline/uncommitted edit that hasn't been confirmed
      //     by the server. A stale delta that re-discovers an older txid/eid
      //     for that bookId must not overwrite the locally-pending fields —
      //     otherwise the in-memory edit survives but the next flush uploads
      //     the stale remote snapshot and clobbers the user's edit remotely
      //     too. Mirrors pendingDeleteBookIds: edit markers are queued in
      //     _scheduleEditUpload and removed only on a confirmed upload
      //     (removeEditOp) or successful replay (removeOp), so a lingering
      //     marker reliably means "un-acked local edit". We also union the
      //     live in-flight _editQueue keys to cover the window between
      //     scheduling an edit and its async op-queue marker resolving.
      const pendingOps = this._cache.listOps ? await this._cache.listOps() : [];
      const pendingDeleteBookIds = new Set(
        pendingOps.filter(op => op.type === 'delete' && op.bookId).map(op => op.bookId),
      );
      const pendingEditBookIds = new Set(
        pendingOps.filter(op => op.type === 'edit' && op.bookId).map(op => op.bookId),
      );
      for (const queued of this._editQueue.values()) {
        if (queued?.entry?.bookId) pendingEditBookIds.add(queued.entry.bookId);
      }
      const localTombstonedBookIds = new Set(
        localAll.filter(e => e.status === 'tombstoned' && e.bookId).map(e => e.bookId),
      );

      // Build the working set from current cache state (active entries only,
      // skipping tombstones), keyed by bookId for O(1) upsert. We construct
      // the in-memory list here rather than re-reading from cache after the
      // apply loop — both because it avoids an unnecessary IDB round trip
      // and because the test harnesses mock putEntry as a no-op fn.
      const workingByBookId = new Map();
      for (const e of localAll) {
        if (e.status === 'tombstoned' || !e.bookId) continue;
        workingByBookId.set(e.bookId, e);
      }

      // Apply deletes first. Idempotent: an Eid we don't recognize is a
      // no-op (the entry was likely never on this device, or was already
      // removed by a previous sync).
      for (const eid of deleted) {
        const entry = this._eidIndex.get(eid);
        if (entry) {
          await this._cache.deleteById(entry.id);
          this._eidIndex.delete(eid);
          if (entry.bookId) workingByBookId.delete(entry.bookId);
        }
      }

      // Apply upserts. Skip any entry that has a local pending mutation —
      // replayPending() above either succeeded (status was reset to
      // 'confirmed') or failed (op still queued, will retry next sync).
      // A still-pending entry means the user has uncommitted local edits
      // that haven't reached the remote yet; overwriting would lose them.
      let loaded = 0;
      const PROGRESS_INTERVAL = 25; // emit every ~25 entries to balance UI updates vs event spam
      for (const { record, eid } of entries) {
        const local = workingByBookId.get(record.bookId);
        if (local && local.status === 'pending') {
          loaded++;
          continue;
        }
        // Local delete intent (queued op or tombstoned cache row) takes
        // precedence over a stale delta that still lists the record.
        if (pendingDeleteBookIds.has(record.bookId) || localTombstonedBookIds.has(record.bookId)) {
          loaded++;
          continue;
        }
        // Local edit intent (queued/in-flight edit op) takes precedence over
        // a stale delta (BK-3). Skipping the overwrite leaves the pending
        // local edit intact; the next flush/replay uploads the edit. The
        // cursor was already advanced inside getEntriesSince(), so the delta
        // is acked and won't be re-fetched — we skip only the local-record
        // overwrite, not the sync progress.
        if (pendingEditBookIds.has(record.bookId)) {
          loaded++;
          continue;
        }
        const merged = {
          ...record,
          id: record.bookId,
          status: 'confirmed',
          seenRemote: true,
          _committed: true,
          remoteBacked: true,
          _eid: eid,
        };
        await this._cache.putEntry(merged);
        this._eidIndex.set(eid, merged);
        workingByBookId.set(record.bookId, merged);
        loaded++;
        if (loaded % PROGRESS_INTERVAL === 0 || loaded === entries.length) {
          this._emitSyncProgress({ phase: 'applying', loaded, total: entries.length, deleted: deleted.length });
        }
      }

      // Apply the canonical sort (newest first by dateRead, then createdAt).
      // This is the order the library UI reads — keep it stable across syncs.
      this._entries = Array.from(workingByBookId.values()).sort((a, b) => {
        const da = typeof a.dateRead === 'number' ? a.dateRead : 0;
        const db = typeof b.dateRead === 'number' ? b.dateRead : 0;
        if (da !== db) return db - da;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      this._emitSyncProgress({ phase: 'complete', total: entries.length, deleted: deleted.length });
      this._emitChange();
    } catch (e) {
      console.error('[BookRepository] Sync failed:', e.message);
      this._emitSyncProgress({ phase: 'error', error: e.message });
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
            // Reuse the SAME stable key the initial create used (persisted on
            // the op), so this replay is deduped server-side rather than
            // creating a second remote entry (bookish#225 / seam S-2). Ops
            // queued before this change have no op.idempotencyKey; re-derive
            // from the record's bookId — identical to what the create stored.
            const idempotencyKey = op.idempotencyKey || bookCreateIdempotencyKey(local.bookId);
            await client.books.create(payload, { idempotencyKey });
            const oldId = local.id;
            local.id = local.bookId;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true; local.remoteBacked = true;
            await this._cache.replaceProvisional(oldId, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
            if (local.is_private !== true) {
              this._shareAndRefresh(client, local.bookId);
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
              this._shareAndRefresh(client, local.bookId);
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
        this._shareAndRefresh(client, uploadEntry.bookId);
      } else if (!wasPrivate && isPrivate) {
        unshareFromAllFriends(client, uploadEntry.bookId).then(() => friends.invalidateFriendLibraryCache());
      } else if (wasPrivate && !isPrivate) {
        this._shareAndRefresh(client, uploadEntry.bookId);
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
