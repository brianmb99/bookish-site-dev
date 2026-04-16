// keyboard_viewport.js — Smooth keyboard handling for mobile bottom sheets (#93)
// Uses visualViewport API to detect virtual keyboard and adjust sheet positioning.

const KEYBOARD_THRESHOLD = 150; // px difference to consider keyboard open

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

  function onViewportResize() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyLayout);
  }

  function applyLayout() {
    rafId = null;
    const viewportHeight = vv.height;
    // On iOS, window.innerHeight stays the same when keyboard opens,
    // but visualViewport.height shrinks. On Android, both may shrink.
    // Use the initial stored height or window.innerHeight as baseline.
    const fullHeight = window.innerHeight;
    const diff = fullHeight - viewportHeight;
    const isKbOpen = diff > KEYBOARD_THRESHOLD;

    if (isKbOpen && !keyboardOpen) {
      keyboardOpen = true;
      sheet.classList.add('keyboard-open');
      // Set max-height to fit within the visible viewport
      sheet.style.maxHeight = viewportHeight + 'px';
      scrollFocusedInput();
    } else if (isKbOpen && keyboardOpen) {
      // Keyboard still open but viewport height changed (e.g., suggestions bar)
      sheet.style.maxHeight = viewportHeight + 'px';
      scrollFocusedInput();
    } else if (!isKbOpen && keyboardOpen) {
      keyboardOpen = false;
      sheet.classList.remove('keyboard-open');
      sheet.style.maxHeight = '';
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
        block: 'center',
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
          block: 'center',
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
  };
}
