// book_repository.js — Single-responsibility module for all book data operations
//
// Owns the entries array, ops queue, upload pipeline, bridge registration,
// and remote sync. Decoupled from DOM, UI, and encryption internals.
//
// Usage:
//   const repo = new BookRepository({ cache, ensureKeys, ... });
//   repo.on('change', (entries) => render());
//   repo.on('error', ({ code, message, pendingOp }) => showError(message));
//   repo.on('progress', (items) => updateDiagnostics(items));
//   await repo.loadFromCache();

import { registerPendingTx, fetchPendingTxIds } from './pending_tx_bridge.js';

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
    dateRead: entry.dateRead || '',
    readingStatus: entry.readingStatus || READING_STATUS.READ,
    bookId: entry.bookId
  };
  if (entry.coverImage) { payload.coverImage = entry.coverImage; if (entry.mimeType) payload.mimeType = entry.mimeType; }
  if (entry.notes) payload.notes = entry.notes;
  if (entry.rating) payload.rating = entry.rating;
  if (entry.owned) payload.owned = entry.owned;
  if (entry.tags) payload.tags = entry.tags;
  if (entry.readingStartedAt) payload.readingStartedAt = entry.readingStartedAt;
  if (entry.createdAt) payload.createdAt = entry.createdAt;
  if (entry.modifiedAt) payload.modifiedAt = entry.modifiedAt;
  return payload;
}

const prevTag = (edge) => edge.node.tags?.find(t => t.name === 'Prev')?.value;

