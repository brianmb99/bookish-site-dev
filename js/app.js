// Bookish app.js (pure serverless variant)

import { initSyncManager, startSync, stopSync, getSyncStatusForUI, triggerPersistenceCheck, markDirty } from './sync_manager.js';
import * as storageManager from './core/storage_manager.js';
import uiStatusManager from './ui_status_manager.js';
import { getAccountStatus } from './account_ui.js';
import { resizeImageToBase64 } from './core/image_utils.js';
import { BookRepository, READING_STATUS, normalizeReadingStatus } from './core/book_repository.js';

// --- Version logging (always visible in console) ---
{
  const footer = document.querySelector('footer');
  const appVer = footer ? footer.textContent.trim() : 'unknown';
  // Query SW version via MessageChannel
  if (navigator.serviceWorker?.controller) {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => console.info(`[Bookish] ${appVer} | SW ${e.data}`);
    navigator.serviceWorker.controller.postMessage('GET_VERSION', [ch.port2]);
  } else {
    console.info(`[Bookish] ${appVer} | SW not yet active`);
  }
}

// --- DOM refs ---
const statusEl = document.getElementById('status');
const cardsEl = document.getElementById('cards');
const emptyEl = document.getElementById('empty');
const shelfEmptyEl = document.getElementById('shelfEmpty');
const actionBarEl = document.querySelector('.action-bar');
const modal = document.getElementById('modal');
// Funding modal refs
const fundModal = document.getElementById('fundingModal');
const fundClose = document.getElementById('fundClose');
const fundAddrEl = document.getElementById('fundAddr');
const fundCopyBtn = document.getElementById('fundCopy');
const fundL1El = document.getElementById('fundL1');
const fundTurboEl = document.getElementById('fundTurbo');
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
// --- Optional fields (Tap to Track) ---
const optFieldsZone = document.getElementById('optionalFieldsZone');
const fieldChipsEl = document.getElementById('fieldChips');
const starRatingEl = document.getElementById('starRating');
const ratingInput = document.getElementById('ratingInput');
const ownedToggle = document.getElementById('ownedToggle');
const ownedLabel = document.getElementById('ownedLabel');
const tagsInputEl = document.getElementById('tagsInput');
const tagsPillsEl = document.getElementById('tagsPills');
const OPT_FIELDS_KEY = 'bookish_active_fields';
const OPTIONAL_FIELDS = ['notes','rating','owned','tags'];

// --- Reading status (constants imported from book_repository.js) ---
const wtrCounter = document.getElementById('wtrCounter');
const wtrOverlay = document.getElementById('wtrOverlay');
const wtrBackdrop = document.getElementById('wtrBackdrop');
const wtrDrawer = document.getElementById('wtrDrawer');
const wtrClose = document.getElementById('wtrClose');
const wtrListEl = document.getElementById('wtrList');
const wtrEmptyEl = document.getElementById('wtrEmpty');
const wtrAddBtn = document.getElementById('wtrAddBtn');
const wtrFooterAdd = document.getElementById('wtrFooterAdd');
const statusSelector = document.getElementById('statusSelector');
const readingStatusInput = document.getElementById('readingStatusInput');

function showStatusToast(msg) {
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast';
  toast.innerHTML = `<span class="toast-message">${escapeHtml(msg)}</span>`;
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, 2000);
}

const MARK_READ_UNDO_MS = 5500;

/** Toast after marking a currently-reading book as read; Undo restores prior fields via BookRepository. */
function showMarkAsReadToastWithUndo(key, snapshot) {
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast status-toast-with-action';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<span class="toast-message">Marked as read</span><button type="button" class="toast-undo-btn">Undo</button>`;
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);

  let cleared = false;
  const remove = () => {
    if (cleared) return;
    cleared = true;
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  };
  const timer = setTimeout(remove, MARK_READ_UNDO_MS);

  toast.querySelector('.toast-undo-btn')?.addEventListener('click', async () => {
    if (cleared || !bookRepo) return;
    cleared = true;
    clearTimeout(timer);
    await bookRepo.applyReadingSnapshot(key, snapshot);
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  });
}

function getActiveFields(){ try{ return JSON.parse(localStorage.getItem(OPT_FIELDS_KEY))||[]; }catch{ return []; } }
function setActiveFields(list){ localStorage.setItem(OPT_FIELDS_KEY, JSON.stringify(list)); }
function activateField(name){
  const list=getActiveFields(); if(!list.includes(name)) list.push(name); setActiveFields(list);
  showOptionalField(name, true);
}
function deactivateField(name){
  const list=getActiveFields().filter(f=>f!==name); setActiveFields(list);
  showOptionalField(name, false);
}
function showOptionalField(name, show){
  const chip=fieldChipsEl?.querySelector(`.field-chip[data-field="${name}"]`);
  const field=optFieldsZone?.querySelector(`.optional-field[data-field="${name}"]`);
  if(chip) chip.style.display=show?'none':'inline-flex';
  if(field) field.style.display=show?'block':'none';
}
function initOptionalFields(entry){
  const active=getActiveFields();
  OPTIONAL_FIELDS.forEach(name=>{
    const hasData = entry && ((name==='notes' && entry.notes) || (name==='rating' && entry.rating) || (name==='owned' && entry.owned) || (name==='tags' && entry.tags));
    showOptionalField(name, active.includes(name)||!!hasData);
  });
}
function resetOptionalFields(){
  if(ratingInput){ ratingInput.value=''; updateStarDisplay(0); }
  if(ownedToggle){ ownedToggle.checked=false; if(ownedLabel) ownedLabel.textContent='No'; }
  if(tagsInputEl){ tagsInputEl.value=''; }
  if(tagsPillsEl){ tagsPillsEl.innerHTML=''; }
}
function populateOptionalFields(entry){
  resetOptionalFields();
  if(!entry) return;
  if(entry.rating){ ratingInput.value=entry.rating; updateStarDisplay(entry.rating); }
  if(entry.owned){ ownedToggle.checked=true; if(ownedLabel) ownedLabel.textContent='Yes'; }
  if(entry.tags){
    tagsInputEl.value='';
    tagsPillsEl.innerHTML='';
    entry.tags.split(',').map(t=>t.trim()).filter(Boolean).forEach(t=>addTagPill(t));
  }
}
function getOptionalFieldValues(){
  const vals={};
  const r=parseInt(ratingInput?.value);
  if(r>=1&&r<=5) vals.rating=r;
  if(ownedToggle?.checked) vals.owned=true;
  const tags=collectTags();
  if(tags) vals.tags=tags;
  return vals;
}
function collectTags(){
  const pills=[...tagsPillsEl.querySelectorAll('.tag-pill')].map(p=>p.dataset.tag);
  const pending=(tagsInputEl?.value||'').split(',').map(t=>t.trim()).filter(Boolean);
  const all=[...new Set([...pills,...pending])];
  return all.join(', ');
}

