// subscription.js — Bookish subscription state (#74).
//
// Wraps the bookish-api subscription endpoints:
//   GET  /api/subscription/status  — source of truth for free | subscribed | lapsed
//   POST /api/checkout             — kicks off Stripe Checkout
//   POST /api/portal               — opens Stripe Billing Portal (reserved for #107)
//
// Status is cached after the first successful fetch and reused across callers.
// Call resetStatus() on logout; call fetchStatus({force:true}) to refresh after
// returning from Stripe Checkout.

import { getDataLookupKey } from './tarn_service.js';

const BOOKISH_API = window.BOOKISH_API_URL || 'https://bookish-api.bookish.workers.dev';

/** Max books a free-tier user may save. Must match bookish-api FREE_TIER_RULES. */
export const FREE_LIMIT = 5;

/** Show the "N of 5" count once the user has at least this many books.
 *  Below this threshold the count is hidden to avoid anxious chrome for new users. */
export const COUNT_THRESHOLD = 3;

let _status = null;            // 'free' | 'subscribed' | 'lapsed' | null (unknown)
let _currentPeriodEnd = null;  // ISO string when subscribed
let _inflight = null;

/**
 * Fetch subscription status from the API. Cached across callers.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchStatus({ force = false } = {}) {
  const dlk = getDataLookupKey();
  if (!dlk) {
    _status = null;
    _currentPeriodEnd = null;
    return null;
  }
  if (_inflight) return _inflight;
  if (!force && _status !== null) return _status;

  _inflight = (async () => {
    try {
      const url = `${BOOKISH_API}/api/subscription/status?dataLookupKey=${encodeURIComponent(dlk)}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error('[Subscription] Status fetch failed:', res.status);
        return _status;
      }
      const data = await res.json();
      _status = data.status || null;
      _currentPeriodEnd = data.current_period_end || null;
      return _status;
    } catch (err) {
      console.error('[Subscription] Status fetch error:', err?.message || err);
      return _status;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

export function getStatus() { return _status; }
export function getCurrentPeriodEnd() { return _currentPeriodEnd; }
export function isSubscribed() { return _status === 'subscribed'; }
export function isLapsed() { return _status === 'lapsed'; }
export function isFree() { return _status === 'free'; }
export function isKnown() { return _status !== null; }

/** Clear cached state. Call on logout. */
export function resetStatus() {
  _status = null;
  _currentPeriodEnd = null;
}

/**
 * Whether the user should be blocked from adding another book right now.
 * Subscribed: never. Lapsed: always. Free: when at/over FREE_LIMIT.
 * Unknown status (pre-fetch, fetch failed): never — fail open.
 * @param {number} entryCount — non-tombstoned entry count
 */
export function isAddBlocked(entryCount) {
  if (_status === 'subscribed') return false;
  if (_status === 'lapsed') return true;
  if (_status === 'free') return entryCount >= FREE_LIMIT;
  return false;
}

/**
 * Whether to show the "N of 5 free books" count.
 * Only for free-tier users at/above COUNT_THRESHOLD.
 */
export function shouldShowCount(entryCount) {
  return _status === 'free' && entryCount >= COUNT_THRESHOLD;
}

/**
 * Start Stripe Checkout. Redirects the current tab to the Checkout URL.
 * @returns {Promise<void>}
 */
export async function startCheckout() {
  const dlk = getDataLookupKey();
  if (!dlk) throw new Error('Not logged in');

  const res = await fetch(`${BOOKISH_API}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataLookupKey: dlk }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Checkout failed (${res.status}): ${body}`);
  }
  const { url } = await res.json();
  if (!url) throw new Error('No checkout URL returned');
  window.location.assign(url);
}

/**
 * Poll status until it matches one of the target values or a timeout elapses.
 * Used on return from Stripe (?sub=success) because the webhook may take a
 * few seconds to process.
 *
 * @param {string[]} targets — stop as soon as status is one of these
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 */
export async function waitForStatus(targets, { timeoutMs = 12000, intervalMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await fetchStatus({ force: true });
    if (status && targets.includes(status)) return status;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return _status;
}
