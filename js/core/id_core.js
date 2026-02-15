// Core ID & size helpers extracted from browser_client.js (pure logic)
// No DOM or global side-effects.

export async function deriveBookId({ isbn, title, author, edition, createdAt }) {
  const ts = createdAt ? String(createdAt) : String(Date.now());
  if (isbn && isbn.trim()) return `isbn:${isbn.trim()}:${ts}`;
  const s = `${title ?? ''}|${author ?? ''}|${edition ?? ''}|${ts}`.toLowerCase();
  const enc = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `hash:${hex}`;
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
  e.schema='reading'; e.version='0.1.0';
  if(!e.bookId){ e.bookId = await deriveBookId(e); }
  const pt = new TextEncoder().encode(JSON.stringify(e));
  return 12 + 16 + pt.length; // iv + tag + ciphertext
}

// Helper for tests to build a fake base64 cover (not used in production import)
export function fakeCoverBytes(len=128){
  const arr=new Uint8Array(len); for(let i=0;i<len;i++) arr[i]=i%256; return arr;
}
