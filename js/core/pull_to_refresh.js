// pull_to_refresh.js — Pull-to-refresh gesture for standalone PWA mode (#90)

const PULL_THRESHOLD = 64;   // px to pull before refresh triggers
const MAX_PULL = 128;        // max visual displacement (rubber-band cap)
const INDICATOR_HEIGHT = 48; // height of the refresh indicator area

/**
 * Initialize pull-to-refresh on the main shelf view.
 * Only meaningful in standalone PWA mode — caller gates this.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - The scrollable area to watch (typically #app or #cards)
 * @param {Function} opts.onRefresh - Async callback (e.g. triggerSyncNow)
 * @param {Function} opts.isOverlayOpen - Returns true if any modal/overlay is open
 * @returns {{ destroy: Function }} Cleanup handle
 */
export function initPullToRefresh({ container, onRefresh, isOverlayOpen }) {
  let startY = 0;
  let pullDistance = 0;
  let tracking = false;
  let refreshing = false;

  // --- Create indicator DOM ---
  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML =
    '<div class="ptr-spinner">' +
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>' +
        '<polyline points="21 3 21 9 15 9"/>' +
      '</svg>' +
    '</div>';
  document.body.appendChild(indicator);

  const spinnerEl = indicator.querySelector('.ptr-spinner');

  function isAtTop() {
    return window.scrollY <= 0;
  }

  function dampen(distance) {
    // Rubber-band: diminishing returns past threshold
    if (distance <= PULL_THRESHOLD) return distance;
    const over = distance - PULL_THRESHOLD;
    return PULL_THRESHOLD + over * 0.4;
  }

  function updateVisual(distance) {
    const dampened = dampen(distance);
    const clamped = Math.min(dampened, MAX_PULL);
    const progress = Math.min(distance / PULL_THRESHOLD, 1);

    indicator.style.transform = `translateY(${clamped - INDICATOR_HEIGHT}px)`;
    indicator.style.opacity = String(Math.min(progress * 1.2, 1));
    // Rotate the arrow based on progress
    spinnerEl.style.transform = `rotate(${progress * 360}deg)`;
  }

  function showRefreshing() {
    indicator.classList.add('ptr-refreshing');
    indicator.style.transform = `translateY(0px)`;
    indicator.style.opacity = '1';
    indicator.style.transition = 'transform .2s ease-out';
    spinnerEl.style.transform = '';
  }

  function hide() {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    indicator.classList.remove('ptr-refreshing');
    if (reducedMotion) {
      resetVisual();
    } else {
      indicator.style.transition = 'transform .25s ease-in, opacity .25s ease-in';
      indicator.style.transform = `translateY(${-INDICATOR_HEIGHT}px)`;
      indicator.style.opacity = '0';
      const onEnd = () => {
        indicator.removeEventListener('transitionend', onEnd);
        resetVisual();
      };
      indicator.addEventListener('transitionend', onEnd);
      // Safety fallback in case transitionend doesn't fire
      setTimeout(onEnd, 300);
    }
  }

  function resetVisual() {
    indicator.style.transition = '';
    indicator.style.transform = `translateY(${-INDICATOR_HEIGHT}px)`;
    indicator.style.opacity = '0';
    spinnerEl.style.transform = '';
  }

  // Start hidden above
  resetVisual();

  function onTouchStart(e) {
    if (refreshing) return;
    if (e.touches.length !== 1) return;
    if (isOverlayOpen()) return;
    if (!isAtTop()) return;

    startY = e.touches[0].clientY;
    pullDistance = 0;
    tracking = true;
    indicator.style.transition = '';
  }

  function onTouchMove(e) {
    if (!tracking) return;
    if (refreshing) return;

    const currentY = e.touches[0].clientY;
    pullDistance = currentY - startY;

    if (pullDistance <= 0) {
      // Scrolling up — abort tracking
      pullDistance = 0;
      return;
    }

    // If we've started to scroll the page, abort (user scrolled up, then scrolled page down, now page is scrolled)
    if (!isAtTop()) {
      tracking = false;
      pullDistance = 0;
      resetVisual();
      return;
    }

    // Prevent native scroll while pulling
    e.preventDefault();
    updateVisual(pullDistance);
  }

  async function onTouchEnd() {
    if (!tracking) return;
    tracking = false;

    if (refreshing) return;

    if (pullDistance >= PULL_THRESHOLD) {
      refreshing = true;
      showRefreshing();
      try {
        await onRefresh();
      } catch (err) {
        console.error('[Bookish:PTR] Refresh failed:', err);
      }
      refreshing = false;
      hide();
    } else {
      hide();
    }

    pullDistance = 0;
  }

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd);
  container.addEventListener('touchcancel', onTouchEnd);

  function destroy() {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
    indicator.remove();
  }

  return { destroy };
}
