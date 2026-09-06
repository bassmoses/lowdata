import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConnectionStatus } from '../../src/solid/createConnectionStatus.js';
import { setOnline } from '../helpers/dom.js';

describe('createConnectionStatus (solid)', () => {
  // This primitive reads the shared, module-singleton connection monitor (same one
  // getConnectionQuality()/onConnectionChange() use), which only refreshes its cached state on a
  // dispatched event — not merely on navigator.onLine being set. Reset it via a real dispatch
  // before each test so one test's ending state can't leak into the next as a stale initial value.
  beforeEach(() => {
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

  it('reflects the current connection quality and updates when it changes', () => {
    setOnline(true);
    let dispose!: () => void;
    const status = createRoot((d) => {
      dispose = d;
      return createConnectionStatus();
    });
    expect(status().quality).toBe('online');

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(status().quality).toBe('offline');

    dispose();
  });

  it('stops updating once the root is disposed', () => {
    setOnline(true);
    let dispose!: () => void;
    const status = createRoot((d) => {
      dispose = d;
      return createConnectionStatus();
    });
    dispose();

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(status().quality).toBe('online'); // unchanged — unsubscribed on dispose
  });
});
