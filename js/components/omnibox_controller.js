import { filterBySearch } from '../core/shelf_filter.js';
import { normalizeOLDoc, normalizeItunesItem, mergeOmniboxResults } from '../core/omnibox_merge.js';
import { escapeHtml, generatedCoverColor } from './book_card.js';
import { renderPipOverlay } from './friend_pip.js';
import { coverCropStyleAttr } from '../core/cover_crop.js';

const EMPTY_LIBRARY_PLACEHOLDER = 'Add your first book';
const DEFAULT_PLACEHOLDER = 'Find or add a book';

export function activeEntryCount(entries = []) {
  return entries.filter(entry => entry?.status !== 'tombstoned').length;
}

export function renderOmniboxSubscribePrompt({ addResults, subscription }) {
  if (!addResults) return;
  const lapsed = subscription?.isLapsed?.() === true;
  const title = lapsed ? 'Your subscription lapsed' : 'Ready to add more?';
  const body = lapsed
    ? 'Renew to keep adding books \u2014 $10/year, cancel anytime.'
    : 'Add unlimited books for $10/year \u2014 less than a paperback. Cancel anytime.';
  const btnLabel = lapsed ? 'Renew \u2014 $10/year' : 'Subscribe \u2014 $10/year';
  addResults.innerHTML = `
    <div class="omnibox-subscribe-prompt${lapsed ? ' omnibox-lapsed-prompt' : ''}" role="status">
      <div class="omnibox-subscribe-title">${escapeHtml(title)}</div>
      <div class="omnibox-subscribe-body">${escapeHtml(body)}</div>
      <button type="button" class="omnibox-subscribe-btn" data-subscribe-action="${lapsed ? 'renew' : 'subscribe'}">${escapeHtml(btnLabel)}</button>
      <div class="omnibox-subscribe-dismiss">Or keep browsing your library</div>
    </div>
  `;
}

export function renderOmniboxCount({ addSection, count, subscription }) {
  if (!addSection) return;
  let el = addSection.querySelector('.omnibox-count');
  if (!subscription?.shouldShowCount?.(count)) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = addSection.ownerDocument.createElement('div');
    el.className = 'omnibox-count';
    addSection.insertBefore(el, addSection.firstChild);
  }
  el.textContent = `${count} of ${subscription.FREE_LIMIT} free books`;
}

export function renderOmniboxShelfResults({
  query,
  entries = [],
  refs = {},
  normalizeReadingStatus,
  readingStatus,
}) {
  const { shelfSection, shelfResults } = refs;
  if (!shelfResults) return;
  const visible = entries.filter(entry => entry?.status !== 'tombstoned');
  const matches = filterBySearch(visible, query).slice(0, 5);
  if (!matches.length) {
    if (shelfSection) shelfSection.style.display = 'none';
    return;
  }
  if (shelfSection) shelfSection.style.display = '';
  shelfResults.innerHTML = matches.map(entry => {
    const key = entry.txid || entry.id || '';
    const coverDataUrl = entry.coverImage ? `data:${entry.mimeType || 'image/jpeg'};base64,${entry.coverImage}` : '';
    const rs = normalizeReadingStatus?.(entry);
    let statusLabel = '';
    let statusClass = '';
    if (rs === readingStatus?.READ) { statusLabel = 'Read'; statusClass = 'status-read'; }
    else if (rs === readingStatus?.READING) { statusLabel = 'Reading'; statusClass = 'status-reading'; }
    else if (rs === readingStatus?.WANT_TO_READ) { statusLabel = 'Want to Read'; statusClass = 'status-wtr'; }
    const coverHtml = coverDataUrl
      ? `<img src="${coverDataUrl}" data-fit="${entry.coverFit || 'contain'}"${coverCropStyleAttr(entry.coverCrop)}>`
      : `<div class="omnibox-result-mini" style="background:${generatedCoverColor(entry.title || '')}">${escapeHtml((entry.title || '').slice(0, 20))}</div>`;
    const statusHtml = statusLabel
      ? `<span class="omnibox-result-status ${statusClass}">${statusLabel}</span>`
      : '';
    return `<div class="omnibox-result" data-shelf-key="${escapeHtml(key)}">
      <div class="omnibox-result-cover">${coverHtml}</div>
      <div class="omnibox-result-info">
        <div class="omnibox-result-title">${escapeHtml(entry.title || 'Untitled')}</div>
        <div class="omnibox-result-author">${escapeHtml(entry.author || '')}</div>
      </div>
      ${statusHtml}
    </div>`;
  }).join('');
}

