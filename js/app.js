// Bookish app.js (pure serverless variant)

import { initSyncManager, startSync, stopSync, getSyncStatusForUI, triggerSyncNow, markDirty } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import uiStatusManager from './ui_status_manager.js';
import { getAccountStatus } from './account_ui.js';
import { resizeImageToBase64 } from './core/image_utils.js';
import { BookRepository, READING_STATUS, normalizeReadingStatus } from './core/book_repository.js';
import { buildDisplayList, getYearList, getNearestPopulatedYear, filterBySearch } from './core/shelf_filter.js';
import { stripNoise } from './core/search_core.js';
import { pushOverlayState, popOverlayState, consumeSuppressFlag, isStandalone } from './core/overlay_history.js';
import { haptic } from './core/haptic.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';
import { attachKeyboardHandler } from './core/keyboard_viewport.js';
import { initPullToRefresh } from './core/pull_to_refresh.js';
import { getFieldPref, setFieldPref } from './core/field_prefs.js';
import * as subscription from './core/subscription.js';

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
const modal = document.getElementById('modal');
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
// Phase 2: First-run experience refs
const emptyAddBookBtn = document.getElementById('emptyAddBookBtn');
const celebrationToast = document.getElementById('celebrationToast');
const accountNudgeBanner = document.getElementById('accountNudgeBanner');
const nudgeDismissBtn = document.getElementById('nudgeDismissBtn');
const nudgeCreateAccountBtn = document.getElementById('nudgeCreateAccountBtn');
// --- Optional fields (Tap to Track) ---
const optFieldsZone = document.getElementById('optionalFieldsZone');
const addDetailWrap = document.getElementById('addDetailWrap');
const addDetailBtn = document.getElementById('addDetailBtn');
const addDetailMenu = document.getElementById('addDetailMenu');
const starRatingEl = document.getElementById('starRating');
const ratingInput = document.getElementById('ratingInput');
const ownedToggle = document.getElementById('ownedToggle');
const ownedLabel = document.getElementById('ownedLabel');
const tagsInputEl = document.getElementById('tagsInput');
const tagsPillsEl = document.getElementById('tagsPills');
const OPTIONAL_FIELDS = ['notes','rating','owned','tags'];

// --- Reading status (constants imported from book_repository.js) ---
const wtrHeaderBtn = document.getElementById('wtrHeaderBtn');
const wtrBadge = document.getElementById('wtrBadge');
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

// --- Omnibox & year navigation ---
const omniboxWrap = document.getElementById('omniboxWrap');
const omniboxInput = document.getElementById('omniboxInput');
const omniboxClear = document.getElementById('omniboxClear');
const omniboxDropdown = document.getElementById('omniboxDropdown');
const omniboxShelfSection = document.getElementById('omniboxShelfSection');
const omniboxShelfResults = document.getElementById('omniboxShelfResults');
const omniboxAddSection = document.getElementById('omniboxAddSection');
const omniboxAddResults = document.getElementById('omniboxAddResults');
const omniboxManualAdd = document.getElementById('omniboxManualAdd');
let omniboxBackdrop = null; // created dynamically
// Fixed header & mobile search takeover (#80)
const mainHeader = document.getElementById('mainHeader');
const headerSearchBtn = document.getElementById('headerSearchBtn');
const headerSearchCancel = document.getElementById('headerSearchCancel');
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
let searchTakeoverActive = false;
const yearHeader = document.getElementById('yearHeader');
const yearLabelEl = document.getElementById('yearLabel');
const spinePanel = document.getElementById('spinePanel');
const spinePanelInner = spinePanel?.querySelector('.spine-panel-inner');
const spineStrip = document.getElementById('spineStrip');
let selectedYear = null; // null = default (current year or most recent)
let searchQuery = '';
let _searchDebounce = null;
let _lastYearGroups = null; // cached for spine nav interactions
let spineOpen = false; // spine panel expanded?

function showStatusToast(msg) {
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast';
  toast.innerHTML = `<span class="toast-message">${escapeHtml(msg)}</span>`;
  toast.style.cssText = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, 2000);
}

/**
 * Dedicated subscription-success toast (#74). Longer dwell than showStatusToast
 * because a purchase completion deserves a proper acknowledgement, and a checkmark
 * icon so it reads as a confirmation rather than a status update.
 */