// Star rating interaction
function updateStarDisplay(val){
  if(!starRatingEl) return;
  starRatingEl.querySelectorAll('.star').forEach(s=>{
    const v=parseInt(s.dataset.value);
    s.textContent=v<=val?'★':'☆';
    s.classList.toggle('filled',v<=val);
    s.setAttribute('aria-checked',v===val?'true':'false');
  });
}
starRatingEl?.addEventListener('click',e=>{
  const star=e.target.closest('.star');
  if(!star) return;
  const val=parseInt(star.dataset.value);
  const cur=parseInt(ratingInput.value)||0;
  const newVal=(val===cur)?0:val;
  ratingInput.value=newVal||'';
  updateStarDisplay(newVal);
  if(newVal>0) activateField('rating');
  updateDirty();
});

// Owned toggle interaction
ownedToggle?.addEventListener('change',()=>{
  if(ownedLabel) ownedLabel.textContent=ownedToggle.checked?'Yes':'No';
  if(ownedToggle.checked) activateField('owned');
  updateDirty();
});

// Tags interaction
function addTagPill(text){
  const tag=text.trim();
  if(!tag) return;
  const existing=[...tagsPillsEl.querySelectorAll('.tag-pill')].map(p=>p.dataset.tag.toLowerCase());
  if(existing.includes(tag.toLowerCase())) return;
  const pill=document.createElement('span');
  pill.className='tag-pill';
  pill.dataset.tag=tag;
  pill.innerHTML=`${escapeHtml(tag)}<button type="button" class="tag-pill-remove" aria-label="Remove tag ${escapeHtml(tag)}">&times;</button>`;
  pill.querySelector('.tag-pill-remove').addEventListener('click',()=>{ pill.remove(); updateDirty(); });
  tagsPillsEl.appendChild(pill);
}
tagsInputEl?.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===','){
    e.preventDefault();
    const parts=tagsInputEl.value.split(',').map(t=>t.trim()).filter(Boolean);
    parts.forEach(t=>addTagPill(t));
    tagsInputEl.value='';
    if(parts.length) activateField('tags');
    updateDirty();
  }
});
tagsInputEl?.addEventListener('blur',()=>{
  const parts=tagsInputEl.value.split(',').map(t=>t.trim()).filter(Boolean);
  if(parts.length){ parts.forEach(t=>addTagPill(t)); tagsInputEl.value=''; activateField('tags'); updateDirty(); }
});

// Chip click → activate field
fieldChipsEl?.addEventListener('click',e=>{
  const chip=e.target.closest('.field-chip');
  if(!chip) return;
  activateField(chip.dataset.field);
  updateDirty();
});
// Deactivate field
optFieldsZone?.addEventListener('click',e=>{
  const btn=e.target.closest('.field-deactivate');
  if(!btn) return;
  deactivateField(btn.dataset.field);
  updateDirty();
});

if(tileCoverClick && coverFileInput){ tileCoverClick.addEventListener('click',(e)=>{ if(e.target.closest('.cover-remove-btn')) return; coverFileInput.click(); }); }
if(coverRemoveBtn){ coverRemoveBtn.addEventListener('click',(e)=>{ e.stopPropagation(); clearCoverPreview(); updateDirty(); }); }

// --- Helpers ---
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function clearCoverPreview(){ coverPreview.style.display='none'; coverPlaceholder.style.display='block'; delete coverPreview.dataset.b64; delete coverPreview.dataset.mime; coverPreview.src=''; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; coverFileInput.value=''; tileCoverClick.style.removeProperty('--cover-url'); }
function showCoverLoaded(){ if(coverRemoveBtn) coverRemoveBtn.style.display='inline-flex'; }

// --- State ---
let entries=[];
let browserClient; let keyState={ loaded:false };

// Book repository — single owner of all book data operations
let bookRepo = null;

// Export reset function for logout
export function resetKeyState() {
  keyState.loaded = false;
  browserClient = null;
}
let walletError = null; // Track wallet errors for UI status manager
window.BOOKISH_DEBUG=true; function dbg(...a){ if(window.BOOKISH_DEBUG) console.debug('[Bookish]',...a); }

/**
 * Get balance status for UI status manager
 * @returns {Object} { error }
 */
function getBalanceStatus() {
  return { error: walletError };
}

