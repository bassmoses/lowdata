import { Emitter } from '../core/events.js';
import type { Unsubscribe } from '../core/types.js';

export interface ProgressiveImageState {
  src: string;
  isLoaded: boolean;
  /** The full-size image failed to load (404, network error, corrupt file) — `src` stays the placeholder and stays that way; nothing will retry it on its own. */
  error?: boolean;
}

export interface ProgressiveImageLoaderOptions {
  src: string;
  placeholder: string;
}

export interface ProgressiveImageLoader {
  subscribe(callback: (state: ProgressiveImageState) => void): Unsubscribe;
  getState(): ProgressiveImageState;
  destroy(): void;
}

/**
 * Blur-up / placeholder helper: reports the (typically tiny, inlined) placeholder immediately,
 * preloads the full-size image in the background, and reports the swap once it's ready.
 * Framework-agnostic — `lowdata/react`'s `useProgressiveImage` is a thin hook over this.
 */
export function createProgressiveImageLoader(
  options: ProgressiveImageLoaderOptions,
): ProgressiveImageLoader {
  const emitter = new Emitter<ProgressiveImageState>();
  let state: ProgressiveImageState = { src: options.placeholder, isLoaded: false };
  let disposed = false;

  const img = typeof Image !== 'undefined' ? new Image() : undefined;
  if (img) {
    img.onload = () => {
      if (disposed) return;
      state = { src: options.src, isLoaded: true };
      emitter.emit(state);
    };
    // Without this, a 404/corrupt/network-failed full-size image left the loader silently
    // reporting the placeholder forever — no error, no timeout, nothing distinguishing "still
    // loading" from "will never load". `src` stays the placeholder (nothing better to show); only
    // `error` flips, so a consumer can render its own fallback instead of waiting indefinitely.
    img.onerror = () => {
      if (disposed) return;
      state = { ...state, error: true };
      emitter.emit(state);
    };
    img.src = options.src;
  } else {
    // No Image constructor available (SSR) — nothing to preload; report the target src directly.
    state = { src: options.src, isLoaded: true };
  }

  return {
    subscribe: (callback) => emitter.subscribe(callback),
    getState: () => state,
    destroy: () => {
      disposed = true;
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
      emitter.clear();
    },
  };
}
