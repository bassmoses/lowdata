import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import type { ConnectionInfo } from '../core/types.js';
import type { SvelteReadable } from './types.js';

/**
 * A Svelte-store-contract-compatible readable of connection status. Use with `$`-auto-subscription
 * (`import { connectionStatus } from 'lowdata/svelte'; const status = connectionStatus();` then
 * `$status.quality` in a template) — Svelte itself drives subscribe/unsubscribe.
 */
export function connectionStatus(): SvelteReadable<ConnectionInfo> {
  return {
    subscribe(run) {
      run(getConnectionQuality());
      return onConnectionChange(run);
    },
  };
}
