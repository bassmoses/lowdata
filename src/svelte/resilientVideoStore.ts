import { createResilientVideoLoader } from '../media/resilientVideo.js';
import type { ResilientVideoLoaderOptions, ResilientVideoState } from '../media/resilientVideo.js';
import type { SvelteReadable } from './types.js';

export interface ResilientVideoStore extends SvelteReadable<ResilientVideoState> {
  reportPlayable(): void;
  reportError(reason?: string): void;
  retry(): void;
  /**
   * Svelte's `$store` auto-subscription unsubscribes for you, but it has no concept of "this
   * component is gone, release the loader's connection-monitor subscription and any pending
   * stall/retry timer too" — call this yourself (e.g. in `onDestroy` from `'svelte'`) or it leaks.
   */
  destroy(): void;
}

/** Svelte-store binding over `createResilientVideoLoader`. */
export function createResilientVideoStore(
  options: ResilientVideoLoaderOptions,
): ResilientVideoStore {
  const loader = createResilientVideoLoader(options);
  return {
    subscribe(run) {
      run(loader.getState());
      return loader.subscribe(run);
    },
    reportPlayable: () => loader.reportPlayable(),
    reportError: (reason) => loader.reportError(reason),
    retry: () => loader.retry(),
    destroy: () => loader.destroy(),
  };
}
