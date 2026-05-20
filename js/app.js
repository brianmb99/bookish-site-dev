// Bookish app.js (pure serverless variant)

import { initSyncManager, startSync, stopSync, getSyncStatusForUI, triggerSyncNow, markDirty } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import uiStatusManager from './ui_status_manager.js';
import { getAccountStatus } from './account_ui.js';
import { resizeImageToBase64 } from './core/image_utils.js';
import { BookRepository, READING_STATUS, normalizeReadingStatus } from './core/book_repository.js';
import { buildDisplayList, getYearList, getNearestPopulatedYear } from './core/shelf_filter.js';
import { deriveBookId, dateStringToMsNoonUtc, msToDateInputUtc, formatDateReadDisplay, formatMonthYearDisplay } from './core/id_core.js';
import { pushOverlayState, popOverlayState, consumeSuppressFlag, isStandalone } from './core/overlay_history.js';
import { haptic } from './core/haptic.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';
import { attachKeyboardHandler } from './core/keyboard_viewport.js';
import { initPullToRefresh } from './core/pull_to_refresh.js';
import { initPwaUpdateManager } from './core/pwa_update.js';
import { getFieldPref, setFieldPref } from './core/field_prefs.js';
import * as subscription from './core/subscription.js';
import * as friendsRouter from './core/friends_router.js';
import * as accountKeyReminder from './core/account_key_reminder.js';
import { debugLog } from './core/debug_log.js';
import { wireFriendGlyphTrigger, refreshFriendGlyphTrigger } from './components/friend_glyph_trigger.js';
import { buildCardHTML as sharedBuildCardHTML, buildCardDetails as sharedBuildCardDetails, generatedCoverColor as sharedGeneratedCoverColor, escapeHtml as sharedEscapeHtml } from './components/book_card.js';
import { renderPipOverlay } from './components/friend_pip.js';
import { getMatchingFriendBookEntries as friendsGetMatchingFriendBookEntries, primeFriendLibraryCache as friendsPrimeFriendLibraryCache, invalidateFriendLibraryCache as friendsInvalidateLibraryCache } from './core/friends.js';
import { openFriendBookDetail } from './components/friend_book_detail.js';
import { setStatusLine, showMarkAsReadUndoToast, showStatusToast, showSubscriptionSuccessToast, showUpdateReadyToast } from './components/status_helpers.js';
import { createWtrDrawerController, sortWtrList } from './components/wtr_drawer.js';
import { activeEntryCount as countActiveEntries, createOmniboxController } from './components/omnibox_controller.js';

// Friends invite-link routing (#118). Capture the invite parameters from
// /invite/:token_id#:payload_key BEFORE anything else touches window.location
// so a reload after signup doesn't lose the link. Stashes in sessionStorage;
// the accept-invite modal is opened after auth completes.
friendsRouter.captureInviteFromUrl();

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

const pwaUpdateManager = initPwaUpdateManager({
  onUpdateReady: ({ refresh }) => showUpdateReadyToast({ onRefresh: refresh }),
});
window.bookishPwaUpdate = pwaUpdateManager;

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
const deleteBtn = document.getElementById('deleteBtn');
const cancelBtn = document.getElementById('cancelBtn');
// Phase 2: First-run experience refs
// #149: emptyAddBookBtn removed — manual-add lives in the omnibox dropdown.
const celebrationToast = document.getElementById('celebrationToast');
const accountNudgeBanner = document.getElementById('accountNudgeBanner');
const nudgeDismissBtn = document.getElementById('nudgeDismissBtn');
const nudgeCreateAccountBtn = document.getElementById('nudgeCreateAccountBtn');
// --- Optional fields (Tap to Track) ---
const optFieldsZone = document.getElementById('optionalFieldsZone');
const optionalChipsEl = document.getElementById('optionalChips');
const starRatingEl = document.getElementById('starRating');
const ratingInput = document.getElementById('ratingInput');
const ownedToggle = document.getElementById('ownedToggle');
const ownedLabel = document.getElementById('ownedLabel');
const tagsInputEl = document.getElementById('tagsInput');
const tagsPillsEl = document.getElementById('tagsPills');
const placardTitle = document.getElementById('placardTitle');
const placardAuthor = document.getElementById('placardAuthor');
// Use explicit form element lookups for title/author. `form.title` collides
// with the native HTMLElement `title` property in some browser engines.
const titleInput = form?.elements?.namedItem('title') || placardTitle;
const authorInput = form?.elements?.namedItem('author') || placardAuthor;
// Per-book privacy (#129 / FRIENDS.md Surface 7) — three surfaces share one
// `is_private` boolean: an add-form checkbox, an edit-mode lock toggle, and a
// hidden input that carries the current value into the form-submit payload.
const privacyAddCheckbox = document.getElementById('privacyAddCheckbox');
const privacyAddRow = document.getElementById('privacyAddRow');
const privacyToggleBtn = document.getElementById('privacyToggleBtn');
const privacyToggleLabel = document.getElementById('privacyToggleLabel');
const isPrivateInput = document.getElementById('isPrivateInput');
const summaryRowEl = document.getElementById('summaryRow');
const statusMicrocopyEl = document.getElementById('statusMicrocopy');
const autosaveMicrocopyEl = document.getElementById('autosaveMicrocopy');
const addBookCommitBtn = document.getElementById('addBookCommitBtn');
const dateReadLabelEl = document.getElementById('dateReadLabel');
const formatRow = document.querySelector('.detail-row[data-field="format"]');
const dateRow = document.querySelector('.detail-row[data-field="dateRead"]');
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
// Fixed header & mobile search takeover (#80)
const mainHeader = document.getElementById('mainHeader');
const headerSearchBtn = document.getElementById('headerSearchBtn');
const headerSearchCancel = document.getElementById('headerSearchCancel');
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
const yearHeader = document.getElementById('yearHeader');
const yearLabelEl = document.getElementById('yearLabel');
const spinePanel = document.getElementById('spinePanel');
const spinePanelInner = spinePanel?.querySelector('.spine-panel-inner');
const spineStrip = document.getElementById('spineStrip');
let selectedYear = null; // null = default (current year or most recent)
let searchQuery = '';
let _lastYearGroups = null; // cached for spine nav interactions
let spineOpen = false; // spine panel expanded?

/** Toast after marking a currently-reading book as read; Undo restores prior fields via BookRepository. */
function showMarkAsReadToastWithUndo(key, snapshot) {
  return showMarkAsReadUndoToast({
    canUndo: () => Boolean(bookRepo),
    onUndo: () => bookRepo.applyReadingSnapshot(key, snapshot),
  });
}

function showOptionalField(name, show, animate){
  // Hide chip when expanded; show chip when collapsed (#114 inline chips).
  // Status-based hiding (e.g. rating on WTR) is layered on top via _applyStatusFieldVisibility.
  const chip=optionalChipsEl?.querySelector(`.optional-chip[data-field="${name}"]`);
  const field=optFieldsZone?.querySelector(`.optional-field[data-field="${name}"]`);
  if(chip){
    if(show) chip.dataset.hidden='true'; else delete chip.dataset.hidden;
  }
  if(field){
    field.style.display=show?'block':'none';
    if(show && animate){
      field.classList.add('field-reveal');
      field.addEventListener('animationend',()=>{ field.classList.remove('field-reveal'); },{once:true});
      const focusTarget=field.querySelector('input:not([type=hidden]):not([type=checkbox]),textarea');
      if(focusTarget) setTimeout(()=>focusTarget.focus(),200);
    }
  }
  _applyStatusFieldVisibility();
}
function activateField(name){
  const field=optFieldsZone?.querySelector(`.optional-field[data-field="${name}"]`);
  if(field && field.style.display!=='none') return;
  showOptionalField(name, true, true);
  // Explicit user action: remember this choice for future books (#104).
  setFieldPref(name, true);
}
function deactivateField(name, opts = {}){
  showOptionalField(name, false);
  // Only update pref + toast if the preference actually changes — avoids
  // confusing "hidden by default" toast when the user dismisses a field
  // that was only shown because the book has existing data.
  const wasShownByDefault = getFieldPref(name);
  if(wasShownByDefault){
    setFieldPref(name, false);
    if(!opts.silent){
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      showStatusToast(`${label} hidden by default. Use the detail chips to show it again.`);
    }
  }
}
function clearOptionalFieldValue(name){
  if(name === 'rating'){
    if(ratingInput) ratingInput.value = '';
    updateStarDisplay(0);
  } else if(name === 'owned'){
    if(ownedToggle) ownedToggle.checked = false;
    if(ownedLabel) ownedLabel.textContent = 'No';
  } else if(name === 'tags'){
    if(tagsInputEl) tagsInputEl.value = '';
    if(tagsPillsEl) tagsPillsEl.innerHTML = '';
  } else if(name === 'notes'){
    if(notesInput) notesInput.value = '';
    autoGrowNotes();
  }
}
function persistOptionalFieldChange(){
  updateDirty();
  _renderSummaryRow();
  if(!_isAddMode()) _autoSaveIfDirty();
}
function initOptionalFields(entry){
  OPTIONAL_FIELDS.forEach(name=>{
    const hasData = entry && ((name==='notes' && entry.notes) || (name==='rating' && entry.rating) || (name==='owned' && entry.owned) || (name==='tags' && entry.tags));
    // Show if the book has data OR the user has opted-in via preference (#104)
    const shouldShow = !!hasData || getFieldPref(name);
    showOptionalField(name, shouldShow);
  });
  _applyStatusFieldVisibility();
}

/**
 * Hide rating field+chip entirely when status is WTR (#114).
 * Data on disk is preserved; only render is suppressed.
 * Also called when status changes mid-modal.
 */
function _applyStatusFieldVisibility(){
  const status = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const isWtr = status === READING_STATUS.WANT_TO_READ;
  const ratingField = optFieldsZone?.querySelector('.optional-field[data-field="rating"]');
  const ratingChip = optionalChipsEl?.querySelector('.optional-chip[data-field="rating"]');
  if(ratingField){
    if(isWtr){
      ratingField.style.display='none';
    }
    // Otherwise leave display as-is (showOptionalField controls expanded state).
  }
  if(ratingChip){
    if(isWtr){
      ratingChip.dataset.hidden = 'true';
    } else {
      // Restore chip visibility based on whether the field is expanded.
      if(ratingField && ratingField.style.display === 'block'){
        ratingChip.dataset.hidden = 'true';
      } else {
        delete ratingChip.dataset.hidden;
      }
    }
  }
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
  persistOptionalFieldChange();
});

// Owned toggle interaction
ownedToggle?.addEventListener('change',()=>{
  if(ownedLabel) ownedLabel.textContent=ownedToggle.checked?'Yes':'No';
  if(ownedToggle.checked) activateField('owned');
  persistOptionalFieldChange();
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
  pill.querySelector('.tag-pill-remove').addEventListener('click',()=>{ pill.remove(); persistOptionalFieldChange(); });
  tagsPillsEl.appendChild(pill);
}
tagsInputEl?.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===','){
    e.preventDefault();
    const parts=tagsInputEl.value.split(',').map(t=>t.trim()).filter(Boolean);
    parts.forEach(t=>addTagPill(t));
    tagsInputEl.value='';
    if(parts.length) activateField('tags');
    persistOptionalFieldChange();
  }
});
tagsInputEl?.addEventListener('blur',()=>{
  const parts=tagsInputEl.value.split(',').map(t=>t.trim()).filter(Boolean);
  if(parts.length){ parts.forEach(t=>addTagPill(t)); tagsInputEl.value=''; activateField('tags'); persistOptionalFieldChange(); }
});

