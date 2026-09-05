import { ConnectionMonitor } from '../core/connection.js';
import { createQueueBroadcast, type QueueBroadcast } from '../core/broadcast.js';
import { Emitter } from '../core/events.js';
import { createId } from '../core/id.js';
import {
  createIndexedDbStorageAdapter,
  type StorageAdapter,
} from '../core/storageAdapter.js';
import { LOWDATA_DB_NAME, LOWDATA_STORES } from '../core/idb.js';
import type {
  ConnectionInfo,
  ConnectionListener,
  LowdataErrorHandler,
  Unsubscribe,
} from '../core/types.js';
import { LowdataRequestError } from './errors.js';
import { RequestQueue, type QueueListFilter } from './queue.js';
import { attemptWithRetry } from './retry.js';
import { SyncManager } from './sync.js';
import type {
  EnqueueOptions,
  HttpMethod,
  LowdataClientConfig,
  QueueItem,
  QueuedResult,
  SyncEvent,
} from './types.js';

const DEFAULT_MAX_QUEUE_ITEM_BYTES = 5 * 1024 * 1024; // 5 MB
const MUTATING_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

function defaultShouldQueueOffline({ method }: { url: string; method: HttpMethod }): boolean {
  return MUTATING_METHODS.has(method);
}

const defaultOnError: LowdataErrorHandler = (error, { scope }) => {
  console.warn(`lowdata: internal error (${scope})`, error);
};

function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

/** Only string/Blob bodies can be durably queued; other BodyInit shapes fail loudly, not silently. */
function normalizeQueueableBody(body: string | Blob | null | undefined): string | Blob | null {
  if (body == null) return null;
  if (typeof body === 'string' || body instanceof Blob) return body;
  throw new TypeError(
    'lowdata: only string or Blob request bodies can be queued for offline delivery. ' +
      'Serialize your payload (e.g. JSON.stringify) or pass a Blob/File before queuing.',
  );
}

function bodySizeBytes(body: string | Blob | null): number {
  if (body === null) return 0;
  return typeof body === 'string' ? new Blob([body]).size : body.size;
}

export class LowdataClient {
  readonly connection: {
    getStatus: () => ConnectionInfo;
    subscribe: (listener: ConnectionListener) => Unsubscribe;
  };
  readonly queue: {
    add: (
      item: Omit<
        QueueItem,
        'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status' | 'nextAttemptAt'
      >,
    ) => Promise<QueueItem>;
    cancel: (id: string) => Promise<void>;
    /** Moves a terminal (`failed`/`expired`/`cancelled`) item back to `pending` for another attempt. */
    retry: (id: string) => Promise<void>;
    list: (filter?: QueueListFilter) => Promise<QueueItem[]>;
    clear: () => Promise<void>;
    /**
     * Fires with the current queue snapshot whenever it changes — in this tab (an enqueue, a
     * sync outcome) or, via `BroadcastChannel`, in any other open tab. Useful for a UI that shows
     * queue/sync status regardless of which tab is actually doing the sending.
     */
    subscribe: (listener: (items: QueueItem[]) => void) => Unsubscribe;
  };

  private monitor: ConnectionMonitor;
  private storage: StorageAdapter;
  private requestQueue: RequestQueue;
  private syncManager: SyncManager;
  private syncEmitter = new Emitter<SyncEvent>();
  private broadcast: QueueBroadcast;
  private destroyed = false;

