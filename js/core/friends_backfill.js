// friends_backfill.js — "show a new friend my existing shelf" wiring.
//
// Tarn shares a book at save-time to whoever's connected THEN. So a friend
// added AFTER you built your library would see nothing until you re-saved.
// The SDK closes this with two surfaces, both wired here:
//
//   1. An initial-share seed provider (set once). The SDK calls it at every
//      new-connection handshake and seeds that connection's first snapshot
//      with the records the provider names — so a friend sees the whole
//      public shelf the instant they connect, atomically, no empty entry.
//
//   2. A boot-time reconciliation backstop. Re-runnable and idempotent: for
//      each existing connection it ensures the outbound share-state matches
//      the current public library — repairing the rare handshake-time seed
//      failure, backfilling connections that predate this feature, and
//      catching drift (books added while a friend existed but we were
//      offline). It only writes when something is actually missing.
//
// Privacy stays Bookish's call: we hand the SDK only public bookIds
// (is_private !== true). The SDK never sees the privacy field.

/** Public book ids from the repo snapshot (is_private !== true). */
export function publicBookIdsFrom(repoEntries) {
  return (repoEntries || [])
    .filter((b) => b && b.is_private !== true && typeof b.bookId === 'string' && b.bookId)
    .map((b) => b.bookId);
}

/**
 * Register the seed provider on the SDK client. `getPublicBookIds` is called
 * lazily at handshake time, so it always reflects the current shelf.
 */
export function installShareSeedProvider(client, getPublicBookIds) {
  if (!client || typeof client.setInitialShareSeedProvider !== 'function') return;
  client.setInitialShareSeedProvider(async () => ({ books: getPublicBookIds() }));
}

/**
 * Reconcile every connection's outbound share-state to the current public
 * library. Idempotent; safe to call repeatedly. Best-effort: a per-connection
 * failure is logged and skipped, never thrown.
 *
 * @param {object} client            the Tarn SDK client
 * @param {() => string[]} getPublicBookIds
 * @param {{ onWarn?: (...a:any[]) => void }} [opts]
 * @returns {Promise<{ reconciled: number, seeded: number, drifted: number }>}
 */
export async function reconcileConnectionShares(client, getPublicBookIds, opts = {}) {
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : () => {};
  const stats = { reconciled: 0, seeded: 0, drifted: 0 };
  if (!client?.connections?.list || !client?.books?.listSharedWith) return stats;

  let connections = [];
  try {
    connections = await client.connections.list();
  } catch (err) {
    onWarn('[Bookish:Backfill] connections.list failed:', err?.message || err);
    return stats;
  }
  if (!connections.length) return stats;

  const publicIds = getPublicBookIds();
  // Nothing public to share — and nothing to repair (we never publish an
  // empty set on top of an existing log; share-on-save handles future books).
  if (!publicIds.length) return stats;

  for (const conn of connections) {
    try {
      const shared = await client.books.listSharedWith(conn);
      if (shared.length === 0) {
        // Seed never landed (handshake-time failure, or a connection that
        // predates this feature) — full backfill in one snapshot.
        await client.books.shareManyTo(conn, publicIds);
        stats.seeded++;
      } else {
        // Drift repair: share only the public books not already shared.
        const have = new Set(shared);
        const missing = publicIds.filter((id) => !have.has(id));
        if (missing.length) {
          for (const id of missing) {
            try {
              await client.books.share(conn, id);
            } catch (err) {
              onWarn('[Bookish:Backfill] share missing book failed:', id, err?.message || err);
            }
          }
          stats.drifted++;
        }
      }
      stats.reconciled++;
    } catch (err) {
      onWarn('[Bookish:Backfill] reconcile connection failed:', err?.message || err);
    }
  }
  return stats;
}
