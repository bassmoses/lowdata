import { effectScope } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { useConnectionStatus } from '../../src/vue/useConnectionStatus.js';
import { setOnline } from '../helpers/dom.js';

describe('useConnectionStatus (vue)', () => {
  // These composables read the shared, module-singleton connection monitor (same one
  // getConnectionQuality()/onConnectionChange() use), which only refreshes its cached state on a
  // dispatched event — not merely on navigator.onLine being set. Reset it via a real dispatch
  // before each test so one test's ending state can't leak into the next as a stale initial value.
  beforeEach(() => {
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

  it('reflects the current connection quality and updates when it changes', () => {
    setOnline(true);
    const scope = effectScope();
    const status = scope.run(() => useConnectionStatus())!;
    expect(status.value.quality).toBe('online');

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(status.value.quality).toBe('offline');

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(status.value.quality).toBe('online');

    scope.stop();
  });

  it('stops updating once the scope is stopped', () => {
    setOnline(true);
    const scope = effectScope();
    const status = scope.run(() => useConnectionStatus())!;
    scope.stop();

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(status.value.quality).toBe('online'); // unchanged — unsubscribed on scope stop
  });
});