// --- Utility / ordering ---
function setStatus(m){ statusEl.textContent=m; statusEl.classList.remove('warning'); if(window.BOOKISH_DEBUG) console.debug('[Bookish] status:', m); }
function orderEntries(){
  const statusOrder = { reading: 0, read: 1, want_to_read: 2 };
  entries.sort((a,b)=>{
    const sa = statusOrder[normalizeReadingStatus(a)] ?? 1;
    const sb = statusOrder[normalizeReadingStatus(b)] ?? 1;
    if(sa !== sb) return sa - sb;
    const da=a.dateRead||''; const db=b.dateRead||'';
    if(da!==db) return db.localeCompare(da);
    const ca=a.createdAt||0; const cb=b.createdAt||0;
    if(ca!==cb) return cb-ca;
    return 0;
  });
}
function formatDisplayDate(iso){ if(!iso) return ''; const d=new Date(iso+'T00:00:00Z'); if(isNaN(d)) return iso; return d.toLocaleDateString(undefined,{month:'short',year:'numeric'}); }
function mapFormat(f){ const v=(f||'').toLowerCase(); if(v==='ebook') return 'ebook'; if(v==='audiobook'||v==='audio') return 'audio'; return 'print'; }

// --- Modal helpers ---
function openModal(entry, forceIntent){
  _formSubmitting = false;
  modal.classList.add('active');
  const inner = modal.querySelector('.modal-inner');
  if(inner){ if(!entry) inner.classList.add('add-mode'); else inner.classList.remove('add-mode'); }
  const inputs=[...form.querySelectorAll('input,select,textarea')];
  inputs.forEach(i=>{ if(i.name==='priorTxid') return; i.disabled=false; });
  form.priorTxid.value=entry?(entry.txid||entry.id||''):'';
  form.title.value=entry?entry.title:'';
  form.author.value=entry?entry.author:'';
  form.format.value=entry?mapFormat(entry.format):'print';
  if(entry){
    const rs = normalizeReadingStatus(entry);
    if(rs === READING_STATUS.WANT_TO_READ){
      const ts = entry.createdAt;
      form.dateRead.value = ts ? new Date(ts).toISOString().slice(0,10) : (entry.dateRead || new Date().toISOString().slice(0,10));
    } else if(rs === READING_STATUS.READING){
      const ts = entry.readingStartedAt;
      form.dateRead.value = ts ? new Date(ts).toISOString().slice(0,10) : (entry.dateRead || new Date().toISOString().slice(0,10));
    } else {
      form.dateRead.value = entry.dateRead || new Date().toISOString().slice(0,10);
    }
  } else {
    form.dateRead.value = new Date().toISOString().slice(0,10);
  }
  if(notesInput) notesInput.value = entry?.notes || '';
  initOptionalFields(entry);
  populateOptionalFields(entry);
  if(entry&&entry.coverImage){
    const coverDataUrl='data:'+(entry.mimeType||'image/*')+';base64,'+entry.coverImage;
    coverPreview.src=coverDataUrl;
    coverPreview.style.display='block'; coverPlaceholder.style.display='none';
    coverPreview.dataset.b64=entry.coverImage; if(entry.mimeType) coverPreview.dataset.mime=entry.mimeType;
    tileCoverClick.style.setProperty('--cover-url',`url('${coverDataUrl}')`);
    showCoverLoaded();
  } else { clearCoverPreview(); }
  if(deleteBtn) deleteBtn.style.display=entry?'inline-flex':'none';
  if(cancelBtn) cancelBtn.style.display='inline-flex';

  // Reading status: unified selector for both add and edit mode
  const status = entry ? normalizeReadingStatus(entry) : (forceIntent || READING_STATUS.WANT_TO_READ);
  setReadingStatus(status);
  if(statusSelector) statusSelector.style.display='flex';

  snapshotOriginal();
  updateDirty();
  if(window.bookSearch) window.bookSearch.handleModalOpen(!!entry);
  setTimeout(()=>{ if(notesInput){ notesInput.style.height='auto'; notesInput.style.height=Math.max(60,notesInput.scrollHeight)+'px'; }}, 0);
}