// Optional chips (inline, #114): tap a "+ Rate" chip to expand the field.
optionalChipsEl?.addEventListener('click', e=>{
  const chip=e.target.closest('.optional-chip');
  if(!chip) return;
  activateField(chip.dataset.field);
  updateDirty();
  // Auto-save activates field for view mode if entry exists.
  if(form.priorTxid.value) _autoSaveIfDirty();
});
// Deactivate field
optFieldsZone?.addEventListener('click',e=>{
  const btn=e.target.closest('.field-deactivate');
  if(!btn) return;
  clearOptionalFieldValue(btn.dataset.field);
  deactivateField(btn.dataset.field, { silent: true });
  persistOptionalFieldChange();
});

if(tileCoverClick && coverFileInput){ tileCoverClick.addEventListener('click',(e)=>{ if(e.target.closest('.cover-remove-btn,.cover-nav-arrow,.cover-adjust-btn')) return; if(modal.querySelector('.modal-inner')?.classList.contains('adjusting-cover')) return; coverFileInput.click(); }); }
if(coverRemoveBtn){ coverRemoveBtn.addEventListener('click',(e)=>{ e.stopPropagation(); clearCoverPreview(); const inner=modal.querySelector('.modal-inner'); if(inner) inner.classList.add('no-cover'); updateDirty(); if(form.priorTxid.value) _autoSaveIfDirty(); }); }
// #147 item B: collapsed "+ Add cover" CTA expands the cover slot. Removes
// the .no-cover class on .modal-inner (so the full tile + dashed-border
// placeholder + ADD COVER text become visible) and opens the Change-cover
// action panel so the Browse covers / Upload my own buttons are immediately
// reachable — same as if the user clicked the "Change cover ▾" link.
const addCoverCtaEl = document.getElementById('addCoverCta');
if(addCoverCtaEl){
  addCoverCtaEl.addEventListener('click',(e)=>{
    e.stopPropagation();
    const inner = modal.querySelector('.modal-inner');
    if(inner) inner.classList.remove('no-cover');
    const coverActionsEl = document.getElementById('coverActions');
    const changeCoverLink = document.getElementById('changeCoverLink');
    if(coverActionsEl) coverActionsEl.style.display = 'flex';
    if(changeCoverLink) changeCoverLink.setAttribute('aria-expanded','true');
  });
}

// --- Helpers ---
// escapeHtml + buildCardHTML + buildCardDetails + generatedCoverColor moved to
// components/book_card.js (#123) so the friend's-shelf view can reuse the
// same builders verbatim. Local aliases preserve the rest of app.js.
const escapeHtml = sharedEscapeHtml;
function clearCoverPreview(){ coverPreview.style.display='none'; coverPlaceholder.style.display='block'; if(coverPlaceholder) coverPlaceholder.innerHTML='<div class="placeholder-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><span>Add cover</span></div>'; delete coverPreview.dataset.b64; delete coverPreview.dataset.mime; coverPreview.src=''; if(coverRemoveBtn) coverRemoveBtn.style.display='none'; coverFileInput.value=''; tileCoverClick.style.removeProperty('--cover-url'); if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn(); }
function showCoverLoaded(){
  if(coverRemoveBtn) coverRemoveBtn.style.display='inline-flex';
  // Round 2 (#147) introduced the .no-cover collapsed state and a small
  // "+ Add cover" CTA that shows when .no-cover is set on .modal-inner.
  // Every successful cover-attach path calls showCoverLoaded() — central
  // place to also clear .no-cover so the actual cover image renders
  // instead of the CTA. Without this, covers from search prefill (and
  // upload, and browse-covers) get attached but stay hidden behind the
  // collapsed-state CTA.
  const inner=modal.querySelector('.modal-inner');
  if(inner) inner.classList.remove('no-cover');
}

function resetMobileBookSheetViewport(){
  if(!isTouchDevice) return;
  const inner=modal.querySelector('.modal-inner');
  if(!inner) return;
  const active = document.activeElement;
  if(active && inner.contains(active) && typeof active.blur === 'function'){
    active.blur();
  }
  requestAnimationFrame(()=>{ inner.scrollTop = 0; });
}

// --- State ---
let entries=[];
// Book repository — single owner of all book data operations
let bookRepo = null;

// Export for any external callers that need to force-clear auth state
export function resetKeyState() {
  tarnService.logout();
}
let appError = null; // Track errors for UI status manager
function dbg(...a){ debugLog('[Bookish]', ...a); }

/**
 * Get app error status for UI status manager
 * @returns {Object} { error }
 */
function getAppErrorStatus() {
  return { error: appError };
}

// --- Utility / ordering ---
function setStatus(m){ setStatusLine(statusEl, m); }
function orderEntries(){
  const statusOrder = { reading: 0, read: 1, want_to_read: 2 };
  entries.sort((a,b)=>{
    const sa = statusOrder[normalizeReadingStatus(a)] ?? 1;
    const sb = statusOrder[normalizeReadingStatus(b)] ?? 1;
    if(sa !== sb) return sa - sb;
    const da=a.dateRead||0; const db=b.dateRead||0;
    if(da!==db) return db - da;
    const ca=a.createdAt||0; const cb=b.createdAt||0;
    if(ca!==cb) return cb-ca;
    return 0;
  });
}
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
  // Title and author are <textarea> placards (#114).
  if(titleInput) titleInput.value=entry?(entry.title||''):'';
  if(authorInput) authorInput.value=entry?(entry.author||''):'';
  form.format.value=entry?mapFormat(entry.format):'print';
  // Auto-grow placards once values are set
  _autoGrowPlacard(placardTitle);
  _autoGrowPlacard(placardAuthor);
  if(entry){
    const rs = normalizeReadingStatus(entry);
    const todayStr = new Date().toISOString().slice(0,10);
    if(rs === READING_STATUS.WANT_TO_READ){
      const ts = entry.createdAt;
      form.dateRead.value = ts ? new Date(ts).toISOString().slice(0,10) : (msToDateInputUtc(entry.dateRead) || todayStr);
    } else if(rs === READING_STATUS.READING){
      const ts = entry.readingStartedAt;
      form.dateRead.value = ts ? new Date(ts).toISOString().slice(0,10) : (msToDateInputUtc(entry.dateRead) || todayStr);
    } else {
      form.dateRead.value = msToDateInputUtc(entry.dateRead) || todayStr;
    }
  } else {
    form.dateRead.value = new Date().toISOString().slice(0,10);
  }
  if(notesInput) notesInput.value = entry?.notes || '';
  initOptionalFields(entry);
  populateOptionalFields(entry);
  // Per-book privacy (#129). Mirror the entry's `is_private` into all three
  // form-side surfaces. New books default to public (false).
  const initialPrivate = entry?.is_private === true;
  if(isPrivateInput) isPrivateInput.value = initialPrivate ? 'true' : '';
  if(privacyAddCheckbox) privacyAddCheckbox.checked = initialPrivate;
  syncPrivacyToggleVisualState(initialPrivate);
  if(entry&&entry.coverImage){
    const coverDataUrl='data:'+(entry.mimeType||'image/*')+';base64,'+entry.coverImage;
    coverPreview.src=coverDataUrl;
    coverPreview.style.display='block'; coverPlaceholder.style.display='none';
    coverPreview.dataset.b64=entry.coverImage; if(entry.mimeType) coverPreview.dataset.mime=entry.mimeType; if(entry.coverFit) coverPreview.dataset.fit=entry.coverFit;
    tileCoverClick.style.setProperty('--cover-url',`url('${coverDataUrl}')`);
    showCoverLoaded();
    if(inner) inner.classList.remove('no-cover');
  } else { clearCoverPreview(); if(inner) inner.classList.add('no-cover'); }

  // Reading status: unified selector for both add and edit mode
  const status = entry ? normalizeReadingStatus(entry) : (forceIntent || READING_STATUS.WANT_TO_READ);
  setReadingStatus(status, { silent: true });
  if(statusSelector) statusSelector.style.display='flex';

  // Reset transient UI surfaces
  if(statusMicrocopyEl){ statusMicrocopyEl.textContent=''; statusMicrocopyEl.classList.remove('visible'); }
  if(autosaveMicrocopyEl){ autosaveMicrocopyEl.textContent=''; autosaveMicrocopyEl.classList.remove('visible','error'); }
  _renderSummaryRow();

  snapshotOriginal();
  updateDirty();
  // Decoupled cover-edition browser entry point (#114). Hide "Browse covers"
  // when the entry has no work_key (legacy/manual entries).
  const workKey = entry?.work_key || '';
  if(window.bookSearch?.handleModalOpen) window.bookSearch.handleModalOpen(workKey);
  pushOverlayState('modal');
  setTimeout(()=>{
    if(notesInput){ notesInput.style.height='auto'; notesInput.style.height=Math.max(60,notesInput.scrollHeight)+'px'; }
    // In add mode, focus title placard on desktop only. On mobile, automatic
    // focus opens the keyboard and lets the viewport reposition the sheet
    // before the search prefill/cover pipeline finishes.
    if(!entry && placardTitle && !isTouchDevice){
      placardTitle.focus();
      // Place caret at end if value pre-filled by omnibox prefill, otherwise no-op
      const len = placardTitle.value.length;
      try{ placardTitle.setSelectionRange(len,len); }catch{}
    } else if(!entry){
      resetMobileBookSheetViewport();
    }
  }, 0);
}

// --- Per-book privacy (#129 / FRIENDS.md Surface 7) ---------------------
//
// Three UI surfaces feed and reflect the same `is_private` boolean:
//   1. Add-form checkbox (#privacyAddCheckbox) — visible only in add-mode.
//      Updates the hidden #isPrivateInput on toggle; submit reads the input.
//   2. Edit-mode lock toggle (#privacyToggleBtn) — visible only in edit mode.
//      Click flips state and immediately persists via the auto-save pipeline,
//      then shows a subtle toast. The icon swap (locked vs unlocked) is
//      handled by the .privacy-toggle-btn[aria-pressed] CSS rules.
//   3. Hidden #isPrivateInput — single source of truth for form submission.
//
// The book-card lock overlay on the Library is a separate render concern;
// see attachPrivacyLockOverlay() below.

/** Apply the locked/unlocked visual state to the book-detail toggle button. */
function syncPrivacyToggleVisualState(isPrivate){
  if(!privacyToggleBtn) return;
  privacyToggleBtn.setAttribute('aria-pressed', isPrivate ? 'true' : 'false');
  if(privacyToggleLabel){
    privacyToggleLabel.textContent = isPrivate ? 'Make public' : 'Make private';
  }
  privacyToggleBtn.title = isPrivate ? 'Visible only to you — click to make public' : 'Visible to friends — click to make private';
}

// Add-form checkbox: mirror to the hidden input. No save happens here — the
// regular form-submit picks up `is_private` from the hidden input. Editing
// the checkbox flips dirty state for the standard auto-save behavior.
privacyAddCheckbox?.addEventListener('change', () => {
  if(isPrivateInput){
    isPrivateInput.value = privacyAddCheckbox.checked ? 'true' : '';
  }
  updateDirty();
});

// Book-detail lock toggle: flip + immediate persist + toast. The toggle is
// only enabled in edit mode (saved book), so we always have a priorTxid.
privacyToggleBtn?.addEventListener('click', async () => {
  const priorTxid = form.priorTxid?.value;
  if(!priorTxid) return; // defensive — toggle is hidden in add mode
  haptic();
  const wasPrivate = isPrivateInput?.value === 'true';
  const next = !wasPrivate;
  if(isPrivateInput) isPrivateInput.value = next ? 'true' : '';
  if(privacyAddCheckbox) privacyAddCheckbox.checked = next;
  syncPrivacyToggleVisualState(next);
  updateDirty();
  // Use the existing auto-save pipeline so the change rides through the
  // BookRepository.update path (which, in turn, calls the friends.publishBook
  // / unpublishBook fan-out based on the public/private transition).
  // _autoSaveIfDirty resolves to true on success / false on failure (it
  // shows its own error microcopy on failure). Only emit the privacy toast
  // when the save actually committed.
  let saved = false;
  try {
    saved = await _autoSaveIfDirty();
  } catch (err) {
    console.warn('[Bookish] privacy toggle save failed:', err.message);
  }
  if(saved){
    showStatusToast(next ? 'Hidden from friends' : 'Visible to friends');
  } else {
    // Roll back the visual state — the autosave-microcopy already surfaces
    // the failure, so we just revert the toggle so the user knows it didn't
    // stick.
    if(isPrivateInput) isPrivateInput.value = wasPrivate ? 'true' : '';
    if(privacyAddCheckbox) privacyAddCheckbox.checked = wasPrivate;
    syncPrivacyToggleVisualState(wasPrivate);
  }
});

