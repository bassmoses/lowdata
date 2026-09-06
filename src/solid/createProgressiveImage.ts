import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { createProgressiveImageLoader } from '../media/progressiveImage.js';
import type { ProgressiveImageState } from '../media/progressiveImage.js';

/** Blur-up placeholder → full image swap, as a reactive signal. See `createProgressiveImageLoader`. */
export function createProgressiveImage(options: {
  src: string;
  placeholder: string;
}): Accessor<ProgressiveImageState> {
  const loader = createProgressiveImageLoader(options);
  const [state, setState] = createSignal<ProgressiveImageState>(loader.getState());
  const unsubscribe = loader.subscribe(setState);

  onCleanup(() => {
    unsubscribe();
    loader.destroy();
  });

  return state;
}