function setReadingStatus(status){
  if(readingStatusInput) readingStatusInput.value = status;
  statusSelector?.querySelectorAll('.status-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  applyIntentUI(status);
}

function applyIntentUI(intent){
  const dateBlock = form.dateRead?.closest('.field-block');
  const dateLabel = dateBlock?.querySelector('label');
  const dateInput = form.dateRead;
  const isWtr = intent === READING_STATUS.WANT_TO_READ;
  const isReading = intent === READING_STATUS.READING;

  if(dateBlock){
    dateBlock.style.display = '';
    if(isWtr){
      if(dateLabel) dateLabel.textContent = 'Added';
      if(dateInput){
        const entry = form.priorTxid.value ? entries.find(e=>(e.txid||e.id)===form.priorTxid.value) : null;
        const ts = entry?.createdAt;
        dateInput.value = ts ? new Date(ts).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
        dateInput.readOnly = true;
        dateBlock.classList.add('date-readonly');
      }
    } else if(isReading){
      if(dateLabel) dateLabel.textContent = 'Started';
      if(dateInput){
        const entry = form.priorTxid.value ? entries.find(e=>(e.txid||e.id)===form.priorTxid.value) : null;
        const ts = entry?.readingStartedAt;
        if(!dateInput.value || dateInput.readOnly) dateInput.value = ts ? new Date(ts).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
        dateInput.readOnly = false;
        dateBlock.classList.remove('date-readonly');
      }
    } else {
      if(dateLabel) dateLabel.textContent = 'Completed';
      if(dateInput){
        const entry = form.priorTxid.value ? entries.find(e=>(e.txid||e.id)===form.priorTxid.value) : null;
        if(dateInput.readOnly || !dateInput.value) dateInput.value = entry?.dateRead || new Date().toISOString().slice(0,10);
        dateInput.readOnly = false;
        dateBlock.classList.remove('date-readonly');
      }
    }
  }

  const isAddMode = modal.querySelector('.modal-inner')?.classList.contains('add-mode');
  if(isAddMode){
    if(saveBtn) saveBtn.textContent = (isWtr || isReading) ? 'Add to List' : 'Add to Shelf';
  } else {
    if(saveBtn) saveBtn.textContent = 'Save';
  }
}

function closeModal(){ modal.classList.remove('active'); const inner=modal.querySelector('.modal-inner'); if(inner) inner.classList.remove('add-mode'); form.reset(); resetOptionalFields(); coverPreview.style.display='none'; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; delete form.dataset.orig; saveBtn.disabled=true; saveBtn.textContent='Save'; if(statusSelector) statusSelector.style.display='none';
  const dateBlock = form.dateRead?.closest('.field-block');
  if(dateBlock){ dateBlock.style.display=''; dateBlock.classList.remove('date-readonly'); }
  if(form.dateRead) form.dateRead.readOnly=false;
  const dateLabel = dateBlock?.querySelector('label');
  if(dateLabel) dateLabel.textContent='Completed';
  if(window.bookSearch) window.bookSearch.handleModalOpen(true); }
function clearBooks(){ if(bookRepo) bookRepo.clear(); else { entries=[]; render(); } }
window.bookishApp={ openModal, clearBooks, showCoverLoaded, clearCoverPreview, render, changeReadingStatus };
// Dirty tracking helpers
function currentFormState(){ return JSON.stringify({
  prior: form.priorTxid.value||'',
  title: form.title.value.trim(),
  author: form.author.value.trim(),
  format: form.format.value,
  dateRead: form.dateRead.value,
  readingStatus: readingStatusInput?.value||READING_STATUS.WANT_TO_READ,
  cover: coverPreview.dataset.b64||'',
  notes: (notesInput?.value||'').trim(),
  rating: ratingInput?.value||'',
  owned: ownedToggle?.checked?'1':'',
  tags: collectTags()
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
    tileCoverClick.style.setProperty('--cover-url',`url('${dataUrl}')`);
    showCoverLoaded();
  } catch(err) {
    // Fallback to original if resize fails
    const r = new FileReader(); r.onload = e => { const b64full = e.target.result; const b64 = b64full.split(',')[1]; coverPreview.src = b64full; coverPreview.style.display = 'block'; coverPlaceholder.style.display = 'none'; coverPreview.dataset.b64 = b64; coverPreview.dataset.mime = f.type || 'image/jpeg'; tileCoverClick.style.setProperty('--cover-url',`url('${b64full}')`); showCoverLoaded(); }; r.readAsDataURL(f);
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
    // Estimate current pending cost if payload present (protocol fee + Turbo storage)
    if(lastPendingOp){
      try{
        const bytes = await (browserClient?.estimateEntryBytes?.(lastPendingOp.payload) || window.bookishEstimate?.entryBytes?.(lastPendingOp.payload));
        if(bytes){
          fundCostEl.textContent = `${bytes} bytes — protocol fee $0.005 per upload`;
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
  fundDoBtn.disabled=true;
  fundMsgEl.textContent='Turbo handles funding automatically during upload. Just retry publish.';
  fundDoBtn.disabled=false;
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
  if(storageManager.isLoggedIn()) return;

  // Don't show if user has ever had an account (they know what it is)
  if(localStorage.getItem('bookish.hasHadAccount') === 'true') return;

  if(localStorage.getItem('bookish.accountNudgeDismissed')) return;

  if(entries.length < 3) return;

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

/** Build inner HTML for a single book card */
function buildCardHTML(e){
  const dateDisp=formatDisplayDate(e.dateRead);
  const notesSnippet = e.notes ? `<p class="card-notes">${escapeHtml(e.notes)}</p>` : '';
  const metaStrip = buildCardMetadata(e);
  const coverDataUrl = e.coverImage ? `data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}` : '';
  const rs = normalizeReadingStatus(e);
  const isReading = rs === READING_STATUS.READING;
  const cardKey = e.txid || e.id || '';
  const readingRow = isReading
    ? `<div class="card-reading-label"><span class="card-reading-text">◐ Reading</span><button type="button" class="card-done-check" data-done-key="${escapeHtml(cardKey)}" title="Mark as read" aria-label="Mark as read">✓</button></div>`
    : '';
  const showDate = !isReading && dateDisp;
  return `
      <div class="cover"${coverDataUrl?` style="--cover-url:url('${coverDataUrl}')"`:''}>${e.coverImage?`<img src="${coverDataUrl}">`:`<div class="generated-cover" style="background:${generatedCoverColor(e.title||'')}"><span class="generated-title">${escapeHtml(e.title||'Untitled')}</span>${e.author?`<span class="generated-author">${escapeHtml(e.author)}</span>`:''}</div>`}</div>
      <div class="meta">
        <p class="title">${e.title||'<i>Untitled</i>'}</p>
        <p class="author">${e.author||''}</p>
        ${metaStrip}
        <div class="details">${readingRow}${showDate ? `<span class="read-date">Read ${dateDisp}</span>` : ''}</div>
        ${notesSnippet}
      </div>`;
}

function buildCardMetadata(e){
  const parts=[];
  if(e.rating && e.rating>=1 && e.rating<=5){
    const filled='★'.repeat(e.rating);
    const empty='☆'.repeat(5-e.rating);
    parts.push(`<span class="card-rating" aria-label="Rated ${e.rating} out of 5">${filled}<span class="stars-empty">${empty}</span></span>`);
  }
  if(e.owned){
    parts.push('<span class="card-owned">📖 Owned</span>');
  }
  if(e.tags){
    const tagList=e.tags.split(',').map(t=>t.trim()).filter(Boolean).slice(0,3);
    if(tagList.length) parts.push('<span class="card-tags">'+tagList.map(t=>escapeHtml(t)).join(' · ')+'</span>');
  }
  if(!parts.length) return '';
  return '<div class="card-metadata">'+parts.join('<span class="meta-sep">·</span>')+'</div>';
}

/** Quick fingerprint for change detection — avoids unnecessary innerHTML rewrites */
function entryFingerprint(e){
  return (e.txid||e.id||'')+'\t'+(e.title||'')+'\t'+(e.author||'')+'\t'+(e.dateRead||'')+'\t'+(e.notes||'')+'\t'+(e.coverImage?'1':'0')+'\t'+(e.onArweave?'1':'0')+'\t'+(e._deleting?'1':'0')+'\t'+(e.format||'')+'\t'+(e.readingStatus||'')+'\t'+(e.rating||'')+'\t'+(e.owned?'1':'0')+'\t'+(e.tags||'');
}

function render(){
  const visible = entries.filter(e => e.status !== 'tombstoned');

  // Split by reading status
  const readingList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.READING);
  const readList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.READ);
  const wantList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.WANT_TO_READ);

  // Sort each list
  readingList.sort((a,b)=> (b.readingStartedAt||b.createdAt||0) - (a.readingStartedAt||a.createdAt||0));
  readList.sort((a,b)=>{ const da=a.dateRead||''; const db=b.dateRead||''; if(da!==db) return db.localeCompare(da); return (b.createdAt||0)-(a.createdAt||0); });
  wantList.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));

  // Main grid shows: reading first, then read
  const shelfEntries = [...readingList, ...readList];

  if(wtrCounter){
    if(wantList.length > 0){
      wtrCounter.innerHTML = `My Reading List <span class="wtr-count">${wantList.length}</span>`;
    } else {
      wtrCounter.textContent = 'My Reading List';
    }
  }

  // Update WTR drawer if open
  if(wtrOverlay && wtrOverlay.style.display !== 'none') renderWtrDrawer(wantList);

  if(!shelfEntries.length && !wantList.length){
    const syncStatus = getSyncStatusForUI();
    const isLoading = storageManager.isLoggedIn() && !syncStatus.initialSynced;

    const headline = emptyEl.querySelector('.empty-headline');
    const subtext = emptyEl.querySelector('.empty-subtext');
    const addBtn = emptyEl.querySelector('.empty-cta');
    const signInDiv = document.getElementById('emptySignIn');
    const illustration = emptyEl.querySelector('.empty-illustration');

    if(isLoading){
      if(headline) headline.textContent = 'Syncing your books\u2026';
      if(subtext) subtext.textContent = 'Fetching your library from the cloud.';
      if(addBtn) addBtn.style.display = 'none';
      if(signInDiv) signInDiv.style.display = 'none';
      if(illustration) illustration.textContent = '\u23F3';
    } else {
      if(headline) headline.textContent = 'Your reading journey starts here';
      if(subtext) subtext.textContent = 'Track what you read. Keep it forever. Access it anywhere.';
      if(addBtn) addBtn.style.display = '';
      if(signInDiv) signInDiv.style.display = storageManager.isLoggedIn() ? 'none' : '';
      if(illustration) illustration.textContent = '\uD83D\uDCDA';
    }

    if(cardsEl.children.length > 0) cardsEl.replaceChildren();
    emptyEl.style.display='block';
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
    if(actionBarEl) actionBarEl.style.display = 'none';
    hideAccountNudge();
    return;
  }

  if(!shelfEntries.length && wantList.length){
    if(cardsEl.children.length > 0) cardsEl.replaceChildren();
    emptyEl.style.display='none';
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'block';
    if(actionBarEl) actionBarEl.style.display = '';
    hideAccountNudge();
    return;
  }

  emptyEl.style.display='none';
  if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
  if(actionBarEl) actionBarEl.style.display = '';
  if(storageManager.isLoggedIn()) hideAccountNudge();

  // --- Keyed DOM reconciliation ---
  const existingMap = new Map();
  for(const el of [...cardsEl.children]){
    if(el.dataset && el.dataset.txid) existingMap.set(el.dataset.txid, el);
  }

  const desiredKeys = new Set();
  const orderedCards = [];

  for(const e of shelfEntries){
    const key = e.txid || e.id || '';
    desiredKeys.add(key);
    const fp = entryFingerprint(e);
    const isReading = normalizeReadingStatus(e) === READING_STATUS.READING;

    let card = existingMap.get(key);
    if(card){
      if(card.dataset._fp !== fp){
        const rawFmt=(e.format||'').toLowerCase();
        const fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
        card.className='card'+(e._deleting?' deleting':'');
        card.dataset.fmt=fmtVariant;
        card.dataset.format=rawFmt;
        if(isReading) card.dataset.reading='true'; else delete card.dataset.reading;
        card.innerHTML=buildCardHTML(e);
        card.dataset._fp=fp;
        if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
        else { card.style.pointerEvents=''; card.style.opacity=''; }
      }
    } else {
      card=document.createElement('div');
      const rawFmt=(e.format||'').toLowerCase();
      const fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
      card.className='card'+(e._deleting?' deleting':'');
      card.dataset.txid=key;
      card.dataset.fmt=fmtVariant;
      card.dataset.format=rawFmt;
      if(isReading) card.dataset.reading='true';
      card.innerHTML=buildCardHTML(e);
      card.dataset._fp=fp;
      if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
    }
    card.onclick=(ev)=>{
      if(e._deleting) return;
      const path=typeof ev.composedPath==='function'?ev.composedPath():[];
      for(const n of path){
        if(n instanceof Element && n.classList?.contains('card-done-check')) return;
      }
      openModal(e);
    };
    orderedCards.push(card);
  }

  for(const [key, el] of existingMap){
    if(!desiredKeys.has(key)) el.remove();
  }

  for(let i=0; i<orderedCards.length; i++){
    if(cardsEl.children[i] !== orderedCards[i]){
      cardsEl.insertBefore(orderedCards[i], cardsEl.children[i] || null);
    }
  }

  setTimeout(probePendingArweaveConfirmations, 0);
}

let _probeRenderScheduled = false;
function scheduleRenderAfterProbe(){
  if(_probeRenderScheduled) return;
  _probeRenderScheduled = true;
  queueMicrotask(() => { _probeRenderScheduled = false; render(); });
}

/**
 * Probe Arweave for entries uploaded but not yet confirmed (no UI; updates cache + display).
 */
function probePendingArweaveConfirmations(){
  for(const e of entries){
    if(!e.txid || e.onArweave) continue;
    probeAndUpdateEntry(e);
  }
}

/**
 * Probe backoff state — exponential backoff per entry after failures
 * Prevents spamming gateways with HEAD requests for entries not yet on Arweave
 */
const probeBackoff = new Map(); // txid → { fails: number, lastAttempt: number }
const PROBE_BASE_MS = 60000;   // 60s base backoff
const PROBE_MAX_MS  = 900000;  // 15 min max backoff

/**
 * Probe Arweave availability and update entry state
 * Uses exponential backoff per entry to avoid continuous error traffic
 */
async function probeAndUpdateEntry(entry) {
  const txid = entry.txid;
  const state = probeBackoff.get(txid);
  if (state) {
    const backoff = Math.min(PROBE_BASE_MS * Math.pow(2, state.fails), PROBE_MAX_MS);
    if (Date.now() - state.lastAttempt < backoff) {
      return;
    }
  }

  try {
    const rec = await window.bookishNet?.probeAvailability?.(txid);
    if(rec?.arweave) {
      entry.onArweave = true;
      probeBackoff.delete(txid);
      if(window.bookishCache) {
        await window.bookishCache.putEntry(entry);
      }
      scheduleRenderAfterProbe();
    } else {
      const prev = probeBackoff.get(txid) || { fails: 0, lastAttempt: 0 };
      probeBackoff.set(txid, { fails: prev.fails + 1, lastAttempt: Date.now() });
    }
  } catch(err) {
    const prev = probeBackoff.get(txid) || { fails: 0, lastAttempt: 0 };
    probeBackoff.set(txid, { fails: prev.fails + 1, lastAttempt: Date.now() });
    console.debug('[Bookish] Arweave probe failed for', txid, err);
  }
}

// --- WTR drawer logic ---
function openWtrDrawer(){
  const wantList = entries.filter(e => e.status !== 'tombstoned' && normalizeReadingStatus(e) === READING_STATUS.WANT_TO_READ);
  wantList.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
  renderWtrDrawer(wantList);
  if(wtrOverlay) wtrOverlay.style.display = 'block';
}
function closeWtrDrawer(){
  if(wtrOverlay) wtrOverlay.style.display = 'none';
}
function renderWtrDrawer(wantList){
  if(!wtrListEl) return;
  if(!wantList.length){
    wtrListEl.innerHTML = '';
    if(wtrEmptyEl) wtrEmptyEl.style.display = 'block';
    return;
  }
  if(wtrEmptyEl) wtrEmptyEl.style.display = 'none';
  wtrListEl.innerHTML = wantList.map(e => {
    const key = e.txid || e.id || '';
    const coverDataUrl = e.coverImage ? `data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}` : '';
    const coverHtml = coverDataUrl
      ? `<img src="${coverDataUrl}">`
      : `<div class="wtr-mini-cover" style="background:${generatedCoverColor(e.title||'')}"><span class="wtr-mini-title">${escapeHtml(e.title||'')}</span></div>`;
    return `<div class="wtr-item" data-key="${escapeHtml(key)}">
      <div class="wtr-item-cover">${coverHtml}</div>
      <div class="wtr-item-info">
        <div class="wtr-item-title">${escapeHtml(e.title||'Untitled')}</div>
        <div class="wtr-item-author">${escapeHtml(e.author||'')}</div>
      </div>
      <button type="button" class="wtr-start-btn" data-key="${escapeHtml(key)}">Start Reading</button>
    </div>`;
  }).join('');
}

wtrCounter?.addEventListener('click', openWtrDrawer);
wtrBackdrop?.addEventListener('click', closeWtrDrawer);
wtrClose?.addEventListener('click', closeWtrDrawer);
wtrAddBtn?.addEventListener('click', ()=>{ closeWtrDrawer(); openModal(null, READING_STATUS.WANT_TO_READ); });
wtrFooterAdd?.addEventListener('click', ()=>{ closeWtrDrawer(); openModal(null, READING_STATUS.WANT_TO_READ); });
document.getElementById('shelfEmptyBrowse')?.addEventListener('click', openWtrDrawer);

// WTR drawer event delegation: "Start Reading" + row tap
wtrListEl?.addEventListener('click', (ev)=>{
  const startBtn = ev.target.closest('.wtr-start-btn');
  if(startBtn){
    ev.stopPropagation();
    const key = startBtn.dataset.key;
    changeReadingStatus(key, READING_STATUS.READING);
    return;
  }
  const row = ev.target.closest('.wtr-item');
  if(row){
    const key = row.dataset.key;
    const entry = entries.find(e => (e.txid||e.id) === key);
    if(entry){ closeWtrDrawer(); openModal(entry); }
  }
});

// Mark as read (checkmark) on Currently Reading cards — toast with Undo
cardsEl?.addEventListener('click', (ev)=>{
  const doneBtn = ev.target.closest('.card-done-check');
  if(doneBtn){
    ev.stopPropagation();
    ev.preventDefault();
    const key = doneBtn.dataset.doneKey;
    if(!key || !bookRepo) return;
    const entry = bookRepo.getById(key);
    if(!entry || normalizeReadingStatus(entry) !== READING_STATUS.READING) return;
    const snapshot = {
      readingStatus: READING_STATUS.READING,
      dateRead: entry.dateRead || '',
      readingStartedAt: entry.readingStartedAt
    };
    bookRepo.changeStatus(key, READING_STATUS.READ).then((result) => {
      if (result) showMarkAsReadToastWithUndo(key, snapshot);
    });
  }
});

// ESC closes WTR drawer
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && wtrOverlay && wtrOverlay.style.display !== 'none'){
    closeWtrDrawer();
  }
});