function showSubscriptionSuccessToast(msg) {
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast celebration-toast';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </span>
    <span class="toast-message">${escapeHtml(msg)}</span>
  `;
  toast.style.cssText = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, 4500);
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
  toast.style.cssText = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';
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

function showOptionalField(name, show, animate){
  const option=addDetailMenu?.querySelector(`.add-detail-option[data-field="${name}"]`);
  const field=optFieldsZone?.querySelector(`.optional-field[data-field="${name}"]`);
  // Chip visibility: remove inline style to let CSS flex handle layout;
  // setting 'block' would break the chip row layout (#103).
  if(option) option.style.display=show?'none':'';
  if(field){
    field.style.display=show?'block':'none';
    if(show && animate){
      field.classList.add('field-reveal');
      field.addEventListener('animationend',()=>{ field.classList.remove('field-reveal'); },{once:true});
      const focusTarget=field.querySelector('input:not([type=hidden]):not([type=checkbox]),textarea');
      if(focusTarget) setTimeout(()=>focusTarget.focus(),200);
    }
  }
  updateAddDetailButton();
}
function activateField(name){
  const field=optFieldsZone?.querySelector(`.optional-field[data-field="${name}"]`);
  if(field && field.style.display!=='none') return;
  showOptionalField(name, true, true);
  // Explicit user action: remember this choice for future books (#104).
  setFieldPref(name, true);
}
function deactivateField(name){
  showOptionalField(name, false);
  // Only update pref + toast if the preference actually changes — avoids
  // confusing "hidden by default" toast when the user dismisses a field
  // that was only shown because the book has existing data.
  const wasShownByDefault = getFieldPref(name);
  if(wasShownByDefault){
    setFieldPref(name, false);
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    showStatusToast(`${label} hidden by default. Use "+ Add detail" to show it again.`);
  }
}
function initOptionalFields(entry){
  OPTIONAL_FIELDS.forEach(name=>{
    const hasData = entry && ((name==='notes' && entry.notes) || (name==='rating' && entry.rating) || (name==='owned' && entry.owned) || (name==='tags' && entry.tags));
    // Show if the book has data OR the user has opted-in via preference (#104)
    const shouldShow = !!hasData || getFieldPref(name);
    showOptionalField(name, shouldShow);
  });
  closeAddDetailMenu();
}
function updateAddDetailButton(){
  if(!addDetailMenu||!addDetailWrap) return;
  const remaining=addDetailMenu.querySelectorAll('.add-detail-option:not([style*="display: none"])');
  addDetailWrap.style.display=remaining.length?'':'none';
}
function closeAddDetailMenu(){
  if(addDetailMenu) addDetailMenu.style.display='none';
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

// Add detail chip menu toggle (#103)
addDetailBtn?.addEventListener('click',()=>{
  if(!addDetailMenu) return;
  // Clear inline style to let CSS flex-row chips show; 'none' to hide.
  addDetailMenu.style.display=addDetailMenu.style.display==='none'?'':'none';
});
// Add detail menu option click → activate field
addDetailMenu?.addEventListener('click',e=>{
  const opt=e.target.closest('.add-detail-option');
  if(!opt) return;
  activateField(opt.dataset.field);
  closeAddDetailMenu();
  updateDirty();
});
// Close popover on outside click
document.addEventListener('click',e=>{
  if(addDetailMenu?.style.display!=='none' && !addDetailWrap?.contains(e.target)){
    closeAddDetailMenu();
  }
});
// Deactivate field
optFieldsZone?.addEventListener('click',e=>{
  const btn=e.target.closest('.field-deactivate');
  if(!btn) return;
  deactivateField(btn.dataset.field);
  updateDirty();
});

if(tileCoverClick && coverFileInput){ tileCoverClick.addEventListener('click',(e)=>{ if(e.target.closest('.cover-remove-btn,.cover-nav-arrow')) return; coverFileInput.click(); }); }
if(coverRemoveBtn){ coverRemoveBtn.addEventListener('click',(e)=>{ e.stopPropagation(); clearCoverPreview(); updateDirty(); }); }

// --- Helpers ---
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function clearCoverPreview(){ coverPreview.style.display='none'; coverPlaceholder.style.display='block'; if(coverPlaceholder) coverPlaceholder.innerHTML='<div class="placeholder-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><span>No cover</span></div>'; delete coverPreview.dataset.b64; delete coverPreview.dataset.mime; coverPreview.src=''; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; coverFileInput.value=''; tileCoverClick.style.removeProperty('--cover-url'); }
function showCoverLoaded(){ if(coverRemoveBtn) coverRemoveBtn.style.display='inline-flex'; }

// --- State ---
let entries=[];
// Book repository — single owner of all book data operations
let bookRepo = null;

// Export for any external callers that need to force-clear auth state
export function resetKeyState() {
  tarnService.logout();
}
let appError = null; // Track errors for UI status manager
window.BOOKISH_DEBUG=true; function dbg(...a){ if(window.BOOKISH_DEBUG) console.debug('[Bookish]',...a); }

/**
 * Get app error status for UI status manager
 * @returns {Object} { error }
 */
function getAppErrorStatus() {
  return { error: appError };
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
function openModalWithHero(entry, cardEl){
  const isCoarse = window.matchMedia('(pointer: coarse)').matches;
  if(!document.startViewTransition || prefersReducedMotion() || isCoarse){
    openModal(entry);
    return;
  }
  // Old state: card cover has the transition name
  setHeroCover(cardEl);
  // Suppress root crossfade during modal open to eliminate desktop flicker (#102).
  // The hero book-cover morph still runs; only the page fade is disabled.
  document.documentElement.classList.add('modal-transitioning');
  const transition = document.startViewTransition(()=>{
    // New state: move transition name to modal cover
    const cardCover = cardEl.querySelector('.cover');
    if(cardCover) cardCover.style.viewTransitionName = '';
    if(tileCoverClick) tileCoverClick.style.viewTransitionName = 'book-cover';
    openModal(entry);
  });
  const clearFlag = () => document.documentElement.classList.remove('modal-transitioning');
  transition.finished.then(clearFlag).catch(clearFlag);
}

function openModal(entry, forceIntent){
  _formSubmitting = false;
  modal.classList.add('active');
  document.body.classList.add('modal-open');
  const inner = modal.querySelector('.modal-inner');
  if(inner){ inner.classList.remove('sheet-dismissing'); }
  // Add sheet handle bar on touch devices (for bottom sheet UX)
  if(inner && window.matchMedia('(pointer: coarse)').matches && !inner.querySelector('.sheet-handle')){
    const handle = document.createElement('div');
    handle.className = 'sheet-handle';
    inner.insertBefore(handle, inner.firstChild);
    // Attach swipe-to-dismiss once the handle exists (#87)
    // Call _finalizeCloseModal directly — the swipe already animated the sheet off-screen,
    // so we skip closeModal's CSS dismiss animation to avoid a double-slide.
    resetModalSwipe = attachSwipeDismiss({ sheet: inner, handles: [handle], onDismiss: () => { _finalizeCloseModal(false); clearHeroCover(); } });
    // Attach keyboard-aware viewport handling for mobile (#93)
    detachKeyboard = attachKeyboardHandler({ sheet: inner });
  }
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
    coverPreview.dataset.b64=entry.coverImage; if(entry.mimeType) coverPreview.dataset.mime=entry.mimeType; if(entry.coverFit) coverPreview.dataset.fit=entry.coverFit;
    tileCoverClick.style.setProperty('--cover-url',`url('${coverDataUrl}')`);
    showCoverLoaded();
  } else { clearCoverPreview(); }
  if(cancelBtn) cancelBtn.style.display='inline-flex';

  // Reading status: unified selector for both add and edit mode
  const status = entry ? normalizeReadingStatus(entry) : (forceIntent || READING_STATUS.WANT_TO_READ);
  setReadingStatus(status);
  if(statusSelector) statusSelector.style.display='flex';

  snapshotOriginal();
  updateDirty();
  if(window.bookSearch) window.bookSearch.handleModalOpen(!!entry);
  if(entry && window.bookSearch?.showFindCoversBtn){
    const hasCover=!!(entry.coverImage);
    window.bookSearch.showFindCoversBtn(hasCover);
  }
  pushOverlayState('modal');
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

function _finalizeCloseModal(fromPopstate){
  if(resetModalSwipe) resetModalSwipe();
  if(detachKeyboard) detachKeyboard();
  modal.classList.remove('active');
  document.body.classList.remove('modal-open');
  const inner=modal.querySelector('.modal-inner');
  if(inner){ inner.classList.remove('add-mode'); inner.classList.remove('sheet-dismissing'); }
  form.reset(); resetOptionalFields(); coverPreview.style.display='none'; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; delete form.dataset.orig; saveBtn.disabled=true; saveBtn.textContent='Save'; if(statusSelector) statusSelector.style.display='none';
  const dateBlock = form.dateRead?.closest('.field-block');
  if(dateBlock){ dateBlock.style.display=''; dateBlock.classList.remove('date-readonly'); }
  if(form.dateRead) form.dateRead.readOnly=false;
  const dateLabel = dateBlock?.querySelector('label');
  if(dateLabel) dateLabel.textContent='Completed';
  if(window.bookSearch) window.bookSearch.handleModalOpen(true);
  if(omniboxInput && omniboxInput.value){ clearOmnibox(); }
  closeOmniboxDropdown();
  if(!fromPopstate) popOverlayState();
}
function closeModal(fromPopstate = false){
  if(!modal.classList.contains('active')) return;
  const inner = modal.querySelector('.modal-inner');
  const isCoarse = window.matchMedia('(pointer: coarse)').matches;
  if(inner && isCoarse && !inner.classList.contains('sheet-dismissing')){
    inner.classList.add('sheet-dismissing');
    inner.addEventListener('animationend', function handler(){
      inner.removeEventListener('animationend', handler);
      _finalizeCloseModal(fromPopstate);
      clearHeroCover();
    });
  } else if(!inner || !inner.classList.contains('sheet-dismissing')){
    if(_heroSourceCard && document.startViewTransition && !prefersReducedMotion()){
      // Old state: modal cover has the transition name
      if(tileCoverClick) tileCoverClick.style.viewTransitionName = 'book-cover';
      const cardEl = _heroSourceCard;
      // Suppress root crossfade during close too — keep only the hero morph (#102)
      document.documentElement.classList.add('modal-transitioning');
      const clearFlag = () => document.documentElement.classList.remove('modal-transitioning');
      document.startViewTransition(()=>{
        // New state: move transition name to card cover
        if(tileCoverClick) tileCoverClick.style.viewTransitionName = '';
        const cardCover = cardEl.querySelector('.cover');
        if(cardCover) cardCover.style.viewTransitionName = 'book-cover';
        _finalizeCloseModal(fromPopstate);
      }).finished.then(()=>{ clearFlag(); clearHeroCover(); }).catch(()=>{ clearFlag(); clearHeroCover(); });
    } else {
      _finalizeCloseModal(fromPopstate);
      clearHeroCover();
    }
  }
}
function clearBooks(){ if(bookRepo) bookRepo.clear(); else { entries=[]; render(); } }
window.bookishApp={ openModal, clearBooks, showCoverLoaded, clearCoverPreview, render, changeReadingStatus, showShelfSkeletons, clearShelfSkeletons, getActiveEntryCount: ()=>activeEntryCount(), showStatusToast };
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
    updateDirty();
  } catch(err) {
    // Fallback to original if resize fails
    const r = new FileReader(); r.onload = e => { const b64full = e.target.result; const b64 = b64full.split(',')[1]; coverPreview.src = b64full; coverPreview.style.display = 'block'; coverPlaceholder.style.display = 'none'; coverPreview.dataset.b64 = b64; coverPreview.dataset.mime = f.type || 'image/jpeg'; tileCoverClick.style.setProperty('--cover-url',`url('${b64full}')`); showCoverLoaded(); updateDirty(); }; r.readAsDataURL(f);
  }
});

const closeModalBtn = document.getElementById('closeModal');
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', closeModal);
// Close modal on backdrop click (click on overlay outside modal-inner)
modal?.addEventListener('click', (ev)=>{
  if(ev.target === modal) closeModal();
});
// Close modal on Escape key
document.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape' && modal?.classList.contains('active')) closeModal();
});

// --- Account modal logic ---
// Account UI handles all updates via account_ui.js
// Import modal functions from account_ui.js
let openAccountModal;
let closeAccountModalFn;
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
    closeAccountModalFn = accountUI.closeAccountModal;

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

// --- Popstate handler for standalone PWA back-button overlay dismissal (#81) ---
window.addEventListener('popstate', () => {
  if (!isStandalone) return;
  if (consumeSuppressFlag()) return;
  // Close topmost visible overlay (search takeover > notes > modal > account > wtr)
  if (searchTakeoverActive) {
    closeSearchTakeover(true);
  } else if (notesOverlay && notesOverlay.style.display === 'flex') {
    closeNotesOverlay(true);
  } else if (modal && modal.classList.contains('active')) {
    closeModal(true);
  } else {
    const accountModal = document.getElementById('accountModal');
    if (accountModal && accountModal.style.display === 'flex') {
      if (closeAccountModalFn) closeAccountModalFn(true);
    } else if (wtrOverlay && wtrOverlay.style.display === 'block') {
      closeWtrDrawer(true);
    }
  }
});

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
  if(tarnService.isLoggedIn()) return;

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
function buildCardHTML(e, isWtrResult){
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
  const wtrLabel = isWtrResult ? '<div class="card-wtr-label">Want to Read</div>' : '';
  const yearBadge = e._showYearBadge && e.dateRead ? `<span class="card-year-badge">${escapeHtml(e.dateRead.slice(0,4))}</span>` : '';
  return `
      <div class="cover"${coverDataUrl?` style="--cover-url:url('${coverDataUrl}')"`:''}>${e.coverImage?`<img src="${coverDataUrl}" data-fit="${e.coverFit||'contain'}">`:`<div class="generated-cover" style="background:${generatedCoverColor(e.title||'')}"><span class="generated-title">${escapeHtml(e.title||'Untitled')}</span>${e.author?`<span class="generated-author">${escapeHtml(e.author)}</span>`:''}</div>`}</div>
      <div class="meta">
        <p class="title">${e.title||'<i>Untitled</i>'}</p>
        <p class="author">${e.author||''}</p>
        ${metaStrip}
        <div class="details">${wtrLabel}${yearBadge}${readingRow}${showDate ? `<span class="read-date">Read ${dateDisp}</span>` : ''}</div>
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
  return (e.txid||e.id||'')+'\t'+(e.title||'')+'\t'+(e.author||'')+'\t'+(e.dateRead||'')+'\t'+(e.notes||'')+'\t'+(e.coverImage?'1':'0')+'\t'+(e.onArweave?'1':'0')+'\t'+(e._deleting?'1':'0')+'\t'+(e.format||'')+'\t'+(e.readingStatus||'')+'\t'+(e.rating||'')+'\t'+(e.owned?'1':'0')+'\t'+(e.tags||'')+'\t'+(e._showYearBadge?'1':'0');
}

