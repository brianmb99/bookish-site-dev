// log_local.js - Minimal local logging with circular buffer for diagnostics
// Stores {ts, phase, code, details} entries in localStorage

const LOG_KEY = 'bookish:log';
const MAX_ENTRIES = 200;

function now() { return Date.now(); }

function readLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(entries) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch (e) {
    console.warn('[Bookish:Log] failed to persist', e);
  }
}

export function append(phase, code, details = null) {
  const entries = readLog();
  entries.push({ ts: now(), phase, code, details });
  // Keep only last MAX_ENTRIES
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  writeLog(entries);
}

export function getAll() {
  return readLog();
}

export function clear() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {}
}

// Export as window.bookishLog for manual inspection / future "send logs" UI
if (typeof window !== 'undefined') {
  window.bookishLog = { append, getAll, clear };
}
