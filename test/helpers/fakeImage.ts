/**
 * Minimal `Image` stand-in for testing `createProgressiveImageLoader`/its framework bindings —
 * resolves `onload` on the next microtask after `src` is set, without ever making a real network
 * request. Shared across react/vue/svelte/angular/solid's progressive-image tests: it was
 * previously copy-pasted identically into all five.
 */
export class FakeImage {
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
