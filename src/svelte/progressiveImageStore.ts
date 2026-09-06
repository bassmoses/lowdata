import { createProgressiveImageLoader } from '../media/progressiveImage.js';
import type { ProgressiveImageState } from '../media/progressiveImage.js';
import type { SvelteReadable } from './types.js';

export interface ProgressiveImageStore extends SvelteReadable<ProgressiveImageState> {
  destroy(): void;
}

/** Svelte-store binding over `createProgressiveImageLoader`. Blur-up placeholder → full image swap. */
export function createProgressiveImageStore(options: {
  src: string;
  placeholder: string;
}): ProgressiveImageStore {
  const loader = createProgressiveImageLoader(options);
  return {
    subscribe(run) {
      run(loader.getState());
      return loader.subscribe(run);
    },
    destroy: () => loader.destroy(),
  };
}