// Status selector event listener
statusSelector?.addEventListener('click', (ev)=>{
  const btn = ev.target.closest('.status-option');
  if(!btn) return;
  setReadingStatus(btn.dataset.status);
  updateDirty();
});

// --- Change reading status (delegates to BookRepository) ---
async function changeReadingStatus(key, newStatus){
  if (!bookRepo) return;
  const result = await bookRepo.changeStatus(key, newStatus);
  if (result?.toastMessage) showStatusToast(result.toastMessage);
}

// --- Key handling ---
async function ensureKeys(){
  if(keyState.loaded) return true;
  let symTxt=localStorage.getItem('bookish.sym');
  // Legacy hex key prompt removed - now using credential-based seed storage
  if(!symTxt){ return false; }
  try { const sym=localStorage.getItem('bookish.sym'); if(window.createBrowserClient){ browserClient=await window.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } else if(window.bookishBrowserClient){ browserClient=await window.bookishBrowserClient.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } if(!browserClient){ setStatus('Client loading...'); return false; } keyState.loaded=true; const addr=await browserClient.address(); setStatus('EVM '+(addr?addr.slice(0,8)+'...':'ready')); return true; } catch(e){ console.error(e); setStatus('Key load error'); return false; }
}

// --- Book data operations (delegated to BookRepository) ---

