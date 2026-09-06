import { onScopeDispose, ref, type Ref } from 'vue';
import { createProgressiveImageLoader } from '../media/progressiveImage.js';
import type { ProgressiveImageState } from '../media/progressiveImage.js';

/**
 * Blur-up placeholder → full image swap, as reactive state. See `createProgressiveImageLoader`.
 * `options` is read once at setup, matching the React hook's contract — call this composable
 * fresh (e.g. behind a `:key`) if `src`/`placeholder` need to change for the same component.
 */
export function useProgressiveImage(options: {
  src: string;
  placeholder: string;
}): Ref<ProgressiveImageState> {
  const loader = createProgressiveImageLoader(options);
  const state = ref<ProgressiveImageState>(loader.getState()) as Ref<ProgressiveImageState>;
  const unsubscribe = loader.subscribe((next) => {
    state.value = next;
  });

  onScopeDispose(() => {
    unsubscribe();
    loader.destroy();
  });

  return state;
}
