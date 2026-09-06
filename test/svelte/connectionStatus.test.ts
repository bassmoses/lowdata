import { beforeEach, describe, expect, it } from 'vitest';
import { connectionStatus } from '../../src/svelte/connectionStatus.js';
import { setOnline } from '../helpers/dom.js';

describe('connectionStatus (svelte store)', () => {
  // This store reads the shared, module-singleton connection monitor (same one
  // getConnectionQuality()/onConnectionChange() use), which only refreshes its cached state on a
  // dispatched event — not merely on navigator.onLine being set. Reset it via a real dispatch
  // before each test so one test's ending state can't leak into the next as a stale initial value.
  beforeEach(() => {
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

  it('immediately supplies the current value on subscribe, then updates', () => {
    setOnline(true);
    const store = connectionStatus();
    const values: string[] = [];
    const unsubscribe = store.subscribe((info) => values.push(info.quality));

    expect(values).toEqual(['online']); // supplied synchronously, matching the Svelte store contract

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(values).toEqual(['online', 'offline']);

    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    setOnline(true);
    const store = connectionStatus();
    const values: string[] = [];
    const unsubscribe = store.subscribe((info) => values.push(info.quality));
    unsubscribe();

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(values).toEqual(['online']);
  });
});