async function syncBooksFromArweave() {
  if (!bookRepo) return;
  await bookRepo.sync();
  setTimeout(probePendingArweaveConfirmations, 50);
}

async function createServerless(payload) {
  if (!bookRepo) return;
  const result = await bookRepo.create(payload);
  if (result.isDuplicate) {
    uiStatusManager.refresh();
    const el = cardsEl.querySelector('[data-txid="' + (result.entry.txid || result.entry.id) + '"]');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 1500); }
    return;
  }
  if (entries.length === 1) showCelebrationToast();
  if (entries.length === 3) showAccountNudge();
}

async function editServerless(priorTxid, payload) {
  if (!bookRepo) return;
  await bookRepo.update(priorTxid, payload);
}

async function deleteServerless(priorTxid) {
  if (!bookRepo) return;
  const entry = bookRepo.getById(priorTxid);
  if (entry) markDeletingVisual(entry);
  uiStatusManager.refresh();
  await bookRepo.delete(priorTxid);
}

// --- Form handlers ---
let _formSubmitting = false;
form.addEventListener('submit',ev=>{ ev.preventDefault(); if(_formSubmitting) return; _formSubmitting=true; const priorTxid=form.priorTxid.value||undefined; const rsValue = readingStatusInput?.value || READING_STATUS.WANT_TO_READ; const dateVal = form.dateRead.value; const payload={ title:form.title.value.trim(), author:form.author.value.trim(), format:form.format.value, dateRead:'', readingStatus:rsValue }; if(rsValue === READING_STATUS.READ){ payload.dateRead = dateVal; } else if(rsValue === READING_STATUS.READING){ payload.readingStartedAt = dateVal ? new Date(dateVal+'T00:00:00').getTime() : Date.now(); } if(coverPreview.dataset.b64){ payload.coverImage=coverPreview.dataset.b64; if(coverPreview.dataset.mime) payload.mimeType=coverPreview.dataset.mime; } const notesVal=(notesInput?.value||'').trim(); if(notesVal) payload.notes=notesVal; const optVals=getOptionalFieldValues(); if(priorTxid){ payload.rating=optVals.rating||0; payload.owned=!!optVals.owned; payload.tags=optVals.tags||''; if(!notesVal) payload.notes=''; } else { if(optVals.rating) payload.rating=optVals.rating; if(optVals.owned) payload.owned=optVals.owned; if(optVals.tags) payload.tags=optVals.tags; } uiStatusManager.refresh();
  const toastMsg = rsValue === READING_STATUS.WANT_TO_READ ? 'Added to Want to Read' : rsValue === READING_STATUS.READING ? 'Added to Currently Reading' : (!priorTxid ? 'Added to Shelf' : null);
  if(priorTxid){
  closeModal();
  editServerless(priorTxid,payload).catch(()=> { walletError='Save failed'; uiStatusManager.refresh(); });
} else { closeModal(); createServerless(payload).then(()=>{ if(toastMsg) showStatusToast(toastMsg); }).catch(()=> { walletError='Save failed'; uiStatusManager.refresh(); }); }
});