export function renderOmniboxApiSkeletons({ addSection, addResults }) {
  if (!addResults) return;
  if (addSection) addSection.style.display = '';
  addResults.innerHTML = Array(3).fill(`<div class="omnibox-skeleton">
    <div class="omnibox-skeleton-cover"></div>
    <div class="omnibox-skeleton-text"><div class="omnibox-skeleton-line"></div><div class="omnibox-skeleton-line"></div></div>
  </div>`).join('');
}

export function renderOmniboxApiResults({ results = [], refs = {}, onAfterRender = () => {} }) {
  const { addResults } = refs;
  if (!addResults) return;
  if (!results.length) {
    addResults.innerHTML = '';
    return;
  }
  addResults.innerHTML = results.slice(0, 8).map(result => {
    const coverHtml = result.coverUrl
      ? `<img src="${result.coverUrl}">`
      : `<div class="omnibox-result-mini" style="background:${generatedCoverColor(result.title || '')}">${escapeHtml((result.title || '').slice(0, 20))}</div>`;
    const meta = [result.year, result.publisher, result.duration].filter(Boolean).join(' \u00B7 ');
    const workKey = (result.work_key && typeof result.work_key === 'string') ? result.work_key : '';
    const wkAttr = workKey ? ` data-work-key='${escapeHtml(workKey)}'` : '';
    const addLabel = result.title ? `Add ${result.title}` : 'Add book';
    return `<div class="omnibox-result" data-add-json='${encodeURIComponent(JSON.stringify(result))}'${wkAttr}>
      <div class="omnibox-result-cover">${coverHtml}</div>
      <div class="omnibox-result-info">
        <div class="omnibox-result-title">${escapeHtml(result.title || '')}</div>
        <div class="omnibox-result-author">${escapeHtml(result.author || '')}</div>
        ${meta ? `<div class="omnibox-result-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
      <button type="button" class="omnibox-result-add" aria-label="${escapeHtml(addLabel)}">Add</button>
    </div>`;
  }).join('');
  onAfterRender();
}

export function attachOmniboxResultPips({
  addResults,
  getMatchingFriendBookEntries,
  openFriendBookDetail,
  onError = () => {},
}) {
  if (!addResults) return;
  const rows = addResults.querySelectorAll('.omnibox-result[data-work-key]');
  for (const row of rows) {
    const existing = row.querySelector('.friend-pip-overlay');
    if (existing) existing.remove();

    const wk = row.dataset.workKey;
    if (!wk) continue;
    const matchEntries = getMatchingFriendBookEntries?.(wk) || [];
    if (!matchEntries.length) continue;

    const bookByShare = new Map();
    for (const match of matchEntries) {
      bookByShare.set(match.connection.share_pub, match.book);
    }
    const connections = matchEntries.map(match => match.connection);

    const overlay = renderPipOverlay(connections, {
      onTapPip: (connection) => {
        const friendBook = bookByShare.get(connection.share_pub);
        if (!friendBook) return;
        try {
          openFriendBookDetail?.({ book: friendBook, connection });
        } catch (err) {
          onError(err);
        }
      },
    });
    if (overlay) {
      overlay.classList.add('friend-pip-overlay--inline');
      const addBtn = row.querySelector('.omnibox-result-add');
      if (addBtn) row.insertBefore(overlay, addBtn);
      else row.appendChild(overlay);
    }
  }
}

export function createOmniboxController({
  refs = {},
  getEntries = () => [],
  setSearchQuery = () => {},
  onSearchQueryChange = () => {},
  onRender = () => {},
  normalizeReadingStatus,
  readingStatus,
  subscription,
  getActiveEntryCount = () => activeEntryCount(getEntries()),
  onSubscribeAction = () => {},
  onOpenShelfEntry = () => {},
  onOpenApiResult = () => {},
  onManualAdd = () => {},
  getMatchingFriendBookEntries,
  openFriendBookDetail,
  pushOverlayState = () => {},
  popOverlayState = () => {},
  isTouchDevice = false,
  fetchImpl = globalThis.fetch,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  onWarn = () => {},
} = {}) {
  let apiDebounce = null;
  let searchDebounce = null;
  let apiAbort = null;
  let apiCounter = 0;
  let selectionMade = false;
  let searchTakeoverActive = false;
  let backdrop = null;
  let emptySearchRoomTimer = null;

  function isEmptyPlacement() {
    return refs.wrap?.classList?.contains('omnibox-in-empty') === true;
  }

  function getViewportBounds() {
    const vv = windowRef?.visualViewport;
    const height = Number.isFinite(vv?.height)
      ? vv.height
      : (windowRef?.innerHeight || documentRef?.documentElement?.clientHeight || 0);
    const top = Number.isFinite(vv?.offsetTop) ? vv.offsetTop : 0;
    return { top, height, bottom: top + height };
  }

  function reducedMotion() {
    return windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  }

  function setEmptySearchActive(active) {
    const shouldActivate = Boolean(active && isTouchDevice && isEmptyPlacement());
    documentRef?.body?.classList?.toggle('empty-omnibox-active', shouldActivate);
  }

  function schedulePositionDropdown(delay = 0) {
    if (emptySearchRoomTimer) windowRef?.clearTimeout?.(emptySearchRoomTimer);
    emptySearchRoomTimer = windowRef?.setTimeout?.(() => {
      emptySearchRoomTimer = null;
      positionDropdown();
    }, delay) || null;
  }

  function nextPlaceholder() {
    return isEmptyPlacement() || count() === 0
      ? EMPTY_LIBRARY_PLACEHOLDER
      : DEFAULT_PLACEHOLDER;
  }

  function refreshPlaceholder() {
    if (!refs.input) return;
    try { refs.input.placeholder = nextPlaceholder(); }
    catch (err) { onWarn('[Bookish] omnibox placeholder rotation failed:', err?.message || err); }
  }

  function count() {
    return getActiveEntryCount();
  }

  function isAddBlocked() {
    return subscription?.isAddBlocked?.(count()) === true;
  }

  function setVisible(visible) {
    if (isTouchDevice) {
      if (refs.headerSearchBtn) refs.headerSearchBtn.style.display = visible ? '' : 'none';
    } else if (refs.wrap) {
      refs.wrap.style.display = visible ? '' : 'none';
    }
  }

  function setLocation(location) {
    if (!refs.wrap) return;
    const headerContainer = refs.mainHeader;
    const emptySlot = documentRef?.getElementById?.('emptyOmniboxSlot');
    if (location === 'empty') {
      if (emptySlot && refs.wrap.parentElement !== emptySlot) {
        emptySlot.appendChild(refs.wrap);
      }
      refs.wrap.classList.add('omnibox-in-empty');
      refs.wrap.style.display = '';
      if (refs.headerSearchBtn) refs.headerSearchBtn.style.display = 'none';
    } else {
      if (headerContainer && refs.wrap.parentElement !== headerContainer) {
        const headerActions = headerContainer.querySelector('.header-actions');
        if (headerActions) headerContainer.insertBefore(refs.wrap, headerActions);
        else headerContainer.appendChild(refs.wrap);
      }
      refs.wrap.classList.remove('omnibox-in-empty');
    }
    refreshPlaceholder();
    positionDropdown();
  }

  function positionDropdown() {
    if (!refs.dropdown || !refs.wrap) return;
    if (refs.wrap.classList.contains('omnibox-in-empty')) {
      const rect = refs.wrap.getBoundingClientRect();
      const top = rect.bottom + 4;
      const viewport = getViewportBounds();
      const availableHeight = Math.max(120, viewport.bottom - top - 8);
      refs.dropdown.style.top = (rect.bottom + 4) + 'px';
      refs.dropdown.style.left = rect.left + 'px';
      refs.dropdown.style.right = 'auto';
      refs.dropdown.style.width = rect.width + 'px';
      refs.dropdown.style.maxWidth = 'none';
      refs.dropdown.style.maxHeight = availableHeight + 'px';
    } else {
      refs.dropdown.style.top = '';
      refs.dropdown.style.left = '';
      refs.dropdown.style.right = '';
      refs.dropdown.style.width = '';
      refs.dropdown.style.maxWidth = '';
      refs.dropdown.style.maxHeight = '';
    }
  }

  function ensureEmptySearchRoom() {
    if (!isTouchDevice || !isEmptyPlacement() || !refs.wrap || !refs.dropdown) return;
    if (refs.dropdown.style.display === 'none') return;
    const rect = refs.wrap.getBoundingClientRect();
    const viewport = getViewportBounds();
    const dropdownTop = rect.bottom + 4;
    const desiredHeight = Math.min(320, Math.max(220, viewport.height * 0.46));
    const availableHeight = viewport.bottom - dropdownTop - 8;
    if (availableHeight >= desiredHeight) return;

    const delta = Math.ceil(desiredHeight - availableHeight);
    if (typeof windowRef?.scrollBy === 'function') {
      windowRef.scrollBy({
        top: delta,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
      schedulePositionDropdown(120);
    } else if (typeof refs.wrap.scrollIntoView === 'function') {
      refs.wrap.scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      schedulePositionDropdown(120);
    }
  }

  function handleViewportChange() {
    if (!isEmptyPlacement()) return;
    positionDropdown();
    ensureEmptySearchRoom();
  }

  windowRef?.addEventListener?.('resize', () => {
    if (refs.wrap && refs.wrap.classList.contains('omnibox-in-empty')) {
      positionDropdown();
    }
  });
  windowRef?.visualViewport?.addEventListener?.('resize', handleViewportChange);
  windowRef?.visualViewport?.addEventListener?.('scroll', handleViewportChange);

  function showDropdown() {
    if (!refs.dropdown) return;
    setEmptySearchActive(true);
    refs.dropdown.style.display = '';
    positionDropdown();
    ensureEmptySearchRoom();
    refs.input?.setAttribute('aria-expanded', 'true');
    if (!backdrop) {
      backdrop = documentRef.createElement('div');
      backdrop.className = 'omnibox-backdrop';
      backdrop.addEventListener('click', () => clear());
    }
    if (!backdrop.parentNode) documentRef.body.appendChild(backdrop);
  }

  function closeDropdown() {
    if (refs.dropdown) refs.dropdown.style.display = 'none';
    setEmptySearchActive(false);
    refs.input?.setAttribute('aria-expanded', 'false');
    if (backdrop?.parentNode) backdrop.remove();
  }

  function abortApi() {
    if (apiAbort) {
      apiAbort.abort();
      apiAbort = null;
    }
  }

  function completeSelection() {
    selectionMade = true;
    if (refs.input) refs.input.value = '';
    setSearchQuery('');
    if (refs.clearBtn) refs.clearBtn.style.display = 'none';
    closeDropdown();
    abortApi();
    if (searchTakeoverActive) closeSearchTakeover();
  }

  function clear(options = {}) {
    if (refs.input) refs.input.value = '';
    setSearchQuery('');
    if (refs.clearBtn) refs.clearBtn.style.display = 'none';
    closeDropdown();
    abortApi();
    if (refs.shelfSection) refs.shelfSection.style.display = 'none';
    if (refs.addSection) refs.addSection.style.display = 'none';
    if (refs.manualAdd) refs.manualAdd.style.display = 'none';
    onRender();
    if (options.refocus !== false) refs.input?.focus();
  }

  function renderShelfResults(query) {
    renderOmniboxShelfResults({
      query,
      entries: getEntries(),
      refs,
      normalizeReadingStatus,
      readingStatus,
    });
  }

  function renderCount() {
    renderOmniboxCount({ addSection: refs.addSection, count: count(), subscription });
  }

  function renderSubscribePrompt() {
    renderOmniboxSubscribePrompt({ addResults: refs.addResults, subscription });
  }

  function renderApiSkeletons() {
    renderOmniboxApiSkeletons({ addSection: refs.addSection, addResults: refs.addResults });
  }

  function renderApiResults(results) {
    renderOmniboxApiResults({
      results,
      refs,
      onAfterRender: attachResultPips,
    });
  }

  function attachResultPips() {
    attachOmniboxResultPips({
      addResults: refs.addResults,
      getMatchingFriendBookEntries,
      openFriendBookDetail,
      onError: (err) => onWarn('[Bookish] omnibox friend-pip tap failed to open modal:', err?.message || err),
    });
  }

  function searchApis(query) {
    if (isAddBlocked()) {
      renderSubscribePrompt();
      return;
    }
    abortApi();
    const controller = new AbortController();
    apiAbort = controller;
    const signal = controller.signal;
    const mySearch = ++apiCounter;
    const isStale = () => mySearch !== apiCounter || signal.aborted;
    const term = encodeURIComponent(query);
    const fields = 'key,title,author_name,cover_i,first_publish_year,isbn,subtitle,language';
    const olUrl = `https://openlibrary.org/search.json?q=${term}&limit=15&fields=${fields}`;
    const itUrl = `https://itunes.apple.com/search?media=audiobook&term=${term}&limit=8`;

    renderApiSkeletons();

    let olResults = [];
    let itResults = [];

    function mergeAndShow() {
      if (isStale()) return;
      renderApiResults(mergeOmniboxResults({ itunesResults: itResults, olResults, query }));
    }

    fetchImpl(olUrl, { signal }).then(r => r.json()).then(json => {
      if (isStale()) return;
      olResults = (json.docs || []).slice(0, 10).map(normalizeOLDoc);
      mergeAndShow();
    }).catch(err => { if (err.name !== 'AbortError') mergeAndShow(); });

    fetchImpl(itUrl, { signal }).then(r => r.json()).then(json => {
      if (isStale()) return;
      itResults = (json.results || []).slice(0, 6).map(normalizeItunesItem);
      mergeAndShow();
    }).catch(err => { if (err.name !== 'AbortError') mergeAndShow(); });
  }

  function handleInput() {
    if (selectionMade) return;

    const query = (refs.input?.value || '').trim();
    if (refs.clearBtn) refs.clearBtn.style.display = query ? '' : 'none';

    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      onSearchQueryChange(query);
    }, 150);

    if (query.length > 0) {
      showDropdown();
      renderShelfResults(query);
      if (refs.addSection) refs.addSection.style.display = '';

      if (isAddBlocked()) {
        if (refs.manualAdd) refs.manualAdd.style.display = 'none';
        abortApi();
        clearTimeout(apiDebounce);
        renderCount();
        renderSubscribePrompt();
      } else {
        if (refs.manualAdd) refs.manualAdd.style.display = '';
        renderCount();
        clearTimeout(apiDebounce);
        apiDebounce = setTimeout(() => searchApis(query), 350);
      }
    } else {
      closeDropdown();
      abortApi();
    }
  }

  function handleDropdownClick(event) {
    const subscribeBtn = event.target.closest('[data-subscribe-action]');
    if (subscribeBtn) {
      event.preventDefault();
      event.stopPropagation();
      onSubscribeAction();
      return;
    }

    const shelfRow = event.target.closest('[data-shelf-key]');
    if (shelfRow) {
      const key = shelfRow.dataset.shelfKey;
      const entry = getEntries().find(item => (item.txid || item.id) === key);
      if (entry) {
        completeSelection();
        onOpenShelfEntry(entry);
      }
      return;
    }

    const addRow = event.target.closest('[data-add-json]');
    if (addRow) {
      try {
        const meta = JSON.parse(decodeURIComponent(addRow.dataset.addJson));
        completeSelection();
        onOpenApiResult(meta);
      } catch {}
    }
  }

  function openSearchTakeover() {
    if (!refs.mainHeader || !isTouchDevice || searchTakeoverActive) return;
    searchTakeoverActive = true;
    refs.mainHeader.classList.add('search-takeover');
    if (refs.wrap) refs.wrap.style.display = '';
    pushOverlayState('search');
    setTimeout(() => {
      refs.input?.focus();
    }, 50);
  }

  function closeSearchTakeover(fromPopstate = false) {
    if (!refs.mainHeader || !searchTakeoverActive) return;
    searchTakeoverActive = false;
    refs.input?.blur();
    refs.mainHeader.classList.remove('search-takeover');
    clear({ refocus: false });
    if (!fromPopstate) popOverlayState();
  }

  refs.input?.addEventListener('input', handleInput);
  refs.clearBtn?.addEventListener('click', () => clear());
  refs.input?.addEventListener('mousedown', () => { selectionMade = false; });
  refs.input?.addEventListener('focus', () => {
    selectionMade = false;
    setEmptySearchActive(true);
    schedulePositionDropdown();
  });
  refs.input?.addEventListener('blur', () => {
    windowRef?.setTimeout?.(() => {
      if (!refs.dropdown || refs.dropdown.style.display === 'none') setEmptySearchActive(false);
    }, 80);
  });
  refs.input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (searchTakeoverActive) closeSearchTakeover();
    else clear();
  });
  refs.dropdown?.addEventListener('click', handleDropdownClick);
  refs.manualAdd?.addEventListener('click', () => {
    const query = (refs.input?.value || '').trim();
    completeSelection();
    onManualAdd(query);
  });
  refs.headerSearchBtn?.addEventListener('click', openSearchTakeover);
  refs.headerSearchCancel?.addEventListener('click', () => closeSearchTakeover());

  refreshPlaceholder();

  return {
    setVisible,
    setLocation,
    positionDropdown,
    showDropdown,
    closeDropdown,
    completeSelection,
    clear,
    renderShelfResults,
    renderApiSkeletons,
    renderApiResults,
    attachResultPips,
    searchApis,
    openSearchTakeover,
    closeSearchTakeover,
    isSearchTakeoverActive: () => searchTakeoverActive,
    hasInputValue: () => Boolean(refs.input?.value),
  };
}
