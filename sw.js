// sw.js - basic PWA service worker
const VERSION='v295';
const CACHE_NAME='bookish-precache-'+VERSION;
const PRECACHE=[
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/cache.js',
  '/js/book_search.js',
  '/js/date_picker.js',
  '/js/sync_manager.js',
  '/js/account_ui.js',
  '/js/ui_status_manager.js',
  '/js/core/tarn_service.js',
  '/js/core/image_utils.js',
  '/js/core/search_core.js',
  '/js/core/cover_pipeline.js',
  '/js/core/id_core.js',
  '/js/lib/tarn/tarn.js',
  '/js/lib/tarn/crypto.js',
  '/manifest.json',
  '/fonts/dm-sans-latin.woff2',
  '/fonts/fraunces-latin.woff2',
  '/fonts/jetbrains-mono-latin.woff2'
];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{ const c=await caches.open(CACHE_NAME); try{ await c.addAll(PRECACHE); }catch(err){ console.warn('[SW] Precache partial failure:',err); } self.skipWaiting(); })());
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
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));
    return;
  }
  if(url.origin===location.origin){
    if(url.pathname.startsWith('/fonts/')){ e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request))); return; }
    if(url.pathname.startsWith('/icons/')){ e.respondWith(staleWhileRevalidate(e.request)); return; }
    if(url.pathname.startsWith('/covers/')||/\.(jpg|png|webp)$/i.test(url.pathname)){ e.respondWith(staleWhileRevalidate(e.request)); return; }
    // All same-origin JS/CSS: network-first so SW updates always serve fresh code
    if(/\.(js|css)$/.test(url.pathname)){ e.respondWith(networkFirst(e.request)); return; }
    if(url.pathname==='/'||url.pathname==='/index.html'||url.pathname==='/manifest.json'){
      e.respondWith(networkFirst(e.request)); return;
    }
  }
  if(/openlibrary\.org|itunes\.apple\.com/.test(url.hostname)){ e.respondWith(staleWhileRevalidate(e.request)); }
});
