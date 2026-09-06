import { beforeEach, describe, expect, it } from 'vitest';
import { connectionStatus$ } from '../../src/angular/connectionStatus.js';
import { setOnline } from '../helpers/dom.js';

describe('connectionStatus$ (angular/rxjs)', () => {
  // This reads the shared, module-singleton connection monitor (same one
  // getConnectionQuality()/onConnectionChange() use), which only refreshes its cached state on a
  // dispatched event — not merely on navigator.onLine being set. Reset it via a real dispatch
  // before each test so one test's ending state can't leak into the next as a stale initial value.
  beforeEach(() => {
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

  it('emits the current value immediately, then updates on change', () => {
    setOnline(true);
    const values: string[] = [];
    const subscription = connectionStatus$().subscribe((info) => values.push(info.quality));

    expect(values).toEqual(['online']);

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(values).toEqual(['online', 'offline']);

    subscription.unsubscribe();
  });

  it('shares one underlying listener across multiple subscribers (shareReplay)', () => {
    setOnline(true);
    const status$ = connectionStatus$();
    const a: string[] = [];
    const b: string[] = [];
    const subA = status$.subscribe((info) => a.push(info.quality));
    const subB = status$.subscribe((info) => b.push(info.quality));

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    expect(a).toEqual(['online', 'offline']);
    expect(b).toEqual(['online', 'offline']);

    subA.unsubscribe();
    subB.unsubscribe();
  });
});