/**
 * Animate a card out of the shelf. If `preMeasured` is supplied (with
 * top/left/width/height from a batch measurement), use those values —
 * caller has already recorded the rect before mutating the DOM.
 * Otherwise, measure here (legacy single-exit path — e.g. swipe-delete).
 */
function animateCardExit(el, preMeasured){
  if(el.classList.contains('card-exiting')) return;
  const parent = el.parentElement;
  if(!parent){ el.remove(); return; }
  let top, left, width, height;
  if(preMeasured){
    ({ top, left, width, height } = preMeasured);
  } else {
    const rect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    top = rect.top - parentRect.top;
    left = rect.left - parentRect.left;
    width = rect.width;
    height = rect.height;
  }
  el.style.position = 'absolute';
  el.style.top = top + 'px';
  el.style.left = left + 'px';
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.opacity = '';
  el.style.margin = '0';
  el.classList.add('card-exiting');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => { if(el.parentNode) el.remove(); }, 400);
}

/** Render N skeleton placeholder cards into the cards container */
function showShelfSkeletons(count = 6){
  if(!cardsEl) return;
  const html = Array(count).fill(
    `<div class="card-skeleton"><div class="skel-cover"></div><div class="skel-meta"><div class="skel-line skel-title"></div><div class="skel-line skel-author"></div><div class="skel-line skel-detail"></div></div></div>`
  ).join('');
  cardsEl.innerHTML = html;
}

function clearShelfSkeletons(){
  if(!cardsEl) return;
  const skels = cardsEl.querySelectorAll('.card-skeleton');
  for(const s of skels) s.remove();
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
  sortWtrList(wantList);

  // Main grid shows: reading first, then read
  const shelfEntries = [...readingList, ...readList];

  // Update WTR header badge
  if(wtrHeaderBtn){
    if(wantList.length > 0 || shelfEntries.length > 0){
      wtrHeaderBtn.style.display = '';
    }
    if(wtrBadge){
      if(wantList.length > 0){
        wtrBadge.textContent = wantList.length;
        wtrBadge.style.display = '';
      } else {
        wtrBadge.style.display = 'none';
      }
    }
  }

  // Update WTR drawer if open
  if(wtrOverlay && wtrOverlay.style.display !== 'none') renderWtrDrawer(wantList);

  if(!shelfEntries.length && !wantList.length){
    const syncStatus = getSyncStatusForUI();
    const isLoading = tarnService.isLoggedIn() && !syncStatus.initialSynced;

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
      showShelfSkeletons(6);
      emptyEl.style.display='none';
    } else {
      if(headline) headline.textContent = 'Your reading journey starts here';
      if(subtext) subtext.textContent = 'Track what you read. Keep it forever. Access it anywhere.';
      if(addBtn) addBtn.style.display = '';
      if(signInDiv) signInDiv.style.display = tarnService.isLoggedIn() ? 'none' : '';
      if(illustration) illustration.textContent = '\uD83D\uDCDA';
      if(cardsEl.children.length > 0) cardsEl.replaceChildren();
      emptyEl.style.display='block';
    }
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
    setOmniboxVisible(false);
    if(headerSearchBtn) headerSearchBtn.style.display = 'none';
    if(yearHeader) yearHeader.style.display = 'none';
    closeSpinePanel();
    hideAccountNudge();
    return;
  }

  if(!shelfEntries.length && wantList.length){
    if(cardsEl.children.length > 0) cardsEl.replaceChildren();
    emptyEl.style.display='none';
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'block';
    setOmniboxVisible(true);
    if(yearHeader) yearHeader.style.display = 'none';
    closeSpinePanel();
    hideAccountNudge();
    return;
  }

  emptyEl.style.display='none';
  if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
  setOmniboxVisible(true);
  if(tarnService.isLoggedIn()) hideAccountNudge();

  // --- Search filtering + year grouping via shelf_filter ---
  const { displayEntries, matchCount, isSearching, yearGroups, activeYear } = buildDisplayList({
    shelfEntries, wantList, searchQuery, selectedYear
  });
  _lastYearGroups = yearGroups;

  const yearList = getYearList(yearGroups);

  if(isSearching){
    if(yearHeader) yearHeader.style.display = 'none';
    closeSpinePanel();
  } else {
    // Year header toggle line
    if(yearHeader && activeYear){
      const count = displayEntries.length;
      const yearDisplay = activeYear === 'Undated' ? 'Undated' : activeYear;
      if(yearLabelEl) yearLabelEl.textContent = `${yearDisplay} \u00B7 ${count} book${count===1?'':'s'}`;
      yearHeader.style.display = yearList.length > 0 ? '' : 'none';

      // Render spines into the panel (even if closed, so they're ready)
      renderSpineNav(yearList, activeYear);
    } else if(yearHeader){
      yearHeader.style.display = 'none';
    }
  }

  // Add year badges during search
  if(isSearching){
    for(const e of displayEntries) e._showYearBadge = true;
  }

  // Auto-navigate away from empty year (e.g. after deleting last book)
  if(!isSearching && activeYear && displayEntries.length === 0 && yearGroups.size > 0){
    const nearest = getNearestPopulatedYear(yearGroups, activeYear);
    if(nearest){
      navigateYear(nearest);
      return;
    }
    // No populated years remain — show empty message
    cardsEl.innerHTML = `<div class="year-empty"><div class="year-empty-icon">\uD83D\uDCD6</div>No books in ${activeYear === 'Undated' ? 'Undated' : activeYear} yet</div>`;
    return;
  }

  // --- Keyed DOM reconciliation ---
  // Clear any skeleton placeholders before rendering real cards
  clearShelfSkeletons();
  // Remove non-card elements (e.g. year-empty message)
  const yearEmptyMsg = cardsEl.querySelector('.year-empty');
  if(yearEmptyMsg) yearEmptyMsg.remove();

  const existingMap = new Map();
  for(const el of [...cardsEl.children]){
    if(el.dataset && el.dataset.txid && !el.classList.contains('card-exiting')) existingMap.set(el.dataset.txid, el);
  }

  const desiredKeys = new Set();
  const orderedCards = [];

  for(const e of displayEntries){
    try{
    const key = e.txid || e.id || '';
    desiredKeys.add(key);
    const fp = entryFingerprint(e) + (e._wtrResult ? '\twtr' : '');
    const isReading = normalizeReadingStatus(e) === READING_STATUS.READING;

    const isSyncPending = tarnService.isLoggedIn() && !e.onArweave && !e._deleting;

    let card = existingMap.get(key);
    if(card){
      if(card.dataset._fp !== fp){
        const rawFmt=(e.format||'').toLowerCase();
        const fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
        card.className='card'+(e._deleting?' deleting':'')+(isSyncPending?' sync-pending':'');
        card.dataset.fmt=fmtVariant;
        card.dataset.format=rawFmt;
        if(isReading) card.dataset.reading='true'; else delete card.dataset.reading;
        card.innerHTML=buildCardHTML(e, e._wtrResult);
        card.dataset._fp=fp;
        if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
        else { card.style.pointerEvents=''; card.style.opacity=''; }
      } else {
        card.classList.toggle('sync-pending', isSyncPending);
      }
    } else {
      card=document.createElement('div');
      const rawFmt=(e.format||'').toLowerCase();
      const fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
      card.className='card'+(e._deleting?' deleting':'')+(isSyncPending?' sync-pending':'');
      card.dataset.txid=key;
      card.dataset.fmt=fmtVariant;
      card.dataset.format=rawFmt;
      if(isReading) card.dataset.reading='true';
      card.innerHTML=buildCardHTML(e, e._wtrResult);
      card.dataset._fp=fp;
      if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
    }
    card.onclick=(ev)=>{
      if(e._deleting) return;
      const path=typeof ev.composedPath==='function'?ev.composedPath():[];
      for(const n of path){
        if(n instanceof Element && n.classList?.contains('card-done-check')) return;
      }
      openModalWithHero(e, card);
    };
    orderedCards.push(card);
    }catch(err){ console.warn('[Bookish] Skipping corrupt entry', e.txid||e.id, err.message); }
  }

  // Measure rects for ALL exiting cards BEFORE any are mutated.
  // If we measure-then-mutate one card at a time, each absolute positioning
  // reflows the grid, so the next getBoundingClientRect reads a shifted
  // position — and all exiting cards end up stacked at the first few slots.
  const exiting = [];
  for(const [key, el] of existingMap){
    if(!desiredKeys.has(key)){
      const parent = el.parentElement;
      if(parent){
        const rect = el.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        exiting.push({ el, top: rect.top - parentRect.top, left: rect.left - parentRect.left, width: rect.width, height: rect.height });
      } else {
        el.remove();
      }
    }
  }
  for(const entry of exiting){
    animateCardExit(entry.el, entry);
  }

  for(let i=0; i<orderedCards.length; i++){
    if(cardsEl.children[i] !== orderedCards[i]){
      cardsEl.insertBefore(orderedCards[i], cardsEl.children[i] || null);
    }
  }

}

