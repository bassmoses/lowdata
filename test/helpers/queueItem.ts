import type { QueueItem } from '../../src/network/types.js';

export function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const now = Date.now();
  return {
    id: `item-${Math.random()}`,
    url: '/api/thing',
    method: 'POST',
    priority: 'normal',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: 'pending',
    nextAttemptAt: now,
    body: null,
    ...overrides,
  };
}
