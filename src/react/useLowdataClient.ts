import { useEffect, useMemo, useRef } from 'react';
import { createLowdataClient, type LowdataClient } from '../network/client.js';
import type { LowdataClientConfig } from '../network/types.js';

/**
 * Creates (and owns) a `LowdataClient` for the component's lifetime, destroying it on unmount.
 * The config is only read once, on first render — pass a stable object if you need to change it.
 */
export function useLowdataClient(config?: LowdataClientConfig): LowdataClient {
  const configRef = useRef(config);
  const client = useMemo(() => createLowdataClient(configRef.current), []);

  useEffect(() => {
    return () => client.destroy();
  }, [client]);

  return client;
}
