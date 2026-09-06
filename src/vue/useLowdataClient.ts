import { onScopeDispose } from 'vue';
import { createLowdataClient, type LowdataClient } from '../network/client.js';
import type { LowdataClientConfig } from '../network/types.js';

/**
 * Creates (and owns) a `LowdataClient` for the current component instance's lifetime, destroying
 * it on unmount. Unlike the React hook of the same name, no memoization dance is needed here —
 * Vue's `setup()` runs exactly once per instance, so a plain call to `createLowdataClient` already
 * only happens once.
 */
export function useLowdataClient(config?: LowdataClientConfig): LowdataClient {
  const client = createLowdataClient(config);
  onScopeDispose(() => client.destroy());
  return client;
}
