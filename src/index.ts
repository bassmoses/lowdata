// Root entry point: connection detection + the network client + offline forms — the common case.
// Image compression (`lowdata/media`) and React hooks (`lowdata/react`) are separate subpaths so
// apps that don't need them never bundle them. See README for the full subpath breakdown.

export {
  createLowdataClient,
  LowdataClient,
  isQueued,
  LowdataRequestError,
  defaultRetryOn,
  getConnectionQuality,
  onConnectionChange,
  ConnectionMonitor,
  createIndexedDbStorageAdapter,
  createMemoryStorageAdapter,
  CircuitBreaker,
  defaultBreakerKey,
} from './network/index.js';
export type {
  QueueItem,
  QueueItemStatus,
  HttpMethod,
  EnqueueOptions,
  QueuedResult,
  SyncEvent,
  LowdataClientConfig,
  ConnectionMonitorOptions,
  ConnectionInfo,
  ConnectionQuality,
  ConnectionListener,
  Unsubscribe,
  RequestPriority,
  RetryBackoffConfig,
  JitterStrategy,
  LowdataErrorScope,
  LowdataErrorHandler,
  EncryptionHooks,
  StorageAdapter,
  IndexedDbStorageAdapterOptions,
  CircuitBreakerConfig,
} from './network/index.js';

export { createOfflineForm } from './forms/index.js';
export type {
  OfflineForm,
  FormStatus,
  FormSubmissionDetail,
  OfflineFormConfig,
  FormRecord,
} from './forms/index.js';