export class BookRepository {
  /**
   * @param {Object} deps
   * @param {Object} deps.cache - IndexedDB cache (window.bookishCache)
   * @param {Function} deps.ensureKeys - async () => boolean
   * @param {Function} deps.getBrowserClient - () => browserClient|null
   * @param {Function} deps.getWalletAddress - async () => string|null
   * @param {Function} deps.ensureWallet - async () => void
   * @param {Function} [deps.deriveBookId] - async (payload) => string
   * @param {Function} [deps.onDirty] - () => void; signals sync manager
   */
  constructor({ cache, ensureKeys, getBrowserClient, getWalletAddress, ensureWallet, deriveBookId, onDirty }) {
    this._cache = cache;
    this._ensureKeys = ensureKeys;
    this._getBrowserClient = getBrowserClient;
    this._getWalletAddress = getWalletAddress;
    this._ensureWallet = ensureWallet || (() => {});
    this._deriveBookId = deriveBookId;
    this._onDirty = onDirty || (() => {});

    this._entries = [];
    this._editQueue = new Map();
    this._replaying = false;
    this._lastPendingOp = null;
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

  _emitError(code, message, pendingOp) {
    if (code) this._lastPendingOp = pendingOp || null;
    else this._lastPendingOp = null;
    this._emit('error', { code, message, pendingOp: pendingOp || null });
  }

  _emitProgress(items) { this._emit('progress', items); }

  // --- Queries ---

  getAll() { return this._entries; }

  getById(key) {
    return this._entries.find(e => (e.txid || e.id) === key);
  }

  getLastPendingOp() { return this._lastPendingOp; }

  // --- Lifecycle ---

  async loadFromCache() {
    if (!this._cache) return;
    this._entries = await this._cache.getAllActive();
    this._entries.forEach(e => { e._committed = !!(e.status === 'confirmed' && e.seenRemote); });
    this._emitChange();
  }

  clear() {
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

    try {
      const haveKeys = await this._ensureKeys();
      if (!haveKeys) {
        if (this._cache) await this._cache.queueOp({ type: 'create', localId: rec.id, payload });
        return { entry: rec, isDuplicate: false };
      }

      await this._ensureWallet();
      this._emitProgress(['Publishing to Arweave...', 'If funding is needed, you\'ll be prompted']);

      const client = this._getBrowserClient();
      const res = await client.uploadEntry(payload, {});
      const addr = await this._getWalletAddress();
      registerPendingTx(addr, res.txid).catch(() => {});

      const oldId = rec.id;
      rec.txid = res.txid; rec.id = res.txid;
      rec.pending = false; rec.status = 'confirmed'; rec.seenRemote = true; rec.onArweave = false;
      if (this._cache) await this._cache.replaceProvisional(oldId, rec);
      this._emitError(null, null);
      this._emitChange();
      this._emitProgress(null);
    } catch (e) {
      console.warn('[BookRepository] uploadEntry error:', e);
      const pending = { type: 'create', localId: rec.id, payload };
      if (this._cache) await this._cache.queueOp(pending);

      if (e?.code === 'upload-required') {
        this._emitError('upload-required', 'Upload client missing. Refresh page and retry.', pending);
        this._emitProgress(['Upload client missing', 'Refresh page and retry']);
      } else if (e?.code === 'post-fund-timeout') {
        this._emitError('post-fund-timeout', 'Funding sent. Credit pending (can take a few minutes). Try again shortly from Account.', pending);
        this._emitProgress(['Funding sent – awaiting credit', 'Retry from Account shortly']);
      } else if (e?.code === 'base-insufficient-funds' || e?.code === 'base-insufficient-funds-recent') {
        this._emitError('base-insufficient-funds', 'Auto-fund blocked: Base wallet low on ETH. Add a small amount and retry from Account.', pending);
        this._emitProgress(['Base wallet low on ETH', 'Add a small amount, then retry']);
      } else {
        this._emitProgress(['Offline – queued for publish']);
      }
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
    old.modifiedAt = Date.now();
    old.pending = true;
    old.status = 'pending';
    old.seenRemote = false;
    old._committed = false;
    if (this._cache) await this._cache.putEntry(old);
    this._onDirty();
    this._emitChange();

    if (queueEntry?.uploading) {
      console.log('[BookRepository] Edit queued - will upload after current edit completes');
      queueEntry.pendingPayload = { ...payload, bookId: old.bookId };
      return;
    }

    this._editQueue.set(entryKey, { uploading: true, pendingPayload: null });
    await this._doEditUpload(entryKey, old, id, { ...payload, bookId: old.bookId }, snapshot);
  }

  async delete(id) {
    const entry = this._entries.find(e => e.txid === id) || this._entries.find(e => e.id === id);
    if (!entry) return;

    entry._deleting = true;
    entry._committed = false;
    this._emitChange();

    if (!entry.txid) {
      if (this._cache) await this._cache.deleteById(entry.id);
      this._entries = this._entries.filter(e => e !== entry);
      this._emitChange();
      return;
    }

    try {
      const haveKeys = await this._ensureKeys();
      if (!haveKeys) throw new Error('Cannot delete: encryption keys not available');

      const client = this._getBrowserClient();
      const tombRes = await client.tombstone(id, { note: 'user delete' });
      const addr = await this._getWalletAddress();
      registerPendingTx(addr, tombRes?.txid).catch(() => {});

      entry.status = 'tombstoned';
      entry.tombstonedAt = Date.now();
      if (this._cache) await this._cache.putEntry(entry);
      this._entries = this._entries.filter(e => e.status !== 'tombstoned');
      this._emitError(null, null);
      this._onDirty();
      this._emitChange();
    } catch {
      entry._deleting = false;
      this._emitChange();
      this._emitError('delete-failed', 'Delete failed');
    }
  }

  /**
   * Change reading status with optimistic UI update + background upload.
   * @returns {{ entry, previousStatus, toastMessage } | null}
   */
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
      entry.dateRead = new Date().toISOString().slice(0, 10);
    }

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    const toastMessage = newStatus === READING_STATUS.READING ? 'Moved to Currently Reading'
      : newStatus === READING_STATUS.READ ? 'Finished! Added to your shelf'
      : 'Moved to Want to Read';

    if (entry.txid) {
      const payload = buildPayloadFromEntry(entry);
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.pendingPayload = payload;
      } else {
        this._editQueue.set(entryKey, { uploading: true, pendingPayload: null });
        const snapshot = { ...entry };
        this._doEditUpload(entryKey, entry, entry.txid, payload, snapshot).catch(() => {
          this._emitError('status-update-failed', 'Status update failed');
        });
      }
    }

