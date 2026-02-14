// Bookish app.js (pure serverless variant)

import { initSyncManager, startSync, stopSync, getSyncStatusForUI, triggerPersistenceCheck, markDirty, triggerSyncNow } from './sync_manager.js';
import * as storageManager from './core/storage_manager.js';
import uiStatusManager from './ui_status_manager.js';
import { getAccountStatus } from './account_ui.js';
import { resizeImageToBase64 } from './core/image_utils.js';

// --- DOM refs ---
const statusEl = document.getElementById('status');
// status banner removed; we now write a single status line into the geek panel
const cardsEl = document.getElementById('cards');
const emptyEl = document.getElementById('empty');
const geekBtn = document.getElementById('geekBtn');
const geekPanel = document.getElementById('geekPanel');
const geekClose = document.getElementById('geekClose');
const geekBody = document.getElementById('geekBody');
const geekStatusLine = document.getElementById('geekStatusLine');
const modal = document.getElementById('modal');
// Funding modal refs
const fundModal = document.getElementById('fundingModal');
const fundClose = document.getElementById('fundClose');
const fundAddrEl = document.getElementById('fundAddr');
const fundCopyBtn = document.getElementById('fundCopy');
const fundL1El = document.getElementById('fundL1');
const fundIrysEl = document.getElementById('fundIrys');
const fundCostEl = document.getElementById('fundCost');
const fundMsgEl = document.getElementById('fundMsg');
const fundRefreshBtn = document.getElementById('fundRefresh');
const fundDoBtn = document.getElementById('fundDo');
const fundRetryBtn = document.getElementById('fundRetry');
// Account panel refs
const accountBtn = document.getElementById('accountBtn');
const accountPanel = document.getElementById('accountPanel');
const accountClose = document.getElementById('accountClose');
const form = document.getElementById('entryForm');
const coverFileInput = document.getElementById('hiddenCoverInput');
const coverPreview = document.getElementById('coverPreview');
const tileCoverClick = document.getElementById('tileCoverClick');
const coverPlaceholder = document.getElementById('coverPlaceholder');
const coverRemoveBtn = document.getElementById('coverRemoveBtn');
const notesInput = document.getElementById('notesInput');
const saveBtn = document.getElementById('saveBtn');
const deleteBtn = document.getElementById('deleteBtn');
const cancelBtn = document.getElementById('cancelBtn');
const newBtn = document.getElementById('newBtn');
// Phase 2: First-run experience refs
const emptyAddBookBtn = document.getElementById('emptyAddBookBtn');
const celebrationToast = document.getElementById('celebrationToast');
const accountNudgeBanner = document.getElementById('accountNudgeBanner');
const nudgeDismissBtn = document.getElementById('nudgeDismissBtn');
const nudgeCreateAccountBtn = document.getElementById('nudgeCreateAccountBtn');
if(tileCoverClick && coverFileInput){ tileCoverClick.addEventListener('click',(e)=>{ if(e.target.closest('.cover-remove-btn')) return; coverFileInput.click(); }); }
if(coverRemoveBtn){ coverRemoveBtn.addEventListener('click',(e)=>{ e.stopPropagation(); clearCoverPreview(); updateDirty(); }); }

// --- Helpers ---
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function clearCoverPreview(){ coverPreview.style.display='none'; coverPlaceholder.style.display='block'; delete coverPreview.dataset.b64; delete coverPreview.dataset.mime; coverPreview.src=''; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; coverFileInput.value=''; }
function showCoverLoaded(){ if(coverRemoveBtn) coverRemoveBtn.style.display='inline-flex'; }

// --- State ---
let entries=[]; let replaying=false;
const SERVERLESS=true;
let browserClient; let keyState={ loaded:false };

// Export reset function for logout
export function resetKeyState() {
  keyState.loaded = false;
  browserClient = null;
}
let walletError = null; // Track wallet errors for UI status manager
window.BOOKISH_DEBUG=true; function dbg(...a){ if(window.BOOKISH_DEBUG) console.debug('[Bookish]',...a); }

// --- Superuser mode ---
const SU_KEY = 'bookish_superuser';
function isSuperuser(){ return document.body.hasAttribute('data-superuser'); }
function setSuperuser(on){
  if(on){
    document.body.setAttribute('data-superuser','');
    localStorage.setItem(SU_KEY,'true');
    if(geekBtn) geekBtn.classList.add('superuser-active');
  } else {
    document.body.removeAttribute('data-superuser');
    localStorage.removeItem(SU_KEY);
    if(geekBtn) geekBtn.classList.remove('superuser-active');
  }
}
// Restore superuser state on load
if(localStorage.getItem(SU_KEY)==='true') setSuperuser(true);

/**
 * Get balance status for UI status manager
 * @returns {Object} { error }
 */
function getBalanceStatus() {
  return { error: walletError };
}

// --- Utility / ordering ---
function setStatus(m){ statusEl.textContent=m; statusEl.classList.remove('warning'); if(window.BOOKISH_DEBUG) console.debug('[Bookish] status:', m); }
function orderEntries(){ entries.sort((a,b)=>{ const da=a.dateRead||''; const db=b.dateRead||''; if(da!==db) return db.localeCompare(da); if(a._committed!==b._committed) return a._committed?-1:1; return 0; }); }
function formatDisplayDate(iso){ if(!iso) return ''; const d=new Date(iso+'T00:00:00Z'); if(isNaN(d)) return iso; return d.toLocaleDateString(undefined,{month:'short',year:'numeric'}); }