// --- Library-card lock overlay (#129 / FRIENDS.md Surface 7) -------------
//
// Owner-only chip on the user's own Library cards: a small lock glyph in
// the top-left corner of the cover for books marked private. Hidden on
// public books and on friend's-shelf views (private books never reach
// those surfaces in the first place — defense in depth lives in
// friends.fetchFriendLibrary).
//
// Idempotent: drops any existing `.privacy-lock-overlay` first, then
// inserts a fresh one if the entry is private. Same wrapper-as-anchor
// pattern as friend pips: lives inside `.cover-wrap` so the cover's own
// `overflow: hidden` doesn't clip it.

const PRIVACY_LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg>`;

function attachPrivacyLockOverlay(cardEl, entry){
  if(!cardEl) return;
  const wrap = cardEl.querySelector('.cover-wrap');
  if(!wrap) return;
  const existing = wrap.querySelector('.privacy-lock-overlay');
  if(existing) existing.remove();
  if(!entry || entry.is_private !== true) return;
  const lock = document.createElement('div');
  lock.className = 'privacy-lock-overlay';
  lock.setAttribute('aria-label', 'Private — only you see this');
  lock.title = 'Private — only you see this';
  lock.innerHTML = PRIVACY_LOCK_SVG;
  wrap.appendChild(lock);
}

/** Auto-grow a single-row textarea (#114 placards). */
function _autoGrowPlacard(el){
  if(!el) return;
  const styles = window.getComputedStyle ? window.getComputedStyle(el) : null;
  const lineHeight = parseFloat(styles?.lineHeight) || (parseFloat(styles?.fontSize) || 16) * 1.3;
  const padding = (parseFloat(styles?.paddingTop) || 0) + (parseFloat(styles?.paddingBottom) || 0);
  const maxLines = parseFloat(styles?.getPropertyValue('--placard-max-lines')) || 2;
  const maxHeight = Math.ceil(lineHeight * maxLines + padding);
  _autoSizePlacardWidth(el, styles);
  el.style.height='auto';
  const nextHeight = Math.min(el.scrollHeight, maxHeight);
  el.style.height = nextHeight + 'px';
  el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
}

function _autoSizePlacardWidth(el, styles){
  const parent = el.closest?.('.book-detail-placards');
  const parentWidth = parent?.clientWidth || el.parentElement?.clientWidth || 0;
  if(!parentWidth || !styles) return;

  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const minCh = parseFloat(styles.getPropertyValue('--placard-min-ch')) || 10;
  const maxCh = parseFloat(styles.getPropertyValue('--placard-max-ch')) || 32;
  const fontSize = parseFloat(styles.fontSize) || 16;
  let chWidth = fontSize * 0.55;
  let measured = 0;

  try{
    const canvas = _autoSizePlacardWidth._canvas || (_autoSizePlacardWidth._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    if(ctx){
      ctx.font = `${styles.fontStyle} ${styles.fontVariant} ${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
      chWidth = ctx.measureText('0').width || chWidth;
      const text = (el.value || el.placeholder || ' ').split('\n');
      measured = Math.max(...text.map(line => ctx.measureText(line || ' ').width));
    }
  }catch{}

  const maxWidth = Math.min(parentWidth, Math.ceil(chWidth * maxCh + padding));
  const minWidth = Math.min(maxWidth, Math.ceil(chWidth * minCh + padding));
  const contentWidth = measured ? Math.ceil(measured + padding + 2) : minWidth;
  el.style.setProperty('width', Math.max(minWidth, Math.min(maxWidth, contentWidth)) + 'px', 'important');
}

function _hasRequiredTitle(){
  return !!(titleInput?.value || '').trim();
}

function _addCommitLabel(status){
  if(status === READING_STATUS.READING) return 'Add as Reading';
  if(status === READING_STATUS.READ) return 'Add as Read';
  return 'Add to Want to Read';
}

function _syncAddCommitCta(){
  if(!addBookCommitBtn) return;
  const isAddMode = _isAddMode();
  const status = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  addBookCommitBtn.textContent = _addCommitLabel(status);
  addBookCommitBtn.disabled = !isAddMode || !_hasRequiredTitle() || _formSubmitting;
}

function _syncStatusSelectorMode(){
  if(!statusSelector) return;
  const isAddMode = _isAddMode();
  const isDisabled = _formSubmitting;
  statusSelector.setAttribute('role', 'radiogroup');
  statusSelector.setAttribute('aria-label', isAddMode ? 'Initial reading status' : 'Reading status');
  statusSelector.querySelectorAll('.status-option').forEach(btn => {
    btn.disabled = isDisabled;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', btn.classList.contains('active') ? 'true' : 'false');
  });
  _syncAddCommitCta();
}

function _stampStatusTransitionDates(newStatus, prevStatus){
  const todayIso = new Date().toISOString().slice(0,10);
  if(newStatus === READING_STATUS.READING && prevStatus === READING_STATUS.WANT_TO_READ){
    if(form.dateRead) form.dateRead.value = todayIso;
  }
  if(newStatus === READING_STATUS.READ && prevStatus !== READING_STATUS.READ){
    if(form.dateRead) form.dateRead.value = todayIso;
  }
}

