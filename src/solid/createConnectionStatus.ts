import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import type { ConnectionInfo } from '../core/types.js';

/** Reactive connection status (online / slow / offline), backed by the shared connection monitor. */
export function createConnectionStatus(): Accessor<ConnectionInfo> {
  const [status, setStatus] = createSignal<ConnectionInfo>(getConnectionQuality());
  const unsubscribe = onConnectionChange(setStatus);
  onCleanup(unsubscribe);
  return status;
}
