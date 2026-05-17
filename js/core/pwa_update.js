export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function noop() {}

function getDefaultWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function getDefaultNavigator() {
  return typeof navigator !== 'undefined' ? navigator : null;
}

/**
 * Register the service worker and surface waiting updates without surprising
 * the user. A new worker waits by default; we only ask it to skip waiting
 * after the user accepts the refresh action.
 */
export function initPwaUpdateManager(options = {}) {
  const windowRef = options.windowRef || getDefaultWindow();
  const navigatorRef = options.navigatorRef || getDefaultNavigator();
  const serviceWorker = navigatorRef?.serviceWorker;
  if (!windowRef || !serviceWorker) return null;

  const serviceWorkerUrl = options.serviceWorkerUrl || './sw.js';
  const updateIntervalMs = options.updateIntervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const onUpdateReady = options.onUpdateReady || noop;
  const onError = options.onError || ((err) => console.warn('SW registration failed:', err));

  let registration = null;
  let intervalId = null;
  let promptedWorker = null;
  let refreshAccepted = false;

  const hasController = () => Boolean(serviceWorker.controller);

  const refresh = () => {
    refreshAccepted = true;
    if (registration?.waiting) {
      registration.waiting.postMessage('SKIP_WAITING');
      return;
    }
    windowRef.location?.reload?.();
  };

  const notifyWaitingUpdate = (reg) => {
    if (!reg?.waiting || !hasController() || promptedWorker === reg.waiting) return;
    promptedWorker = reg.waiting;
    onUpdateReady({
      registration: reg,
      worker: reg.waiting,
      refresh,
    });
  };

  const watchRegistration = (reg) => {
    notifyWaitingUpdate(reg);
    reg.addEventListener?.('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener?.('statechange', () => {
        if (worker.state === 'installed') notifyWaitingUpdate(reg);
      });
    });
  };

  const checkForUpdates = async () => {
    if (!registration?.update) return undefined;
    try {
      const result = await registration.update();
      notifyWaitingUpdate(registration);
      return result;
    } catch (err) {
      onError(err);
      return undefined;
    }
  };

  const register = async () => {
    try {
      registration = await serviceWorker.register(serviceWorkerUrl);
      watchRegistration(registration);
      await checkForUpdates();
      if (updateIntervalMs > 0 && windowRef.setInterval) {
        intervalId = windowRef.setInterval(() => { checkForUpdates(); }, updateIntervalMs);
      }
    } catch (err) {
      onError(err);
    }
  };

  const onControllerChange = () => {
    if (!refreshAccepted) return;
    refreshAccepted = false;
    windowRef.location?.reload?.();
  };

  windowRef.addEventListener?.('load', register, { once: true });
  serviceWorker.addEventListener?.('controllerchange', onControllerChange);

  return {
    checkForUpdates,
    destroy: () => {
      if (intervalId !== null && windowRef.clearInterval) windowRef.clearInterval(intervalId);
      serviceWorker.removeEventListener?.('controllerchange', onControllerChange);
    },
    getRegistration: () => registration,
    refresh,
  };
}
