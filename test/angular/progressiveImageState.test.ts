import { afterEach, describe, expect, it, vi } from 'vitest';
import { progressiveImageState$ } from '../../src/angular/progressiveImageState.js';
import { waitForCondition } from '../helpers/wait.js';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';

  set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }

  get src(): string {
    return this._src;
  }
}

describe('progressiveImageState$ (angular/rxjs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits the placeholder immediately, then the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const states: Array<{ src: string; isLoaded: boolean }> = [];
    const subscription = progressiveImageState$({ src: '/full.jpg', placeholder: '/tiny.jpg' }).subscribe(
      (state) => states.push(state),
    );
    expect(states[0]).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitForCondition(() => states.some((s) => s.isLoaded), {
      message: 'expected the loader to swap to the full image',
    });
    expect(states[states.length - 1]).toEqual({ src: '/full.jpg', isLoaded: true });

    subscription.unsubscribe();
  });

  it('recreates the loader for a fresh subscriber after the previous one unsubscribed (refCount teardown)', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);
    const state$ = progressiveImageState$({ src: '/full.jpg', placeholder: '/tiny.jpg' });

    const first = state$.subscribe(() => {});
    first.unsubscribe(); // drops refCount to 0 — tears the loader down

    const states: Array<{ src: string; isLoaded: boolean }> = [];
    const second = state$.subscribe((state) => states.push(state));

    expect(states[0]).toEqual({ src: '/tiny.jpg', isLoaded: false });
    await waitForCondition(() => states.some((s) => s.isLoaded));
    second.unsubscribe();
  });
});
