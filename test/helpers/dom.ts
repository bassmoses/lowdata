/**
 * Simulates `navigator.onLine` changing. Pair with dispatching a real `'online'`/`'offline'`
 * window event afterward so `ConnectionMonitor`'s listeners react to it, e.g.:
 *   setOnline(false);
 *   window.dispatchEvent(new Event('offline'));
 */
export function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}
