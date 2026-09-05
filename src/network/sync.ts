import { computeBackoffDelay } from '../core/backoff.js';
import { createId } from '../core/id.js';
import { acquireSyncLock } from '../core/lock.js';
import {
  DEFAULT_RETRY_CONFIG,
  type LowdataErrorHandler,
  type RetryBackoffConfig,
} from '../core/types.js';
import type { ConnectionMonitor } from '../core/connection.js';
import type { StorageAdapter } from '../core/storageAdapter.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { CircuitBreakerConfig } from './circuitBreaker.js';
import { LowdataRequestError } from './errors.js';
import { DEFAULT_TIMEOUT_MS, defaultRetryOn, parseRetryAfterMs } from './retry.js';
import type { RequestQueue } from './queue.js';
import type { QueueItem, SyncEvent } from './types.js';

/** Items stuck in `sending` longer than this are assumed crashed and revived to `pending`. */
const STALE_SENDING_MS = 60_000;
/** Safety poll interval — covers reconnects the `online` event misses (e.g. laptop sleep/wake). */
const SAFETY_POLL_MS = 30_000;
const SYNC_LOCK_NAME = 'lowdata-sync';

/** Sentinel abort reason distinguishing an explicit `queue.cancel()` from a timeout/network drop. */
const CANCELLED = Symbol('lowdata-cancelled');

export interface SyncManagerOptions {
  queue: RequestQueue;
  connection: ConnectionMonitor;
  storage: StorageAdapter;
  retryConfig?: Partial<RetryBackoffConfig>;
  /** How many queued items to send concurrently. Default 1 — deliberately conservative on 2G. */
  syncConcurrency?: number;
  circuitBreaker?: CircuitBreakerConfig;
  schemaVersion?: number;
  migrateQueueItem?: (item: QueueItem) => QueueItem;
  onEvent?: (event: SyncEvent) => void;
  onError?: LowdataErrorHandler;
}

/**
 * Drives the offline queue: drains eligible items when the connection is up, retries failed
 * ones with backoff across drain cycles (so retries survive reloads), prevents two open tabs
 * from double-sending the same item via a cross-tab lock, and backs off a whole failing endpoint
 * together via a per-origin circuit breaker rather than retrying every item against it independently.
 */
export class SyncManager {
  private readonly ownerId = createId();
  private readonly retryConfig: RetryBackoffConfig;
  private readonly syncConcurrency: number;
  private readonly breaker: CircuitBreaker;
  private inFlight = new Map<string, AbortController>();
  private draining = false;
  private disposed = false;
  private unsubscribeConnection: () => void;
  private safetyTimer?: ReturnType<typeof setInterval>;