// --- Modal helpers ---
function openModal(entry){
  modal.classList.add('active');
  // Toggle add-mode class: controls search UI visibility and edit-only elements
  const inner = modal.querySelector('.modal-inner');
  if(inner){ if(!entry) inner.classList.add('add-mode'); else inner.classList.remove('add-mode'); }
  // Ensure all inputs enabled (was previously gated by edit toggle)
  const inputs=[...form.querySelectorAll('input,select,textarea')];
  inputs.forEach(i=>{ if(i.name==='priorTxid') return; i.disabled=false; });
  // Populate fields
  form.priorTxid.value=entry?(entry.txid||entry.id||''):'';
  form.title.value=entry?entry.title:'';
  form.author.value=entry?entry.author:'';
  form.edition.value=entry?entry.edition:'';
  form.format.value=entry?entry.format:'paperback';
  form.dateRead.value=entry?entry.dateRead:new Date().toISOString().slice(0,10);
  if(notesInput) notesInput.value = entry?.notes || '';
  if(entry&&entry.coverImage){
    coverPreview.src='data:'+(entry.mimeType||'image/*')+';base64,'+entry.coverImage;
    coverPreview.style.display='block'; coverPlaceholder.style.display='none';
    coverPreview.dataset.b64=entry.coverImage; if(entry.mimeType) coverPreview.dataset.mime=entry.mimeType;
    showCoverLoaded();
  } else { clearCoverPreview(); }
  // Delete button only for existing entry
  if(deleteBtn) deleteBtn.style.display=entry?'inline-flex':'none';
  if(cancelBtn) cancelBtn.style.display='inline-flex';
  // Dirty tracking snapshot
  snapshotOriginal();
  updateDirty();
  if(window.bookSearch) window.bookSearch.handleModalOpen(!!entry);
}
function closeModal(){ modal.classList.remove('active'); const inner=modal.querySelector('.modal-inner'); if(inner) inner.classList.remove('add-mode'); form.reset(); coverPreview.style.display='none'; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; delete form.dataset.orig; saveBtn.disabled=true; if(window.bookSearch) window.bookSearch.handleModalOpen(true); }
function clearBooks(){ entries=[]; render(); }
window.bookishApp={ openModal, clearBooks, showCoverLoaded, clearCoverPreview };
// Dirty tracking helpers
function currentFormState(){ return JSON.stringify({
  prior: form.priorTxid.value||'',
  title: form.title.value.trim(),
  author: form.author.value.trim(),
  edition: form.edition.value.trim(),
  format: form.format.value,
  dateRead: form.dateRead.value,
  cover: coverPreview.dataset.b64||'',
  notes: (notesInput?.value||'').trim()
}); }
function snapshotOriginal(){ form.dataset.orig = currentFormState(); }
function updateDirty(){ const orig=form.dataset.orig||''; const cur=currentFormState(); saveBtn.disabled = (orig===cur); }
if(!form._dirtyBound){
  form._dirtyBound=true;
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
}

// --- Cover file input ---
coverFileInput.addEventListener('change', async ()=>{ const f=coverFileInput.files[0]; if(!f) return;
  try {
    const { base64, mime, wasResized, dataUrl } = await resizeImageToBase64(f);
    if(wasResized) console.info('[Bookish] User upload resized for storage efficiency');
    coverPreview.src = dataUrl;
    coverPreview.style.display = 'block';
    coverPlaceholder.style.display = 'none';
    coverPreview.dataset.b64 = base64;
    coverPreview.dataset.mime = mime;
    showCoverLoaded();
  } catch(err) {
    // Fallback to original if resize fails
    const r = new FileReader(); r.onload = e => { const b64full = e.target.result; const b64 = b64full.split(',')[1]; coverPreview.src = b64full; coverPreview.style.display = 'block'; coverPlaceholder.style.display = 'none'; coverPreview.dataset.b64 = b64; coverPreview.dataset.mime = f.type || 'image/jpeg'; showCoverLoaded(); }; r.readAsDataURL(f);
  }
});

const closeModalBtn = document.getElementById('closeModal');
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', closeModal);

// --- Funding UI logic ---
let lastPendingOp=null;
function openFundingModal(pending){
  lastPendingOp = pending||lastPendingOp;
  if(fundModal) fundModal.classList.add('active');
  refreshFundingInfo().catch(()=>{});
}
function closeFundingModal(){ if(fundModal) fundModal.classList.remove('active'); }
async function refreshFundingInfo(){
  try{
    await (window.bookishWallet?.ensure?.());
    const addr = await (window.bookishWallet?.getAddress?.());
    if(addr) fundAddrEl.textContent = addr;
    // L1 balance
    const balWei = await (window.bookishWallet?.getBalance?.());
    if(balWei!=null){
      const eth = Number(balWei)/1e18; fundL1El.textContent = eth.toFixed(6)+' ETH';
    }
    // Irys balance removed from UI
    // Estimate current pending cost if payload present
    if(lastPendingOp && window.bookishIrys){
      try{
        // use estimator based on entry json size
        const bytes = await (browserClient?.estimateEntryBytes?.(lastPendingOp.payload) || window.bookishEstimate?.entryBytes?.(lastPendingOp.payload));
        if(bytes){
          const price = await window.bookishIrys.estimateCost(bytes);
          fundCostEl.textContent = `${bytes} bytes ≈ ${(Number(price)/1e18).toFixed(6)} ETH`;
        }
      }catch{}
    }
    fundMsgEl.textContent = '';
  }catch(e){ fundMsgEl.textContent = 'Unable to refresh balances'; }
}
fundClose?.addEventListener('click', closeFundingModal);
fundCopyBtn?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(fundAddrEl.textContent||''); fundMsgEl.textContent='Address copied'; }catch{} });
fundRefreshBtn?.addEventListener('click', ()=> refreshFundingInfo());
fundDoBtn?.addEventListener('click', async ()=>{
  fundDoBtn.disabled=true; fundMsgEl.textContent='Funding...';
  try{
    if(!lastPendingOp) throw new Error('no-pending');
    const bytes = await (browserClient?.estimateEntryBytes?.(lastPendingOp.payload) || window.bookishEstimate?.entryBytes?.(lastPendingOp.payload));
    if(!bytes) throw new Error('no-estimate');
    const price = await window.bookishIrys.estimateCost(bytes);
    await window.bookishIrys.fund(price.toString());
    fundMsgEl.textContent='Funded. You can retry publish now.';
    await refreshFundingInfo();
  }catch(e){ fundMsgEl.textContent='Funding failed.'; }
  finally{ fundDoBtn.disabled=false; }
});
fundRetryBtn?.addEventListener('click', async ()=>{
  if(!lastPendingOp){ fundMsgEl.textContent='Nothing to retry.'; return; }
  closeFundingModal();
  uiStatusManager.refresh();
  try{
    if(lastPendingOp.type==='create'){
      await createServerless(lastPendingOp.payload);
    } else if(lastPendingOp.type==='edit'){
      await editServerless(lastPendingOp.priorTxid, lastPendingOp.payload);
    }
    lastPendingOp=null;
  }catch{ walletError='Retry failed'; uiStatusManager.refresh(); }
});

