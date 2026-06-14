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
//      This is the primary path; it covers every connection formed from now
//      on.
//
//   2. A boot-time reconciliation backstop, run AT MOST ONCE PER CONNECTION
//      (persisted in localStorage). Its only job is to cover connections the
//      seed provider couldn't: ones that predate this feature, and the rare
//      handshake where the seed write failed. For those, outbound is empty, so
//      it publishes the whole public shelf in one atomic snapshot. Once a
//      connection has been reconciled it is never touched again — forward
//      books ride share-on-save, so there is nothing left to do on later boots.
//
// What this backstop deliberately does NOT do: diff each connection's outbound
// set against the library on every boot and per-book share() the difference.
// That re-issues a network write per missing book against a peer log that may
// be unreadable (e.g. a migrated/rotated peer), which floods the console with
// unwrap failures and runs every single page load. (That was the 2026-06
// regression this rewrite removes.) True offline drift — a book whose
// share-on-save write failed while a friend was already connected — is a
// share-on-save retry concern, not a boot-time hammer.
//
// Privacy stays Bookish's call: we hand the SDK only public bookIds
// (is_private !== true). The SDK never sees the privacy field.

// localStorage key holding the JSON array of connection share_pubs we've
// already reconciled. Bumping this string would force a one-time re-reconcile.
const SEEDED_STORE_KEY = 'bookish.backfillSeeded';

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
 * A persisted set of connection share_pubs we've already reconciled, backed by
 * localStorage. Tolerant of a missing/clobbered store (treats it as empty).
 */
function defaultSeenStore() {
  const read = () => {
    try {
      const raw = localStorage.getItem(SEEDED_STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  return {
    has: (key) => read().includes(key),
    add: (key) => {
      try {
        const arr = read();
        if (!arr.includes(key)) {
          arr.push(key);
          localStorage.setItem(SEEDED_STORE_KEY, JSON.stringify(arr));
        }
      } catch {
        /* ignore — best-effort; worst case we re-seed once next boot */
      }
    },
  };
}

/**
 * Reconcile connections that predate the seed provider (or whose handshake
 * seed failed) by publishing the whole public library to any with an empty
 * outbound share-state. Runs each connection at most once, ever (persisted).
 * Idempotent and best-effort: a per-connection failure is logged, skipped, and
 * left un-marked so it retries next boot; it is never thrown.
 *
 * @param {object} client            the Tarn SDK client
 * @param {() => string[]} getPublicBookIds
 * @param {{ onWarn?: (...a:any[]) => void, seenStore?: { has:(k:string)=>boolean, add:(k:string)=>void } }} [opts]
 * @returns {Promise<{ reconciled: number, seeded: number, skipped: number }>}
 */
export async function reconcileConnectionShares(client, getPublicBookIds, opts = {}) {
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : () => {};
  const seen = opts.seenStore || defaultSeenStore();
  const stats = { reconciled: 0, seeded: 0, skipped: 0 };
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
    const key = conn?.share_pub;
    if (!key) continue;
    // Once per connection, forever. Subsequent boots have nothing to do here.
    if (seen.has(key)) {
      stats.skipped++;
      continue;
    }
    try {
      const shared = await client.books.listSharedWith(conn);
      if (shared.length === 0) {
        // Seed never landed (handshake failure, or a connection that predates
        // this feature) — full backfill in one atomic snapshot.
        await client.books.shareManyTo(conn, publicIds);
        stats.seeded++;
      }
      // Non-empty outbound: already seeded at handshake; forward books ride
      // share-on-save. We deliberately do NOT diff-and-repair per book.
      seen.add(key);
      stats.reconciled++;
    } catch (err) {
      // Leave un-marked so a transient failure retries next boot — but only
      // one warning per connection per boot, never a per-book flood.
      onWarn('[Bookish:Backfill] reconcile connection failed:', key, err?.message || err);
    }
  }
  return stats;
}