  constructor(private opts: SyncManagerOptions) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...opts.retryConfig };
    this.syncConcurrency = Math.max(1, opts.syncConcurrency ?? 1);
    this.breaker = new CircuitBreaker(opts.circuitBreaker);

    this.unsubscribeConnection = this.opts.connection.subscribe((info) => {
      if (info.quality !== 'offline') void this.drain();
    });

    if (typeof document !== 'undefined' && typeof setInterval !== 'undefined') {
      this.safetyTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.drain();
      }, SAFETY_POLL_MS);
    }
  }

  /** Call after enqueueing a new item so a high-priority item is picked up without waiting for the next trigger. */
  notifyEnqueued(): void {
    if (this.opts.connection.getStatus().quality !== 'offline') void this.drain();
  }

  cancel(id: string): void {
    this.inFlight.get(id)?.abort(CANCELLED);
    this.inFlight.delete(id);
  }

  /**
   * Never throws/rejects — `drain()` is always invoked fire-and-forget (`void this.drain()`) from
   * event listeners, so any failure here (e.g. the shared storage connection was closed
   * mid-drain) is swallowed rather than surfacing as an unhandled rejection; the next reconnect
   * or safety poll simply tries again.
   */
  async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    if (this.opts.connection.getStatus().quality === 'offline') return;

    // Set synchronously, before any `await`, so two drain() calls issued in the same tick (e.g.
    // two client.fetch() calls both calling notifyEnqueued()) can't both pass the guard above
    // before either sets it — otherwise both could go on to acquire the lock and, on the
    // storage-fallback lock (a non-atomic get-then-put, unlike the atomic Web Locks API), both
    // could believe they hold it and send the same item twice.
    this.draining = true;
    try {
      const lock = await acquireSyncLock(this.opts.storage, SYNC_LOCK_NAME, this.ownerId).catch(
        (error) => {
          this.opts.onError?.(error, { scope: 'db-open' });
          return undefined;
        },
      );
      if (!lock) return; // another tab is already draining, or no lock could be acquired this cycle

      let succeeded = 0;
      let failed = 0;
      try {
        await this.opts.queue.sweepStale(STALE_SENDING_MS, Date.now());

        for (const expired of await this.opts.queue.expireOverdue(Date.now())) {
          this.opts.onEvent?.({ type: 'item-expired', item: expired });
        }

        const initialEligible = await this.opts.queue.selectEligible(Date.now());
        const blockedByDependency = await this.opts.queue.blockedByDependency(Date.now());
        if (blockedByDependency.length > 0) {
          this.opts.onEvent?.({
            type: 'items-blocked',
            reason: 'dependency',
            items: blockedByDependency,
          });
        }
        if (initialEligible.length === 0) return;
        this.opts.onEvent?.({ type: 'sync-start', pending: initialEligible.length });

        while (!this.disposed && this.opts.connection.getStatus().quality !== 'offline') {
          const eligible = await this.opts.queue.selectEligible(Date.now());
          if (eligible.length === 0) break;

          const migrated = await this.applyMigrations(eligible);
          const sendable: QueueItem[] = [];
          const blockedByBreaker: QueueItem[] = [];
          for (const item of migrated) {
            (this.breaker.isOpen(item.url) ? blockedByBreaker : sendable).push(item);
          }
          if (blockedByBreaker.length > 0) {
            this.opts.onEvent?.({
              type: 'items-blocked',
              reason: 'circuit-breaker',
              items: blockedByBreaker,
            });
          }
          if (sendable.length === 0) break; // everything eligible is currently breaker-blocked

          const openedKeys = new Set<string>();
          const batch = sendable.slice(0, this.syncConcurrency);
          const results = await Promise.all(batch.map((item) => this.sendItem(item, openedKeys)));
          succeeded += results.filter(Boolean).length;
          failed += results.filter((ok) => !ok).length;
          for (const key of openedKeys) this.opts.onEvent?.({ type: 'circuit-open', key });
        }

        this.opts.onEvent?.({ type: 'sync-complete', succeeded, failed });
      } finally {
        await lock.release().catch(() => {});
      }
    } catch (error) {
      // swallow — see doc comment above — but still make it observable.
      this.opts.onError?.(error, { scope: 'sync' });
    } finally {
      this.draining = false;
    }
  }

  destroy(): void {
    this.disposed = true;
    this.unsubscribeConnection();
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    for (const controller of this.inFlight.values()) controller.abort(CANCELLED);
    this.inFlight.clear();
  }

  /** Upgrades any item whose `schemaVersion` predates the current one before it's sent. */
  private async applyMigrations(items: QueueItem[]): Promise<QueueItem[]> {
    const targetVersion = this.opts.schemaVersion;
    const migrate = this.opts.migrateQueueItem;
    if (targetVersion == null || !migrate) return items;

    return Promise.all(
      items.map(async (item) => {
        if (item.schemaVersion === targetVersion) return item;
        const migrated: QueueItem = { ...migrate(item), schemaVersion: targetVersion };
        await this.opts.queue.update(migrated);
        return migrated;
      }),
    );
  }

  private async sendItem(item: QueueItem, openedKeys: Set<string>): Promise<boolean> {
    const controller = new AbortController();
    this.inFlight.set(item.id, controller);
    const timeoutMs = item.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Everything from here on is wrapped in one try/finally: if even the very first `queue.update`
    // below throws (a storage hiccup), `inFlight`/the timer must still be cleaned up — otherwise
    // this item's AbortController leaks forever and a later `queue.cancel(item.id)` would silently
    // no-op against a controller nothing is actually using anymore.
    try {
      const sendingItem: QueueItem = { ...item, status: 'sending', updatedAt: Date.now() };
      await this.opts.queue.update(sendingItem);
      this.opts.onEvent?.({ type: 'item-start', item: sendingItem });

      const retryConfig = { ...this.retryConfig, ...item.retry };
      const retryOn = retryConfig.retryOn ?? defaultRetryOn;
      const headers = item.idempotencyKey
        ? { ...item.headers, 'Idempotency-Key': item.idempotencyKey }
        : item.headers;

      let requestError: LowdataRequestError | undefined;
      try {
        const response = await fetch(item.url, {
          method: item.method,
          headers,
          body: item.body ?? undefined,
          signal: controller.signal,
        });
        // Only a genuine 2xx counts as delivered. Anything else — including a status this queue
        // doesn't consider retryable, like a 400, 404, 500, or the 505 that prompted this review —
        // falls through to the shared failure/retry handling below instead of being purged as
        // 'done'. There's no caller here to hand a non-ok Response back to for inspection (unlike
        // the live `client.fetch()` path); treating "not retryable" as "successful" would silently
        // report a hard server-side rejection as a sync success and delete the only record of it.
        if (response.ok) {
          const doneItem: QueueItem = { ...sendingItem, status: 'done', updatedAt: Date.now() };
          // Terminal and successful — nothing more to do with it, so purge rather than let a
          // long-lived app's queue store grow forever. The event still carries the final item for
          // any subscriber that wants to build its own history.
          await this.opts.queue.remove(doneItem.id);
          this.opts.onEvent?.({ type: 'item-success', item: doneItem });
          this.breaker.recordSuccess(item.url);
          return true;
        }
        requestError = new LowdataRequestError(`Request failed with status ${response.status}`, {
          status: response.status,
          attempt: item.attempts,
          retryAfterMs: parseRetryAfterMs(response),
        });
      } catch (cause) {
        if (controller.signal.reason === CANCELLED) {
          const cancelledItem: QueueItem = {
            ...sendingItem,
            status: 'cancelled',
            updatedAt: Date.now(),
          };
          await this.opts.queue.update(cancelledItem);
          this.opts.onEvent?.({ type: 'item-failed', item: cancelledItem, willRetry: false });
          return false;
        }
        // Genuinely never reaching the server (offline mid-send, DNS failure, connection refused)
        // never aborts our own controller — only our timeout does — so this correctly falls to
        // isNetworkError rather than isTimeout for "never reached the server" specifically.
        const isTimeout = controller.signal.aborted && controller.signal.reason !== CANCELLED;
        requestError = new LowdataRequestError(
          isTimeout ? 'Request timed out' : 'Network request failed',
          { isNetworkError: !isTimeout, isTimeout, attempt: item.attempts, cause },
        );
      }

      const justOpened = this.breaker.recordFailure(item.url);
      if (justOpened) openedKeys.add(this.breaker.keyFor(item.url));

      const attempts = item.attempts + 1;
      const willRetry = attempts <= retryConfig.maxRetries && retryOn(requestError, item.attempts);
      // Capped the same way the live-retry path (retry.ts) caps it, so a server's Retry-After is
      // honored consistently regardless of whether the request started live or queued from the start.
      const rawDelay = requestError.retryAfterMs ?? computeBackoffDelay(item.attempts, retryConfig);
      const nextAttemptAt = willRetry
        ? Date.now() + Math.min(rawDelay, retryConfig.maxDelayMs)
        : sendingItem.nextAttemptAt;
      const resultItem: QueueItem = {
        ...sendingItem,
        attempts,
        status: willRetry ? 'pending' : 'failed',
        nextAttemptAt,
        lastError: requestError.message,
        updatedAt: Date.now(),
      };
      await this.opts.queue.update(resultItem);
      this.opts.onEvent?.({ type: 'item-failed', item: resultItem, willRetry });
      return false;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(item.id);
    }
  }
}