// --- Account modal logic ---
// Account UI handles all updates via account_ui.js
// Import modal functions from account_ui.js
let openAccountModal;
(async function setupAccountButton() {
  try {
    // Wait for DOM to be ready if needed
    if (document.readyState === 'loading') {
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
    }

    const accountUI = await import('./account_ui.js');
    if (!accountUI || !accountUI.openAccountModal) {
      console.error('[Bookish] Failed to import openAccountModal from account_ui.js', accountUI);
      return;
    }
    openAccountModal = accountUI.openAccountModal;

    // Get button reference (may not exist at module load time)
    const btn = document.getElementById('accountBtn');
    if(btn) {
      const clickHandler = async () => {
        console.log('[Bookish] Account button clicked');
        if(openAccountModal) {
          try {
            await openAccountModal();
          } catch (error) {
            console.error('[Bookish] Error opening account modal:', error);
          }
        } else {
          console.error('[Bookish] openAccountModal is not defined');
        }
      };
      btn.onclick = clickHandler;
      console.log('[Bookish] Account button wired up successfully');
    } else {
      console.warn('[Bookish] accountBtn not found in DOM, retrying...');
      // Retry after a short delay in case DOM isn't ready yet
      setTimeout(() => {
        const retryBtn = document.getElementById('accountBtn');
        if (retryBtn && openAccountModal) {
          retryBtn.onclick = () => openAccountModal();
          console.log('[Bookish] Account button wired up on retry');
        } else {
          console.error('[Bookish] Failed to wire up account button after retry');
        }
      }, 100);
    }
  } catch (error) {
    console.error('[Bookish] Failed to load account_ui.js:', error);
  }
})();

// No settings UI anymore; defaults used

// --- Phase 2: First-run experience functions ---
export function showCelebrationToast(){
  const celebrated = localStorage.getItem('bookish.firstBookCelebrated');
  if(celebrated) return; // Already shown

  if(celebrationToast){
    celebrationToast.style.display='flex';
    localStorage.setItem('bookish.firstBookCelebrated', 'true');
    setTimeout(()=>{
      if(celebrationToast){
        celebrationToast.classList.add('hiding');
        setTimeout(()=>{
          if(celebrationToast){
            celebrationToast.style.display='none';
            celebrationToast.classList.remove('hiding');
          }
        }, 300);
      }
    }, 3000);
  }
}

export function showAccountNudge(){
  // Don't show if logged in
  if(storageManager.isLoggedIn()) return;

  // Don't show if dismissed
  const dismissed = localStorage.getItem('bookish.accountNudgeDismissed');
  if(dismissed) return;

  // Only show if 3+ books
  if(entries.length < 3) return;

  // Hide the other account banner to avoid duplicates
  const otherBanner = document.getElementById('accountBanner');
  if(otherBanner) otherBanner.style.display='none';

  if(accountNudgeBanner){
    accountNudgeBanner.style.display='flex';
  }
}

export function hideAccountNudge(){
  if(accountNudgeBanner){
    accountNudgeBanner.style.display='none';
  }
}

// --- Generated cover color palette ---
const COVER_PALETTE=[
  'linear-gradient(145deg,#6b2137 0%,#4a1528 100%)', // burgundy
  'linear-gradient(145deg,#1e3a5f 0%,#152a45 100%)', // navy
  'linear-gradient(145deg,#2d4a3e 0%,#1c332b 100%)', // forest
  'linear-gradient(145deg,#5b4a3f 0%,#3d312a 100%)', // umber
  'linear-gradient(145deg,#4a3b6b 0%,#332852 100%)', // plum
  'linear-gradient(145deg,#3a5043 0%,#263830 100%)', // sage
  'linear-gradient(145deg,#5a3e3e 0%,#3d2929 100%)', // clay
  'linear-gradient(145deg,#2a4a5a 0%,#1c3340 100%)', // slate
  'linear-gradient(145deg,#5a4a2a 0%,#3d3220 100%)', // olive
  'linear-gradient(145deg,#4a2a4a 0%,#331e33 100%)', // aubergine
];
function generatedCoverColor(title){
  let h=0; for(let i=0;i<title.length;i++) h=((h<<5)-h+title.charCodeAt(i))|0;
  return COVER_PALETTE[Math.abs(h)%COVER_PALETTE.length];
}

// --- Render ---
function markDeletingVisual(entry){ entry._deleting=true; entry._committed=false; const key=entry.txid||entry.id||''; const el=key?document.querySelector('.card[data-txid="'+key+'"]'):null; if(el){ el.classList.add('deleting'); el.style.pointerEvents='none'; el.style.opacity='0.35'; } }
function render(){
  cardsEl.innerHTML='';
  if(!entries.length){ emptyEl.style.display='block'; hideAccountNudge(); return; } else emptyEl.style.display='none';

  // Check if should show account nudge (only if not logged in)
  if(storageManager.isLoggedIn()){
    hideAccountNudge();
  } else {
    showAccountNudge();
  }
  for(const e of entries){
    if(e.status==='tombstoned') continue;
    const div=document.createElement('div');
    const rawFmt=(e.format||'').toLowerCase(); let fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
    div.className='card'+(e._deleting?' deleting':''); div.dataset.txid=e.txid||e.id||''; div.dataset.fmt=fmtVariant; div.dataset.format=rawFmt;
    const dotClass = (!e.txid) ? 'local' : (e.onArweave ? 'arweave' : 'irys');
    const dotTitle = (!e.txid) ? 'Local only' : (e.onArweave ? 'Saved to Arweave' : 'Saved to Irys \u2014 settling to Arweave\u2026');
    const dateDisp=formatDisplayDate(e.dateRead);
    const notesSnippet = e.notes ? `<p class="card-notes">${escapeHtml(e.notes)}</p>` : '';
    div.innerHTML=`
      <div class="status-dot ${dotClass}" data-tip="${dotTitle}"></div>
      <div class="cover">${e.coverImage?`<img src="data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}">`:`<div class="generated-cover" style="background:${generatedCoverColor(e.title||'')}"><span class="generated-title">${escapeHtml(e.title||'Untitled')}</span>${e.author?`<span class="generated-author">${escapeHtml(e.author)}</span>`:''}</div>`}</div>
      <div class="meta">
        <p class="title">${e.title||'<i>Untitled</i>'}</p>
        <p class="author">${e.author||''}</p>
        <div class="details">${dateDisp ? `<span class="read-date">Read ${dateDisp}</span>` : ''}</div>
        ${notesSnippet}
      </div>`;
    div.onclick=()=>{ if(!e._deleting) openModal(e); };
    cardsEl.appendChild(div);
  }
  // Update book status dots
  setTimeout(updateBookDots, 0);
}