// --- WTR drawer logic ---
function sortWtrList(wantList) {
  const hasPositions = wantList.some(e => e.wtrPosition != null);
  if (hasPositions) {
    wantList.sort((a, b) => {
      const pa = a.wtrPosition != null ? a.wtrPosition : Infinity;
      const pb = b.wtrPosition != null ? b.wtrPosition : Infinity;
      if (pa !== pb) return pa - pb;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  } else {
    wantList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return wantList;
}

function openWtrDrawer(){
  const wantList = entries.filter(e => e.status !== 'tombstoned' && normalizeReadingStatus(e) === READING_STATUS.WANT_TO_READ);
  sortWtrList(wantList);
  renderWtrDrawer(wantList);
  if(wtrOverlay) wtrOverlay.style.display = 'block';
  document.body.classList.add('modal-open');
  pushOverlayState('wtr');
}
function closeWtrDrawer(fromPopstate = false){
  if(resetWtrSwipe) resetWtrSwipe();
  if(wtrOverlay) wtrOverlay.style.display = 'none';
  document.body.classList.remove('modal-open');
  if(!fromPopstate) popOverlayState();
}
function renderWtrDrawer(wantList){
  if(!wtrListEl) return;
  if(!wantList.length){
    wtrListEl.innerHTML = '';
    if(wtrEmptyEl) wtrEmptyEl.style.display = 'block';
    return;
  }
  if(wtrEmptyEl) wtrEmptyEl.style.display = 'none';
  const showHandle = wantList.length > 1;
  wtrListEl.innerHTML = wantList.map(e => {
    const key = e.txid || e.id || '';
    const coverDataUrl = e.coverImage ? `data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}` : '';
    const coverHtml = coverDataUrl
      ? `<img src="${coverDataUrl}">`
      : `<div class="wtr-mini-cover" style="background:${generatedCoverColor(e.title||'')}"><span class="wtr-mini-title">${escapeHtml(e.title||'')}</span></div>`;
    return `<div class="wtr-item" data-key="${escapeHtml(key)}" draggable="${showHandle}">
      <div class="wtr-item-cover">${coverHtml}</div>
      <div class="wtr-item-info">
        <div class="wtr-item-title">${escapeHtml(e.title||'Untitled')}</div>
        <div class="wtr-item-author">${escapeHtml(e.author||'')}</div>
      </div>
      <button type="button" class="wtr-start-btn" data-key="${escapeHtml(key)}">Start Reading</button>
    </div>`;
  }).join('');
}

// --- WTR drag-to-reorder ---
(function initWtrDragReorder() {
  if (!wtrListEl) return;
  let dragItem = null;
  let touchStartY = 0;
  let touchCurrentY = 0;
  let placeholder = null;
  let dragClone = null;
  let isDragging = false;
  let startedFromHandle = false;
  let longPressTimer = null;
  let longPressReady = false;

  // --- Mouse drag (uses native HTML5 drag API) ---
  wtrListEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.wtr-item');
    if (!item) { e.preventDefault(); return; }
    dragItem = item;
    item.classList.add('wtr-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });

  wtrListEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragItem) return;
    const target = getDragTarget(e.clientY);
    if (target && target !== dragItem) {
      const rect = target.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        wtrListEl.insertBefore(dragItem, target);
      } else {
        wtrListEl.insertBefore(dragItem, target.nextSibling);
      }
    }
  });

  wtrListEl.addEventListener('dragend', (e) => {
    if (dragItem) {
      dragItem.classList.remove('wtr-dragging');
      commitReorder();
      dragItem = null;
    }
  });

  // --- Touch drag (custom implementation with long-press) ---
  wtrListEl.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.wtr-item');
    if (!item || e.target.closest('.wtr-start-btn')) { startedFromHandle = false; return; }
    startedFromHandle = true;
    longPressReady = false;
    dragItem = item;
    touchStartY = e.touches[0].clientY;
    touchCurrentY = touchStartY;
    // Require 300ms hold before drag activates — allows normal scrolling
    longPressTimer = setTimeout(() => {
      longPressReady = true;
      if (dragItem) dragItem.classList.add('wtr-long-press');
    }, 300);
  }, { passive: true });

  wtrListEl.addEventListener('touchmove', (e) => {
    if (!startedFromHandle || !dragItem) return;
    touchCurrentY = e.touches[0].clientY;

    // If long-press hasn't fired yet, cancel on movement (it's a scroll)
    if (!longPressReady) {
      if (Math.abs(touchCurrentY - touchStartY) > 4) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        startedFromHandle = false;
        dragItem.classList.remove('wtr-long-press');
        dragItem = null;
      }
      return;
    }

    e.preventDefault();

    if (!isDragging) {
      if (Math.abs(touchCurrentY - touchStartY) < 8) return;
      dragItem.classList.remove('wtr-long-press');
      isDragging = true;
      const rect = dragItem.getBoundingClientRect();
      // Create placeholder
      placeholder = document.createElement('div');
      placeholder.className = 'wtr-drag-placeholder';
      placeholder.style.height = rect.height + 'px';
      dragItem.parentNode.insertBefore(placeholder, dragItem);
      // Create floating clone
      dragClone = dragItem.cloneNode(true);
      dragClone.className = 'wtr-item wtr-drag-clone';
      dragClone.style.width = rect.width + 'px';
      document.body.appendChild(dragClone);
      dragItem.classList.add('wtr-dragging');
    }

    // Position clone at touch point
    if (dragClone) {
      const rect = dragClone.getBoundingClientRect();
      dragClone.style.top = (touchCurrentY - rect.height / 2) + 'px';
      dragClone.style.left = dragItem.getBoundingClientRect().left + 'px';
    }

    // Move placeholder to drop position
    const target = getDragTarget(touchCurrentY);
    if (target && target !== dragItem && target !== placeholder) {
      const targetRect = target.getBoundingClientRect();
      const mid = targetRect.top + targetRect.height / 2;
      if (touchCurrentY < mid) {
        wtrListEl.insertBefore(placeholder, target);
      } else {
        wtrListEl.insertBefore(placeholder, target.nextSibling);
      }
    }
  }, { passive: false });

  function finishTouchDrag() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressReady = false;
    if (!isDragging || !dragItem) {
      if (dragItem) dragItem.classList.remove('wtr-long-press');
      isDragging = false;
      startedFromHandle = false;
      dragItem = null;
      return;
    }
    // Move actual item to placeholder position
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(dragItem, placeholder);
      placeholder.remove();
    }
    if (dragClone) { dragClone.remove(); dragClone = null; }
    dragItem.classList.remove('wtr-dragging');
    commitReorder();
    isDragging = false;
    startedFromHandle = false;
    placeholder = null;
    dragItem = null;
  }

  wtrListEl.addEventListener('touchend', finishTouchDrag);
  wtrListEl.addEventListener('touchcancel', finishTouchDrag);

  function getDragTarget(clientY) {
    const items = [...wtrListEl.querySelectorAll('.wtr-item:not(.wtr-dragging):not(.wtr-drag-clone)')];
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return item;
    }
    return null;
  }

  function commitReorder() {
    if (!bookRepo) return;
    const items = wtrListEl.querySelectorAll('.wtr-item');
    const keys = [];
    items.forEach(item => {
      if (item.dataset.key) keys.push(item.dataset.key);
    });
    if (keys.length > 1) { haptic(); bookRepo.reorderWtr(keys); }
  }
})();

wtrHeaderBtn?.addEventListener('click', openWtrDrawer);
wtrBackdrop?.addEventListener('click', closeWtrDrawer);
wtrClose?.addEventListener('click', closeWtrDrawer);
wtrAddBtn?.addEventListener('click', ()=>{ closeWtrDrawer(); openModal(null, READING_STATUS.WANT_TO_READ); });
wtrFooterAdd?.addEventListener('click', ()=>{ closeWtrDrawer(); openModal(null, READING_STATUS.WANT_TO_READ); });
document.getElementById('shelfEmptyBrowse')?.addEventListener('click', openWtrDrawer);

// --- Swipe-to-dismiss on bottom sheets (#87) ---
let resetWtrSwipe = null;
let resetModalSwipe = null;
let detachKeyboard = null;
if (isTouchDevice && wtrDrawer) {
  const wtrHandle = wtrDrawer.querySelector('.wtr-drawer-handle');
  const wtrHeader = wtrDrawer.querySelector('.wtr-header');
  const swipeHandles = [wtrHandle, wtrHeader].filter(Boolean);
  if (swipeHandles.length) {
    resetWtrSwipe = attachSwipeDismiss({ sheet: wtrDrawer, handles: swipeHandles, onDismiss: () => closeWtrDrawer() });
  }
}

// --- Omnibox visibility helper (#80) ---
// On desktop: show/hide the inline omnibox input normally.
// On mobile: show/hide the search icon button; omnibox itself is controlled by search takeover.
function setOmniboxVisible(visible){
  if(isTouchDevice){
    // Mobile: toggle search icon button visibility
    if(headerSearchBtn) headerSearchBtn.style.display = visible ? '' : 'none';
    // Don't touch omniboxWrap on mobile — CSS handles it via .search-takeover class
  } else {
    // Desktop: toggle omnibox input directly
    if(omniboxWrap) omniboxWrap.style.display = visible ? '' : 'none';
  }
}

// --- Subscription helpers (#74) ---

