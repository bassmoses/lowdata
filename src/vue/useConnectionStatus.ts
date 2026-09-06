import { onScopeDispose, ref, type Ref } from 'vue';
import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import type { ConnectionInfo } from '../core/types.js';

/** Reactive connection status (online / slow / offline), backed by the shared connection monitor. */
export function useConnectionStatus(): Ref<ConnectionInfo> {
  const status = ref<ConnectionInfo>(getConnectionQuality()) as Ref<ConnectionInfo>;
  const unsubscribe = onConnectionChange((info) => {
    status.value = info;
  });
  onScopeDispose(unsubscribe);
  return status;
}