/**
 * Update book status dots with smart probing
 * Only probes entries that have txid but aren't confirmed on Arweave yet
 */
async function updateBookDots(){
  for(const e of entries){
    const card = cardsEl.querySelector(`.card[data-txid="${e.txid||e.id||''}"]`);
    if(!card) continue;
    const dot = card.querySelector('.status-dot');
    if(!dot) continue;

    // Set color based on current state
    dot.classList.remove('local','irys','arweave');

    if(!e.txid) {
      // Local only - not uploaded
      dot.classList.add('local');
      dot.dataset.tip = 'Local only';
    } else if(e.onArweave) {
      // Final state - on Arweave, stop checking
      dot.classList.add('arweave');
      dot.dataset.tip = 'Saved to Arweave';
    } else {
      // On Irys - check if reached Arweave
      dot.classList.add('irys');
      dot.dataset.tip = 'Saved to Irys \u2014 settling to Arweave\u2026';

      // Probe in background (only for entries needing it)
      probeAndUpdateDot(e, dot);
    }
  }
}

/**
 * Probe backoff state — exponential backoff per entry after failures
 * Prevents spamming gateways with HEAD requests for entries not yet on Arweave
 */
const probeBackoff = new Map(); // txid → { fails: number, lastAttempt: number }
const PROBE_BASE_MS = 60000;   // 60s base backoff
const PROBE_MAX_MS  = 900000;  // 15 min max backoff

/** Reset all probe backoff counters (called on Sync Now) */
function resetProbeBackoff() { probeBackoff.clear(); }

/**
 * Probe Arweave availability and update entry state
 * Uses exponential backoff per entry to avoid continuous error traffic
 */
async function probeAndUpdateDot(entry, dot) {
  const txid = entry.txid;
  const state = probeBackoff.get(txid);
  if (state) {
    const backoff = Math.min(PROBE_BASE_MS * Math.pow(2, state.fails), PROBE_MAX_MS);
    if (Date.now() - state.lastAttempt < backoff) {
      return; // Still in backoff window
    }
  }

  try {
    const rec = await window.bookishNet?.probeAvailability?.(txid);
    if(rec?.arweave) {
      // Reached Arweave - persist this flag so we stop probing
      entry.onArweave = true;
      probeBackoff.delete(txid); // Success — clear backoff
      if(window.bookishCache) {
        await window.bookishCache.putEntry(entry);
      }
      dot.classList.remove('irys');
      dot.classList.add('arweave');
      dot.dataset.tip = 'Saved to Arweave';
    } else {
      // Not on Arweave yet — increment backoff
      const prev = probeBackoff.get(txid) || { fails: 0, lastAttempt: 0 };
      probeBackoff.set(txid, { fails: prev.fails + 1, lastAttempt: Date.now() });
    }
  } catch(err) {
    // Probe failed — increment backoff
    const prev = probeBackoff.get(txid) || { fails: 0, lastAttempt: 0 };
    probeBackoff.set(txid, { fails: prev.fails + 1, lastAttempt: Date.now() });
    console.debug('[Bookish] Arweave probe failed for', txid, err);
  }
}

// --- Diagnostics status line (inside geek panel) ---
let diagItems=[]; let diagTimer=null; let diagIdx=0;
let diagTickTimer=null; let diagIdle=true;
function diagRender(){
  if(!geekStatusLine) return;
  if(!diagItems.length){ geekStatusLine.textContent=''; return; }
  geekStatusLine.textContent = String(diagItems[diagIdx % diagItems.length]);
}
function diagSet(items){
  diagItems = Array.isArray(items) ? items.filter(Boolean) : (items?[String(items)]:[]);
  diagIdx=0; diagRender();
  if(diagTimer) clearInterval(diagTimer);
  if(diagItems.length>1){ diagTimer=setInterval(()=>{ diagIdx=(diagIdx+1)%diagItems.length; diagRender(); }, 2500); }
  diagIdle=false;
}
function diagClear(){ diagItems=[]; if(diagTimer) clearInterval(diagTimer); diagTimer=null; diagRender(); diagIdle=true; }
function diagMaybeSet(items){ diagSet(items); }
function diagMaybeClear(){ diagClear(); }

function fmtCountdown(ms){ if(ms<=0) return 'now'; const s=Math.ceil(ms/1000); return s+'s'; }
function diagIdleSeed(){
  // If nothing active, show countdowns for next sync and next probe
  const now=Date.now();
  const nextSyncAt = (window.bookishNextSyncAt||0);
  const syncIn = Math.max(0, nextSyncAt - now);
  const nextProbeAt = (window.bookishNet?.nextProbeAt)||0;
  const probeIn = Math.max(0, nextProbeAt - now);
  const inflightIrys = (window.bookishNet?.irysInFlight)||0;
  const inflightAr = (window.bookishNet?.arweaveInFlight)||0;
  const probePart = inflightAr>0 ? 'Probing Arweave now...' : (probeIn<=0 ? 'Probing Arweave now...' : `Next Arweave probe in ${fmtCountdown(probeIn)}`);
  const syncStatus = window.bookishSyncManager?.getSyncStatus?.();
  const isSyncing = syncStatus?.isSyncing || inflightIrys > 0;
  const syncPart = isSyncing ? 'Syncing...' : `Next Irys sync in ${fmtCountdown(syncIn)}`;
  const line = `${syncPart}; ${probePart}`;
  // Do not flip to active; keep idle mode and recompute every tick
  diagItems=[line]; diagRender();
}

