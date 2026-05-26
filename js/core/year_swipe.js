export function getSwipeYearTarget(years, activeYear, direction) {
  if (!Array.isArray(years) || years.length < 2 || !activeYear) return null;
  const current = years.indexOf(activeYear);
  if (current < 0) return null;

  const next = direction === 'left' ? current + 1 : current - 1;
  return years[next] || null;
}

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.('button,a,input,textarea,select,[contenteditable="true"],[role="button"],[role="tab"]'));
}

export function attachYearSwipeNavigation(el, {
  getYears,
  getActiveYear,
  isEnabled = () => true,
  onNavigate,
  threshold = 56,
  restraint = 42,
  windowRef = window,
} = {}) {
  if (!el || typeof onNavigate !== 'function') return () => {};
  if (!windowRef.matchMedia?.('(pointer: coarse)').matches) return () => {};

  let startX = 0;
  let startY = 0;
  let tracking = false;
  let horizontal = false;

  const reset = () => {
    startX = 0;
    startY = 0;
    tracking = false;
    horizontal = false;
  };

  const onStart = ev => {
    if (!isEnabled() || ev.touches?.length !== 1 || isInteractiveTarget(ev.target)) {
      reset();
      return;
    }
    const touch = ev.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
    horizontal = false;
  };

  const onMove = ev => {
    if (!tracking || ev.touches?.length !== 1) return;
    const touch = ev.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!horizontal && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      horizontal = true;
    }
    if (horizontal) ev.preventDefault();
  };

  const onEnd = ev => {
    if (!tracking) return;
    const touch = ev.changedTouches?.[0];
    if (!touch) {
      reset();
      return;
    }
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const direction = dx < 0 ? 'left' : 'right';
    const target = Math.abs(dx) >= threshold && Math.abs(dy) <= restraint
      ? getSwipeYearTarget(getYears?.() || [], getActiveYear?.(), direction)
      : null;
    reset();
    if (target) onNavigate(target, direction);
  };

  const opts = { passive: false };
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, opts);
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', reset, { passive: true });

  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove, opts);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', reset);
  };
}