function setReadingStatus(status, opts){
  const prev = readingStatusInput?.value;
  if(readingStatusInput) readingStatusInput.value = status;
  statusSelector?.querySelectorAll('.status-option').forEach(btn => {
    const active = btn.dataset.status === status;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  applyIntentUI(status);
  _syncStatusSelectorMode();
  _applyStatusFieldVisibility();
  _renderSummaryRow();
  // Confirmation pulse + microcopy (#114) — skipped during initial silent open
  if(!opts?.silent && prev !== status){
    const activeBtn = statusSelector?.querySelector(`.status-option[data-status="${status}"]`);
    if(activeBtn){
      activeBtn.classList.add('pulse');
      setTimeout(()=>activeBtn.classList.remove('pulse'), 500);
    }
    _showStatusMicrocopy(status);
  }
}

/**
 * Apply status-driven state for the date value. The physical date row is kept
 * out of the detail table; the summary chip owns the visible edit affordance.
 */
function applyIntentUI(intent){
  const isWtr = intent === READING_STATUS.WANT_TO_READ;
  const isReading = intent === READING_STATUS.READING;
  const dateInput = form.dateRead;

  if(dateRow){
    dateRow.dataset.hidden = 'true';
  }
  if(dateReadLabelEl){
    dateReadLabelEl.textContent = isReading ? 'Started' : 'Finished';
  }
  if(dateInput){
    dateInput.readOnly = false;
    const entry = form.priorTxid.value ? entries.find(e=>(e.txid||e.id)===form.priorTxid.value) : null;
    if(isReading){
      const ts = entry?.readingStartedAt;
      if(!dateInput.value) dateInput.value = ts ? new Date(ts).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
    } else if(!isWtr){
      if(!dateInput.value) dateInput.value = msToDateInputUtc(entry?.dateRead) || new Date().toISOString().slice(0,10);
    }
  }

  _syncStatusSelectorMode();
}

const STATUS_MICROCOPY = {
  [READING_STATUS.WANT_TO_READ]: 'Moved to Want to Read',
  [READING_STATUS.READING]: 'Moved to Reading',
  [READING_STATUS.READ]: 'Marked as Read'
};
function _showStatusMicrocopy(status){
  if(!statusMicrocopyEl) return;
  statusMicrocopyEl.textContent = STATUS_MICROCOPY[status] || '';
  statusMicrocopyEl.classList.add('visible');
  clearTimeout(statusMicrocopyEl._fadeTimer);
  statusMicrocopyEl._fadeTimer = setTimeout(()=>{
    statusMicrocopyEl.classList.remove('visible');
  }, 1500);
}

/**
 * Render the inline summary row under the status pills (#114).
 * Day/month only (no year) — shelf is grouped by year.
 * Shows: rating stars, Started date, Finished date — only segments that are set.
 * Hidden entirely on WTR with no data.
 */
let _summaryDateEditing = null;

function _dateInputToSummaryMs(value){
  if(!value) return null;
  const ms = dateStringToMsNoonUtc(value);
  return ms == null ? null : ms;
}

function _summaryDateValueForStatus(status, entry){
  const formValue = form.dateRead?.value || '';
  if(formValue) return formValue;
  if(status === READING_STATUS.READING) return entry?.readingStartedAt ? new Date(entry.readingStartedAt).toISOString().slice(0,10) : '';
  if(status === READING_STATUS.READ) return msToDateInputUtc(entry?.dateRead) || '';
  return '';
}

function _renderSummaryDateSegment(kind, label, value){
  const ms = _dateInputToSummaryMs(value);
  if(ms == null) return '';
  const ariaLabel = kind === 'started' ? 'Edit start date' : 'Edit finish date';
  if(_summaryDateEditing === kind){
    return `<input type="date" class="summary-date-input" data-edit-date="${kind}" aria-label="${ariaLabel}" value="${escapeHtml(value)}">`;
  }
  return `<span class="summary-seg summary-date-seg" data-edit="${kind}" tabindex="0" role="button" aria-label="${ariaLabel}">${label} ${escapeHtml(_formatDayMonth(ms))}</span>`;
}

function _renderSummaryRow(){
  if(!summaryRowEl) return;
  const status = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const isWtr = status === READING_STATUS.WANT_TO_READ;
  const segs = [];
  const rating = parseInt(ratingInput?.value)||0;
  if(!_isAddMode() && !isWtr && rating>=1 && rating<=5){
    const stars = '★★★★★'.slice(0,rating) + '☆☆☆☆☆'.slice(0,5-rating);
    segs.push(`<span class="summary-seg summary-stars" data-edit="rating" tabindex="0" role="button" aria-label="Edit rating">${stars}</span>`);
  }
  const entry = form.priorTxid.value ? entries.find(e=>(e.txid||e.id)===form.priorTxid.value) : null;
  const startedMs = entry?.readingStartedAt;
  const currentDateValue = _summaryDateValueForStatus(status, entry);
  if(status === READING_STATUS.READING){
    const startedSeg = _renderSummaryDateSegment('started', 'Started', currentDateValue);
    if(startedSeg) segs.push(startedSeg);
  }
  if(status === READING_STATUS.READ){
    if(startedMs) segs.push(`<span class="summary-seg summary-static-seg">Started ${escapeHtml(_formatDayMonth(startedMs))}</span>`);
    const finishedSeg = _renderSummaryDateSegment('finished', 'Finished', currentDateValue);
    if(finishedSeg) segs.push(finishedSeg);
  }
  if(!segs.length){
    summaryRowEl.style.display='none';
    summaryRowEl.innerHTML='';
    return;
  }
  summaryRowEl.innerHTML = segs.join('<span class="summary-sep">·</span>');
  summaryRowEl.style.display='flex';
}

function _startSummaryDateEdit(which){
  const status = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const canEditStarted = which === 'started' && status === READING_STATUS.READING;
  const canEditFinished = which === 'finished' && status === READING_STATUS.READ;
  if(!canEditStarted && !canEditFinished) return;
  _summaryDateEditing = which;
  _renderSummaryRow();
  requestAnimationFrame(()=>{
    const input = summaryRowEl?.querySelector(`.summary-date-input[data-edit-date="${which}"]`);
    input?.focus?.();
    try{ input?.showPicker?.(); }catch{}
  });
}

function _commitSummaryDateInput(input){
  if(!input || !input.classList.contains('summary-date-input')) return;
  if(input.value && form.dateRead.value !== input.value){
    form.dateRead.value = input.value;
    updateDirty();
  }
  _summaryDateEditing = null;
  _renderSummaryRow();
  _syncAddCommitCta();
  if(!_isAddMode()) _autoSaveIfDirty();
}

function _formatDayMonth(ms){
  if(ms == null || ms === '') return '';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if(!Number.isFinite(n)) return '';
  const d = new Date(n);
  if(isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', timeZone:'UTC' }).format(d);
}

function _finalizeCloseModal(fromPopstate){
  if(resetModalSwipe) resetModalSwipe();
  if(detachKeyboard) detachKeyboard();
  if(form.priorTxid.value && bookRepo?.flushPendingEdits){
    bookRepo.flushPendingEdits().catch(err => console.warn('[Bookish] flush pending edits failed:', err?.message || err));
  }
  modal.classList.remove('active');
  document.body.classList.remove('modal-open');
  const inner=modal.querySelector('.modal-inner');
  if(inner){ inner.classList.remove('add-mode'); inner.classList.remove('sheet-dismissing'); inner.classList.remove('no-cover'); }
  form.reset();
  resetOptionalFields();
  coverPreview.style.display='none';
  if(coverRemoveBtn) coverRemoveBtn.style.display='none';
  delete form.dataset.orig;
  if(statusSelector){ statusSelector.style.display='none'; }
  if(addBookCommitBtn){ addBookCommitBtn.textContent='Add to Want to Read'; addBookCommitBtn.disabled=true; }
  // Reset placard dimensions
  if(placardTitle){ placardTitle.style.height=''; placardTitle.style.width=''; placardTitle.style.overflowY=''; }
  if(placardAuthor){ placardAuthor.style.height=''; placardAuthor.style.width=''; placardAuthor.style.overflowY=''; }
  // Reset row visibility for next open
  if(dateRow) delete dateRow.dataset.hidden;
  if(form.dateRead) form.dateRead.readOnly=false;
  if(dateReadLabelEl) dateReadLabelEl.textContent='Finished';
  // Reset summary row + microcopy
  if(summaryRowEl){ summaryRowEl.innerHTML=''; summaryRowEl.style.display='none'; }
  if(statusMicrocopyEl){ statusMicrocopyEl.textContent=''; statusMicrocopyEl.classList.remove('visible'); }
  if(autosaveMicrocopyEl){ autosaveMicrocopyEl.textContent=''; autosaveMicrocopyEl.classList.remove('visible','error'); }
  // Reset cover edit panel state
  const coverActionsEl = document.getElementById('coverActions');
  if(coverActionsEl) coverActionsEl.style.display='none';
  const changeCoverLink = document.getElementById('changeCoverLink');
  if(changeCoverLink) changeCoverLink.setAttribute('aria-expanded','false');
  // Decoupled cover-search reset (#114)
  if(window.bookSearch?.handleModalClose) window.bookSearch.handleModalClose();
  // #149: clear without refocus — modal close shouldn't yank focus back
  // into the header omnibox (it's behind the modal that's animating out).
  if(omniboxInput && omniboxInput.value){ clearOmnibox({ refocus: false }); }
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
window.bookishApp={ openModal, clearBooks, showCoverLoaded, clearCoverPreview, render, changeReadingStatus, showShelfSkeletons, clearShelfSkeletons, getActiveEntryCount: ()=>activeEntryCount(), showStatusToast, _autoSaveIfDirty: ()=>_autoSaveIfDirty(),
  // Test-only: synchronously inject an entry into the in-memory list and
  // re-render. Used by browser tests that need a deterministic card without
  // reaching through the network-bound search-and-save flow. NEVER called
  // from production code paths.
  _testInjectEntry: (entry)=>{ if(entry) entries.push(entry); render(); },
};
// Dirty tracking helpers
function currentFormState(){ return JSON.stringify({
  prior: form.priorTxid.value||'',
  title: (titleInput?.value||'').trim(),
  author: (authorInput?.value||'').trim(),
  format: form.format.value,
  dateRead: form.dateRead.value,
  readingStatus: readingStatusInput?.value||READING_STATUS.WANT_TO_READ,
  cover: coverPreview.dataset.b64||'',
  notes: (notesInput?.value||'').trim(),
  rating: ratingInput?.value||'',
  owned: ownedToggle?.checked?'1':'',
  tags: collectTags(),
  // Per-book privacy (#129) — included so flipping the lock toggle or the
  // add-form checkbox marks the form dirty and triggers the standard save
  // path. Without this, the auto-save would treat a privacy flip as a no-op.
  isPrivate: isPrivateInput?.value === 'true' ? '1' : ''
}); }
function snapshotOriginal(){ form.dataset.orig = currentFormState(); }
function updateDirty(){
  const orig=form.dataset.orig||'';
  const cur=currentFormState();
  _syncStatusSelectorMode();
  _syncAddCommitCta();
}
if(!form._dirtyBound){
  form._dirtyBound=true;
  form.addEventListener('input', ()=>{
    updateDirty();
    // Auto-grow placards in response to any form input (covers programmatic
    // prefills from omnibox/book_search that dispatch synthetic input events).
    _autoGrowPlacard(placardTitle);
    _autoGrowPlacard(placardAuthor);
    _renderSummaryRow();
  });
  form.addEventListener('change', updateDirty);
}

// --- Auto-save (#114) ---
// Auto-save on blur for inline-edit fields. Skip when no change vs snapshot,
// or when in add-mode (status commit buttons handle that case).
let _autosaveInFlight = false;
function _isAddMode(){ return modal.querySelector('.modal-inner')?.classList.contains('add-mode'); }
function _showAutosaveSaved(){
  if(!autosaveMicrocopyEl) return;
  autosaveMicrocopyEl.textContent='Saved ✓';
  autosaveMicrocopyEl.classList.remove('error');
  autosaveMicrocopyEl.classList.add('visible');
  clearTimeout(autosaveMicrocopyEl._fadeTimer);
  autosaveMicrocopyEl._fadeTimer = setTimeout(()=>{
    autosaveMicrocopyEl.classList.remove('visible');
  }, 1200);
}
function _showAutosaveError(){
  if(!autosaveMicrocopyEl) return;
  autosaveMicrocopyEl.textContent='Couldn’t save. Tap to retry.';
  autosaveMicrocopyEl.classList.add('visible','error');
  clearTimeout(autosaveMicrocopyEl._fadeTimer);
}
autosaveMicrocopyEl?.addEventListener('click', ()=>{
  if(autosaveMicrocopyEl.classList.contains('error')){
    autosaveMicrocopyEl.classList.remove('visible','error');
    _autoSaveIfDirty();
  }
});

/**
 * Auto-save: if in edit mode and the form has changed from snapshot, persist
 * via BookRepository.update and refresh snapshot. Returns true if a save was
 * issued. Errors revert the field to the prior snapshot value and show a
 * retry microcopy.
 */
async function _autoSaveIfDirty(){
  if(_isAddMode()) return false;
  if(_autosaveInFlight) return false;
  const priorTxid = form.priorTxid.value;
  if(!priorTxid) return false;
  const orig = form.dataset.orig||'';
  const cur = currentFormState();
  if(orig === cur) return false;
  _autosaveInFlight = true;
  try{
    const payload = _buildPayloadFromForm();
    await editServerless(priorTxid, payload);
    snapshotOriginal();
    updateDirty();
    _showAutosaveSaved();
    _renderSummaryRow();
    return true;
  } catch(err){
    console.warn('[Bookish] auto-save failed:', err?.message||err);
    // Revert: restore form fields from snapshot JSON
    try{
      const snap = JSON.parse(orig);
      if(titleInput) titleInput.value = snap.title || '';
      if(authorInput) authorInput.value = snap.author || '';
      form.format.value = snap.format || 'print';
      form.dateRead.value = snap.dateRead || '';
      if(notesInput) notesInput.value = snap.notes || '';
      _autoGrowPlacard(placardTitle);
      _autoGrowPlacard(placardAuthor);
    }catch{}
    _showAutosaveError();
    return false;
  } finally {
    _autosaveInFlight = false;
  }
}

/** Build the persistence payload from current form state (for auto-save). */
function _buildPayloadFromForm(){
  const rsValue = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const dateVal = form.dateRead.value;
  const payload = {
    title: (titleInput?.value||'').trim(),
    author: (authorInput?.value||'').trim(),
    format: form.format.value,
    readingStatus: rsValue
  };
  if(rsValue === READING_STATUS.READ){
    const ms = dateStringToMsNoonUtc(dateVal);
    if(ms != null) payload.dateRead = ms;
  } else if(rsValue === READING_STATUS.READING){
    payload.readingStartedAt = dateVal ? new Date(dateVal+'T00:00:00').getTime() : Date.now();
  }
  if(coverPreview.dataset.b64){
    payload.coverImage = coverPreview.dataset.b64;
    if(coverPreview.dataset.mime) payload.mimeType = coverPreview.dataset.mime;
    if(coverPreview.dataset.fit) payload.coverFit = coverPreview.dataset.fit;
  } else if(form.priorTxid.value){
    payload.coverImage = '';
    payload.mimeType = '';
  }
  const notesVal=(notesInput?.value||'').trim();
  payload.notes = notesVal;
  const optVals = getOptionalFieldValues();
  payload.rating = optVals.rating || 0;
  payload.owned = !!optVals.owned;
  payload.tags = optVals.tags || '';
  // Per-book privacy (#129). Always forward an explicit boolean so the
  // BookRepository edit path can detect public→private and private→public
  // transitions to fan out the correct share-log call (publish / unpublish).
  // Without an explicit `false`, an entry that flips off would keep its
  // stale `is_private: true`.
  payload.is_private = isPrivateInput?.value === 'true';
  return payload;
}

// Wire up blur-based auto-save for inline-edit fields. Triggered only in
// edit (view) mode — add-mode commits via the status choices.
function _bindAutoSaveBlur(el){
  if(!el || el._autoSaveBound) return;
  el._autoSaveBound = true;
  el.addEventListener('blur', ()=>{
    if(_isAddMode()) return;
    _autoSaveIfDirty();
  });
  // Enter on placard textareas blurs to commit (auto-save). Shift+Enter inserts newline.
  if(el.tagName === 'TEXTAREA' && (el === placardTitle || el === placardAuthor)){
    el.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter' && !ev.shiftKey){
        ev.preventDefault();
        el.blur();
      }
    });
  }
}
[placardTitle, placardAuthor, form.format, form.dateRead, notesInput, ratingInput, ownedToggle, tagsInputEl].forEach(_bindAutoSaveBlur);

// Summary-row segment click → activate/scroll to the editor for that field
summaryRowEl?.addEventListener('click', e=>{
  const seg = e.target.closest('.summary-seg');
  if(!seg) return;
  const which = seg.dataset.edit;
  if(which === 'rating'){
    activateField('rating');
    const firstStar = starRatingEl?.querySelector('.star');
    firstStar?.focus?.();
  } else if(which === 'started' || which === 'finished'){
    _startSummaryDateEdit(which);
  }
});
summaryRowEl?.addEventListener('keydown', e=>{
  const seg = e.target.closest('.summary-seg');
  if(!seg) return;
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const which = seg.dataset.edit;
  if(which !== 'started' && which !== 'finished') return;
  e.preventDefault();
  _startSummaryDateEdit(which);
});
summaryRowEl?.addEventListener('change', e=>{
  const input = e.target.closest('.summary-date-input');
  if(input) _commitSummaryDateInput(input);
});
summaryRowEl?.addEventListener('focusout', e=>{
  const input = e.target.closest('.summary-date-input');
  if(input) setTimeout(()=>{
    if(_summaryDateEditing) _commitSummaryDateInput(input);
  }, 0);
});
summaryRowEl?.addEventListener('keydown', e=>{
  const input = e.target.closest('.summary-date-input');
  if(!input) return;
  if(e.key === 'Enter'){
    e.preventDefault();
    _commitSummaryDateInput(input);
  }
  if(e.key === 'Escape'){
    e.preventDefault();
    _summaryDateEditing = null;
    _renderSummaryRow();
  }
});

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
    if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn();
    const inner = modal.querySelector('.modal-inner');
    if(inner) inner.classList.remove('no-cover');
    updateDirty();
    if(form.priorTxid.value) _autoSaveIfDirty();
  } catch(err) {
    // Fallback to original if resize fails
    const r = new FileReader(); r.onload = e => { const b64full = e.target.result; const b64 = b64full.split(',')[1]; coverPreview.src = b64full; coverPreview.style.display = 'block'; coverPlaceholder.style.display = 'none'; coverPreview.dataset.b64 = b64; coverPreview.dataset.mime = f.type || 'image/jpeg'; tileCoverClick.style.setProperty('--cover-url',`url('${b64full}')`); showCoverLoaded(); const inner=modal.querySelector('.modal-inner'); if(inner) inner.classList.remove('no-cover'); updateDirty(); if(form.priorTxid.value) _autoSaveIfDirty(); }; r.readAsDataURL(f);
  }
});