// --- Key handling ---
async function ensureKeys(){
  if(keyState.loaded) return true;
  let symTxt=localStorage.getItem('bookish.sym');
  // Legacy hex key prompt removed - now using credential-based seed storage
  if(!symTxt){ return false; }
  try { const sym=localStorage.getItem('bookish.sym'); if(window.createBrowserClient){ browserClient=await window.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } else if(window.bookishBrowserClient){ browserClient=await window.bookishBrowserClient.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } if(!browserClient){ setStatus('Client loading...'); return false; } keyState.loaded=true; const addr=await browserClient.address(); setStatus('EVM '+(addr?addr.slice(0,8)+'...':'ready')); return true; } catch(e){ console.error(e); setStatus('Key load error'); return false; }
}

// --- Arweave queries ---
async function serverlessFetchEntries(){
  if(!browserClient) return { entries:[], tombstones:[] };

  // Step 1: Query GraphQL for all transactions
  const owner=null; let allEdges=[]; let cursor=undefined; let safety=0; const PAGE=50;
  console.log('[Bookish] Querying Arweave GraphQL for book entries...');
  const queryStart = Date.now();
  for(;;){
    const { edges, pageInfo } = await browserClient.searchByOwner(owner,{limit:PAGE,cursor});
    allEdges.push(...edges);
    if(!pageInfo.hasNextPage) break;
    cursor=edges[edges.length-1]?.cursor;
    if(++safety>40) break;
  }
  console.log('[Bookish] GraphQL query completed in', Date.now() - queryStart, 'ms, found', allEdges.length, 'transactions');

  const { liveEdges, tombstones } = browserClient.computeLiveSets(allEdges);
  console.log('[Bookish] After filtering:', liveEdges.length, 'live entries,', tombstones.length, 'tombstones');

  // Step 2: Check which txids we already have cached with seenRemote flag
  const cachedEntries = window.bookishCache ? await window.bookishCache.listAllRaw() : [];
  const confirmedTxids = new Set(
    cachedEntries
      .filter(e => e.txid && e.seenRemote && e.status === 'confirmed')
      .map(e => e.txid)
  );
  const needsDecrypt = liveEdges.filter(e => !confirmedTxids.has(e.node.id));
  const alreadySynced = liveEdges.filter(e => confirmedTxids.has(e.node.id));

  console.log('[Bookish] Cache check:', alreadySynced.length, 'already synced,', needsDecrypt.length, 'need decrypt');

  // Step 3: Decrypt entries that aren't fully synced in cache
  const hydrated = [];
  const decryptStart = Date.now();
  const prevTag = (edge) => edge.node.tags?.find(t => t.name === 'Prev')?.value;
  for(const e of needsDecrypt){
    try{
      const dec = await browserClient.decryptTx(e.node.id);
      const prevTxid = prevTag(e);
      hydrated.push({ txid:e.node.id, ...dec, block:e.node.block, ...(prevTxid && { prevTxid }) });
    }catch(err){
      console.warn('[Bookish] Failed to decrypt', e.node.id, err);
    }
  }

  // Step 4: For already-synced entries, use cached data with updated block info
  for(const e of alreadySynced) {
    const cached = cachedEntries.find(c => c.txid === e.node.id);
    if (cached) {
      const prevTxid = prevTag(e);
      hydrated.push({
        ...cached,
        block: e.node.block, // Update block info if changed
        ...(prevTxid && { prevTxid })
      });
    }
  }

  console.log('[Bookish] Decrypted', needsDecrypt.length, 'entries in', Date.now() - decryptStart, 'ms');
  hydrated.sort((a,b)=>{ const da=a.dateRead||'0000-00-00'; const db=b.dateRead||'0000-00-00'; if(da!==db) return db.localeCompare(da); const ha=(a.block&&a.block.height)||0; const hb=(b.block&&b.block.height)||0; return hb-ha; });
  return { entries:hydrated, tombstones };
}

// --- Ops replay ---
async function replayOps(){
  if(replaying) return; replaying=true;
  try{
    // Skip replay if cache is disabled (IndexedDB unavailable)
    if(!window.bookishCache) return;
    const haveKeys = await ensureKeys();
    if (!haveKeys) return;
    const ops=await window.bookishCache.listOps();
    if(!ops.length) return;
  diagMaybeSet(['Replaying pending changes...']);
    for(const op of ops){
      if(op.type==='create'){
        const local=entries.find(e=>e.id===op.localId);
        if(!local){ await window.bookishCache.removeOp(op.id); continue; }
        if(local.txid){ await window.bookishCache.removeOp(op.id); continue; }
        try {
          const res=await browserClient.uploadEntry(op.payload,{});
          const oldId=local.id; local.txid=res.txid; local.id=res.txid; local.pending=false; local.status='confirmed'; local.seenRemote=true;
          await window.bookishCache.replaceProvisional(oldId,local);
          await window.bookishCache.removeOp(op.id);
          setStatus('Republished '+(local.title||''));
          orderEntries(); render();
        } catch{
          setStatus('Replay pending...');
          diagMaybeSet(['Awaiting Irys credit...','Will retry automatically']);
          break;
        }
      }
    }
  } finally {
    replaying=false;
    diagMaybeClear();
  }
}

// --- Sync (now managed by sync_manager.js) ---
async function syncBooksFromArweave(){
  // Fast fail if cache is unavailable (IndexedDB error)
  if(!window.bookishCache){
    console.warn('[Bookish] Book sync skipped - cache unavailable');
    return;
  }

  await replayOps();
  const have = await ensureKeys();

  if (!have) {
    // Only load cached books if user is logged in
    if (storageManager.isLoggedIn()) {
      entries = await window.bookishCache.getAllActive();
      console.log('[Bookish] Loaded', entries.length, 'books from cache (no keys)');
      orderEntries();
      render();
    }
    return;
  }

  console.log('[Bookish] Starting book sync from Arweave...');
  const { entries: remoteEntries, tombstones } = await serverlessFetchEntries();
  console.log('[Bookish] Fetched', remoteEntries.length, 'remote entries,', tombstones.length, 'tombstones');
  if (window.BOOKISH_DEBUG) console.debug('[Bookish] fetched remote entries:', remoteEntries.length, 'tombstones:', tombstones.length);

  const remote = remoteEntries.map(e => ({ ...e, status: 'confirmed', id: e.txid }));
  entries = await window.bookishCache.applyRemote(remote, tombstones);
  entries.forEach(e => e._committed = true);
  orderEntries();
  render();

  // Update dots after sync
  setTimeout(updateBookDots, 50);
}

