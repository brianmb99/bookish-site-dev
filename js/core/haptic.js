/**
 * Haptic feedback utility (Android only — iOS PWAs don't support vibrate).
 * Feature-detects navigator.vibrate before calling.
 */
export function haptic(ms = 10) {
  if (navigator.vibrate) navigator.vibrate(ms);
}