const closeModalBtn = document.getElementById('closeModal');
closeModalBtn?.addEventListener('click', closeModal);
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
        debugLog('[Bookish] Account button clicked');
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
      debugLog('[Bookish] Account button wired up successfully');
    } else {
      console.warn('[Bookish] accountBtn not found in DOM, retrying...');
      // Retry after a short delay in case DOM isn't ready yet
      setTimeout(() => {
        const retryBtn = document.getElementById('accountBtn');
        if (retryBtn && openAccountModal) {
          retryBtn.onclick = () => openAccountModal();
          debugLog('[Bookish] Account button wired up on retry');
        } else {
          console.error('[Bookish] Failed to wire up account button after retry');
        }
      }, 100);
    }

    // #149: signed-out header chip. Opens the sign-in pane of the same
    // account modal that the (now-deleted) empty-state "Sign in" line
    // used to open. Visibility is toggled by `refreshHeaderAuthState()`
    // alongside the Account gear. The first paint of the header auth
    // state happens at module-load time (below this IIFE) so the button
    // shows immediately without waiting for the dynamic import.
    const signInBtn = document.getElementById('signInHeaderBtn');
    if(signInBtn){
      signInBtn.onclick = () => {
        try {
          if (window.accountUI?.handleSignIn) window.accountUI.handleSignIn();
          else if (openAccountModal) openAccountModal('signin');
        } catch (err) {
          console.error('[Bookish] signInHeaderBtn click failed:', err?.message || err);
        }
      };
    }
  } catch (error) {
    console.error('[Bookish] Failed to load account_ui.js:', error);
  }
})();

/**
 * #149: toggle header chip visibility based on auth state. Signed-out
 * shows the "Sign in" text button; signed-in shows the Account gear.
 * Both elements live in `#mainHeader .header-actions`. Called from the
 * render() cycle so it stays in sync with login/logout transitions
 * (clearBooks() on logout triggers render(); updateBookDots() after
 * sign-in triggers render() via the BookRepository change event).
 */
function refreshHeaderAuthState(){
  // Visibility is driven by CSS keyed on `html.is-signed-in`. We toggle the
  // class here so the header reacts to login/logout without a page reload.
  // The initial state is stamped synchronously by an inline <script> in
  // <head> reading tarn:session:v1 — that's what prevents the first-paint
  // flash for returning signed-in users.
  document.documentElement.classList.toggle('is-signed-in', tarnService.isLoggedIn());
}

refreshHeaderAuthState();

// No settings UI anymore; defaults used

