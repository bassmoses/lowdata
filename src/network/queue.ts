import {
  createDbFallbackAccessor,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
} from '../core/idb.js';
import type { LowdataErrorHandler } from '../core/types.js';
import type { QueueItem, QueueItemStatus } from './types.js';

const STORE = 'queue';

const PRIORITY_ORDER: Record<QueueItem['priority'], number> = { high: 0, normal: 1, low: 2 };

export interface QueueListFilter {
  status?: QueueItemStatus;
}

/**
 * Persistent (IndexedDB-backed) request queue with an automatic in-memory fallback for
 * environments without IndexedDB (SSR, very old/locked-down browsers). The fallback is
 * non-persistent — it exists so importing lowdata never throws, not to promise durability there.
 */
export class RequestQueue {
  private memory = new Map<string, QueueItem>();
  private accessor;

  constructor(getDb: () => Promise<IDBDatabase>, onError?: LowdataErrorHandler) {
    this.accessor = createDbFallbackAccessor(getDb, onError);
  }

  isPersistent(): boolean {
    return this.accessor.isPersistent();
  }

  async add(item: QueueItem): Promise<QueueItem> {
    return this.accessor.run(
      async (db) => {
        await idbPut<QueueItem>(db, STORE, item);
        return item;
      },
      () => {
        this.memory.set(item.id, item);
        return item;
      },
    );
  }

  async update(item: QueueItem): Promise<void> {
    await this.accessor.run(
      async (db) => {
        await idbPut<QueueItem>(db, STORE, item);
      },
      () => {
        this.memory.set(item.id, item);
      },
    );
  }

  async get(id: string): Promise<QueueItem | undefined> {
    return this.accessor.run(
      (db) => idbGet<QueueItem>(db, STORE, id),
      () => this.memory.get(id),
    );
  }

  async remove(id: string): Promise<void> {
    await this.accessor.run(
      (db) => idbDelete(db, STORE, id),
      () => {
        this.memory.delete(id);
      },
    );
  }

  /** Filtering by status queries the `status` index rather than scanning the whole store. */
  async list(filter?: QueueListFilter): Promise<QueueItem[]> {
    if (filter?.status) {
      const status = filter.status;
      return this.accessor.run(
        (db) => idbGetAll<QueueItem>(db, STORE, { indexName: 'status', query: status }),
        () => Array.from(this.memory.values()).filter((item) => item.status === status),
      );
    }
    return this.accessor.run(
      (db) => idbGetAll<QueueItem>(db, STORE),
      () => Array.from(this.memory.values()),
    );
  }

  async clear(): Promise<void> {
    await this.accessor.run(
      (db) => idbClear(db, STORE),
      () => {
        this.memory.clear();
      },
    );
  }

  /** Items ready to send now: `pending` and due, sorted by priority then insertion order. */
  async selectEligible(now: number): Promise<QueueItem[]> {
    const pending = await this.list({ status: 'pending' });
    return pending
      .filter((item) => item.nextAttemptAt <= now)
      .sort((a, b) => {
        const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
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
}