deleteBtn?.addEventListener('click', async ()=>{ const txid=form.priorTxid.value; if(!txid) return; closeModal(); await deleteServerless(txid); });

// header refresh removed; app auto-syncs

newBtn?.addEventListener('click', ()=>openModal(null, READING_STATUS.WANT_TO_READ));

// Phase 2: First-run experience event handlers
emptyAddBookBtn?.addEventListener('click', ()=>openModal(null));

// Empty state sign-in link
const emptySignInBtn = document.getElementById('emptySignInBtn');
emptySignInBtn?.addEventListener('click', ()=>{
  if(window.accountUI?.handleSignIn) window.accountUI.handleSignIn();
  else if(openAccountModal) openAccountModal();
});

nudgeDismissBtn?.addEventListener('click', ()=>{
  hideAccountNudge();
  localStorage.setItem('bookish.accountNudgeDismissed', 'true');
});

nudgeCreateAccountBtn?.addEventListener('click', ()=>{
  if(openAccountModal) openAccountModal();
});

// --- Cache layer ---
async function initCacheLayer(){
  if(!window.bookishCache) return;
  try {
    await window.bookishCache.initCache();

    // Create the BookRepository — single owner of all book data operations
    bookRepo = new BookRepository({
      cache: window.bookishCache,
      ensureKeys,
      getBrowserClient: () => browserClient,
      getWalletAddress: async () => window.bookishWallet?.getAddress?.(),
      ensureWallet: async () => { if (window.bookishWallet?.ensure) await window.bookishWallet.ensure(); },
      deriveBookId: (payload) => window.bookishBrowserClient?.deriveBookId?.(payload),
      onDirty: markDirty
    });

    // Wire repository events to UI
    bookRepo.on('change', (repoEntries) => {
      entries = repoEntries;
      orderEntries();
      render();
      uiStatusManager.refresh();
      // Show account nudge when 3+ books and logged out (on load or after add)
      showAccountNudge();
    });
    bookRepo.on('error', ({ code, message, pendingOp }) => {
      if (code) { walletError = message; if (pendingOp) lastPendingOp = pendingOp; }
      else { walletError = null; }
      uiStatusManager.refresh();
    });
    bookRepo.on('progress', (items) => {
      if (items) dbg('sync progress:', items);
    });

    // Load cached books immediately for instant display
    await bookRepo.loadFromCache();
    console.log('[Bookish] Loaded', entries.length, 'books from cache');
    // Show account nudge on load if 3+ books and logged out (per FIRST_RUN_EXPERIENCE.md)
    showAccountNudge();

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
        if (window.accountUI?.updateBalanceDisplay) {
          window.accountUI.updateBalanceDisplay(balanceETH);
        }
      }
    });

    // Ensure wallet is available before any sync cycle (prevents address:undefined race)
    try {
      await import('./wallet.js');
      await window.bookishWallet?.ensure?.();
      const addr = await window.bookishWallet?.getAddress?.();
      if (addr) setStatus((statusEl.textContent ? statusEl.textContent + ' • ' : '') + 'EVM ' + addr.slice(0, 6) + '...');
    } catch (e) {
      console.warn('[Bookish] Wallet init failed (non-fatal):', e.message);
    }

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

