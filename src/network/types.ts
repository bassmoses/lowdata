import type { ConnectionMonitorOptions } from '../core/connection.js';
import type { LowdataErrorHandler, RequestPriority, RetryBackoffConfig } from '../core/types.js';
import type { StorageAdapter } from '../core/storageAdapter.js';
import type { CircuitBreakerConfig } from './circuitBreaker.js';

export type QueueItemStatus =
  | 'pending'
  | 'sending'
  | 'failed'
  | 'done'
  | 'cancelled'
  /** Never sent: `maxAgeMs` elapsed before the connection allowed a send attempt. Terminal, like 'failed'. */
  | 'expired';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface QueueItem {
  id: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string | Blob | null;
  priority: RequestPriority;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  status: QueueItemStatus;
  nextAttemptAt: number;
  lastError?: string;
  meta?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: Partial<RetryBackoffConfig>;
  idempotencyKey?: string;
  /**
   * Other queue item ids that must reach `done` (or be explicitly `cancelled`) before this one is
   * eligible to send — e.g. don't sync a sale that references a still-local, not-yet-synced
   * product. A dependency left `failed`/`expired` keeps blocking indefinitely; resolve it (or
   * `queue.cancel()`/`queue.retry()` it) rather than have lowdata guess.
   */
  dependsOn?: string[];
  /** This item expires (see `'expired'` status) `maxAgeMs` after `createdAt`, if set. */
  maxAgeMs?: number;
  /** Stamped from `LowdataClientConfig.schemaVersion` at creation; read by `migrateQueueItem`. */
  schemaVersion?: number;
  /** Set internally when `LowdataClientConfig.encryption` is configured — do not set this by hand. */
  bodyEncrypted?: boolean;
}

export interface EnqueueOptions {
  priority?: RequestPriority;
  meta?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: Partial<RetryBackoffConfig>;
  idempotencyKey?: string;
  /** Skip the live attempt and go straight to the persistent queue, even if currently online. */
  forceQueue?: boolean;
  dependsOn?: string[];
  maxAgeMs?: number;
}

/** Result returned by `client.fetch()` when a request could not be sent live and was queued instead. */
export interface QueuedResult {
  queued: true;
  id: string;
  item: QueueItem;
}

export function isQueued(result: Response | QueuedResult): result is QueuedResult {
  return typeof result === 'object' && result !== null && (result as QueuedResult).queued === true;
}

export type SyncEvent =
  | { type: 'sync-start'; pending: number }
  | { type: 'item-start'; item: QueueItem }
  | { type: 'item-success'; item: QueueItem }
  | { type: 'item-failed'; item: QueueItem; willRetry: boolean }
  | { type: 'item-expired'; item: QueueItem }
  | { type: 'circuit-open'; key: string }
  /**
   * Items that are due to send but are currently being withheld — either because a `dependsOn`
   * id hasn't resolved yet, or because a circuit breaker is open for their origin. Without this,
   * a blocked item is completely invisible: no `item-start`/`item-failed` ever fires for it, so an
   * app watching `onSync` alone can't tell "still waiting its turn" apart from "silently stuck
   * forever" (e.g. its dependency permanently failed). Check `queue.list()` for the blocking
   * dependency's own status, or `queue.cancel()`/`queue.retry()` it to unblock.
   */
  | { type: 'items-blocked'; reason: 'dependency' | 'circuit-breaker'; items: QueueItem[] }
  | { type: 'sync-complete'; succeeded: number; failed: number };

/** Encrypt/decrypt hooks applied to a queue item's `body` before it is persisted / after it is read back. */
export interface EncryptionHooks {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface LowdataClientConfig {
  /** Prefixed onto every relative URL passed to `fetch()`/`queue.add()`. */
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  retry?: Partial<RetryBackoffConfig>;
  connection?: ConnectionMonitorOptions;
  /** How many queued items to send concurrently during a sync drain. Default 1 (conservative). */
  syncConcurrency?: number;
  /** Reject `queue.add()` for payloads larger than this. Default 5 MB. */
  maxQueueItemSizeBytes?: number;
  /**
   * Decide whether a failed/offline request should be queued for later instead of surfaced as an
   * error. Default: only mutating methods (POST/PUT/PATCH/DELETE) are queued; GET/HEAD are not,
   * since queuing a read rarely makes sense.
   */
  shouldQueueOffline?: (input: { url: string; method: HttpMethod }) => boolean;
  /**
   * Observe otherwise-silent internal failures (a background sync error, a fallback to an
   * in-memory queue/draft store) instead of them only producing a single `console.warn`. Useful
   * for piping into your own logging/monitoring in production.
   */
  onError?: LowdataErrorHandler;
  /**
   * Supply your own persistence backend (SQLite in an Electron main process, AsyncStorage/SQLite
   * in React Native, an in-memory adapter for tests) instead of the default IndexedDB one. See
   * `StorageAdapter` / `createIndexedDbStorageAdapter` / `createMemoryStorageAdapter`.
   */
  storage?: StorageAdapter;
  /**
   * Isolates this client's queue into its own physical database (`` `lowdata:${namespace}` ``)
   * when using the default IndexedDB adapter — e.g. one namespace per business/tenant/device
   * session, so switching context can't leak or cross-send another context's queued writes.
   * Ignored when a custom `storage` adapter is supplied (namespace that yourself).
   */
  namespace?: string;
  /** Transparently encrypts each queued item's string `body` at rest. Blob bodies are left as-is. */
  encryption?: EncryptionHooks;
  /** Backs off an entire failing endpoint together, instead of retrying every queued item against it independently. */
  circuitBreaker?: CircuitBreakerConfig;
  /**
   * Version stamped onto every newly-created queue item. Bump this when a breaking change to your
   * request shape ships, and provide `migrateQueueItem` to upgrade items enqueued by an older
   * build that are still pending when the new one runs.
   */
  schemaVersion?: number;
  /** Upgrades a queue item whose `schemaVersion` doesn't match the current one, just before it's next sent. */
  migrateQueueItem?: (item: QueueItem) => QueueItem;
  /**
   * Auto-generates an `Idempotency-Key` header (and `QueueItem.idempotencyKey`) for mutating
   * requests that don't already specify one, so retries/queued replays are safe to de-dupe
   * server-side by default. Default `true`.
   */
  autoIdempotencyKey?: boolean;
}
