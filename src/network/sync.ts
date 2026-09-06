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
import type { CapturedResponse, QueueItem, SyncEvent } from './types.js';

const DEFAULT_CAPTURE_RESPONSE_BODY_MAX_BYTES = 100_000; // 100 KB

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
  captureResponseBody?: boolean;
  captureResponseBodyMaxBytes?: number;
  /** See `LowdataClientConfig.resolveHeaders` — called fresh before every queued send attempt. */
  resolveHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
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

      try {
        await this.reconcileQueue(Date.now());
        if (!(await this.announceStartIfAnythingEligible(Date.now()))) return;

        let succeeded = 0;
        let failed = 0;
        while (!this.disposed && this.opts.connection.getStatus().quality !== 'offline') {
          const sendable = await this.selectSendableBatch();
          if (!sendable) break; // nothing due, or everything due is currently breaker-blocked

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

  /** Revives crashed-mid-send items and expires overdue ones, before anything is selected to send. */
  private async reconcileQueue(now: number): Promise<void> {
    await this.opts.queue.sweepStale(STALE_SENDING_MS, now);
    for (const expired of await this.opts.queue.expireOverdue(now)) {
      this.opts.onEvent?.({ type: 'item-expired', item: expired });
    }
  }

  /**
   * Reports any dependency-blocked items (once per drain cycle — unlike breaker-blocks, which can
   * change every loop iteration), then returns whether there's anything eligible to actually start
   * draining. Returning `false` means "nothing to do this cycle", not an error.
   */
  private async announceStartIfAnythingEligible(now: number): Promise<boolean> {
    const initialEligible = await this.opts.queue.selectEligible(now);
    const blockedByDependency = await this.opts.queue.blockedByDependency(now);
    if (blockedByDependency.length > 0) {
      this.opts.onEvent?.({
        type: 'items-blocked',
        reason: 'dependency',
        items: blockedByDependency,
      });
    }
    if (initialEligible.length === 0) return false;
    this.opts.onEvent?.({ type: 'sync-start', pending: initialEligible.length });
    return true;
  }

  /**
   * One drain-loop iteration's worth of items actually ready to send right now: due, migrated to
   * the current schema, and not currently withheld by an open circuit breaker (reported via
   * `items-blocked` here, since which items are breaker-blocked can change every iteration as
   * breakers open/close). `null` means the loop should stop — either nothing is due at all, or
   * everything that's due is blocked.
   */
  private async selectSendableBatch(): Promise<QueueItem[] | null> {
    const eligible = await this.opts.queue.selectEligible(Date.now());
    if (eligible.length === 0) return null;

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
    return sendable.length > 0 ? sendable : null;
  }

  /**
   * Reads and (best-effort) parses a response body for `CapturedResponse` — never throws: a
   * malformed body or a read failure still yields `{ status }` rather than losing the whole event.
   * Bodies over the configured size limit are skipped entirely (only `status` is captured) so one
   * huge response can't balloon memory just because capture is enabled.
   */
  private async captureResponse(response: Response): Promise<CapturedResponse> {
    const maxBytes =
      this.opts.captureResponseBodyMaxBytes ?? DEFAULT_CAPTURE_RESPONSE_BODY_MAX_BYTES;
    try {
      const text = await response.text();
      // Byte length, not string length — a UTF-16 code-unit count would understate real size for
      // any non-ASCII body, letting past exactly the multi-byte content this cap exists to catch.
      if (!text || new Blob([text]).size > maxBytes) return { status: response.status };
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        try {
          return { status: response.status, body: JSON.parse(text) };
        } catch {
          return { status: response.status, body: text };
        }
      }
      return { status: response.status, body: text };
    } catch {
      return { status: response.status };
    }
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

  /**
   * Records an explicitly cancelled send (via `queue.cancel()`) as terminal — shared by both the
   * `resolveHeaders()` and `fetch()` failure paths in `sendItem()`, since a cancellation can land
   * while either one is in flight.
   */
  private async markCancelled(sendingItem: QueueItem): Promise<false> {
    const cancelledItem: QueueItem = { ...sendingItem, status: 'cancelled', updatedAt: Date.now() };
    await this.opts.queue.update(cancelledItem);
    this.opts.onEvent?.({ type: 'item-failed', item: cancelledItem, willRetry: false });
    return false;
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

      let requestError: LowdataRequestError | undefined;
      let capturedResponse: CapturedResponse | undefined;
      let headers: Record<string, string> | undefined;
      try {
        // Re-asked on every attempt, not just the first — a bearer token frozen into `item.headers`
        // at enqueue time can expire during a long offline stretch, and without this a queued item
        // would 401 on every replay with no way to recover short of a manual queue.retry() after
        // re-auth. Layered under `item.headers` so a caller can still hard-pin a header per item if
        // they need to; `Idempotency-Key` always layers on top of both, unchanged.
        const resolved = this.opts.resolveHeaders ? await this.opts.resolveHeaders() : undefined;
        headers = {
          ...item.headers,
          ...resolved,
          ...(item.idempotencyKey ? { 'Idempotency-Key': item.idempotencyKey } : {}),
        };
      } catch (cause) {
        // Treated exactly like a failed fetch: retried with the same backoff, never left to crash
        // the whole batch this item's send was scheduled alongside (see the try/finally note above).
        requestError = new LowdataRequestError('Failed to resolve headers before sending', {
          isNetworkError: true,
          attempt: item.attempts,
          cause,
        });
      }

      // A queue.cancel() can land at any point while resolveHeaders() was in flight — unlike
      // fetch(), that call isn't wired to `controller.signal`, so cancellation wouldn't otherwise
      // surface until here. Check before falling through to the shared retry logic below: without
      // this, a resolveHeaders() rejection racing a cancel() would overwrite the 'cancelled' status
      // the app just wrote with a fresh 'pending'/'failed' one, silently reviving a cancelled item.
      if (controller.signal.reason === CANCELLED) return this.markCancelled(sendingItem);

      // Skipped entirely when resolveHeaders() already failed above — requestError is already set,
      // and falling through to the shared retry/backoff handling below (rather than attempting a
      // fetch with incomplete headers) is exactly the point.
      if (!requestError) {
        try {
          const response = await fetch(item.url, {
            method: item.method,
            headers,
            body: item.body ?? undefined,
            signal: controller.signal,
          });
          const shouldCapture = item.captureResponseBody ?? this.opts.captureResponseBody;
          if (shouldCapture) {
            capturedResponse = await this.captureResponse(response);
          }
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
            // any subscriber that wants to build its own history. `response` matters here precisely
            // because "2xx" and "actually a fresh success, not a business-level duplicate/conflict
            // the server chose to report with a 200" are two different things — see `CapturedResponse`.
            await this.opts.queue.remove(doneItem.id);
            this.opts.onEvent?.({
              type: 'item-success',
              item: doneItem,
              response: capturedResponse,
            });
            this.breaker.recordSuccess(item.url);
            return true;
          }
          requestError = new LowdataRequestError(`Request failed with status ${response.status}`, {
            status: response.status,
            attempt: item.attempts,
            retryAfterMs: parseRetryAfterMs(response),
          });
        } catch (cause) {
          if (controller.signal.reason === CANCELLED) return this.markCancelled(sendingItem);
          // Genuinely never reaching the server (offline mid-send, DNS failure, connection refused)
          // never aborts our own controller — only our timeout does — so this correctly falls to
          // isNetworkError rather than isTimeout for "never reached the server" specifically.
          const isTimeout = controller.signal.aborted && controller.signal.reason !== CANCELLED;
          requestError = new LowdataRequestError(
            isTimeout ? 'Request timed out' : 'Network request failed',
            { isNetworkError: !isTimeout, isTimeout, attempt: item.attempts, cause },
          );
        }
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
      this.opts.onEvent?.({
        type: 'item-failed',
        item: resultItem,
        willRetry,
        response: capturedResponse,
      });
      return false;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(item.id);
    }
  }
}