// --- Create / edit / delete ---
async function createServerless(payload){ if(window.bookishCache){ const dup=await window.bookishCache.detectDuplicate(payload); if(dup){ uiStatusManager.refresh(); const el=cardsEl.querySelector('[data-txid="'+(dup.txid||dup.id)+'"]'); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('pulse'); setTimeout(()=>el.classList.remove('pulse'),1500);} return; } }
  const localId='local-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const rec={id:localId, txid:null, ...payload, createdAt:Date.now(), status:'pending', pending:true, seenRemote:false, onArweave:false, _committed:false};
  entries.push(rec);
  if(window.bookishCache) await window.bookishCache.putEntry(rec);
  markDirty(); // Signal sync manager that local data changed
  orderEntries(); render();

  // Phase 2: First-book celebration
  if(entries.length === 1){
    showCelebrationToast();
  }

  // Phase 2: Account nudge after 3rd book
  if(entries.length === 3){
    showAccountNudge();
  }
  try {
    // Ensure browser client is initialized
    const haveKeys = await ensureKeys();
    if (!haveKeys) {
      // Not logged in — book saved locally, upload deferred until account exists
      return;
    }

    // Ensure hidden EVM wallet exists before upload
    if(window.bookishWallet?.ensure){ const ensured = await window.bookishWallet.ensure(); if(window.BOOKISH_DEBUG) console.debug('[Bookish] wallet ensure:', ensured, await window.bookishWallet.getAddress()); }
    if(window.BOOKISH_DEBUG) console.debug('[Bookish] uploadEntry start');
  diagMaybeSet(['Publishing via Irys...','If funding is needed, you\'ll be prompted']);
    const res=await browserClient.uploadEntry(payload,{});
    if(window.BOOKISH_DEBUG) console.debug('[Bookish] uploadEntry ok:', res);
    const oldId=rec.id; rec.txid=res.txid; rec.id=res.txid; rec.pending=false; rec.status='confirmed'; rec.seenRemote=true; rec.onArweave=false;
    if(window.bookishCache) await window.bookishCache.replaceProvisional(oldId,rec);
    walletError=null; // Clear any previous errors
    orderEntries(); render(); uiStatusManager.refresh();
  diagMaybeClear();
    setTimeout(updateBookDots, 50);
  } catch(e){
    console.warn('[Bookish] uploadEntry error:', e);
    if(e && e.code==='irys-required'){
      // Queue op and nudge user to Account panel
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
  walletError='Irys client missing. Refresh page and retry.'; uiStatusManager.refresh();
  diagMaybeSet(['Irys client missing','Refresh page and retry']);
    } else if(e && e.code==='post-fund-timeout'){
      // We funded, but node hasn't credited yet. Keep the op queued and inform the user.
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
      walletError='Funding sent. Credit pending on Irys (can take a few minutes). Try again shortly from Account.'; uiStatusManager.refresh();
  diagMaybeSet(['Funding sent – awaiting credit','Retry from Account shortly']);
    } else if(e && (e.code==='base-insufficient-funds' || e.code==='base-insufficient-funds-recent')){
      // Wallet lacks L1 ETH to fund bundler; queue op and prompt manual top-up
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
      walletError='Auto-fund blocked: Base wallet low on ETH. Add a small amount and retry from Account.'; uiStatusManager.refresh();
  diagMaybeSet(['Base wallet low on ETH','Add a small amount, then retry']);
    } else {
      uiStatusManager.refresh();
      await window.bookishCache.queueOp({ type:'create', localId:rec.id, payload });
  diagMaybeSet(['Offline – queued for publish']);
    }
  }
}
async function editServerless(priorTxid,payload){ const old=entries.find(e=>e.txid===priorTxid) || entries.find(e=>e.id===priorTxid); if(!old) throw new Error('Entry not found'); const snapshot={...old}; Object.assign(old,payload); old.pending=true; old.status='pending'; old.seenRemote=false; old._committed=false; await window.bookishCache.putEntry(old); markDirty(); orderEntries(); render(); if(!old.txid){ /* local-only entry — saved to cache, no upload needed */ return; } try { const haveKeys = await ensureKeys(); if (!haveKeys) throw new Error('Cannot upload: encryption keys not available'); payload.bookId=old.bookId; diagMaybeSet(['Saving via Irys\u2026']); const res=await browserClient.uploadEntry({ ...payload },{ extraTags:[{name:'Prev',value:priorTxid}] }); const oldTxid=priorTxid; old.txid=res.txid; old.id=res.txid; old.pending=false; old.status='confirmed'; old.seenRemote=true; await window.bookishCache.replaceProvisional(oldTxid,old); walletError=null; orderEntries(); render(); uiStatusManager.refresh(); diagMaybeClear(); } catch(e){ if(e && e.code==='irys-required'){ // revert UI and prompt refresh
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    walletError='Irys client missing. Refresh page and retry.'; uiStatusManager.refresh();
  diagMaybeSet(['Irys client missing','Refresh page and retry']);
  } else if(e && e.code==='post-fund-timeout'){
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    walletError='Funding sent. Credit pending on Irys (few minutes). Retry from Account shortly.'; uiStatusManager.refresh();
  diagMaybeSet(['Funding sent – awaiting credit','Retry from Account shortly']);
  } else if(e && (e.code==='base-insufficient-funds' || e.code==='base-insufficient-funds-recent')){
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    walletError='Auto-fund blocked: Base wallet low on ETH. Top up and retry from Account.'; uiStatusManager.refresh();
  diagMaybeSet(['Base wallet low on ETH','Add a small amount, then retry']);
  } else { Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render(); walletError='Save failed'; uiStatusManager.refresh(); diagMaybeSet(['Save failed']); } } }