// --- Popstate handler for standalone PWA back-button overlay dismissal (#81) ---
window.addEventListener('popstate', () => {
  if (!isStandalone) return;
  if (consumeSuppressFlag()) return;
  // Close topmost visible overlay (search takeover > notes > modal > account > friends > wtr)
  if (omniboxController.isSearchTakeoverActive()) {
    closeSearchTakeover(true);
  } else if (notesOverlay && notesOverlay.style.display === 'flex') {
    closeNotesOverlay(true);
  } else if (modal && modal.classList.contains('active')) {
    closeModal(true);
  } else {
    const accountModal = document.getElementById('accountModal');
    const friendsOverlay = document.getElementById('friendsOverlay');
    const friendShelfOverlay = document.getElementById('friendShelfOverlay');
    if (accountModal && accountModal.style.display === 'flex') {
      if (closeAccountModalFn) closeAccountModalFn(true);
    } else if (friendShelfOverlay && friendShelfOverlay.style.display === 'block') {
      // Friend's shelf full-screen view (#123). Topmost peer of the friends
      // drawer; closed via popstate so the PWA system back button returns
      // the user to their Library.
      import('./components/friend_shelf_view.js').then(m => m.closeFriendShelfView(true)).catch(() => {});
    } else if (friendsOverlay && friendsOverlay.style.display === 'block') {
      // Friends drawer (#122) — stack peer of WTR. Closed via popstate so the
      // PWA system back button dismisses it just like any other overlay.
      import('./components/friends_drawer.js').then(m => m.closeFriendsDrawer(true)).catch(() => {});
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


// Generated cover color palette + generatedCoverColor() live in
// components/book_card.js (#123). Local alias preserves callers in this file.
const generatedCoverColor = sharedGeneratedCoverColor;

// --- Render ---
function markDeletingVisual(entry){ entry._deleting=true; entry._committed=false; const key=entry.txid||entry.id||''; const el=key?document.querySelector('.card[data-txid="'+key+'"]'):null; if(el){ el.classList.add('deleting'); el.style.pointerEvents='none'; el.style.opacity='0.35'; } }

// buildCardDetails + buildCardHTML live in components/book_card.js (#123).
// Local aliases preserve the rest of app.js.
const buildCardDetails = sharedBuildCardDetails;
const buildCardHTML = sharedBuildCardHTML;

/**
 * Attach (or refresh) the friend-pip overlay on a Library card.
 *
 * Friend pips (#126 / FRIENDS.md Surface 3) are an additive overlay on top of
 * the cover. They live as a child of `.cover-wrap` (the non-clipping wrapper
 * around `.cover`) so the CSS `bottom: -7px` rule positions them straddling
 * the cover's bottom edge — half on the cover, half on the card padding
 * below — per the spec.
 *
 * Why a separate post-render attach instead of baking pips into
 * `buildCardHTML`: the pure builder is consumed by both Library (where pips
 * are wanted) and the friend's-shelf view (where they are NOT — viewing
 * Maya's shelf shouldn't pip Maya's books with… Maya). Keeping pips in the
 * Library render loop makes that separation enforced by file boundaries
 * rather than by passing flags through the shared builder.
 *
 * Idempotent: drops any existing `.friend-pip-overlay` first, then appends a
 * fresh one if there are matches. Safe to call on every render; the
 * underlying match cache is keyed by work_key so repeated calls cost a
 * single Map lookup per card.
 */
function attachFriendPips(cardEl, entry){
  if(!cardEl) return;
  // Pip overlay lives in `.cover-wrap` (a sibling of `.cover`) so its
  // bottom-half can straddle the cover's bottom edge without being clipped
  // by `.cover { overflow: hidden }`. See book_card.js for the wrapper.
  const wrap = cardEl.querySelector('.cover-wrap');
  if(!wrap) return;
  // Always clear stale overlays first so a friend who removed the book or
  // muted the connection sees their pip vanish on the next render.
  const existing = wrap.querySelector('.friend-pip-overlay');
  if(existing) existing.remove();

  const wk = entry && typeof entry.work_key === 'string' ? entry.work_key : '';
  if(!wk) return;
  const matchEntries = friendsGetMatchingFriendBookEntries(wk);
  if(!matchEntries.length) return;

  // The pip component takes a flat connection list; we keep the per-friend
  // book records in a side map keyed by share_pub so the tap handler can
  // surface the friend's record (their dateRead, their reading status) to
  // the friend-book-detail modal — matching the spec line "their copy —
  // their dates, future ratings/notes."
  const bookByShare = new Map();
  for(const me of matchEntries){
    bookByShare.set(me.connection.share_pub, me.book);
  }
  const connections = matchEntries.map(me => me.connection);

  const overlay = renderPipOverlay(connections, {
    onTapPip: (connection) => {
      const friendBook = bookByShare.get(connection.share_pub) || entry;
      try {
        openFriendBookDetail({ book: friendBook, connection });
      } catch (err) {
        console.warn('[Bookish] friend-pip tap failed to open modal:', err.message);
      }
    },
  });
  if(overlay) wrap.appendChild(overlay);
}

/** Quick fingerprint for change detection — avoids unnecessary innerHTML rewrites */
function entryFingerprint(e){
  return (e.txid||e.id||'')+'\t'+(e.title||'')+'\t'+(e.author||'')+'\t'+(e.dateRead||'')+'\t'+(e.readingStartedAt||'')+'\t'+(e.createdAt||'')+'\t'+(e._deleting?'1':'0')+'\t'+(e.format||'')+'\t'+(e.readingStatus||'')+'\t'+(e.rating||'')+'\t'+(e.is_private===true?'p':'_');
}

function cardCoverChanged(card, e){
  return card._bookishCoverImage !== (e.coverImage || '') ||
    card._bookishCoverMime !== (e.mimeType || '') ||
    card._bookishCoverFit !== (e.coverFit || '');
}

function rememberCardCover(card, e){
  card._bookishCoverImage = e.coverImage || '';
  card._bookishCoverMime = e.mimeType || '';
  card._bookishCoverFit = e.coverFit || '';
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
  // #149: keep header auth chips (Account gear vs Sign in) in sync with
  // tarnService.isLoggedIn(). render() is called on every login/logout
  // transition (clearBooks → render; bookRepo.on('change') → render).
  refreshHeaderAuthState();

  const visible = entries.filter(e => e.status !== 'tombstoned');

  // Split by reading status
  const readingList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.READING);
  const readList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.READ);
  const wantList = visible.filter(e => normalizeReadingStatus(e) === READING_STATUS.WANT_TO_READ);

  // Sort each list
  readingList.sort((a,b)=> (b.readingStartedAt||b.createdAt||0) - (a.readingStartedAt||a.createdAt||0));
  readList.sort((a,b)=>{ const da=a.dateRead||0; const db=b.dateRead||0; if(da!==db) return db - da; return (b.createdAt||0)-(a.createdAt||0); });
  sortWtrList(wantList);

  // Main grid shows: reading first, then read
  const shelfEntries = [...readingList, ...readList];

  wtrDrawerController.updateHeader(wantList, { hasShelfEntries: shelfEntries.length > 0 });

  // Update WTR drawer if open
  if(wtrDrawerController.isOpen()) renderWtrDrawer(wantList);

  if(!shelfEntries.length && !wantList.length){
    const syncStatus = getSyncStatusForUI();
    const isLoading = tarnService.isLoggedIn() && !syncStatus.initialSynced;

    const headline = emptyEl.querySelector('.empty-headline');
    const subtext = emptyEl.querySelector('.empty-subtext');
    // #144: search affordance in empty state is the relocated `#omniboxWrap`
    // (moved into `#emptyOmniboxSlot`). While syncing, hide the slot so the
    // loading message reads cleanly.
    // #149/#167: declutter \u2014 `.empty-search-examples`,
    // `.empty-add-manual-link`, `#emptySignIn`, and `.empty-links` are gone.
    // The omnibox placeholder now carries the add-book affordance directly;
    // the sign-in entry point is the header chip.
    const emptySlot = emptyEl.querySelector('#emptyOmniboxSlot');
    const illustration = emptyEl.querySelector('.empty-illustration');

    if(isLoading){
      if(headline) headline.textContent = 'Syncing your books\u2026';
      if(subtext) subtext.textContent = 'Fetching your library from the cloud.';
      if(emptySlot) emptySlot.style.display = 'none';
      if(illustration) illustration.dataset.state = 'syncing';
      showShelfSkeletons(6);
      emptyEl.style.display='none';
      // While syncing we don't surface the empty-state slot - keep the
      // omnibox parked in the header so it's still available.
      setOmniboxLocation('header');
      setOmniboxVisible(true);
    } else {
      if(headline) headline.textContent = 'Build a shelf worth keeping';
      if(subtext) subtext.textContent = 'Search for a book, then keep your reading list private, portable, and yours.';
      if(emptySlot) emptySlot.style.display = '';
      if(illustration) delete illustration.dataset.state;
      if(cardsEl.children.length > 0) cardsEl.replaceChildren();
      emptyEl.style.display='block';
      // Relocate the real omnibox into the empty-state slot. Idempotent -
      // re-renders don't repeatedly move the element.
      setOmniboxLocation('empty');
    }
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
    if(yearHeader) yearHeader.style.display = 'none';
    closeSpinePanel();
    hideAccountNudge();
    return;
  }

  if(!shelfEntries.length && wantList.length){
    if(cardsEl.children.length > 0) cardsEl.replaceChildren();
    emptyEl.style.display='none';
    if(shelfEmptyEl) shelfEmptyEl.style.display = 'block';
    setOmniboxLocation('header');
    setOmniboxVisible(true);
    if(yearHeader) yearHeader.style.display = 'none';
    closeSpinePanel();
    hideAccountNudge();
    return;
  }

  emptyEl.style.display='none';
  if(shelfEmptyEl) shelfEmptyEl.style.display = 'none';
  setOmniboxLocation('header');
  setOmniboxVisible(true);
  if(tarnService.isLoggedIn()) hideAccountNudge();

  // --- Search filtering + year grouping via shelf_filter ---
  const { displayEntries, matchCount, isSearching, yearGroups, activeYear } = buildDisplayList({
    shelfEntries, wantList, searchQuery, selectedYear
  });
  _lastYearGroups = yearGroups;

  const yearList = getYearList(yearGroups).map(item => ({
    ...item,
    entries: (yearGroups.get(item.year) || []).slice(0, 4),
  }));

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
    cardsEl.innerHTML = `<div class="year-empty"><div class="year-empty-icon" aria-hidden="true"><span></span><span></span><span></span></div>No books in ${activeYear === 'Undated' ? 'Undated' : activeYear} yet</div>`;
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
    // Cards expose title + author via aria-label so screen readers and
    // keyboard focus announcements work without visible text below the cover.
    const ariaLabel = (e.title || 'Untitled') + (e.author ? ` by ${e.author}` : '');

    let card = existingMap.get(key);
    if(card){
      if(card.dataset._fp !== fp || cardCoverChanged(card, e)){
        const rawFmt=(e.format||'').toLowerCase();
        const fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
        card.className='card'+(e._deleting?' deleting':'');
        card.dataset.fmt=fmtVariant;
        card.dataset.format=rawFmt;
        if(isReading) card.dataset.reading='true'; else delete card.dataset.reading;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', ariaLabel);
        card.innerHTML=buildCardHTML(e, e._wtrResult, { showActions: true });
        attachFriendPips(card, e);
        attachPrivacyLockOverlay(card, e);
        card.dataset._fp=fp;
        rememberCardCover(card, e);
        if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
        else { card.style.pointerEvents=''; card.style.opacity=''; }
      } else {
        // Re-attach pips on every render even when fp is unchanged; the
        // friend-library cache may have repainted since last render and the
        // matching set could have grown / shrunk without the entry itself
        // changing. Cheap: getMatchingFriendBookEntries is a Map.get.
        attachFriendPips(card, e);
        attachPrivacyLockOverlay(card, e);
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
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', ariaLabel);
      card.innerHTML=buildCardHTML(e, e._wtrResult, { showActions: true });
      attachFriendPips(card, e);
      attachPrivacyLockOverlay(card, e);
      card.dataset._fp=fp;
      rememberCardCover(card, e);
      if(e._deleting){ card.style.pointerEvents='none'; card.style.opacity='0.35'; }
    }
    card.onclick=(ev)=>{
      if(e._deleting) return;
      // Inline mark-as-read button shortcut — bypasses the detail-view open.
      const markBtn = ev.target.closest?.('.card-mark-read');
      if(markBtn){
        ev.stopPropagation();
        ev.preventDefault();
        handleInlineMarkRead(e, markBtn.dataset.markReadKey || (e.txid||e.id||''));
        return;
      }
      openModalWithHero(e, card);
    };
    // Keyboard activation: Enter/Space opens detail (matches role="button" affordance).
    card.onkeydown=(ev)=>{
      if(e._deleting) return;
      if(ev.key !== 'Enter' && ev.key !== ' ') return;
      // If focus is on the mark-read affordance (span with role="button"), fire
      // mark-as-read directly. Spans don't get native Enter/Space → click, so
      // we have to dispatch the action ourselves.
      const markEl = ev.target?.closest?.('.card-mark-read');
      if(markEl){
        ev.preventDefault();
        ev.stopPropagation();
        handleInlineMarkRead(e, markEl.dataset.markReadKey || (e.txid||e.id||''));
        return;
      }
      ev.preventDefault();
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
const wtrDrawerController = createWtrDrawerController({
  refs: {
    headerBtn: wtrHeaderBtn,
    badge: wtrBadge,
    overlay: wtrOverlay,
    backdrop: wtrBackdrop,
    drawer: wtrDrawer,
    closeBtn: wtrClose,
    listEl: wtrListEl,
    emptyEl: wtrEmptyEl,
    addBtn: wtrAddBtn,
    footerAddBtn: wtrFooterAdd,
    shelfEmptyBrowseBtn: document.getElementById('shelfEmptyBrowse'),
  },
  getEntries: () => entries,
  getBookRepo: () => bookRepo,
  normalizeReadingStatus,
  wantToReadStatus: READING_STATUS.WANT_TO_READ,
  pushOverlayState,
  popOverlayState,
  attachSwipeDismiss,
  haptic,
  isTouchDevice,
  onStartReading: (key) => changeReadingStatus(key, READING_STATUS.READING),
  onOpenEntry: (entry) => openModal(entry),
  onAddBook: () => openModal(null, READING_STATUS.WANT_TO_READ),
  documentRef: document,
});

function openWtrDrawer(){ wtrDrawerController.open(); }
function closeWtrDrawer(fromPopstate = false){ wtrDrawerController.close(fromPopstate); }
function renderWtrDrawer(wantList){ wtrDrawerController.render(wantList); }

// --- Swipe-to-dismiss on bottom sheets (#87) ---
let resetModalSwipe = null;
let detachKeyboard = null;

// --- Subscription helpers (#74) ---

/** Non-tombstoned entry count - what counts against the free tier. */
function activeEntryCount(){
  return countActiveEntries(entries);
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

function openOmniboxApiResult(meta){
  openModal(null, READING_STATUS.WANT_TO_READ);

  // Reserve the cover tile space immediately so the modal opens at its final
  // size. selectItunes/selectWork runs below and would otherwise leave the
  // modal in the compact (.no-cover) state briefly.
  const inner = modal.querySelector('.modal-inner');
  if(inner) inner.classList.remove('no-cover');
  const placeholder = document.getElementById('coverPlaceholder');
  if(placeholder){ placeholder.style.display='flex'; placeholder.innerHTML=''; placeholder.classList.add('cover-skeleton-pulse'); }
  const changeLink = document.getElementById('changeCoverLink');
  if(changeLink) changeLink.style.display='none';
  const coverActions = document.getElementById('coverActions');
  if(coverActions) coverActions.style.display='none';
  const editionInfo = document.getElementById('editionInfo');
  if(editionInfo){ editionInfo.style.display='block'; editionInfo.textContent='Finding covers\u2026'; }

  setTimeout(()=>{
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
      if(titleInput) titleInput.value = meta.title || '';
      if(authorInput) authorInput.value = meta.author || '';
      form.dispatchEvent(new Event('input', {bubbles:true}));
    }
    resetMobileBookSheetViewport();
  }, 50);
}

function openOmniboxManualAdd(query){
  openModal(null, READING_STATUS.WANT_TO_READ);
  setTimeout(()=>{
    if(titleInput && query) titleInput.value = query;
    form.dispatchEvent(new Event('input', {bubbles:true}));
  }, 50);
}

// --- Omnibox controller (#157) ---
const omniboxController = createOmniboxController({
  refs: {
    wrap: omniboxWrap,
    input: omniboxInput,
    clearBtn: omniboxClear,
    dropdown: omniboxDropdown,
    shelfSection: omniboxShelfSection,
    shelfResults: omniboxShelfResults,
    addSection: omniboxAddSection,
    addResults: omniboxAddResults,
    manualAdd: omniboxManualAdd,
    mainHeader,
    headerSearchBtn,
    headerSearchCancel,
  },
  getEntries: () => entries,
  setSearchQuery: (query) => { searchQuery = query; },
  onSearchQueryChange: (query) => {
    searchQuery = query;
    render();
  },
  onRender: () => render(),
  normalizeReadingStatus,
  readingStatus: READING_STATUS,
  subscription,
  getActiveEntryCount: () => activeEntryCount(),
  onSubscribeAction: () => startSubscribeCheckout(),
  onOpenShelfEntry: (entry) => openModal(entry),
  onOpenApiResult: openOmniboxApiResult,
  onManualAdd: openOmniboxManualAdd,
  getMatchingFriendBookEntries: friendsGetMatchingFriendBookEntries,
  openFriendBookDetail,
  pushOverlayState,
  popOverlayState,
  isTouchDevice,
  documentRef: document,
  windowRef: window,
  onWarn: (...args) => console.warn(...args),
});

function setOmniboxVisible(visible){ omniboxController.setVisible(visible); }
function setOmniboxLocation(location){ omniboxController.setLocation(location); }
function positionOmniboxDropdown(){ omniboxController.positionDropdown(); }
function closeOmniboxDropdown(){ omniboxController.closeDropdown(); }
function completeOmniboxSelection(){ omniboxController.completeSelection(); }
function clearOmnibox(opts){ omniboxController.clear(opts); }
function attachOmniboxResultPips(){ omniboxController.attachResultPips(); }
function openSearchTakeover(){ omniboxController.openSearchTakeover(); }
function closeSearchTakeover(fromPopstate){ omniboxController.closeSearchTakeover(fromPopstate); }

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
const SPINE_TONE_CACHE = new Map();
const SPINE_TONE_PENDING = new Map();
const SPINE_COVER_BLEND_TOP = 0.62;
const SPINE_COVER_BLEND_BOTTOM = 0.56;
const SPINE_COVER_SATURATION_FACTOR = 0.52;
const SPINE_COVER_SATURATION_MIN = 0.08;
const SPINE_COVER_SATURATION_MAX = 0.34;
const SPINE_LIGHT_COVER_MIN_SHARE = 0.46;
const SPINE_FALLBACK_TONES = {
  0: { top: '#3c3029', bottom: '#26211e' },
  1: { top: '#38322a', bottom: '#25231f' },
  2: { top: '#31363a', bottom: '#22272a' },
  3: { top: '#3e2f28', bottom: '#28211d' },
  4: { top: '#3a3038', bottom: '#272229' },
  5: { top: '#30382f', bottom: '#222821' },
  6: { top: '#3f332b', bottom: '#29231f' },
  7: { top: '#37372e', bottom: '#25251f' },
  undated: { top: '#343434', bottom: '#242424' },
};

function clamp(n, min, max){
  return Math.max(min, Math.min(max, n));
}

function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if(max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if(max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l){
  if(s === 0){
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hueToRgb = (p, q, t)=>{
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1 / 6) return p + (q - p) * 6 * t;
    if(t < 1 / 2) return q;
    if(t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function rgbToHex({ r, g, b }){
  const part = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function hexToRgb(hex){
  const clean = String(hex || '').replace('#', '');
  if(!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 48, g: 44, b: 40 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function mixRgb(a, b, amount){
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

function paperSpineToneFromRgb(h, s, l){
  const paperS = clamp(s * 0.42, 0.04, 0.16);
  const paperL = clamp(l, 0.54, 0.68);
  const coverTop = hslToRgb(h, paperS, clamp(paperL - 0.03, 0.50, 0.64));
  const coverBottom = hslToRgb(h, paperS * 0.9, clamp(paperL - 0.22, 0.34, 0.48));
  const agedTop = { r: 184, g: 170, b: 145 };
  const agedBottom = { r: 112, g: 96, b: 74 };
  const top = mixRgb(coverTop, agedTop, 0.24);
  const bottom = mixRgb(coverBottom, agedBottom, 0.20);
  const warmEdge = { r: 196, g: 154, b: 88 };
  return {
    top: rgbToHex(top),
    bottom: rgbToHex(bottom),
    activeTop: rgbToHex(mixRgb(top, warmEdge, 0.12)),
    activeBottom: rgbToHex(mixRgb(bottom, { r: 244, g: 236, b: 216 }, 0.06)),
  };
}

function mutedSpineToneFromRgb(r, g, b, toneKey, kind = 'color'){
  const { h, s, l } = rgbToHsl(r, g, b);
  if(kind === 'paper') return paperSpineToneFromRgb(h, s, l);

  const fallback = SPINE_FALLBACK_TONES[toneKey] || SPINE_FALLBACK_TONES[0];
  const fallbackTop = hexToRgb(fallback.top);
  const fallbackBottom = hexToRgb(fallback.bottom);
  const clothS = clamp(
    s < SPINE_COVER_SATURATION_MIN ? SPINE_COVER_SATURATION_MIN : s * SPINE_COVER_SATURATION_FACTOR,
    SPINE_COVER_SATURATION_MIN,
    SPINE_COVER_SATURATION_MAX,
  );
  const clothL = clamp(l < 0.12 ? 0.18 : l * 0.86, 0.17, 0.36);
  const coverTop = hslToRgb(h, clothS, clamp(clothL + 0.05, 0.22, 0.44));
  const coverBottom = hslToRgb(h, clothS * 0.84, clamp(clothL - 0.05, 0.12, 0.30));
  const top = mixRgb(fallbackTop, coverTop, SPINE_COVER_BLEND_TOP);
  const bottom = mixRgb(fallbackBottom, coverBottom, SPINE_COVER_BLEND_BOTTOM);
  const warmEdge = { r: 196, g: 154, b: 88 };
  return {
    top: rgbToHex(top),
    bottom: rgbToHex(bottom),
    activeTop: rgbToHex(mixRgb(mixRgb(top, { r: 244, g: 236, b: 216 }, 0.10), warmEdge, 0.07)),
    activeBottom: rgbToHex(mixRgb(bottom, { r: 244, g: 236, b: 216 }, 0.08)),
  };
}

function pickCoverRgb(rgba){
  const bins = new Map();
  let fallbackR = 0, fallbackG = 0, fallbackB = 0, fallbackN = 0;
  let paperR = 0, paperG = 0, paperB = 0, paperN = 0;
  for(let i = 0; i < rgba.length; i += 4){
    const a = rgba[i + 3];
    if(a < 160) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = (max - min) / 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    fallbackR += r; fallbackG += g; fallbackB += b; fallbackN++;
    if(lum > 0.78 && sat < 0.24){
      paperR += r; paperG += g; paperB += b; paperN++;
    }
    if(lum < 0.04 && sat < 0.16) continue;
    let weight = 1 + sat * 3;
    if(lum < 0.12) weight *= 0.38;
    if(lum > 0.86 && sat < 0.24) weight *= 0.25;
    else if(lum > 0.82) weight *= 0.55;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bin = bins.get(key) || { score: 0, r: 0, g: 0, b: 0 };
    bin.score += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
    bins.set(key, bin);
  }
  let best = null;
  for(const bin of bins.values()){
    if(!best || bin.score > best.score) best = bin;
  }
  if(fallbackN > 0 && paperN / fallbackN >= SPINE_LIGHT_COVER_MIN_SHARE){
    return {
      r: paperR / paperN,
      g: paperG / paperN,
      b: paperB / paperN,
      kind: 'paper',
    };
  }
  if(best && best.score > 0){
    return {
      r: best.r / best.score,
      g: best.g / best.score,
      b: best.b / best.score,
      kind: 'color',
    };
  }
  if(fallbackN > 0){
    return { r: fallbackR / fallbackN, g: fallbackG / fallbackN, b: fallbackB / fallbackN, kind: 'color' };
  }
  return null;
}

function spineToneCacheKey(entry){
  const cover = entry?.coverImage || '';
  if(!cover) return '';
  return `${entry.txid || entry.id || ''}:${cover.length}:${cover.slice(0, 48)}`;
}

function sampleCoverSpineTone(entry){
  const key = spineToneCacheKey(entry);
  if(!key) return Promise.resolve(null);
  if(SPINE_TONE_CACHE.has(key)) return Promise.resolve(SPINE_TONE_CACHE.get(key));
  if(SPINE_TONE_PENDING.has(key)) return SPINE_TONE_PENDING.get(key);

  const promise = new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try{
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 24;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if(!ctx){ resolve(null); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(pickCoverRgb(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${entry.mimeType || 'image/jpeg'};base64,${entry.coverImage}`;
  }).then(tone => {
    SPINE_TONE_CACHE.set(key, tone);
    SPINE_TONE_PENDING.delete(key);
    return tone;
  });

  SPINE_TONE_PENDING.set(key, promise);
  return promise;
}

function applyCoverSpineTone(book, tone){
  if(!book || !tone) return;
  book.style.setProperty('--spine-tone-top', tone.top);
  book.style.setProperty('--spine-tone-bottom', tone.bottom);
  book.style.setProperty('--spine-tone-active-top', tone.activeTop);
  book.style.setProperty('--spine-tone-active-bottom', tone.activeBottom);
  book.dataset.coverTone = 'true';
}

function hydrateCoverSpineTone(book, entry){
  if(!entry?.coverImage) return;
  const toneKey = book.dataset.bookTone || '0';
  sampleCoverSpineTone(entry).then(rgb => {
    if(!book.isConnected || !rgb) return;
    applyCoverSpineTone(book, mutedSpineToneFromRgb(rgb.r, rgb.g, rgb.b, toneKey, rgb.kind));
  });
}

function spineHash(value){
  const s = String(value);
  let h = 0;
  for(let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function spineVisibleBookCount(count){
  return clamp(Math.round(count || 0), 1, 4);
}

function spineBookLayout(year, count){
  const visibleCount = spineVisibleBookCount(count);
  const hash = spineHash(year);
  const books = [];
  for(let j = 0; j < visibleCount; j++){
    books.push({
      width: 7 + ((hash >> (j * 2)) % 4),
      shortness: ((hash >> (j * 3 + 2)) % 5),
    });
  }
  return books;
}

/** Spine target width: hug the visible books while still fitting the year label. */
function spineWidth(year, count){
  const books = spineBookLayout(year, count);
  const bookWidth = books.reduce((sum, book)=>sum + book.width, 0) + Math.max(0, books.length - 1);
  const labelWidth = year === 'Undated' ? 18 : 24;
  return Math.max(32, Math.ceil(Math.max(bookWidth + 4, labelWidth + 6)));
}

function renderSpineBooks(year, count, colorOffset, entries = []){
  const group = document.createElement('span');
  group.className = 'spine-books';
  group.setAttribute('aria-hidden', 'true');

  const books = spineBookLayout(year, count);
  for(let j = 0; j < books.length; j++){
    const { width, shortness } = books[j];
    const entry = entries[j];
    const book = document.createElement('span');
    book.className = 'spine-book';
    book.dataset.bookTone = year === 'Undated' ? 'undated' : String((colorOffset + j) % SPINE_COLORS);
    if(entry?.txid || entry?.id) book.dataset.sourceEntry = entry.txid || entry.id;
    book.style.setProperty('--spine-book-width', `${width}px`);
    book.style.setProperty('--spine-book-height', `${58 - shortness}px`);
    group.appendChild(book);
    hydrateCoverSpineTone(book, entry);
  }

  return group;
}

function renderSpineNav(yearList, activeYear){
  if(!spineStrip) return;
  spineStrip.innerHTML = '';
  let prevDecade = null;
  for(let i = 0; i < yearList.length; i++){
    const { year, count, entries: yearEntries = [] } = yearList[i];
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
    btn.style.width = `${spineWidth(year, count)}px`;
    btn.appendChild(renderSpineBooks(year, count, i, yearEntries));

    // Year text — horizontal, centered over the visible spine cluster.
    const txt = document.createElement('span');
    txt.className = 'spine-label';
    txt.textContent = year === 'Undated' ? '?' : year;
    btn.appendChild(txt);

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

// #121: Removed the per-card mark-as-read (.card-done-check) click handler.
// The button was deleted from card chrome along with the multi-line reading
// label so the meta row could be a single uniform line. Mark-as-read flows
// through the detail view. The showMarkAsReadToastWithUndo helper above is
// retained for any future callers (e.g. detail-view bulk actions).

// ESC closes WTR drawer
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && wtrOverlay && wtrOverlay.style.display !== 'none'){
    closeWtrDrawer();
  }
});

// Status selector event listener (#114: with side effects + auto-save in view mode)
statusSelector?.addEventListener('click', (ev)=>{
  const btn = ev.target.closest('.status-option');
  if(!btn) return;
  const newStatus = btn.dataset.status;
  const prevStatus = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  if(_isAddMode() && !form.priorTxid.value){
    _stampStatusTransitionDates(newStatus, prevStatus);
    setReadingStatus(newStatus, { silent: true });
    updateDirty();
    return;
  }
  if(newStatus === prevStatus) return;
  haptic();
  // Stamp transition timestamps when crossing into Reading/Read for the first time.
  // (BookRepository.changeStatus also stamps these on persist; we mirror here so
  // the open modal reflects the new state immediately and auto-save sends
  // the canonical values.)
  _stampStatusTransitionDates(newStatus, prevStatus);
  setReadingStatus(newStatus);
  updateDirty();
  // Auto-save status change in view mode (#114)
  if(form.priorTxid.value) _autoSaveIfDirty();
});

// --- Change reading status (delegates to BookRepository) ---
async function changeReadingStatus(key, newStatus){
  if (!bookRepo) return;
  const result = await bookRepo.changeStatus(key, newStatus);
  if (result?.toastMessage) showStatusToast(result.toastMessage);
}

// --- Inline mark-as-read (✓ button on currently-reading cards) ---
// Snapshots prior fields, flips status to READ, surfaces toast with Undo.
async function handleInlineMarkRead(entry, key){
  if(!bookRepo || !key || !entry) return;
  haptic();
  const snapshot = {
    readingStatus: entry.readingStatus,
    dateRead: entry.dateRead,
    readingStartedAt: entry.readingStartedAt,
  };
  await bookRepo.changeStatus(key, READING_STATUS.READ);
  showMarkAsReadToastWithUndo(key, snapshot);
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

function flushPendingBookEdits(){
  if(!bookRepo?.flushPendingEdits) return;
  bookRepo.flushPendingEdits().catch(err => console.warn('[Bookish] flush pending edits failed:', err?.message || err));
}

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') flushPendingBookEdits();
});
window.addEventListener('pagehide', flushPendingBookEdits);

// --- Form handlers ---
let _formSubmitting = false;

function _buildSubmitPayloadFromForm(priorTxid){
  const rsValue = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const dateVal = form.dateRead.value;
  const payload = {
    title: (titleInput?.value||'').trim(),
    author: (authorInput?.value||'').trim(),
    format: form.format.value,
    readingStatus: rsValue
  };
  if(rsValue === READING_STATUS.READ){
    const ms = dateStringToMsNoonUtc(dateVal);
    if(ms != null) payload.dateRead = ms;
  } else if(rsValue === READING_STATUS.READING){
    payload.readingStartedAt = dateVal ? new Date(dateVal+'T00:00:00').getTime() : Date.now();
  }
  if(coverPreview.dataset.b64){
    payload.coverImage = coverPreview.dataset.b64;
    if(coverPreview.dataset.mime) payload.mimeType = coverPreview.dataset.mime;
    if(coverPreview.dataset.fit) payload.coverFit = coverPreview.dataset.fit;
  } else if(priorTxid){
    payload.coverImage = '';
    payload.mimeType = '';
  }
  const notesVal = (notesInput?.value||'').trim();
  if(notesVal) payload.notes = notesVal;
  const optVals = getOptionalFieldValues();
  if(priorTxid){
    payload.rating = optVals.rating || 0;
    payload.owned = !!optVals.owned;
    payload.tags = optVals.tags || '';
    if(!notesVal) payload.notes = '';
  } else {
    if(optVals.rating) payload.rating = optVals.rating;
    if(optVals.owned) payload.owned = optVals.owned;
    if(optVals.tags) payload.tags = optVals.tags;
  }

  // Friend-matching identifiers: capture from search state for new books only.
  // Edits leave the existing work_key/isbn13 untouched (book_repository.update merges).
  if(!priorTxid && window.bookSearch?.getSearchMeta){
    try{
      const meta=window.bookSearch.getSearchMeta()||{};
      if(meta.work_key) payload.work_key=meta.work_key;
      if(meta.isbn13) payload.isbn13=meta.isbn13;
    }catch(err){ /* non-fatal: friend-matching is optional */ }
  }
  // Per-book privacy (#129). The hidden #isPrivateInput is the single source
  // of truth for both the add-form checkbox and the edit-mode lock toggle.
  // We always forward the current value so an edit that flips public→private
  // sets `is_private: true` (publish-gate kicks in), and a flip private→public
  // explicitly sets `is_private: false` so the BookRepository edit path can
  // detect the transition (the snapshot captures pre-edit state). Without
  // explicitly forwarding `false`, buildPayloadFromEntry would omit the field
  // and the entry would still carry the stale `is_private: true` from the
  // pre-edit shape.
  if(isPrivateInput?.value === 'true') payload.is_private = true;
  else if(priorTxid) payload.is_private = false;
  return payload;
}

function commitEntryForm(){
  if(_formSubmitting) return;
  const priorTxid = form.priorTxid.value || undefined;
  if(!priorTxid && !_hasRequiredTitle()){
    _syncStatusSelectorMode();
    titleInput?.focus();
    return;
  }
  _formSubmitting = true;
  _syncStatusSelectorMode();
  const rsValue = readingStatusInput?.value || READING_STATUS.WANT_TO_READ;
  const payload = _buildSubmitPayloadFromForm(priorTxid);
  uiStatusManager.refresh();
  const toastMsg = rsValue === READING_STATUS.WANT_TO_READ ? 'Added to Want to Read' : rsValue === READING_STATUS.READING ? 'Added to Currently Reading' : (!priorTxid ? 'Added to Shelf' : null);
  haptic();
  if(priorTxid){
    closeModal();
    editServerless(priorTxid,payload).catch(()=> { appError='Couldn\u2019t save to cloud. Your book is safe locally.'; uiStatusManager.refresh(); });
  } else {
    closeModal();
    createServerless(payload).then(()=>{ if(toastMsg) showStatusToast(toastMsg); }).catch(()=> { appError='Couldn\u2019t save to cloud. Your book is safe locally.'; uiStatusManager.refresh(); });
  }
}

form.addEventListener('submit', ev => {
  ev.preventDefault();
  commitEntryForm();
});

deleteBtn?.addEventListener('click', async ()=>{ const txid=form.priorTxid.value; if(!txid) return; haptic(); closeModal(); await deleteServerless(txid); });

// header refresh removed; app auto-syncs

// newBtn removed (omnibox replaces "+ Add a Book")

// Phase 2: First-run experience event handlers
// #144: empty-state search affordance is now the relocated `#omniboxWrap`
// itself (moved into `#emptyOmniboxSlot` by `setOmniboxLocation('empty')`).
// No separate CTA button — the user taps/clicks the real input directly.
// #149: removed the `emptyAddBookBtn` and `emptySignInBtn` handlers — the
// manual-add affordance lives in the omnibox dropdown, and the sign-in
// entry point is the header `#signInHeaderBtn` chip (wired below).

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

    // Capture before init(): a failed restore can clear the persisted blob.
    const hadPersistedTarnSession = (() => {
      try { return !!localStorage.getItem('tarn:session:v1'); }
      catch { return false; }
    })();

    // Restore Tarn session from localStorage
    const sessionRestored = await tarnService.init();
    if (sessionRestored) {
      debugLog('[Bookish] Tarn session restored');
      setStatus('Signed in');
    }

    // If an existing session blob couldn't be restored (expired / tampered /
    // schema-mismatched / wrapping-key rotated), wipe the IndexedDB book cache
    // before loadFromCache() runs. Otherwise the user, who appears logged out,
    // would see previously-decrypted account books rendered on screen. Do not
    // clear for true guest mode: logged-out books intentionally live in
    // IndexedDB on this device. See #113 and the guest persistence fix.
    //
    // Mid-session auth failures (401 during sync) are intentionally NOT handled
    // here — that requires distinguishing real auth death from transient network
    // hiccups inside sync_manager.js, which is its own design problem. See the
    // follow-up issue.
    if (hadPersistedTarnSession && !tarnService.isLoggedIn()) {
      await window.bookishCache.clearAll();
    }

    // Create the BookRepository — single owner of all book data operations.
    // deriveBookId is required for the schema-first SDK (every record needs a
    // primary key); the form never sets bookId so the repo derives one on save.
    bookRepo = new BookRepository({
      cache: window.bookishCache,
      tarnService,
      deriveBookId,
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
    debugLog('[Bookish] Loaded', entries.length, 'books from cache');
    showAccountNudge();

    // Initialize sync manager
    initSyncManager({
      onStatusChange: () => uiStatusManager.refresh(),
      onBookSync: syncBooksFromTarn,
    });

    // Only start sync loop if user is logged in
    if (tarnService.isLoggedIn()) {
      debugLog('[Bookish] User logged in, starting sync loop');
      startSync();
      // Fetch subscription status for free/subscribed/lapsed gating (#74).
      // Fire-and-forget; omnibox UI reads whatever's cached at interaction time.
      subscription.fetchStatus().catch(err =>
        console.warn('[Bookish] Subscription status fetch failed:', err?.message || err)
      );
      // Handle return from Stripe Checkout (?sub=success / ?sub=cancel).
      handleStripeReturn();
      // Friends invite redemption (#118). If the user landed on /invite/:token_id
      // and is already logged in, open the accept modal. Lazy import keeps the
      // friends modules out of the boot bundle for users who never click invites.
      friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
        console.warn('[Bookish] Friends invite handler failed:', err?.message || err)
      );
      // Phase 5: engagement-milestone reminder. Increment the session
      // counter (idempotent within a page life) and render the banner if
      // the user qualifies (Model B + ≥2 sessions + ≥5 books + not
      // already saved + not dismissed this session).
      try { accountKeyReminder.init(); } catch (err) {
        console.warn('[Bookish] accountKeyReminder.init failed:', err?.message || err);
      }
    } else {
      debugLog('[Bookish] User not logged in, sync loop will not start');
      // Friends invite redemption (#118) — if they landed via /invite/... and
      // are logged out, prompt for signup/sign-in so the post-auth hook can
      // fire the accept modal.
      friendsRouter.maybePromptSignupForInvite().catch(err =>
        console.warn('[Bookish] Friends signup prompt failed:', err?.message || err)
      );
    }
  } catch(err) {
    console.error('[Bookish] IndexedDB failed to initialize:', err);
    // Fail fast with clear error message
    appError='Local storage unavailable. Your published books are safe.'; uiStatusManager.refresh();
    // Show error in UI
    if(emptyEl) {
      emptyEl.style.display='block';
      emptyEl.innerHTML = `
        <div class="storage-error-panel">
          <h2 class="storage-error-title"><span class="storage-error-mark" aria-hidden="true">!</span>Local storage error</h2>
          <p class="storage-error-copy">
            <strong>Local storage is unavailable.</strong> Bookish requires it to function.
          </p>
          <p class="storage-error-copy">
            If you have a Bookish account, your published books are safe — they're stored permanently and will re-sync when this is fixed.
          </p>
          <p class="storage-error-detail">
            <strong>Error:</strong> ${escapeHtml(err.message || 'Internal error opening backing store for indexedDB.open')}
          </p>
          <div class="storage-error-help">
            <p class="storage-error-help-title">Try these fixes</p>
            <ol class="storage-error-list">
              <li><strong>Restart your browser</strong> - browser updates can corrupt IndexedDB until restart</li>
              <li><strong>Clear site data:</strong> DevTools (F12) → Application → Clear Storage → "Clear site data"</li>
              <li><strong>Try private/incognito mode</strong> to rule out browser profile corruption</li>
              <li><strong>Check disk space</strong> - IndexedDB needs available storage</li>
              <li><strong>Try a different browser</strong> (Chrome, Edge, Firefox)</li>
              <li><strong>Disable browser extensions</strong> that might block storage</li>
            </ol>
          </div>
          <button onclick="location.reload()" class="btn secondary storage-error-retry">Reload page</button>
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

// Friends drawer header trigger (#122, #124). Wire the click listener and
// then refresh visibility based on the local "hidden" preference. After
// #124 the trigger is visible by default whenever the user is logged in;
// the refresh is purely a localStorage read, so no async needed.
wireFriendGlyphTrigger();
refreshFriendGlyphTrigger();
// Re-evaluate visibility when connections change (e.g. after an invite
// redeem) so the glyph state stays consistent if any future logic ever
// branches on connection presence again.
window.addEventListener('bookish:connections-changed', () => {
  refreshFriendGlyphTrigger();
  // Friend pips on Library cards (#126) — the friend-library match cache
  // is keyed by work_key and built from each friend's published shelf. When
  // the connection set changes (add / remove / mute), the cache is stale.
  // Drop it and re-prime; the prime emits `bookish:friend-libraries-refreshed`
  // which the render loop listens to below.
  friendsInvalidateLibraryCache();
  friendsPrimeFriendLibraryCache({ force: true }).catch(() => { /* logged inside */ });
});

// Friend pips: when the per-friend library cache repaints, re-render the
// Library grid so the new match results land on cards. Cheap — render() is
// keyed-reconciled and only innerHTML-rewrites cards whose fingerprint
// changed; the pip-attach side-effect runs on every card and reads from the
// already-warm Map.
window.addEventListener('bookish:friend-libraries-refreshed', () => {
  try { render(); } catch (err) { console.warn('[Bookish] re-render after friend-libraries-refreshed failed:', err.message); }
  // Friend pips on unisearch results (#7): when the cache repaints while the
  // omnibox dropdown is open (e.g. user adds a friend mid-search, or the
  // first prime resolves after a search has already returned), re-attach
  // pips on visible rows so they light up without the user re-typing.
  try { attachOmniboxResultPips(); } catch (err) { console.warn('[Bookish] re-attach omnibox pips after refresh failed:', err.message); }
});

// Kick off an opportunistic prime so pips appear without waiting for the
// first card click. Best-effort; failures are logged inside primeFriendLibraryCache.
// Today this returns immediately with friendCount=0 because publish-on-save
// (#8) hasn't shipped, but the wiring is correct for the moment it does.
friendsPrimeFriendLibraryCache().catch(() => { /* logged inside */ });
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
  persistOptionalFieldChange();
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
        omniboxController.isSearchTakeoverActive() ||
        (notesOverlay && notesOverlay.style.display === 'flex') ||
        (wtrOverlay && wtrOverlay.style.display === 'block'),
    });
  }
}
