// swipe_dismiss.js — Swipe-to-dismiss gesture for bottom sheet elements (#87)

const DISMISS_THRESHOLD = 0.3; // 30% of sheet height

/**
 * Attach swipe-to-dismiss to a bottom sheet.
 * Tracks touchmove on designated handle areas. If swiped down past
 * the threshold, animates off-screen and calls onDismiss. Otherwise
 * snaps back.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.sheet - The sheet element to transform
 * @param {HTMLElement[]} opts.handles - Touch targets for initiating swipe
 * @param {Function} opts.onDismiss - Called after dismiss completes
 * @returns {Function} reset - Clears any inline styles left by the gesture
 */
export function attachSwipeDismiss({ sheet, handles, onDismiss }) {
  let startY = 0;
  let currentY = 0;
  let tracking = false;
  let swiping = false;

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    tracking = true;
    swiping = false;
  }

  function onTouchMove(e) {
    if (!tracking) return;
    currentY = e.touches[0].clientY;
    const deltaY = currentY - startY;

    if (deltaY <= 0) {
      // Swiping up or no movement — keep sheet at origin
      if (swiping) sheet.style.transform = 'translateY(0)';
      return;
    }

    // First downward movement — lock into swipe gesture
    if (!swiping) {
      swiping = true;
      sheet.style.animation = 'none';
      sheet.style.transition = 'none';
      sheet.style.willChange = 'transform';
    }

    e.preventDefault();
    sheet.style.transform = `translateY(${deltaY}px)`;
  }

  function onTouchEnd() {
    if (!tracking) return;
    tracking = false;
    if (!swiping) return;
    swiping = false;

    const deltaY = currentY - startY;
    const sheetHeight = sheet.offsetHeight;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (deltaY > sheetHeight * DISMISS_THRESHOLD) {
      // Dismiss
      if (reducedMotion) {
        reset();
        onDismiss();
      } else {
        sheet.style.transition = 'transform .25s ease-in';
        sheet.style.transform = 'translateY(100%)';
        const onEnd = (evt) => {
          if (evt.propertyName !== 'transform') return;
          sheet.removeEventListener('transitionend', onEnd);
          reset();
          onDismiss();
        };
        sheet.addEventListener('transitionend', onEnd);
      }
    } else if (deltaY > 0) {
      // Snap back
      if (reducedMotion) {
        reset();
      } else {
        sheet.style.transition = 'transform .2s ease-out';
        sheet.style.transform = 'translateY(0)';
        const onEnd = (evt) => {
          if (evt.propertyName !== 'transform') return;
          sheet.removeEventListener('transitionend', onEnd);
          sheet.style.transition = '';
          sheet.style.willChange = '';
          sheet.style.animation = '';
        };
        sheet.addEventListener('transitionend', onEnd);
      }
    } else {
      // Swiped back to origin or above — just clean up
      reset();
    }
  }

  function reset() {
    tracking = false;
    swiping = false;
    sheet.style.transform = '';
    sheet.style.transition = '';
    sheet.style.animation = '';
    sheet.style.willChange = '';
  }

  for (const handle of handles) {
    handle.addEventListener('touchstart', onTouchStart, { passive: true });
    handle.addEventListener('touchmove', onTouchMove, { passive: false });
    handle.addEventListener('touchend', onTouchEnd);
    handle.addEventListener('touchcancel', onTouchEnd);
  }

  return reset;
}