  constructor(private config: LowdataClientConfig = {}) {
    const onError = config.onError ?? defaultOnError;
    const storage: StorageAdapter =
      config.storage ??
      createIndexedDbStorageAdapter({
        dbName: config.namespace ? `${LOWDATA_DB_NAME}:${config.namespace}` : LOWDATA_DB_NAME,
        stores: LOWDATA_STORES,
        onError,
      });
    this.storage = storage;

    this.monitor = new ConnectionMonitor(config.connection);
    this.requestQueue = new RequestQueue(storage, config.encryption, onError);
    this.broadcast = createQueueBroadcast(
      config.namespace ? `lowdata-queue:${config.namespace}` : undefined,
    );
    this.syncManager = new SyncManager({
      queue: this.requestQueue,
      connection: this.monitor,
      storage,
      retryConfig: config.retry,
      syncConcurrency: config.syncConcurrency,
      circuitBreaker: config.circuitBreaker,
      schemaVersion: config.schemaVersion,
      migrateQueueItem: config.migrateQueueItem,
      onEvent: (event) => {
        this.syncEmitter.emit(event);
        this.broadcast.post();
      },
      onError,
    });

    this.connection = {
      getStatus: () => this.monitor.getStatus(),
      subscribe: (listener) => this.monitor.subscribe(listener),
    };
    this.queue = {
      add: (item) => this.enqueue(item),
      cancel: (id) => this.cancelQueued(id),
      retry: (id) => this.retryQueued(id),
      list: (filter) => this.requestQueue.list(filter),
      clear: () => this.requestQueue.clear(),
      subscribe: (listener) => this.subscribeToQueue(listener),
    };
  }

  onSync(listener: (event: SyncEvent) => void): Unsubscribe {
    return this.syncEmitter.subscribe(listener);
  }

