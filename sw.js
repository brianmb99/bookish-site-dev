// sw.js - basic PWA service worker (v10 serverless)
const VERSION='v40';
const CACHE_NAME='bookish-precache-'+VERSION;
const CORE_ASSETS=[
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/cache.js',
  '/browser_client.js',
  '/book_search.js',
  '/date_picker.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png'
];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{ const c=await caches.open(CACHE_NAME); try{ await c.addAll(CORE_ASSETS); }catch(_){} self.skipWaiting(); })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    console.log('[SW] Activating version:',VERSION);
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message',e=>{
  if(e.data==='SKIP_WAITING'){ self.skipWaiting(); }
  if(e.data==='GET_VERSION' && e.ports?.[0]){ e.ports[0].postMessage(VERSION); }
});
async function cachePut(req,res){ try{ const c=await caches.open(CACHE_NAME); await c.put(req,res); }catch(_){} }
async function networkFirst(req){ try{ const net=await fetch(req); const copy=net.clone(); cachePut(req,copy); return net; } catch{ const cached=await caches.match(req); if(cached) return cached; throw new Response('Offline',{status:503}); } }
async function staleWhileRevalidate(req){ const cached=await caches.match(req); const fetchPromise=fetch(req).then(r=>{ cachePut(req,r.clone()); return r; }).catch(()=>cached); return cached||fetchPromise; }
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return; // ignore non-GET
  const url=new URL(e.request.url);
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));
    return;
  }
  if(url.origin===location.origin){
    if(url.pathname.startsWith('/icons/')){ e.respondWith(staleWhileRevalidate(e.request)); return; }
    if(url.pathname.startsWith('/covers/')||/\.(jpg|png|webp)$/i.test(url.pathname)){ e.respondWith(staleWhileRevalidate(e.request)); return; }
    if(CORE_ASSETS.includes(url.pathname)||url.pathname==='/'){ e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))); return; }
  }
  if(/openlibrary\.org|itunes\.apple\.com/.test(url.hostname)){ e.respondWith(staleWhileRevalidate(e.request)); }
});