async function deleteServerless(priorTxid){ const entry=entries.find(e=>e.txid===priorTxid) || entries.find(e=>e.id===priorTxid); if(!entry) return; markDeletingVisual(entry); uiStatusManager.refresh(); if(!entry.txid){ /* local-only entry — just remove from cache and entries */ if(window.bookishCache) await window.bookishCache.deleteById(entry.id); entries=entries.filter(e=>e!==entry); orderEntries(); render(); uiStatusManager.refresh(); return; } try { const haveKeys = await ensureKeys(); if (!haveKeys) throw new Error('Cannot delete: encryption keys not available'); await browserClient.tombstone(priorTxid,{ note:'user delete' }); entry.status='tombstoned'; entry.tombstonedAt=Date.now(); await window.bookishCache.putEntry(entry); entries=entries.filter(e=>e.status!=='tombstoned'); walletError=null; markDirty(); orderEntries(); render(); uiStatusManager.refresh(); } catch{ entry._deleting=false; render(); walletError='Delete failed'; uiStatusManager.refresh(); } }

// --- Form handlers ---
form.addEventListener('submit',ev=>{ ev.preventDefault(); const priorTxid=form.priorTxid.value||undefined; const payload={ title:form.title.value.trim(), author:form.author.value.trim(), edition:form.edition.value.trim(), format:form.format.value, dateRead:form.dateRead.value }; if(coverPreview.dataset.b64){ payload.coverImage=coverPreview.dataset.b64; if(coverPreview.dataset.mime) payload.mimeType=coverPreview.dataset.mime; } const notesVal=(notesInput?.value||'').trim(); if(notesVal) payload.notes=notesVal; uiStatusManager.refresh(); if(priorTxid){ // immediate close, background edit
  closeModal();
  editServerless(priorTxid,payload).catch(()=> { walletError='Save failed'; uiStatusManager.refresh(); });
} else { closeModal(); createServerless(payload).catch(()=> { walletError='Save failed'; uiStatusManager.refresh(); }); }
});

deleteBtn?.addEventListener('click', async ()=>{ const txid=form.priorTxid.value; if(!txid) return; closeModal(); await deleteServerless(txid); });

// header refresh removed; app auto-syncs

newBtn?.addEventListener('click', ()=>openModal(null));

// Phase 2: First-run experience event handlers
emptyAddBookBtn?.addEventListener('click', ()=>openModal(null));

nudgeDismissBtn?.addEventListener('click', ()=>{
  hideAccountNudge();
  localStorage.setItem('bookish.accountNudgeDismissed', 'true');
  // Also suppress the other account banner so it doesn't reappear
  localStorage.setItem('bookish_account_banner_dismissed', 'true');
  const otherBanner = document.getElementById('accountBanner');
  if(otherBanner) otherBanner.style.display='none';
});

nudgeCreateAccountBtn?.addEventListener('click', ()=>{
  if(openAccountModal) openAccountModal();
});

// --- Cache layer ---
async function initCacheLayer(){
  if(!window.bookishCache) return;
  try {
    await window.bookishCache.initCache();

    // Always load cached books immediately for instant display
    entries=await window.bookishCache.getAllActive();
    entries.forEach(e=>{ e._committed=!!(e.status==='confirmed'&&e.seenRemote); });
    console.log('[Bookish] Loaded', entries.length, 'books from cache');
    orderEntries();
    render();
    uiStatusManager.refresh();

    // Initialize sync manager
    initSyncManager({
      onStatusChange: () => uiStatusManager.refresh(),
      onBookSync: syncBooksFromArweave,
      onAccountPersistence: async (isAutoTrigger) => {
        if (window.accountUI?.handlePersistAccountToArweave) {
          await window.accountUI.handlePersistAccountToArweave(isAutoTrigger);
        }
      },
      getWalletInfo: async () => {
        try {
          const address = await window.bookishWallet?.getAddress();
          if (!address) return null;
          return { address };
        } catch {
          return null;
        }
      },
      updateBalance: (balanceETH) => {
        // Delegate to account_ui if available
        if (window.accountUI?.updateBalanceDisplay) {
          window.accountUI.updateBalanceDisplay(balanceETH);
        }
      }
    });

    // Only start sync loop if user is logged in
    if (storageManager.isLoggedIn()) {
      console.log('[Bookish] User logged in, starting sync loop');
      startSync();
    } else {
      console.log('[Bookish] User not logged in, sync loop will not start');
    }
  } catch(err) {
    console.error('[Bookish] IndexedDB failed to initialize:', err);
    // Fail fast with clear error message
    walletError='Storage Error: IndexedDB unavailable'; uiStatusManager.refresh();
    diagMaybeSet([
      'IndexedDB Error - Cannot start app',
      'Try: Clear browser data, use private mode, or different browser',
      'Error: ' + (err.message || 'Internal error opening backing store')
    ]);
    // Show error in UI
    if(emptyEl) {
      emptyEl.style.display='block';
      emptyEl.innerHTML = `
        <div style="max-width:600px;margin:40px auto;padding:32px;background:#1e293b;border:2px solid #dc2626;border-radius:12px;text-align:left;">
          <h2 style="color:#dc2626;margin:0 0 16px 0;font-size:1.5rem;">⚠️ Storage Error</h2>
          <p style="font-size:1rem;line-height:1.6;margin-bottom:16px;">
            <strong>IndexedDB is unavailable.</strong> Bookish requires local storage to function.
          </p>
          <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin-bottom:24px;">
            <strong>Error:</strong> ${err.message || 'Internal error opening backing store for indexedDB.open'}
          </p>
          <div style="background:#0f172a;padding:16px;border-radius:6px;border-left:3px solid #3b82f6;margin-bottom:20px;">
            <p style="font-size:.875rem;font-weight:600;margin:0 0 12px 0;">💡 Try these solutions:</p>
            <ol style="font-size:.875rem;line-height:1.8;margin:0;padding-left:20px;opacity:.9;">
              <li><strong>Restart your browser</strong> - browser updates can corrupt IndexedDB until restart</li>
              <li><strong>Clear site data:</strong> DevTools (F12) → Application → Clear Storage → "Clear site data"</li>
              <li><strong>Try private/incognito mode</strong> to rule out browser profile corruption</li>
              <li><strong>Check disk space</strong> - IndexedDB needs available storage</li>
              <li><strong>Try a different browser</strong> (Chrome, Edge, Firefox)</li>
              <li><strong>Disable browser extensions</strong> that might block storage</li>
            </ol>
          </div>
          <button onclick="location.reload()" class="btn" style="width:100%;padding:12px;font-size:1rem;">
            🔄 Retry (Reload Page)
          </button>
        </div>
      `;
    }
    // Do NOT continue - stop app initialization
    return;
  }
}

