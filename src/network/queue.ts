import type { LowdataErrorHandler } from '../core/types.js';
import type { StorageAdapter } from '../core/storageAdapter.js';
import type { EncryptionHooks, QueueItem, QueueItemStatus } from './types.js';

const STORE = 'queue';

const PRIORITY_ORDER: Record<QueueItem['priority'], number> = { high: 0, normal: 1, low: 2 };

export interface QueueListFilter {
  status?: QueueItemStatus;
}

/**
 * Persistent request queue backed by a `StorageAdapter` (IndexedDB by default; see
 * `createIndexedDbStorageAdapter`/`createMemoryStorageAdapter`, or supply your own for a
 * non-browser host). Encryption (if configured) and dependency/expiry accounting happen here, so
 * every caller — `LowdataClient`, `SyncManager` — sees plain, decrypted, already-filtered items.
 */
export class RequestQueue {
  constructor(
    private storage: StorageAdapter,
    private encryption?: EncryptionHooks,
    private onError?: LowdataErrorHandler,
  ) {}

  isPersistent(): boolean {
    return this.storage.isPersistent();
  }

  private async encryptForStorage(item: QueueItem): Promise<QueueItem> {
    if (!this.encryption || typeof item.body !== 'string') return item;
    return {
      ...item,
      body: await this.encryption.encrypt(item.body),
      bodyEncrypted: true,
    };
  }

  /**
   * Decrypts `item.body` for callers, in place. A decrypt failure (a rotated/lost key, corrupted
   * ciphertext) is isolated to *this one item* rather than left to reject the `Promise.all` in
   * `list()` — an unhandled rejection there would make every other pending item permanently
   * unreachable too, since `selectEligible()`/`SyncManager.drain()` would never get past this one
   * poisoned read. Instead: report it, mark the item `'failed'` so it stops being selected, and let
   * the rest of the queue keep flowing.
   */
  private async decryptFromStorage(item: QueueItem): Promise<QueueItem> {
    if (!item.bodyEncrypted) return item;
    if (!this.encryption) {
      // Encryption was configured when this item was written but isn't now (e.g. misconfiguration
      // across an app restart) — surface ciphertext rather than silently sending it as plaintext.
      return item;
    }
    try {
      const body =
        typeof item.body === 'string' ? await this.encryption.decrypt(item.body) : item.body;
      const decrypted: QueueItem = { ...item, body };
      delete decrypted.bodyEncrypted;
      return decrypted;
    } catch (error) {
      this.onError?.(error, { scope: 'decrypt' });
      if (item.status === 'failed') return item; // already handled — avoid rewriting on every read
      const failedItem: QueueItem = {
        ...item,
        status: 'failed',
        lastError: "lowdata: failed to decrypt this item's body — it will not be sent",
        updatedAt: Date.now(),
      };
      // Persisted directly (bypassing encryptForStorage): body/bodyEncrypted are untouched, still
      // exactly the ciphertext that failed to decrypt — only `status`/`lastError` are new.
      await this.storage.put(STORE, failedItem);
      return failedItem;
    }
  }

  async add(item: QueueItem): Promise<QueueItem> {
    await this.storage.put(STORE, await this.encryptForStorage(item));
    return item;
  }

  async update(item: QueueItem): Promise<void> {
    await this.storage.put(STORE, await this.encryptForStorage(item));
  }

  async get(id: string): Promise<QueueItem | undefined> {
    const stored = await this.storage.get<QueueItem>(STORE, id);
    return stored ? this.decryptFromStorage(stored) : undefined;
  }

  async remove(id: string): Promise<void> {
    await this.storage.delete(STORE, id);
  }

  /** Filtering by status queries the `status` index rather than scanning the whole store. */
  async list(filter?: QueueListFilter): Promise<QueueItem[]> {
    const stored = filter?.status
      ? await this.storage.getAll<QueueItem>(STORE, { indexName: 'status', query: filter.status })
      : await this.storage.getAll<QueueItem>(STORE);
    return Promise.all(stored.map((item) => this.decryptFromStorage(item)));
  }

  async clear(): Promise<void> {
    await this.storage.clear(STORE);
  }

  /**
   * Items ready to send now: `pending`, due, every `dependsOn` id already resolved (absent —
   * meaning it succeeded and was purged — or `cancelled`), sorted by priority then insertion order.
   */
  async selectEligible(now: number): Promise<QueueItem[]> {
    const due = await this.dueItems(now);
    if (due.length === 0) return [];

    const byId = await this.dependencyLookupIfNeeded(due);
    const ready = byId ? due.filter((item) => !this.isBlockedByDependency(item, byId)) : due;
    return ready.sort(byPriorityThenAge);
  }

  /**
   * Due, pending items withheld *solely* because a `dependsOn` id hasn't resolved yet — the
   * complement of what `selectEligible()` returns. Exists purely for observability (see
   * `SyncEvent`'s `'items-blocked'`): without it, a dependency-blocked item is indistinguishable
   * from "just not due yet" and never surfaces anywhere.
   */
  async blockedByDependency(now: number): Promise<QueueItem[]> {
    const due = await this.dueItems(now);
    const byId = await this.dependencyLookupIfNeeded(due);
    if (!byId) return [];
    return due.filter((item) => this.isBlockedByDependency(item, byId));
  }

  private async dueItems(now: number): Promise<QueueItem[]> {
    const pending = await this.list({ status: 'pending' });
    return pending.filter((item) => item.nextAttemptAt <= now);
  }

  /** Only pays for a full-table scan when at least one candidate actually declares a dependency. */
  private async dependencyLookupIfNeeded(
    candidates: QueueItem[],
  ): Promise<Map<string, QueueItem> | undefined> {
    const needsCheck = candidates.some((item) => item.dependsOn && item.dependsOn.length > 0);
    if (!needsCheck) return undefined;
    const all = await this.list();
    return new Map(all.map((item) => [item.id, item]));
  }

  /** Absent = already succeeded and purged. `'cancelled'` = explicitly abandoned by the app. Anything else present (pending/sending/failed/expired) still blocks. */
  private isBlockedByDependency(item: QueueItem, byId: Map<string, QueueItem>): boolean {
    if (!item.dependsOn || item.dependsOn.length === 0) return false;
    return item.dependsOn.some((depId) => {
      const dep = byId.get(depId);
      return !!dep && dep.status !== 'cancelled';
    });
  }

  /** Revive items stuck in `sending` longer than `staleAfterMs` (recovers from a crash mid-send). */
  async sweepStale(staleAfterMs: number, now: number): Promise<QueueItem[]> {
    const sending = await this.list({ status: 'sending' });
    const revived: QueueItem[] = [];
    for (const item of sending) {
      if (now - item.updatedAt > staleAfterMs) {
        const next: QueueItem = { ...item, status: 'pending', updatedAt: now };
        await this.update(next);
        revived.push(next);
      }
    }
    return revived;
  }

  /** Marks pending items whose `maxAgeMs` has elapsed as `'expired'` instead of ever sending them. */
  async expireOverdue(now: number): Promise<QueueItem[]> {
    const pending = await this.list({ status: 'pending' });
    const expired: QueueItem[] = [];
    for (const item of pending) {
      if (item.maxAgeMs != null && now - item.createdAt > item.maxAgeMs) {
        const next: QueueItem = { ...item, status: 'expired', updatedAt: now };
        await this.update(next);
        expired.push(next);
      }
    }
    return expired;
  }
}

function byPriorityThenAge(a: QueueItem, b: QueueItem): number {
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
}
