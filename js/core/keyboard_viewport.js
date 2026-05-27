// keyboard_viewport.js — Smooth keyboard handling for mobile bottom sheets (#93)
// Uses visualViewport API to detect virtual keyboard and adjust sheet positioning.

const KEYBOARD_THRESHOLD = 150; // px difference to consider keyboard open

function isBookDetailPlacard(el) {
  return !!el?.classList?.contains('placard') && !!el.closest?.('.book-detail-placards');
}

function isInlineAccountEdit(el) {
  return !!el?.closest?.('.account-display-name-edit');
}

function getScrollBlock(el) {
  return isBookDetailPlacard(el) || isInlineAccountEdit(el) ? 'nearest' : 'center';
}

function shouldResizeSheet(sheet) {
  return !sheet?.classList?.contains('account-modal');
}

/**
 * Attach keyboard-aware viewport handling to a bottom sheet modal.
 * Listens for visualViewport resize events to detect keyboard open/close,
 * adjusts the sheet's max-height, and scrolls the focused input into view.
 *
 * Only activates on touch devices (pointer: coarse). No-ops on desktop.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.sheet - The .modal-inner element
 * @returns {Function} detach - Call to remove all listeners and reset styles
 */
export function attachKeyboardHandler({ sheet }) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  if (!window.matchMedia('(pointer: coarse)').matches) return () => {};

  let keyboardOpen = false;
  let rafId = null;
  let baselineHeight = Math.max(window.innerHeight || 0, vv.height || 0);
  const resizeSheet = shouldResizeSheet(sheet);

  function onViewportResize() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyLayout);
  }

  function applyLayout() {
    rafId = null;
    const viewportHeight = vv.height;
    // On iOS, window.innerHeight stays the same when keyboard opens; on
    // Android, both window.innerHeight and visualViewport.height may shrink.
    // Keep a pre-keyboard baseline so Android resize-keyboards are detected.
    const layoutHeight = window.innerHeight || viewportHeight;
    baselineHeight = Math.max(baselineHeight, layoutHeight, viewportHeight);
    const visibleHeight = Math.min(layoutHeight, viewportHeight);
    const diff = baselineHeight - visibleHeight;
    const isKbOpen = diff > KEYBOARD_THRESHOLD;
    // Only offset sheets when the layout viewport itself has not resized
    // around the keyboard. If the layout viewport already shrank, adding a
    // bottom margin pushes full-height sheets off the top of the screen.
    const bottomInset = Math.max(0, layoutHeight - viewportHeight - (vv.offsetTop || 0));

    if (isKbOpen && !keyboardOpen) {
      keyboardOpen = true;
      sheet.classList.add('keyboard-open');
      if (resizeSheet) {
        // Set max-height to fit within the visible viewport.
        sheet.style.maxHeight = visibleHeight + 'px';
        sheet.style.marginBottom = bottomInset ? bottomInset + 'px' : '';
      } else {
        sheet.style.maxHeight = '';
        sheet.style.marginBottom = '';
      }
      scrollFocusedInput();
    } else if (isKbOpen && keyboardOpen) {
      if (resizeSheet) {
        // Keyboard still open but viewport height changed (e.g., suggestions bar).
        sheet.style.maxHeight = visibleHeight + 'px';
        sheet.style.marginBottom = bottomInset ? bottomInset + 'px' : '';
      } else {
        sheet.style.maxHeight = '';
        sheet.style.marginBottom = '';
      }
      scrollFocusedInput();
    } else if (!isKbOpen && keyboardOpen) {
      keyboardOpen = false;
      sheet.classList.remove('keyboard-open');
      sheet.style.maxHeight = '';
      sheet.style.marginBottom = '';
    }
  }

  function scrollFocusedInput() {
    const focused = sheet.querySelector(':focus');
    if (!focused) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Small delay lets the layout settle after max-height change
    setTimeout(() => {
      focused.scrollIntoView({
        behavior: reducedMotion ? 'instant' : 'smooth',
        block: getScrollBlock(focused),
      });
    }, 50);
  }

  // Also scroll into view when a new input is focused while keyboard is open
  function onFocusIn(e) {
    if (!keyboardOpen) return;
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => {
        el.scrollIntoView({
          behavior: reducedMotion ? 'instant' : 'smooth',
          block: getScrollBlock(el),
        });
      }, 100);
    }
  }

  vv.addEventListener('resize', onViewportResize);
  sheet.addEventListener('focusin', onFocusIn);

  return function detach() {
    vv.removeEventListener('resize', onViewportResize);
    sheet.removeEventListener('focusin', onFocusIn);
    if (rafId) cancelAnimationFrame(rafId);
    keyboardOpen = false;
    sheet.classList.remove('keyboard-open');
    sheet.style.maxHeight = '';
    sheet.style.marginBottom = '';
  };
}