loadStatus(); initCacheLayer(); // wallet init + sync started in initCacheLayer
// Initialize account UI
(async function initAccount(){ try { const { initAccountUI } = await import('./account_ui.js'); await initAccountUI(); } catch(e){ console.error('Failed to init account UI:', e); } })();
window.addEventListener('online',()=>{ uiStatusManager.refresh(); if(bookRepo) bookRepo.replayPending(); });

// Expose sync manager methods for account UI
window.bookishSyncManager = { getSyncStatus: getSyncStatusForUI, triggerPersistenceCheck };

window.updateBookDots = probePendingArweaveConfirmations;

// --- Notes expand overlay ---
const notesExpandBtn = document.getElementById('notesExpandBtn');
const notesOverlay = document.getElementById('notesOverlay');
const notesOverlayInput = document.getElementById('notesOverlayInput');
const notesOverlayClose = document.getElementById('notesOverlayClose');
const notesOverlayBackdrop = notesOverlay?.querySelector('.notes-overlay-backdrop');
const notesOverlayCount = document.getElementById('notesOverlayCount');

function openNotesOverlay(){
  if(!notesOverlay) return;
  notesOverlayInput.value = notesInput?.value || '';
  notesOverlay.style.display = 'flex';
  if(notesOverlayCount) notesOverlayCount.textContent = notesOverlayInput.value.length;
  setTimeout(()=> notesOverlayInput.focus(), 50);
}
function closeNotesOverlay(){
  if(!notesOverlay) return;
  if(notesInput) notesInput.value = notesOverlayInput.value;
  notesOverlay.style.display = 'none';
  autoGrowNotes();
  updateDirty();
}
notesExpandBtn?.addEventListener('click', openNotesOverlay);
notesOverlayClose?.addEventListener('click', closeNotesOverlay);
notesOverlayBackdrop?.addEventListener('click', closeNotesOverlay);
notesOverlayInput?.addEventListener('input', ()=>{
  if(notesOverlayCount) notesOverlayCount.textContent = notesOverlayInput.value.length;
});
// ESC closes notes overlay
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape' && notesOverlay && notesOverlay.style.display==='flex'){
    e.stopPropagation();
    closeNotesOverlay();
  }
}, true);

// --- Notes auto-grow ---
function autoGrowNotes(){
  if(!notesInput) return;
  notesInput.style.height = 'auto';
  notesInput.style.height = Math.max(60, notesInput.scrollHeight) + 'px';
}
notesInput?.addEventListener('input', ()=>{ autoGrowNotes(); if(notesInput.value.trim()) activateField('notes'); });
// Also auto-grow on modal open (when value is set programmatically)
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
