import { onCleanup } from 'solid-js';
import { createLowdataClient as createClient, type LowdataClient } from '../network/client.js';
import type { LowdataClientConfig } from '../network/types.js';

/**
 * Creates (and owns) a `LowdataClient` for the current reactive scope, destroying it via Solid's
 * `onCleanup` — the only difference from calling `createLowdataClient` from `lowdata` directly.
 */
export function createLowdataClient(config?: LowdataClientConfig): LowdataClient {
  const client = createClient(config);
  onCleanup(() => client.destroy());
  return client;
}