/** Non-tombstoned entry count — what counts against the free tier. */
function activeEntryCount(){
  return entries.filter(e => e.status !== 'tombstoned').length;
}

/**
 * Render the subscribe/lapsed prompt in place of add-book search results.
 * Free-at-limit → subscribe copy; lapsed → renew copy.
 */
function renderOmniboxSubscribePrompt(){
  if(!omniboxAddResults) return;
  const lapsed = subscription.isLapsed();
  const title = lapsed
    ? "Your subscription lapsed"
    : "Ready to add more?";
  const body = lapsed
    ? "Renew to keep adding books \u2014 $10/year, cancel anytime."
    : "Add unlimited books for $10/year \u2014 less than a paperback. Cancel anytime.";
  const btnLabel = lapsed ? "Renew \u2014 $10/year" : "Subscribe \u2014 $10/year";
  omniboxAddResults.innerHTML = `
    <div class="omnibox-subscribe-prompt${lapsed ? ' omnibox-lapsed-prompt' : ''}" role="status">
      <div class="omnibox-subscribe-title">${escapeHtml(title)}</div>
      <div class="omnibox-subscribe-body">${escapeHtml(body)}</div>
      <button type="button" class="omnibox-subscribe-btn" data-subscribe-action="${lapsed ? 'renew' : 'subscribe'}">${escapeHtml(btnLabel)}</button>
      <div class="omnibox-subscribe-dismiss">Or keep browsing your library</div>
    </div>
  `;
}

/** Show/hide the small "N of 5 free books" line at the top of the add section. */
function renderOmniboxCount(){
  if(!omniboxAddSection) return;
  const count = activeEntryCount();
  let el = omniboxAddSection.querySelector('.omnibox-count');
  if(!subscription.shouldShowCount(count)){
    if(el) el.remove();
    return;
  }
  if(!el){
    el = document.createElement('div');
    el.className = 'omnibox-count';
    omniboxAddSection.insertBefore(el, omniboxAddSection.firstChild);
  }
  el.textContent = `${count} of ${subscription.FREE_LIMIT} free books`;
}

/** Kick off Stripe Checkout via bookish-api. */
async function startSubscribeCheckout(){
  try {
    await subscription.startCheckout();
    // startCheckout does window.location.assign — code below unreachable on success
  } catch(err) {
    console.error('[Bookish] Checkout failed:', err?.message || err);
    showStatusToast("Couldn't start checkout. Please try again.");
  }
}

/**
 * Handle return from Stripe Checkout. Reads ?sub=success or ?sub=cancel,
 * strips the param, and on success polls status until the webhook has
 * processed, then shows a confirmation toast.
 */
async function handleStripeReturn(){
  const params = new URLSearchParams(window.location.search);
  const subParam = params.get('sub');
  if(!subParam) return;

  // Strip the query param immediately so a refresh doesn't re-trigger.
  params.delete('sub');
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
  window.history.replaceState({}, '', newUrl);

  if(subParam !== 'success') return; // 'cancel' is silent per spec

  const prev = subscription.getStatus();
  // Small initial delay to let the webhook land before the first poll.
  await new Promise(r => setTimeout(r, 500));
  const next = await subscription.waitForStatus(['subscribed']);
  if(next === 'subscribed'){
    const msg = prev === 'lapsed'
      ? 'Subscription renewed. You can add books again.'
      : "You're subscribed. Add as many books as you like.";
    // Let the shelf finish its initial render before the toast animates in,
    // so it doesn't compete with skeleton -> content layout shifts on mobile.
    requestAnimationFrame(() => {
      setTimeout(() => showSubscriptionSuccessToast(msg), 400);
    });
  }
  // If we timed out waiting for webhook, stay quiet — a subsequent render
  // will pick up the new status from the next fetch cycle.
}

// --- Omnibox event handlers ---
let _omniboxApiDebounce = null;
let _omniboxApiAbort = null;
let _omniboxApiCounter = 0;
let _omniboxSelectionMade = false;

function showOmniboxDropdown(){
  if(!omniboxDropdown) return;
  omniboxDropdown.style.display = '';
  omniboxInput?.setAttribute('aria-expanded', 'true');
  if(!omniboxBackdrop){
    omniboxBackdrop = document.createElement('div');
    omniboxBackdrop.className = 'omnibox-backdrop';
    omniboxBackdrop.addEventListener('click', closeOmniboxDropdown);
  }
  if(!omniboxBackdrop.parentNode) document.body.appendChild(omniboxBackdrop);
}

function closeOmniboxDropdown(){
  if(omniboxDropdown) omniboxDropdown.style.display = 'none';
  omniboxInput?.setAttribute('aria-expanded', 'false');
  if(omniboxBackdrop?.parentNode) omniboxBackdrop.remove();
}

function completeOmniboxSelection(){
  _omniboxSelectionMade = true;
  if(omniboxInput) omniboxInput.value = '';
  searchQuery = '';
  if(omniboxClear) omniboxClear.style.display = 'none';
  closeOmniboxDropdown();
  if(_omniboxApiAbort){ _omniboxApiAbort.abort(); _omniboxApiAbort = null; }
  if(searchTakeoverActive) closeSearchTakeover();
}

function clearOmnibox(){
  if(omniboxInput) omniboxInput.value = '';
  searchQuery = '';
  if(omniboxClear) omniboxClear.style.display = 'none';
  closeOmniboxDropdown();
  if(_omniboxApiAbort){ _omniboxApiAbort.abort(); _omniboxApiAbort = null; }
  if(omniboxShelfSection) omniboxShelfSection.style.display = 'none';
  if(omniboxAddSection) omniboxAddSection.style.display = 'none';
  if(omniboxManualAdd) omniboxManualAdd.style.display = 'none';
  render();
}

function renderOmniboxShelfResults(query){
  if(!omniboxShelfResults) return;
  const visible = entries.filter(e => e.status !== 'tombstoned');
  const allBooks = visible;
  const matches = filterBySearch(allBooks, query).slice(0, 5);
  if(!matches.length){
    if(omniboxShelfSection) omniboxShelfSection.style.display = 'none';
    return;
  }
  if(omniboxShelfSection) omniboxShelfSection.style.display = '';
  omniboxShelfResults.innerHTML = matches.map(e => {
    const key = e.txid || e.id || '';
    const coverDataUrl = e.coverImage ? `data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}` : '';
    const rs = normalizeReadingStatus(e);
    let statusLabel = '', statusClass = '';
    if(rs === READING_STATUS.READ){ statusLabel = 'Read'; statusClass = 'status-read'; }
    else if(rs === READING_STATUS.READING){ statusLabel = 'Reading'; statusClass = 'status-reading'; }
    else if(rs === READING_STATUS.WANT_TO_READ){ statusLabel = 'Want to Read'; statusClass = 'status-wtr'; }
    const coverHtml = coverDataUrl
      ? `<img src="${coverDataUrl}">`
      : `<div class="omnibox-result-mini" style="background:${generatedCoverColor(e.title||'')}">${escapeHtml((e.title||'').slice(0,20))}</div>`;
    return `<div class="omnibox-result" data-shelf-key="${escapeHtml(key)}">
      <div class="omnibox-result-cover">${coverHtml}</div>
      <div class="omnibox-result-info">
        <div class="omnibox-result-title">${escapeHtml(e.title||'Untitled')}</div>
        <div class="omnibox-result-author">${escapeHtml(e.author||'')}</div>
      </div>
      <span class="omnibox-result-status ${statusClass}">${statusLabel}</span>
    </div>`;
  }).join('');
}

function renderOmniboxApiSkeletons(){
  if(!omniboxAddResults) return;
  if(omniboxAddSection) omniboxAddSection.style.display = '';
  omniboxAddResults.innerHTML = Array(3).fill(`<div class="omnibox-skeleton">
    <div class="omnibox-skeleton-cover"></div>
    <div class="omnibox-skeleton-text"><div class="omnibox-skeleton-line"></div><div class="omnibox-skeleton-line"></div></div>
  </div>`).join('');
}