  /**
   * Drop-in `fetch()` wrapper: retries transient failures with backoff, and — for mutating
   * requests that still can't get through — falls back to the persistent offline queue instead
   * of losing the request. Returns a `QueuedResult` (check with `isQueued()`) when queued.
   */
  async fetch(
    url: string,
    init: RequestInit & EnqueueOptions = {},
  ): Promise<Response | QueuedResult> {
    if (this.destroyed) throw new Error('lowdata: this client has been destroyed');

    const fullUrl = this.resolveUrl(url);
    const method = (init.method ?? 'GET').toUpperCase() as HttpMethod;
    const shouldQueueOffline = this.config.shouldQueueOffline ?? defaultShouldQueueOffline;
    const canQueue = shouldQueueOffline({ url: fullUrl, method });
    const isOffline = this.monitor.getStatus().quality === 'offline';

    // Generated once and reused for both the live attempt (every internal retry.ts attempt shares
    // the same `init`/headers already) and a subsequent queued fallback, so a request that starts
    // live and only later gets queued still carries one consistent idempotency key end to end.
    const idempotencyKey = this.resolveIdempotencyKey(init.idempotencyKey, method);
    const headers = {
      ...this.config.defaultHeaders,
      ...normalizeHeaders(init.headers),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };

    if ((init.forceQueue || isOffline) && canQueue) {
      return this.enqueueFromInit(fullUrl, method, { ...init, headers, idempotencyKey });
    }
    if (init.forceQueue || isOffline) {
      // Not queueable (e.g. a GET) and we're offline — surface a clear network error instead of
      // silently attempting (and failing) a doomed fetch.
      throw new LowdataRequestError('Offline and this request is not configured to be queued', {
        isNetworkError: true,
        attempt: 0,
      });
    }

    try {
      return await attemptWithRetry({
        url: fullUrl,
        init: { ...init, headers },
        retryConfig: { ...this.config.retry, ...init.retry },
        timeoutMs: init.timeoutMs,
        signal: init.signal ?? undefined,
        shouldContinue: () => this.monitor.getStatus().quality !== 'offline',
      });
    } catch (err) {
      if (init.signal?.aborted) throw err; // explicit cancellation — never silently queue
      if (canQueue) {
        return this.enqueueFromInit(fullUrl, method, { ...init, headers, idempotencyKey });
      }
      throw err;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.syncManager.destroy();
    this.monitor.destroy();
    this.syncEmitter.clear();
    this.broadcast.destroy();
    void this.storage.destroy?.();
  }

  private resolveUrl(url: string): string {
    if (!this.config.baseUrl || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    return `${this.config.baseUrl.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
  }

  /**
   * Shared by both `fetch()` (a request that may go live or queued) and `persistNewQueueItem()`
   * (a request added directly via `queue.add()`, which never goes live at all) — previously
   * duplicated with two subtly different conditions (one keyed off `shouldQueueOffline`'s
   * potentially-customized `canQueue`, the other off the method directly). Idempotency is about
   * "is this mutating", not "is this configured to be queued when offline", so both call sites
   * now key off the method alone.
   */
  private resolveIdempotencyKey(existingKey: string | undefined, method: HttpMethod): string | undefined {
    if (existingKey) return existingKey;
    if (this.config.autoIdempotencyKey === false) return undefined;
    if (!MUTATING_METHODS.has(method)) return undefined;
    return createId();
  }

  private maxQueueItemBytes(): number {
    return this.config.maxQueueItemSizeBytes ?? DEFAULT_MAX_QUEUE_ITEM_BYTES;
  }

  private assertWithinSizeBudget(body: string | Blob | null): void {
    const size = bodySizeBytes(body);
    const max = this.maxQueueItemBytes();
    if (size > max) {
      throw new RangeError(
        `lowdata: request body (${size} bytes) exceeds maxQueueItemSizeBytes (${max} bytes).`,
      );
    }
  }

  /**
   * Shared by `enqueueFromInit` (the `fetch()` fallback path) and `enqueue` (the direct
   * `queue.add()` path) — the only difference between the two call sites is where the fields come
   * from, not how a queue item gets constructed, persisted, and announced to the sync manager.
   */
  private async persistNewQueueItem(
    fields: Omit<
      QueueItem,
      'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status' | 'nextAttemptAt'
    >,
  ): Promise<QueueItem> {
    const body = normalizeQueueableBody(fields.body);
    this.assertWithinSizeBudget(body);

    const now = Date.now();
    const item: QueueItem = {
      ...fields,
      body,
      id: createId(),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      status: 'pending',
      nextAttemptAt: now,
      idempotencyKey: this.resolveIdempotencyKey(fields.idempotencyKey, fields.method),
      schemaVersion: fields.schemaVersion ?? this.config.schemaVersion,
    };
    const saved = await this.requestQueue.add(item);
    this.syncManager.notifyEnqueued();
    this.broadcast.post();
    return saved;
  }

  private async enqueueFromInit(
    url: string,
    method: HttpMethod,
    init: RequestInit & EnqueueOptions,
  ): Promise<QueuedResult> {
    const saved = await this.persistNewQueueItem({
      url,
      method,
      headers: normalizeHeaders(init.headers),
      body: init.body as string | Blob | null | undefined,
      priority: init.priority ?? 'normal',
      meta: init.meta,
      timeoutMs: init.timeoutMs,
      retry: init.retry,
      idempotencyKey: init.idempotencyKey,
      dependsOn: init.dependsOn,
      maxAgeMs: init.maxAgeMs,
    });
    return { queued: true, id: saved.id, item: saved };
  }

  private async enqueue(
    partial: Omit<
      QueueItem,
      'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status' | 'nextAttemptAt'
    >,
  ): Promise<QueueItem> {
    return this.persistNewQueueItem(partial);
  }

  private async cancelQueued(id: string): Promise<void> {
    this.syncManager.cancel(id);
    const item = await this.requestQueue.get(id);
    if (item && item.status !== 'done' && item.status !== 'cancelled') {
      await this.requestQueue.update({ ...item, status: 'cancelled', updatedAt: Date.now() });
      this.broadcast.post();
    }
  }

  private async retryQueued(id: string): Promise<void> {
    const item = await this.requestQueue.get(id);
    if (!item) return;
    if (item.status !== 'failed' && item.status !== 'expired' && item.status !== 'cancelled') {
      return; // only terminal, non-successful states make sense to retry
    }
    await this.requestQueue.update({
      ...item,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: undefined,
      updatedAt: Date.now(),
    });
    this.syncManager.notifyEnqueued();
    this.broadcast.post();
  }

  private subscribeToQueue(listener: (items: QueueItem[]) => void): Unsubscribe {
    const notify = () => {
      void this.requestQueue.list().then(listener);
    };
    const unsubscribeBroadcast = this.broadcast.subscribe(notify);
    notify(); // deliver the current snapshot immediately, like a normal subscribe
    return unsubscribeBroadcast;
  }
}

export function createLowdataClient(config?: LowdataClientConfig): LowdataClient {
  return new LowdataClient(config);
}
