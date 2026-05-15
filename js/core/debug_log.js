// debug_log.js — opt-in console debugging for normal-path diagnostics.
//
// Enable from DevTools with:
//   window.BOOKISH_DEBUG = true
// or persistently with:
//   localStorage.setItem('bookish.debug', 'true')

export function isDebugEnabled() {
  if (typeof globalThis === 'undefined') return false;
  const flag = globalThis.BOOKISH_DEBUG;
  if (flag === true || flag === 'true' || flag === 1 || flag === '1') return true;
  try {
    const stored = globalThis.localStorage?.getItem?.('bookish.debug');
    return stored === 'true' || stored === '1';
  } catch {
    return false;
  }
}

export function debugLog(...args) {
  if (!isDebugEnabled()) return;
  const logger = globalThis.console;
  if (logger?.debug) logger.debug(...args);
  else if (logger?.log) logger.log(...args);
}
