import { escapeHtml, generatedCoverColor } from './book_card.js';

export function sortWtrList(wantList) {
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

export function getWtrEntryKey(entry) {
  return entry?.txid || entry?.id || '';
}

export function getWantToReadEntries(entries, { normalizeReadingStatus, wantToReadStatus } = {}) {
  const list = (entries || []).filter(entry =>
    entry?.status !== 'tombstoned' &&
    normalizeReadingStatus?.(entry) === wantToReadStatus
  );
  return sortWtrList(list);
}

export function renderWtrDrawerList(wantList, { listEl, emptyEl } = {}) {
  if (!listEl) return;
  if (!wantList.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  const showHandle = wantList.length > 1;
  listEl.innerHTML = wantList.map(entry => {
    const key = getWtrEntryKey(entry);
    const coverDataUrl = entry.coverImage ? `data:${entry.mimeType || 'image/jpeg'};base64,${entry.coverImage}` : '';
    const coverHtml = coverDataUrl
      ? `<img src="${coverDataUrl}">`
      : `<div class="wtr-mini-cover" style="background:${generatedCoverColor(entry.title || '')}"><span class="wtr-mini-title">${escapeHtml(entry.title || '')}</span></div>`;
    return `<div class="wtr-item" data-key="${escapeHtml(key)}" draggable="${showHandle}">
      <div class="wtr-item-cover">${coverHtml}</div>
      <div class="wtr-item-info">
        <div class="wtr-item-title">${escapeHtml(entry.title || 'Untitled')}</div>
        <div class="wtr-item-author">${escapeHtml(entry.author || '')}</div>
      </div>
      <button type="button" class="wtr-start-btn" data-key="${escapeHtml(key)}">Start Reading</button>
    </div>`;
  }).join('');
}

export function attachWtrDragReorder(listEl, { getBookRepo, haptic, documentRef } = {}) {
  if (!listEl) return () => {};
  const doc = documentRef || globalThis.document;
  const listeners = [];
  let dragItem = null;
  let touchStartY = 0;
  let touchCurrentY = 0;
  let placeholder = null;
  let dragClone = null;
  let isDragging = false;
  let startedFromHandle = false;
  let longPressTimer = null;
  let longPressReady = false;

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    listeners.push([target, eventName, handler, options]);
  };

  on(listEl, 'dragstart', (event) => {
    const item = event.target.closest('.wtr-item');
    if (!item) { event.preventDefault(); return; }
    dragItem = item;
    item.classList.add('wtr-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', '');
  });

  on(listEl, 'dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!dragItem) return;
    const target = getDragTarget(event.clientY);
    if (target && target !== dragItem) {
      const rect = target.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (event.clientY < mid) {
        listEl.insertBefore(dragItem, target);
      } else {
        listEl.insertBefore(dragItem, target.nextSibling);
      }
    }
  });

  on(listEl, 'dragend', () => {
    if (dragItem) {
      dragItem.classList.remove('wtr-dragging');
      commitReorder();
      dragItem = null;
    }
  });

  on(listEl, 'touchstart', (event) => {
    const item = event.target.closest('.wtr-item');
    if (!item || event.target.closest('.wtr-start-btn')) { startedFromHandle = false; return; }
    startedFromHandle = true;
    longPressReady = false;
    dragItem = item;
    touchStartY = event.touches[0].clientY;
    touchCurrentY = touchStartY;
    longPressTimer = setTimeout(() => {
      longPressReady = true;
      if (dragItem) dragItem.classList.add('wtr-long-press');
    }, 300);
  }, { passive: true });

  on(listEl, 'touchmove', (event) => {
    if (!startedFromHandle || !dragItem) return;
    touchCurrentY = event.touches[0].clientY;

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

    event.preventDefault();

    if (!isDragging) {
      if (Math.abs(touchCurrentY - touchStartY) < 8) return;
      dragItem.classList.remove('wtr-long-press');
      isDragging = true;
      const rect = dragItem.getBoundingClientRect();
      placeholder = doc.createElement('div');
      placeholder.className = 'wtr-drag-placeholder';
      placeholder.style.height = rect.height + 'px';
      dragItem.parentNode.insertBefore(placeholder, dragItem);
      dragClone = dragItem.cloneNode(true);
      dragClone.className = 'wtr-item wtr-drag-clone';
      dragClone.style.width = rect.width + 'px';
      doc.body.appendChild(dragClone);
      dragItem.classList.add('wtr-dragging');
    }

    if (dragClone) {
      const rect = dragClone.getBoundingClientRect();
      dragClone.style.top = (touchCurrentY - rect.height / 2) + 'px';
      dragClone.style.left = dragItem.getBoundingClientRect().left + 'px';
    }

    const target = getDragTarget(touchCurrentY);
    if (target && target !== dragItem && target !== placeholder) {
      const targetRect = target.getBoundingClientRect();
      const mid = targetRect.top + targetRect.height / 2;
      if (touchCurrentY < mid) {
        listEl.insertBefore(placeholder, target);
      } else {
        listEl.insertBefore(placeholder, target.nextSibling);
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

  on(listEl, 'touchend', finishTouchDrag);
  on(listEl, 'touchcancel', finishTouchDrag);

  function getDragTarget(clientY) {
    const items = [...listEl.querySelectorAll('.wtr-item:not(.wtr-dragging):not(.wtr-drag-clone)')];
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return item;
    }
    return null;
  }

  function commitReorder() {
    const repo = getBookRepo?.();
    if (!repo) return;
    const items = listEl.querySelectorAll('.wtr-item');
    const keys = [];
    items.forEach(item => {
      if (item.dataset.key) keys.push(item.dataset.key);
    });
    if (keys.length > 1) { haptic?.(); repo.reorderWtr(keys); }
  }

  return () => {
    clearTimeout(longPressTimer);
    listeners.forEach(([target, eventName, handler, options]) => {
      target.removeEventListener(eventName, handler, options);
    });
    if (dragClone) dragClone.remove();
    if (placeholder) placeholder.remove();
  };
}

export function createWtrDrawerController({
  refs = {},
  getEntries = () => [],
  getBookRepo = () => null,
  normalizeReadingStatus,
  wantToReadStatus,
  pushOverlayState = () => {},
  popOverlayState = () => {},
  attachSwipeDismiss,
  haptic,
  isTouchDevice = false,
  onStartReading = () => {},
  onOpenEntry = () => {},
  onAddBook = () => {},
  documentRef,
} = {}) {
  const doc = documentRef || globalThis.document;
  let resetSwipe = null;

  function getWantList() {
    return getWantToReadEntries(getEntries(), { normalizeReadingStatus, wantToReadStatus });
  }

  function render(wantList = getWantList()) {
    renderWtrDrawerList(wantList, refs);
  }

  function updateHeader(wantList = getWantList(), { hasShelfEntries = false } = {}) {
    if (refs.headerBtn) {
      if (wantList.length > 0 || hasShelfEntries) {
        refs.headerBtn.style.display = '';
      }
    }
    if (refs.badge) {
      if (wantList.length > 0) {
        refs.badge.textContent = wantList.length;
        refs.badge.style.display = '';
      } else {
        refs.badge.style.display = 'none';
      }
    }
  }

  function isOpen() {
    return Boolean(refs.overlay && refs.overlay.style.display !== 'none');
  }

  function open() {
    render(getWantList());
    if (refs.overlay) refs.overlay.style.display = 'block';
    doc?.body?.classList.add('modal-open');
    pushOverlayState('wtr');
  }

  function close(fromPopstate = false) {
    if (resetSwipe) resetSwipe();
    if (refs.overlay) refs.overlay.style.display = 'none';
    doc?.body?.classList.remove('modal-open');
    if (!fromPopstate) popOverlayState();
  }

  function findEntryByKey(key) {
    return (getEntries() || []).find(entry => getWtrEntryKey(entry) === key);
  }

  refs.headerBtn?.addEventListener('click', open);
  refs.backdrop?.addEventListener('click', () => close());
  refs.closeBtn?.addEventListener('click', () => close());
  refs.addBtn?.addEventListener('click', () => { close(); onAddBook(); });
  refs.footerAddBtn?.addEventListener('click', () => { close(); onAddBook(); });
  refs.shelfEmptyBrowseBtn?.addEventListener('click', open);
  refs.listEl?.addEventListener('click', (event) => {
    const startBtn = event.target.closest('.wtr-start-btn');
    if (startBtn) {
      event.stopPropagation();
      onStartReading(startBtn.dataset.key);
      return;
    }
    const row = event.target.closest('.wtr-item');
    if (row) {
      const entry = findEntryByKey(row.dataset.key);
      if (entry) { close(); onOpenEntry(entry); }
    }
  });

  attachWtrDragReorder(refs.listEl, { getBookRepo, haptic, documentRef: doc });

  if (isTouchDevice && refs.drawer && attachSwipeDismiss) {
    const handle = refs.drawer.querySelector('.wtr-drawer-handle');
    const header = refs.drawer.querySelector('.wtr-header');
    const swipeHandles = [handle, header].filter(Boolean);
    if (swipeHandles.length) {
      resetSwipe = attachSwipeDismiss({ sheet: refs.drawer, handles: swipeHandles, onDismiss: () => close() });
    }
  }

  return { open, close, render, updateHeader, isOpen, getWantList };
}
