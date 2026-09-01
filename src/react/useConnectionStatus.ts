import { useEffect, useState } from 'react';
import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import type { ConnectionInfo } from '../core/types.js';

/** Reactive connection status (online / slow / offline), backed by the shared connection monitor. */
export function useConnectionStatus(): ConnectionInfo {
  const [status, setStatus] = useState<ConnectionInfo>(() => getConnectionQuality());

  useEffect(() => {
    setStatus(getConnectionQuality());
    return onConnectionChange(setStatus);
  }, []);

  return status;
}