function renderOmniboxApiResults(results){
  if(!omniboxAddResults) return;
  if(!results.length){
    omniboxAddResults.innerHTML = '';
    return;
  }
  omniboxAddResults.innerHTML = results.slice(0, 8).map(r => {
    const coverHtml = r.coverUrl
      ? `<img src="${r.coverUrl}">`
      : `<div class="omnibox-result-mini" style="background:${generatedCoverColor(r.title||'')}">${escapeHtml((r.title||'').slice(0,20))}</div>`;
    const meta = [r.year, r.publisher, r.duration].filter(Boolean).join(' \u00B7 ');
    return `<div class="omnibox-result" data-add-json='${encodeURIComponent(JSON.stringify(r))}'>
      <div class="omnibox-result-cover">${coverHtml}</div>
      <div class="omnibox-result-info">
        <div class="omnibox-result-title">${escapeHtml(r.title||'')}</div>
        <div class="omnibox-result-author">${escapeHtml(r.author||'')}</div>
        ${meta ? `<div class="omnibox-result-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
      <button type="button" class="omnibox-result-add">+ Add</button>
    </div>`;
  }).join('');
}

function searchOmniboxApis(query){
  // #74: never fire external add-book searches while blocked.
  if(subscription.isAddBlocked(activeEntryCount())){
    renderOmniboxSubscribePrompt();
    return;
  }
  if(_omniboxApiAbort){ _omniboxApiAbort.abort(); _omniboxApiAbort = null; }
  const controller = new AbortController();
  _omniboxApiAbort = controller;
  const signal = controller.signal;
  const mySearch = ++_omniboxApiCounter;
  const isStale = () => mySearch !== _omniboxApiCounter || signal.aborted;
  const term = encodeURIComponent(query);
  const fields = 'key,title,author_name,cover_i,first_publish_year,isbn,subtitle';
  const olUrl = `https://openlibrary.org/search.json?q=${term}&limit=15&fields=${fields}`;
  const itUrl = `https://itunes.apple.com/search?media=audiobook&term=${term}&limit=8`;

  renderOmniboxApiSkeletons();

  let olResults = [];
  let itResults = [];
  let olDone = false;
  let itDone = false;

  function mergeAndShow(){
    if(isStale()) return;
    // Deduplicate: combine OL + iTunes, transfer OL metadata to surviving entry
    const combined = [];
    const seen = new Map();
    for(const r of [...itResults, ...olResults]){
      const cleanTitle = stripNoise(r.title || '');
      const k = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g,'') + '|' + (r.author||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      if(seen.has(k)){
        const existing = seen.get(k);
        if(r.work_key && !existing.work_key) existing.work_key = r.work_key;
        if(r.isbn && !existing.isbn) existing.isbn = r.isbn;
        continue;
      }
      const entry = {...r, title: cleanTitle};
      seen.set(k, entry);
      combined.push(entry);
    }
    renderOmniboxApiResults(combined);
  }

  fetch(olUrl, {signal}).then(r => r.json()).then(j => {
    if(isStale()) return;
    olResults = (j.docs || []).slice(0, 10).map(d => ({
      title: d.title || '',
      author: d.author_name?.[0] || '',
      year: d.first_publish_year ? String(d.first_publish_year) : '',
      coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
      publisher: '',
      duration: '',
      source: 'ol',
      work_key: d.key || '',
      isbn: (d.isbn || [])[0] || ''
    }));
    olDone = true;
    mergeAndShow();
  }).catch(e => { if(e.name !== 'AbortError'){ olDone = true; mergeAndShow(); } });

  fetch(itUrl, {signal}).then(r => r.json()).then(j => {
    if(isStale()) return;
    itResults = (j.results || []).slice(0, 6).map(i => ({
      title: stripNoise(i.collectionName || i.trackName || ''),
      author: i.artistName || '',
      year: '',
      coverUrl: i.artworkUrl100 || '',
      publisher: '',
      duration: '',
      source: 'itunes',
      artwork: i.artworkUrl100 || ''
    }));
    itDone = true;
    mergeAndShow();
  }).catch(e => { if(e.name !== 'AbortError'){ itDone = true; mergeAndShow(); } });
}

omniboxInput?.addEventListener('input', ()=>{
  // If a selection was just made and the input fires because we cleared it, suppress
  if(_omniboxSelectionMade) return;

  const q = (omniboxInput.value || '').trim();
  if(omniboxClear) omniboxClear.style.display = q ? '' : 'none';

  // Always update shelf filter for card grid
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(()=>{
    searchQuery = q;
    render();
  }, 150);

  // Dropdown: show immediately with shelf results, debounce API
  if(q.length > 0){
    showOmniboxDropdown();
    renderOmniboxShelfResults(q);
    if(omniboxAddSection) omniboxAddSection.style.display = '';

    // Subscription gate (#74): when at free limit or lapsed, replace API
    // results with a subscribe/renew prompt and hide the manual-add path.
    if(subscription.isAddBlocked(activeEntryCount())){
      if(omniboxManualAdd) omniboxManualAdd.style.display = 'none';
      if(_omniboxApiAbort){ _omniboxApiAbort.abort(); _omniboxApiAbort = null; }
      clearTimeout(_omniboxApiDebounce);
      renderOmniboxCount(); // clears count when blocked state doesn't need it
      renderOmniboxSubscribePrompt();
    } else {
      if(omniboxManualAdd) omniboxManualAdd.style.display = '';
      renderOmniboxCount();
      clearTimeout(_omniboxApiDebounce);
      _omniboxApiDebounce = setTimeout(()=> searchOmniboxApis(q), 350);
    }
  } else {
    closeOmniboxDropdown();
    if(_omniboxApiAbort){ _omniboxApiAbort.abort(); _omniboxApiAbort = null; }
  }
});

omniboxClear?.addEventListener('click', clearOmnibox);

// Clear selection guard when user explicitly re-engages with omnibox
omniboxInput?.addEventListener('mousedown', ()=>{ _omniboxSelectionMade = false; });
omniboxInput?.addEventListener('focus', ()=>{ _omniboxSelectionMade = false; });

omniboxInput?.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape'){
    ev.preventDefault();
    if(omniboxDropdown && omniboxDropdown.style.display !== 'none'){
      closeOmniboxDropdown();
    } else if(searchTakeoverActive){
      closeSearchTakeover();
    } else {
      clearOmnibox();
    }
  }
});

// Omnibox dropdown click delegation
omniboxDropdown?.addEventListener('click', (ev)=>{
  // Subscribe/Renew button inside the subscribe prompt (#74)
  const subscribeBtn = ev.target.closest('[data-subscribe-action]');
  if(subscribeBtn){
    ev.preventDefault();
    ev.stopPropagation();
    startSubscribeCheckout();
    return;
  }
  // Shelf result clicked — open edit modal
  const shelfRow = ev.target.closest('[data-shelf-key]');
  if(shelfRow){
    const key = shelfRow.dataset.shelfKey;
    const entry = entries.find(e => (e.txid||e.id) === key);
    if(entry){
      completeOmniboxSelection();
      openModal(entry);
    }
    return;
  }
  // API result clicked — open add modal with pre-filled data
  const addRow = ev.target.closest('[data-add-json]');
  if(addRow){
    try{
      const meta = JSON.parse(decodeURIComponent(addRow.dataset.addJson));
      completeOmniboxSelection();
      openModal(null, READING_STATUS.WANT_TO_READ);
      // Directly select the book via book_search module (no search dropdown)
      setTimeout(()=>{
        // Pre-fill search input so it's ready if user wants to search later
        const bsInput = document.getElementById('bookSearchInput');
        if(bsInput){
          bsInput.value = meta.title + (meta.author ? ' ' + meta.author : '');
        }
        if(meta.source === 'itunes' && window.bookSearch?.selectItunes){
          window.bookSearch.selectItunes({
            title: meta.title || '',
            author: meta.author || '',
            artwork: meta.artwork || meta.coverUrl || '',
            olWorkKeys: meta.work_key ? [meta.work_key] : []
          });
        } else if(meta.source === 'ol' && window.bookSearch?.selectWork){
          window.bookSearch.selectWork({
            title: meta.title || '',
            author: meta.author || '',
            cover_url: meta.coverUrl || '',
            key: meta.work_key || ''
          });
        } else {
          // Fallback: populate form fields directly
          if(form.title) form.title.value = meta.title || '';
          if(form.author) form.author.value = meta.author || '';
          if(meta.source === 'itunes') form.format.value = 'audio';
          form.dispatchEvent(new Event('input', {bubbles:true}));
        }
      }, 50);
    }catch(e){}
    return;
  }
});

omniboxManualAdd?.addEventListener('click', ()=>{
  const q = (omniboxInput?.value || '').trim();
  completeOmniboxSelection();
  openModal(null, READING_STATUS.WANT_TO_READ);
  // Pre-fill title with search query
  setTimeout(()=>{
    if(form.title && q) form.title.value = q;
    form.dispatchEvent(new Event('input', {bubbles:true}));
  }, 50);
});

// --- Mobile search takeover (#80) ---
function openSearchTakeover(){
  if(!mainHeader || !isTouchDevice || searchTakeoverActive) return;
  searchTakeoverActive = true;
  mainHeader.classList.add('search-takeover');
  if(omniboxWrap) omniboxWrap.style.display = '';
  pushOverlayState('search');
  // Focus input after transition
  setTimeout(()=>{
    omniboxInput?.focus();
  }, 50);
}

function closeSearchTakeover(fromPopstate){
  if(!mainHeader || !searchTakeoverActive) return;
  searchTakeoverActive = false;
  // Blur input first to close keyboard
  omniboxInput?.blur();
  mainHeader.classList.remove('search-takeover');
  // Clear and close dropdown
  clearOmnibox();
  if(!fromPopstate) popOverlayState();
}

headerSearchBtn?.addEventListener('click', ()=>{
  openSearchTakeover();
});

headerSearchCancel?.addEventListener('click', ()=>{
  closeSearchTakeover();
});

