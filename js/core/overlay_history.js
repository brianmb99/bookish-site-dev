// overlay_history.js — Back-button support for overlays in standalone PWA mode (#81)
// Gate all history manipulation behind isStandalone to avoid polluting browser history.

const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

// When we programmatically call history.back() (e.g. user taps X to close),
// suppress the resulting popstate so we don't double-close.
let _suppressPopstate = false;

/**
 * Push a history state for an overlay opening.
 * Only takes effect in standalone (installed PWA) mode.
 */
export function pushOverlayState(name) {
  if (isStandalone) {
    history.pushState({ overlay: name }, '');
  }
}

/**
 * Pop the history state for an overlay closing (direct close, not via back button).
 * Sets suppress flag so the popstate listener ignores the resulting event.
 */
export function popOverlayState() {
  if (isStandalone) {
    _suppressPopstate = true;
    history.back();
  }
}

/**
 * Check and consume the suppress flag. Used by the popstate listener
 * to distinguish programmatic history.back() from user back-button presses.
 * Returns true if the popstate should be ignored.
 */
export function consumeSuppressFlag() {
  if (_suppressPopstate) {
    _suppressPopstate = false;
    return true;
  }
  return false;
}

export { isStandalone };
