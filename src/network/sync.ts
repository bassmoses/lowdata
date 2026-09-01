import { computeBackoffDelay } from '../core/backoff.js';
import { createId } from '../core/id.js';
import { acquireSyncLock } from '../core/lock.js';
import { DEFAULT_RETRY_CONFIG, type RetryBackoffConfig } from '../core/types.js';
import type { ConnectionMonitor } from '../core/connection.js';
import { LowdataRequestError } from './errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  defaultRetryOn,
  isRetryableStatus,
  parseRetryAfterMs,
} from './retry.js';
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
  getDb: () => Promise<IDBDatabase>;
  retryConfig?: Partial<RetryBackoffConfig>;
  /** How many queued items to send concurrently. Default 1 — deliberately conservative on 2G. */
  syncConcurrency?: number;
  onEvent?: (event: SyncEvent) => void;
}

/**
 * Drives the offline queue: drains eligible items when the connection is up, retries failed
 * ones with backoff across drain cycles (so retries survive reloads), and prevents two open tabs
 * from double-sending the same item via a cross-tab lock.
 */
export class SyncManager {
  private readonly ownerId = createId();
  private readonly retryConfig: RetryBackoffConfig;
  private readonly syncConcurrency: number;
  private inFlight = new Map<string, AbortController>();
  private draining = false;
  private disposed = false;
  private unsubscribeConnection: () => void;
  private safetyTimer?: ReturnType<typeof setInterval>;

  constructor(private opts: SyncManagerOptions) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...opts.retryConfig };
    this.syncConcurrency = Math.max(1, opts.syncConcurrency ?? 1);

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
   * event listeners, so any failure here (e.g. the shared IndexedDB connection was closed
   * mid-drain) is swallowed rather than surfacing as an unhandled rejection; the next reconnect
   * or safety poll simply tries again.
   */
  async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    if (this.opts.connection.getStatus().quality === 'offline') return;

    // Set synchronously, before any `await`, so two drain() calls issued in the same tick (e.g.
    // two client.fetch() calls both calling notifyEnqueued()) can't both pass the guard above
    // before either sets it — otherwise both could go on to acquire the lock and, on the
    // IndexedDB fallback lock (a non-atomic get-then-put, unlike the atomic Web Locks API), both
    // could believe they hold it and send the same item twice.
    this.draining = true;
    try {
      const db = await this.opts.getDb().catch(() => undefined);
      const lock = await acquireSyncLock(db, SYNC_LOCK_NAME, this.ownerId);
      if (!lock) return; // another tab is already draining, or no lock could be acquired this cycle

      let succeeded = 0;
      let failed = 0;
      try {
        await this.opts.queue.sweepStale(STALE_SENDING_MS, Date.now());

        const initialEligible = await this.opts.queue.selectEligible(Date.now());
        if (initialEligible.length === 0) return;
        this.opts.onEvent?.({ type: 'sync-start', pending: initialEligible.length });

        while (!this.disposed && this.opts.connection.getStatus().quality !== 'offline') {
          const eligible = await this.opts.queue.selectEligible(Date.now());
          if (eligible.length === 0) break;

          const batch = eligible.slice(0, this.syncConcurrency);
          const results = await Promise.all(batch.map((item) => this.sendItem(item)));
          succeeded += results.filter(Boolean).length;
          failed += results.filter((ok) => !ok).length;
        }

        this.opts.onEvent?.({ type: 'sync-complete', succeeded, failed });
      } finally {
        await lock.release().catch(() => {});
      }
    } catch {
      // swallow — see doc comment above
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

  private async sendItem(item: QueueItem): Promise<boolean> {
    const controller = new AbortController();
    this.inFlight.set(item.id, controller);
    const timeoutMs = item.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const sendingItem: QueueItem = { ...item, status: 'sending', updatedAt: Date.now() };
    await this.opts.queue.update(sendingItem);
    this.opts.onEvent?.({ type: 'item-start', item: sendingItem });

    const retryConfig: RetryBackoffConfig = { ...this.retryConfig, ...item.retry };
    const retryOn = retryConfig.retryOn ?? defaultRetryOn;

    let requestError: LowdataRequestError | undefined;
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body ?? undefined,
        signal: controller.signal,
      });
      if (response.ok || !isRetryableStatus(response.status)) {
        const doneItem: QueueItem = { ...sendingItem, status: 'done', updatedAt: Date.now() };
        // Terminal and successful — nothing more to do with it, so purge rather than let a
        // long-lived app's queue store grow forever. The event still carries the final item for
        // any subscriber that wants to build its own history.
        await this.opts.queue.remove(doneItem.id);
        this.opts.onEvent?.({ type: 'item-success', item: doneItem });
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
      const isTimeout = controller.signal.aborted && controller.signal.reason !== CANCELLED;
      requestError = new LowdataRequestError(
        isTimeout ? 'Request timed out' : 'Network request failed',
        { isNetworkError: !isTimeout, isTimeout, attempt: item.attempts, cause },
      );
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(item.id);
    }

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
  }
}