// --- View Transition helpers ---
function prefersReducedMotion(){
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function startViewTransition(callback){
  if(!document.startViewTransition || prefersReducedMotion()){
    callback();
    return;
  }
  document.startViewTransition(callback);
}

// Track the card element whose cover is animating (hero transition)
let _heroSourceCard = null;

function setHeroCover(cardEl){
  clearHeroCover();
  if(!cardEl) return;
  const coverEl = cardEl.querySelector('.cover');
  if(coverEl) coverEl.style.viewTransitionName = 'book-cover';
  _heroSourceCard = cardEl;
}

function clearHeroCover(){
  if(_heroSourceCard){
    const coverEl = _heroSourceCard.querySelector('.cover');
    if(coverEl) coverEl.style.viewTransitionName = '';
  }
  _heroSourceCard = null;
  if(tileCoverClick) tileCoverClick.style.viewTransitionName = '';
}

// --- Year navigation ---
// Year switching: no skeleton needed — entries are already in memory so render()
// executes synchronously. Loading is never perceptible. (#94 spec: "if loading is
// perceptible" qualifier applies; View Transition API handles the visual crossfade.)
function navigateYear(year){
  selectedYear = year;
  // Simple, clean transition: fade the cards container out, instantly
  // swap the content, fade back in. No per-card exit animation, no
  // DOM overlap. The existing `.card { animation: card-enter }` handles
  // the per-card appearance on fade-in.
  //
  // This replaces the previous view-transition + card-exit choreography,
  // which was visually noisy (books of two years briefly overlapped) and
  // had grid-reflow bugs. One container-level opacity transition is both
  // simpler and cleaner.
  if(cardsEl && !prefersReducedMotion()){
    cardsEl.classList.add('cards-fading');
    setTimeout(() => {
      // Clear immediately so existingMap is empty → render() treats all
      // entries as "new" and they play their card-enter animation.
      cardsEl.innerHTML = '';
      render();
      // Next frame: remove fade class so transition plays the fade-in.
      requestAnimationFrame(() => {
        cardsEl.classList.remove('cards-fading');
      });
    }, 150);
  } else {
    render();
  }
}

// --- Spine panel toggle ---
function openSpinePanel(){
  if(!spinePanel || spineOpen) return;
  spineOpen = true;
  spinePanel.classList.remove('closing');
  spinePanel.classList.add('open');
  yearHeader?.classList.add('spine-open');
  yearHeader?.setAttribute('aria-expanded', 'true');
}

function closeSpinePanel(){
  if(!spinePanel || !spineOpen) return;
  spineOpen = false;
  spinePanel.classList.add('closing');
  spinePanel.classList.remove('open');
  yearHeader?.classList.remove('spine-open');
  yearHeader?.setAttribute('aria-expanded', 'false');
  const onEnd = ()=>{ spinePanel.classList.remove('closing'); spinePanel.removeEventListener('transitionend', onEnd); };
  spinePanel.addEventListener('transitionend', onEnd);
}

function toggleSpinePanel(){
  spineOpen ? closeSpinePanel() : openSpinePanel();
}

// Year header click toggles spine panel
yearHeader?.addEventListener('click', toggleSpinePanel);
yearHeader?.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); toggleSpinePanel(); }
});

// Escape closes the spine panel
document.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape' && spineOpen){
    closeSpinePanel();
    yearHeader?.focus();
  }
});

// --- Spine navigator rendering ---
const SPINE_COLORS = 8;

/** Spine width: clamp(36px, count * 3px, 96px) */
function spineWidth(count){
  return Math.max(36, Math.min(count * 3, 96));
}

