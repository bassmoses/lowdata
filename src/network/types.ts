import type { ConnectionMonitorOptions } from '../core/connection.js';
import type { RequestPriority, RetryBackoffConfig } from '../core/types.js';

export type QueueItemStatus = 'pending' | 'sending' | 'failed' | 'done' | 'cancelled';
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
}

export interface EnqueueOptions {
  priority?: RequestPriority;
  meta?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: Partial<RetryBackoffConfig>;
  idempotencyKey?: string;
  /** Skip the live attempt and go straight to the persistent queue, even if currently online. */
  forceQueue?: boolean;
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
  | { type: 'sync-complete'; succeeded: number; failed: number };

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
}
