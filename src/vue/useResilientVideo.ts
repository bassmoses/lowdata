import { onScopeDispose, ref, type Ref } from 'vue';
import { createResilientVideoLoader } from '../media/resilientVideo.js';
import type { ResilientVideoLoaderOptions, ResilientVideoState } from '../media/resilientVideo.js';

export interface UseResilientVideoResult {
  state: Ref<ResilientVideoState>;
  reportPlayable: () => void;
  reportError: (reason?: string) => void;
  retry: () => void;
}

/**
 * Vue binding over `createResilientVideoLoader`. The loader instance is created once, on setup —
 * matching `useOfflineForm`'s contract. Wire `reportPlayable`/`reportError` to your own `<video>`
 * element's `@canplay`/`@loadeddata`/`@error`/`@stalled`.
 */
export function useResilientVideo(options: ResilientVideoLoaderOptions): UseResilientVideoResult {
  const loader = createResilientVideoLoader(options);
  const state = ref<ResilientVideoState>(loader.getState()) as Ref<ResilientVideoState>;
  const unsubscribe = loader.subscribe((next) => {
    state.value = next;
  });

  onScopeDispose(() => {
    unsubscribe();
    loader.destroy();
  });

  return {
    state,
    reportPlayable: () => loader.reportPlayable(),
    reportError: (reason) => loader.reportError(reason),
    retry: () => loader.retry(),
  };
}