/** Deterministic hash of a year string — stable variation across renders. */
function spineHash(s){
  let h = 0;
  for(let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** For a year with N books in the spine, return:
 *  - `positions`: array of divider positions (0-100%) between sub-books
 *  - `heights`: array of top offsets (0-4px) per sub-book — varies so
 *    each "book within the year" has a slightly different height
 *
 *  All values deterministic via the year hash so renders are stable.
 *  Line count scales with book count: 1 divider ≤3 books, 2 ≤8, 3 ≤15, 4 else. */
function spineBookLayout(year, count){
  if(count <= 1) return { positions: [], heights: [0] };
  const h = spineHash(String(year));
  const dividers = count <= 3 ? 1 : count <= 8 ? 2 : count <= 15 ? 3 : 4;
  const positions = [];
  for(let i = 0; i < dividers; i++){
    const base = (100 / (dividers + 1)) * (i + 1);
    const jitter = ((h >> (i * 3)) % 11) - 5;
    positions.push(Math.max(10, Math.min(90, base + jitter)));
  }
  // One height per sub-book section (dividers + 1 sections).
  const heights = [];
  for(let i = 0; i < dividers + 1; i++){
    // Each sub-book gets 0..4px of "shortness" relative to the tallest.
    // Distribution biased toward small variation — most sub-books same.
    const v = (h >> (i * 2 + 4)) & 7; // 0-7
    heights.push(v < 3 ? 0 : v < 5 ? 1 : v < 7 ? 2 : 3);
  }
  return { positions, heights };
}

/** Paint 1-4 thin vertical divider lines inside the spine (on top of cloth
 *  texture). Returns the CSS background layers. */
function spineBookGrain(positions){
  if(positions.length === 0) return '';
  return positions.map(pos =>
    `linear-gradient(90deg, transparent ${pos}%, ` +
    `rgba(0,0,0,.45) ${pos}%, rgba(0,0,0,.45) calc(${pos}% + 1px), ` +
    `rgba(255,255,255,.06) calc(${pos}% + 1px), rgba(255,255,255,.06) calc(${pos}% + 2px), ` +
    `transparent calc(${pos}% + 2px))`
  ).join(',');
}

/** Build a clip-path polygon that carves an irregular top edge — each
 *  sub-book gets its own slight height offset, so the top of the spine
 *  reads as "books of slightly different heights butted up against each
 *  other." Bottom remains flat (books resting on the shelf). */
function spineClipPath(positions, heights){
  if(positions.length === 0 || heights.length === 0) return '';
  // Walk left-to-right across the top edge. Each sub-book section has a
  // Y offset (in px) from 0 (tallest possible) down to 3 (shortest).
  const pts = [];
  // Top-left
  pts.push(`0 ${heights[0]}px`);
  for(let i = 0; i < positions.length; i++){
    const x = positions[i];
    const curH = heights[i];
    const nextH = heights[i + 1];
    // Right edge of current sub-book at its height
    pts.push(`${x}% ${curH}px`);
    // Transition to next sub-book's height (a tiny vertical step at the divider)
    if(nextH !== curH){
      pts.push(`${x}% ${nextH}px`);
    }
  }
  // Top-right corner at last sub-book's height
  const lastH = heights[heights.length - 1];
  pts.push(`100% ${lastH}px`);
  // Bottom-right → bottom-left
  pts.push(`100% 100%`);
  pts.push(`0 100%`);
  return `polygon(${pts.join(', ')})`;
}

function renderSpineNav(yearList, activeYear){
  if(!spineStrip) return;
  spineStrip.innerHTML = '';
  let prevDecade = null;
  for(let i = 0; i < yearList.length; i++){
    const { year, count } = yearList[i];
    const isNumericYear = /^\d{4}$/.test(year);

    // Insert decade divider between decade groups
    if(isNumericYear){
      const decade = year.slice(0, 3);
      if(prevDecade !== null && decade !== prevDecade){
        const gap = document.createElement('div');
        gap.className = 'spine-decade-gap';
        gap.setAttribute('aria-hidden', 'true');
        spineStrip.appendChild(gap);
      }
      prevDecade = decade;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spine-btn';
    btn.role = 'tab';
    btn.setAttribute('aria-selected', year === activeYear ? 'true' : 'false');
    const label = year === 'Undated' ? 'Undated' : year;
    btn.setAttribute('aria-label', `${label}, ${count} book${count===1?'':'s'}`);
    btn.title = `${label} \u00B7 ${count} book${count===1?'':'s'}`;
    const colorKey = year === 'Undated' ? 'undated' : String(i % SPINE_COLORS);
    btn.dataset.spineColor = colorKey;
    btn.style.width = `${spineWidth(count)}px`;
    // Every year is the same height; variation happens inside via sub-book
    // heights (see spineClipPath). Keeps the shelf topline roughly consistent
    // while the individual books within each year differ slightly.
    btn.style.height = `68px`;
    // Compute sub-book layout: divider positions + per-sub-book heights.
    const layout = spineBookLayout(year, count);
    const grain = spineBookGrain(layout.positions);
    if(grain) btn.style.setProperty('--book-grain', grain);
    // Irregular top edge — each sub-book gets 0..3px of "shortness" so the
    // tops of the books within a year vary subtly. Skipped on the selected
    // spine so the ribbon stays anchored and the block reads as focal.
    if(year !== activeYear){
      const clip = spineClipPath(layout.positions, layout.heights);
      if(clip) btn.style.setProperty('--spine-clip', clip);
    }

    // Bookmark ribbon on selected year
    if(year === activeYear){
      const ribbon = document.createElement('span');
      ribbon.className = 'spine-ribbon';
      ribbon.setAttribute('aria-hidden', 'true');
      btn.appendChild(ribbon);
    }

    // Year text — horizontal, full four-digit year
    const txt = document.createElement('span');
    txt.className = 'spine-label';
    txt.textContent = year === 'Undated' ? '?' : year;
    btn.appendChild(txt);

    // Book count below year
    const countEl = document.createElement('span');
    countEl.className = 'spine-count';
    countEl.textContent = `${count}`;
    btn.appendChild(countEl);

    btn.tabIndex = year === activeYear ? 0 : -1;
    btn.addEventListener('click', ()=>{
      navigateYear(year);
      // Panel stays open so users can browse multiple years. Click the
      // year header (or press Escape) to close.
    });
    spineStrip.appendChild(btn);
  }

  // Scroll active spine into view (horizontal only — avoid page jump)
  const activeBtn = spineStrip.querySelector('[aria-selected="true"]');
  if(activeBtn){
    const stripRect = spineStrip.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    const btnCenter = btnRect.left + btnRect.width / 2 - stripRect.left + spineStrip.scrollLeft;
    spineStrip.scrollTo({ left: btnCenter - stripRect.width / 2, behavior: 'smooth' });
  }

  // Check overflow for fade indicators
  updateSpineFades();
  spineStrip.addEventListener('scroll', updateSpineFades, { passive: true });
}

function updateSpineFades(){
  if(!spinePanelInner || !spineStrip) return;
  const { scrollLeft, scrollWidth, clientWidth } = spineStrip;
  const overflows = scrollWidth > clientWidth + 1;
  spineStrip.classList.toggle('overflow-scroll', overflows);
  spinePanelInner.classList.toggle('fade-left', overflows && scrollLeft > 2);
  spinePanelInner.classList.toggle('fade-right', overflows && scrollLeft + clientWidth < scrollWidth - 2);
}

// Keyboard navigation within spine strip (arrow keys)
spineStrip?.addEventListener('keydown', (ev)=>{
  if(ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  const spines = [...spineStrip.querySelectorAll('.spine-btn')];
  const current = spines.findIndex(b => b.getAttribute('aria-selected') === 'true');
  let next = current;
  if(ev.key === 'ArrowLeft' && current > 0) next = current - 1;
  if(ev.key === 'ArrowRight' && current < spines.length - 1) next = current + 1;
  if(next !== current){
    spines[next].focus();
    navigateYear(getYearList(_lastYearGroups)[next]?.year);
  }
});


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
  haptic();
  setReadingStatus(btn.dataset.status);
  updateDirty();
});

// --- Change reading status (delegates to BookRepository) ---
async function changeReadingStatus(key, newStatus){
  if (!bookRepo) return;
  const result = await bookRepo.changeStatus(key, newStatus);
  if (result?.toastMessage) showStatusToast(result.toastMessage);
}

// --- Auth check ---
function isAuthenticated() {
  return tarnService.isLoggedIn();
}

// --- Book data operations (delegated to BookRepository) ---

async function syncBooksFromTarn() {
  if (!bookRepo) return;
  await bookRepo.sync();
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
  if (entries.length === 1) { showCelebrationToast(); }
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
form.addEventListener('submit',ev=>{ ev.preventDefault(); if(_formSubmitting) return; _formSubmitting=true; const priorTxid=form.priorTxid.value||undefined; const rsValue = readingStatusInput?.value || READING_STATUS.WANT_TO_READ; const dateVal = form.dateRead.value; const payload={ title:form.title.value.trim(), author:form.author.value.trim(), format:form.format.value, dateRead:'', readingStatus:rsValue }; if(rsValue === READING_STATUS.READ){ payload.dateRead = dateVal; } else if(rsValue === READING_STATUS.READING){ payload.readingStartedAt = dateVal ? new Date(dateVal+'T00:00:00').getTime() : Date.now(); } if(coverPreview.dataset.b64){ payload.coverImage=coverPreview.dataset.b64; if(coverPreview.dataset.mime) payload.mimeType=coverPreview.dataset.mime; if(coverPreview.dataset.fit) payload.coverFit=coverPreview.dataset.fit; } else if(priorTxid){ payload.coverImage=''; payload.mimeType=''; } const notesVal=(notesInput?.value||'').trim(); if(notesVal) payload.notes=notesVal; const optVals=getOptionalFieldValues(); if(priorTxid){ payload.rating=optVals.rating||0; payload.owned=!!optVals.owned; payload.tags=optVals.tags||''; if(!notesVal) payload.notes=''; } else { if(optVals.rating) payload.rating=optVals.rating; if(optVals.owned) payload.owned=optVals.owned; if(optVals.tags) payload.tags=optVals.tags; }
  // Friend-matching identifiers: capture from search state for new books only.
  // Edits leave the existing work_key/isbn13 untouched (book_repository.update merges).
  if(!priorTxid && window.bookSearch?.getSearchMeta){
    try{
      const meta=window.bookSearch.getSearchMeta()||{};
      if(meta.work_key) payload.work_key=meta.work_key;
      if(meta.isbn13) payload.isbn13=meta.isbn13;
    }catch(err){ /* non-fatal: friend-matching is optional */ }
  }
  uiStatusManager.refresh();
  const toastMsg = rsValue === READING_STATUS.WANT_TO_READ ? 'Added to Want to Read' : rsValue === READING_STATUS.READING ? 'Added to Currently Reading' : (!priorTxid ? 'Added to Shelf' : null);
  haptic();
  if(priorTxid){
  closeModal();
  editServerless(priorTxid,payload).catch(()=> { appError='Couldn\u2019t save to cloud. Your book is safe locally.'; uiStatusManager.refresh(); });
} else { closeModal(); createServerless(payload).then(()=>{ if(toastMsg) showStatusToast(toastMsg); }).catch(()=> { appError='Couldn\u2019t save to cloud. Your book is safe locally.'; uiStatusManager.refresh(); }); }
});

deleteBtn?.addEventListener('click', async ()=>{ const txid=form.priorTxid.value; if(!txid) return; haptic(); closeModal(); await deleteServerless(txid); });

// header refresh removed; app auto-syncs

// newBtn removed (omnibox replaces "+ Add a Book")

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

    // Restore Tarn session from localStorage
    const sessionRestored = await tarnService.init();
    if (sessionRestored) {
      console.log('[Bookish] Tarn session restored');
      setStatus('Signed in');
    }

    // Create the BookRepository — single owner of all book data operations
    bookRepo = new BookRepository({
      cache: window.bookishCache,
      tarnService,
      onDirty: markDirty,
    });

    // Wire repository events to UI
    bookRepo.on('change', (repoEntries) => {
      entries = repoEntries;
      orderEntries();
      render();
      uiStatusManager.refresh();
      showAccountNudge();
    });
    bookRepo.on('error', ({ code, message }) => {
      if (code) { appError = message; }
      else { appError = null; }
      uiStatusManager.refresh();
    });
    bookRepo.on('progress', (items) => {
      if (items) dbg('sync progress:', items);
    });

    // Load cached books immediately for instant display
    await bookRepo.loadFromCache();
    console.log('[Bookish] Loaded', entries.length, 'books from cache');
    showAccountNudge();

    // Initialize sync manager
    initSyncManager({
      onStatusChange: () => uiStatusManager.refresh(),
      onBookSync: syncBooksFromTarn,
    });

    // Only start sync loop if user is logged in
    if (tarnService.isLoggedIn()) {
      console.log('[Bookish] User logged in, starting sync loop');
      startSync();
      // Fetch subscription status for free/subscribed/lapsed gating (#74).
      // Fire-and-forget; omnibox UI reads whatever's cached at interaction time.
      subscription.fetchStatus().catch(err =>
        console.warn('[Bookish] Subscription status fetch failed:', err?.message || err)
      );
      // Handle return from Stripe Checkout (?sub=success / ?sub=cancel).
      handleStripeReturn();
    } else {
      console.log('[Bookish] User not logged in, sync loop will not start');
    }
  } catch(err) {
    console.error('[Bookish] IndexedDB failed to initialize:', err);
    // Fail fast with clear error message
    appError='Local storage unavailable. Your published books are safe.'; uiStatusManager.refresh();
    // Show error in UI
    if(emptyEl) {
      emptyEl.style.display='block';
      emptyEl.innerHTML = `
        <div style="max-width:600px;margin:40px auto;padding:32px;background:#1e293b;border:2px solid #dc2626;border-radius:12px;text-align:left;">
          <h2 style="color:#dc2626;margin:0 0 16px 0;font-size:1.5rem;">⚠️ Local Storage Error</h2>
          <p style="font-size:1rem;line-height:1.6;margin-bottom:8px;">
            <strong>Local storage is unavailable.</strong> Bookish requires it to function.
          </p>
          <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin-bottom:16px;">
            If you have a Bookish account, your published books are safe — they're stored permanently and will re-sync when this is fixed.
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

// --- Status bootstrap ---
function loadStatus() {
  uiStatusManager.refresh();
}

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
  getAppErrorStatus
});

loadStatus(); initCacheLayer(); // wallet init + sync started in initCacheLayer
// Initialize account UI
(async function initAccount(){ try { const { initAccountUI } = await import('./account_ui.js'); await initAccountUI(); } catch(e){ console.error('Failed to init account UI:', e); } })();
window.addEventListener('online',()=>{ uiStatusManager.refresh(); if(bookRepo) bookRepo.replayPending(); });

// Expose sync manager methods for account UI and release tests (triggerSyncNow)
window.bookishSyncManager = { getSyncStatus: getSyncStatusForUI, triggerSyncNow };

window.updateBookDots = () => render();

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
  document.body.classList.add('modal-open');
  if(notesOverlayCount) notesOverlayCount.textContent = notesOverlayInput.value.length;
  pushOverlayState('notes');
  setTimeout(()=> notesOverlayInput.focus(), 50);
}
function closeNotesOverlay(fromPopstate = false){
  if(!notesOverlay) return;
  if(notesInput) notesInput.value = notesOverlayInput.value;
  notesOverlay.style.display = 'none';
  document.body.classList.remove('modal-open');
  autoGrowNotes();
  updateDirty();
  if(!fromPopstate) popOverlayState();
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

// --- Pull-to-refresh (standalone PWA only, #90) ---
if (isStandalone && isTouchDevice) {
  const appEl = document.getElementById('app');
  if (appEl) {
    initPullToRefresh({
      container: appEl,
      onRefresh: () => triggerSyncNow(),
      isOverlayOpen: () =>
        document.body.classList.contains('modal-open') ||
        searchTakeoverActive ||
        (notesOverlay && notesOverlay.style.display === 'flex') ||
        (wtrOverlay && wtrOverlay.style.display === 'block'),
    });
  }
}