    return { entry, previousStatus, toastMessage };
  }

  /**
   * Restore reading-related fields (e.g. undo after quick "mark as read" on a card).
   * @param {string} key
   * @param {{ readingStatus: string, dateRead?: string, readingStartedAt?: number }} snapshot
   */
  async applyReadingSnapshot(key, snapshot) {
    const entry = this.getById(key);
    if (!entry) return null;

    entry.readingStatus = snapshot.readingStatus;
    if (snapshot.dateRead) {
      entry.dateRead = snapshot.dateRead;
    } else {
      delete entry.dateRead;
    }
    if (snapshot.readingStartedAt != null) {
      entry.readingStartedAt = snapshot.readingStartedAt;
    } else {
      delete entry.readingStartedAt;
    }

    if (this._cache) await this._cache.putEntry(entry);
    this._onDirty();
    this._emitChange();

    if (entry.txid) {
      const payload = buildPayloadFromEntry(entry);
      const entryKey = entry.bookId || entry.id;
      const queueEntry = this._editQueue.get(entryKey);

      if (queueEntry?.uploading) {
        queueEntry.pendingPayload = payload;
      } else {
        this._editQueue.set(entryKey, { uploading: true, pendingPayload: null });
        const snapshotEntry = { ...entry };
        this._doEditUpload(entryKey, entry, entry.txid, payload, snapshotEntry).catch(() => {
          this._emitError('status-update-failed', 'Status update failed');
        });
      }
    }

    return { entry };
  }

  // --- Sync pipeline ---

  async sync() {
    if (!this._cache) {
      console.warn('[BookRepository] Sync skipped - cache unavailable');
      return;
    }

    await this.replayPending();
    const haveKeys = await this._ensureKeys();

    if (!haveKeys) {
      this._entries = await this._cache.getAllActive();
      this._emitChange();
      return;
    }

    console.log('[BookRepository] Starting book sync from Arweave...');
    const { entries: remoteEntries, tombstones, partial } = await this._fetchRemoteEntries();
    console.log('[BookRepository] Fetched', remoteEntries.length, 'remote entries,', tombstones.length, 'tombstones', partial ? '(partial)' : '');

    const remote = remoteEntries.map(e => ({ ...e, status: 'confirmed', id: e.txid }));
    this._entries = await this._cache.applyRemote(remote, tombstones);

    await this._cache.compactDuplicates();
    this._entries = await this._cache.getAllActive();
    this._entries.forEach(e => e._committed = true);
    this._emitChange();
  }

  async replayPending() {
    if (this._replaying) return;
    this._replaying = true;
    try {
      if (!this._cache) return;
      const haveKeys = await this._ensureKeys();
      if (!haveKeys) return;
      const ops = await this._cache.listOps();
      if (!ops.length) return;

      this._emitProgress(['Replaying pending changes...']);
      const client = this._getBrowserClient();

      for (const op of ops) {
        if (op.type === 'create') {
          const local = this._entries.find(e => e.id === op.localId);
          if (!local) { await this._cache.removeOp(op.id); continue; }
          if (local.txid) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            const res = await client.uploadEntry(payload, {});
            const addr = await this._getWalletAddress();
            registerPendingTx(addr, res.txid).catch(() => {});
            const oldId = local.id;
            local.txid = res.txid; local.id = res.txid;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(oldId, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
          } catch {
            this._emitProgress(['Awaiting upload credit...', 'Will retry automatically']);
            break;
          }
        } else if (op.type === 'edit') {
          const local = this._entries.find(e => e.txid === op.priorTxid) || this._entries.find(e => e.id === op.priorTxid);
          if (!local) { await this._cache.removeOp(op.id); continue; }
          try {
            const payload = buildPayloadFromEntry(local);
            const res = await client.uploadEntry(payload, { extraTags: [{ name: 'Prev', value: op.priorTxid }] });
            const addr = await this._getWalletAddress();
            registerPendingTx(addr, res.txid).catch(() => {});
            local.txid = res.txid; local.id = res.txid;
            local.pending = false; local.status = 'confirmed'; local.seenRemote = true;
            await this._cache.replaceProvisional(op.priorTxid, local);
            await this._cache.removeOp(op.id);
            this._emitChange();
          } catch {
            this._emitProgress(['Awaiting upload credit...', 'Will retry automatically']);
            break;
          }
        }
      }
    } finally {
      this._replaying = false;
      this._emitProgress(null);
    }
  }

  // --- Internal: edit upload chain ---

  async _doEditUpload(entryKey, entry, prevTxid, payload, snapshot) {
    if (!entry.txid && !prevTxid) {
      this._editQueue.delete(entryKey);
      return;
    }

    try {
      const haveKeys = await this._ensureKeys();
      if (!haveKeys) throw new Error('Cannot upload: encryption keys not available');

      this._emitProgress(['Saving to Arweave\u2026']);
      const client = this._getBrowserClient();
      const res = await client.uploadEntry(payload, { extraTags: [{ name: 'Prev', value: prevTxid }] });
      const addr = await this._getWalletAddress();
      registerPendingTx(addr, res.txid).catch(() => {});

      entry.txid = res.txid; entry.id = res.txid;
      entry.pending = false; entry.status = 'confirmed'; entry.seenRemote = true;

      const prevStillExists = prevTxid && this._cache
        ? await this._cache.findByTxid(prevTxid) : true;
      if (!prevStillExists) {
        const queueEntry = this._editQueue.get(entryKey);
        if (queueEntry?.pendingPayload) {
          await this._cache.queueOp({ type: 'edit', priorTxid: res.txid, payload: queueEntry.pendingPayload });
        }
        this._editQueue.delete(entryKey);
        this._emitProgress(null);
        return;
      }

      if (this._cache) await this._cache.replaceProvisional(prevTxid, entry);
      this._emitError(null, null);
      this._emitChange();
      this._emitProgress(null);

      const queueEntry = this._editQueue.get(entryKey);
      if (queueEntry?.pendingPayload) {
        console.log('[BookRepository] Processing queued edit with new Prev:', res.txid.slice(0, 8));
        const nextPayload = queueEntry.pendingPayload;
        queueEntry.pendingPayload = null;
        await this._doEditUpload(entryKey, entry, res.txid, nextPayload, snapshot);
      } else {
        this._editQueue.delete(entryKey);
      }
    } catch (e) {
      this._editQueue.delete(entryKey);
      Object.assign(entry, snapshot);
      if (this._cache) await this._cache.putEntry(entry);
      this._emitChange();

      const pending = { type: 'edit', priorTxid: prevTxid, payload };
      if (this._cache) await this._cache.queueOp(pending);

      if (e?.code === 'upload-required') {
        this._emitError('upload-required', 'Upload client missing. Refresh page and retry.', pending);
        this._emitProgress(['Upload client missing', 'Refresh page and retry']);
      } else if (e?.code === 'post-fund-timeout') {
        this._emitError('post-fund-timeout', 'Funding sent. Credit pending (few minutes). Retry from Account shortly.', pending);
        this._emitProgress(['Funding sent – awaiting credit', 'Retry from Account shortly']);
      } else if (e?.code === 'base-insufficient-funds' || e?.code === 'base-insufficient-funds-recent') {
        this._emitError('base-insufficient-funds', 'Auto-fund blocked: Base wallet low on ETH. Top up and retry from Account.', pending);
        this._emitProgress(['Base wallet low on ETH', 'Add a small amount, then retry']);
      } else {
        this._emitError('save-failed', 'Save failed', pending);
        this._emitProgress(['Save failed']);
      }
    }
  }

  // --- Internal: remote fetch pipeline ---

  async _fetchRemoteEntries() {
    const client = this._getBrowserClient();
    if (!client) return { entries: [], tombstones: [], partial: false };

    const { entries: bridgeEntries, tombstones: bridgeTombstones } = await this._fetchBridgeEntries();
    const { edges: allEdges, error: gqlError } = await this._fetchGraphQLPages();

    let liveEdges = [], tombstones = [];
    if (allEdges.length > 0) {
      ({ liveEdges, tombstones } = client.computeLiveSets(allEdges));
    }
    if (bridgeTombstones.length > 0) {
      tombstones = [...tombstones, ...bridgeTombstones];
    }

    const cachedEntries = this._cache ? await this._cache.listAllRaw() : [];
    const { needsDecrypt, alreadySynced } = this._partitionEdges(liveEdges, cachedEntries);

    console.log('[BookRepository] Cache check:', alreadySynced.length, 'already synced,', needsDecrypt.length, 'need decrypt');
    window.bookishNet = window.bookishNet || { reads: { arweave: 0, turbo: 0, errors: 0 }, cacheHits: 0 };
    window.bookishNet.cacheHits = (window.bookishNet.cacheHits || 0) + alreadySynced.length;

    const decrypted = await this._decryptEdges(needsDecrypt);
    const restored = this._restoreFromCache(alreadySynced, cachedEntries);
    const hydrated = [...decrypted, ...restored];
    const entries = this._mergeAndDeduplicate(hydrated, bridgeEntries);

    const partial = !!gqlError;
    if (partial && bridgeEntries.length > 0) {
      console.log('[BookRepository] Partial sync: GraphQL unavailable, returning', entries.length, 'bridge entries');
    }

    return { entries, tombstones, partial };
  }

  async _fetchBridgeEntries() {
    try {
      const addr = await this._getWalletAddress();
      if (!addr) return { entries: [], tombstones: [] };
      const pendingIds = await fetchPendingTxIds(addr);
      if (pendingIds.length === 0) return { entries: [], tombstones: [] };

      const cached = this._cache ? await this._cache.listAllRaw() : [];
      const knownTxids = new Set(cached.filter(e => e.txid).map(e => e.txid));
      const newIds = pendingIds.filter(id => !knownTxids.has(id));
      if (newIds.length === 0) return { entries: [], tombstones: [] };

      console.log('[BookRepository] Bridge: fetching', newIds.length, 'pending tx IDs from Turbo');
      const client = this._getBrowserClient();
      const results = [];
      const bridgeTombstones = [];
      for (const txid of newIds) {
        try {
          const dec = await client.decryptTx(txid);
          if (dec.op === 'tombstone' && dec.ref) {
            bridgeTombstones.push({ txid, ref: dec.ref });
          } else {
            results.push({ txid, ...dec, block: null });
          }
        } catch { /* skip undecryptable */ }
      }
      console.log('[BookRepository] Bridge: decrypted', results.length, 'entries,', bridgeTombstones.length, 'tombstones of', newIds.length, 'txids');

      const byBookId = new Map();
      const noBookId = [];
      for (const entry of results) {
        if (entry.bookId) byBookId.set(entry.bookId, entry);
        else noBookId.push(entry);
      }
      const deduped = [...byBookId.values(), ...noBookId];
      if (deduped.length < results.length) {
        console.log('[BookRepository] Bridge: deduped', results.length - deduped.length, 'superseded entries');
      }
      return { entries: deduped, tombstones: bridgeTombstones };
    } catch {
      return { entries: [], tombstones: [] };
    }
  }

  async _fetchGraphQLPages() {
    const client = this._getBrowserClient();
    const allEdges = [];
    let cursor, safety = 0;

    console.log('[BookRepository] Querying Arweave GraphQL for book entries...');
    const t0 = Date.now();

    for (;;) {
      const { edges, pageInfo, error } = await client.searchByOwner(null, { limit: 50, cursor });
      if (error) {
        console.warn('[BookRepository] GraphQL unavailable:', error);
        return { edges: allEdges, error };
      }
      allEdges.push(...edges);
      if (!pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1]?.cursor;
      if (++safety > 40) break;
    }

    console.log('[BookRepository] GraphQL completed in', Date.now() - t0, 'ms, found', allEdges.length, 'transactions');
    return { edges: allEdges, error: null };
  }

  _partitionEdges(liveEdges, cachedEntries) {
    const confirmedTxids = new Set(
      cachedEntries
        .filter(e => e.txid && e.seenRemote && e.status === 'confirmed')
        .map(e => e.txid)
    );
    return {
      needsDecrypt: liveEdges.filter(e => !confirmedTxids.has(e.node.id)),
      alreadySynced: liveEdges.filter(e => confirmedTxids.has(e.node.id))
    };
  }

  async _decryptEdges(edges) {
    const t0 = Date.now();
    const client = this._getBrowserClient();
    const results = [];
    for (const e of edges) {
      try {
        const dec = await client.decryptTx(e.node.id);
        const prev = prevTag(e);
        results.push({ txid: e.node.id, ...dec, block: e.node.block, ...(prev && { prevTxid: prev }) });
      } catch (err) {
        console.warn('[BookRepository] Failed to decrypt', e.node.id, err);
      }
    }
    console.log('[BookRepository] Decrypted', edges.length, 'entries in', Date.now() - t0, 'ms');
    return results;
  }

  _restoreFromCache(edges, cachedEntries) {
    const results = [];
    for (const e of edges) {
      const cached = cachedEntries.find(c => c.txid === e.node.id);
      if (cached) {
        results.push({ ...cached, block: e.node.block, ...(prevTag(e) && { prevTxid: prevTag(e) }) });
      }
    }
    return results;
  }

  _mergeAndDeduplicate(hydrated, bridgeEntries) {
    if (bridgeEntries.length > 0) {
      const txids = new Set(hydrated.map(e => e.txid));
      let added = 0;
      for (const be of bridgeEntries) {
        if (!txids.has(be.txid)) { hydrated.push(be); added++; }
      }
      if (added > 0) console.log('[BookRepository] Bridge: merged', added, 'new entries into sync results');
    }

    const byBookId = new Map();
    const score = (e) => (!e.block?.height) ? Infinity : e.block.height;

    for (const entry of hydrated) {
      if (!entry.bookId) continue;
      const existing = byBookId.get(entry.bookId);
      if (!existing || score(entry) > score(existing)) {
        byBookId.set(entry.bookId, entry);
      }
    }

    const deduped = [...byBookId.values(), ...hydrated.filter(e => !e.bookId)];
    deduped.sort((a, b) => {
      const da = a.dateRead || '0000-00-00', db = b.dateRead || '0000-00-00';
      if (da !== db) return db.localeCompare(da);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return deduped;
  }
}