// --- Status & sync bootstrap ---
async function loadStatus(){ const have=await ensureKeys(); if(!have){ uiStatusManager.refresh(); return; } try { const owner=await browserClient.address(); uiStatusManager.refresh(); } catch{ walletError='Key error'; uiStatusManager.refresh(); } }

// --- Init ---
window.bookishNextSyncAt = Date.now() + 60000;

// Ensure modal is closed on page load
if(modal) {
  modal.classList.remove('active');
}
// Ensure search UI is hidden on page load
if(window.bookSearch) {
  window.bookSearch.handleModalOpen(true);
}

// Initialize UI status manager
uiStatusManager.init({
  getAccountStatus,
  getSyncStatus: getSyncStatusForUI,
  getBalanceStatus
});

loadStatus(); initCacheLayer(); // sync started in initCacheLayer
// Initialize hidden EVM wallet (ensures presence once sym key exists) and show address hint
(async function initWallet(){ try { const ok = await (window.bookishWallet?.ensure?.()); const addr = await (window.bookishWallet?.getAddress?.()); if(addr){ setStatus((statusEl.textContent?statusEl.textContent+' • ':'')+'EVM '+addr.slice(0,6)+'...'); } } catch{} })();
// Initialize account UI
(async function initAccount(){ try { const { initAccountUI } = await import('./account_ui.js'); await initAccountUI(); } catch(e){ console.error('Failed to init account UI:', e); } })();
window.addEventListener('online',()=>{ uiStatusManager.refresh(); replayOps(); });

// Expose sync manager methods for account UI
window.bookishSyncManager = { getSyncStatus: getSyncStatusForUI, triggerPersistenceCheck };

// --- Geek panel wiring (superuser toggle) ---
function updateGeekPanel(){
  if(!geekBody) return;
  if(!storageManager.isLoggedIn()){
    geekBody.textContent = 'Sign in to view sync status';
    return;
  }
  const net = window.bookishNet || { reads:{ irys:0, arweave:0, errors:0 } };
  geekBody.textContent = `Irys: ${net.reads.irys||0}  Arweave: ${net.reads.arweave||0}  Err: ${net.reads.errors||0}`;
}
function openSuperuser(){
  setSuperuser(true);
  if(geekPanel) geekPanel.style.display='block';
  updateGeekPanel();
  setTimeout(()=>{ if(typeof updateBookDots==='function') updateBookDots(); }, 10);
  diagIdle=true; diagIdleSeed();
  if(diagTickTimer) clearInterval(diagTickTimer);
  diagTickTimer=setInterval(()=>{ if(diagIdle) diagIdleSeed(); else diagRender(); }, 1000);
}
function closeSuperuser(){
  setSuperuser(false);
  if(geekPanel) geekPanel.style.display='none';
  diagClear(); if(diagTickTimer){ clearInterval(diagTickTimer); diagTickTimer=null; }
  setTimeout(()=>{ if(typeof updateBookDots==='function') updateBookDots(); }, 10);
}
if(geekBtn && geekPanel && geekClose){
  geekBtn.addEventListener('click',()=>{
    if(isSuperuser()) closeSuperuser(); else openSuperuser();
  });
  geekClose.addEventListener('click',()=>{ closeSuperuser(); });
  // Restore geek panel if superuser was already on
  if(isSuperuser()) openSuperuser();
}

// --- Sync Now button (superuser-only) ---
const syncNowBtn = document.getElementById('syncNowBtn');
if (syncNowBtn) {
  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.disabled = true;
    syncNowBtn.textContent = 'Syncing\u2026';
    resetProbeBackoff(); // Clear all probe backoff counters
    try {
      await triggerSyncNow();
    } catch (e) {
      console.error('[Bookish] Sync Now error:', e);
    } finally {
      syncNowBtn.textContent = 'Sync';
      // Prevent button spam — re-enable after 2s
      setTimeout(() => { syncNowBtn.disabled = false; }, 2000);
    }
  });
}

// --- Pinch / wheel zoom (restore) ---
(function enableMobilePinch(){
  let cols=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mobile-columns')||'2',10);
  function clamp(n){ return Math.min(3, Math.max(1,n)); }
  function apply(){
    document.documentElement.style.setProperty('--mobile-columns', String(cols));
    document.documentElement.dataset.cols=String(cols);
    const scale = cols===1?1.15:(cols===2?1:0.82);
    document.documentElement.style.setProperty('--mobile-scale', scale);
  }
  let pinchStartDist=null; let startCols=cols;
  function dist(t1,t2){ const dx=t1.clientX-t2.clientX, dy=t1.clientY-t2.clientY; return Math.hypot(dx,dy); }
  window.addEventListener('touchstart',e=>{ if(e.touches.length===2){ pinchStartDist=dist(e.touches[0],e.touches[1]); startCols=cols; } });
  window.addEventListener('touchmove',e=>{ if(e.touches.length===2 && pinchStartDist){ const d=dist(e.touches[0],e.touches[1]); const scale=d/pinchStartDist; const target = scale>1? Math.round(startCols - (scale-1)*1.2): Math.round(startCols + (1-scale)*1.2); const next=clamp(target); if(next!==cols){ cols=next; apply(); } e.preventDefault(); } }, { passive:false });
  window.addEventListener('touchend',()=>{ pinchStartDist=null; });
  window.addEventListener('wheel',e=>{ if(!e.ctrlKey) return; e.preventDefault(); cols=clamp(cols + (e.deltaY>0?1:-1)); apply(); }, { passive:false });
  apply();
})();
