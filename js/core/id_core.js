// Core ID & size helpers (pure logic, no DOM or global side-effects)

export async function deriveBookId() {
  return crypto.randomUUID();
}

export function detectMime(raw){
  if(!raw || !raw.length) return undefined;
  if(raw.length>=3 && raw[0]===0xFF && raw[1]===0xD8 && raw[2]===0xFF) return 'image/jpeg';
  if(raw.length>=8 && raw[0]===0x89 && raw[1]===0x50 && raw[2]===0x4E && raw[3]===0x47) return 'image/png';
  return undefined;
}

// Estimate encrypted payload size for a prospective entry (AES-GCM adds 12 iv + 16 tag)
export async function estimateEntryBytes(entry){
  const e = { ...entry };
  e.schema='reading'; e.version='0.3.0';
  if(!e.bookId){ e.bookId = await deriveBookId(e); }
  const pt = new TextEncoder().encode(JSON.stringify(e));
  return 12 + 16 + pt.length; // iv + tag + ciphertext
}

/**
 * Convert a YYYY-MM-DD date string to a JS millisecond epoch at noon UTC.
 * Noon UTC ensures the date stays on the intended calendar day in every viewer
 * timezone (offsets up to ±14h are safely contained), so callers using UTC
 * components on display will see the same Mar 14 the user picked.
 *
 * @param {string} s - Date string in YYYY-MM-DD format
 * @returns {number|null} ms epoch at 12:00:00.000 UTC, or null if input is invalid
 */
export function dateStringToMsNoonUtc(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return Date.UTC(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

/**
 * Convert a ms epoch (or any value Date can parse) back to a YYYY-MM-DD string
 * using UTC components. Used to populate the date-input control from a saved
 * record, and to round-trip an unedited date through the form.
 *
 * @param {number|null|undefined} ms
 * @returns {string} YYYY-MM-DD or '' if input is invalid
 */
export function msToDateInputUtc(ms) {
  if (ms == null || ms === '') return '';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format a ms epoch dateRead for display in card meta rows.
 * Uses UTC components so the user always sees the date they picked, regardless
 * of the viewer's local timezone.
 *
 * @param {number|null|undefined} ms
 * @returns {string} e.g. "Mar 14, 2026" or '' if input is invalid
 */
export function formatDateReadDisplay(ms) {
  if (ms == null || ms === '') return '';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Compact "Mon YYYY" formatter for the slim card details row (e.g. "Mar 2026").
 * Same UTC rationale as formatDateReadDisplay — the noon-UTC value renders as
 * the picked calendar month in every viewer timezone.
 *
 * @param {number|null|undefined} ms
 * @returns {string} e.g. "Mar 2026" or '' if input is invalid
 */
export function formatMonthYearDisplay(ms) {
  if (ms == null || ms === '') return '';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

// Helper for tests to build a fake base64 cover (not used in production import)
export function fakeCoverBytes(len=128){
  const arr=new Uint8Array(len); for(let i=0;i<len;i++) arr[i]=i%256; return arr;
}
