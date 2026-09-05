import { describe, expect, it } from 'vitest';
import { createQueueBroadcast } from '../../src/core/broadcast.js';
import { waitForCondition } from '../helpers/wait.js';

describe('createQueueBroadcast', () => {
  it('notifies its own subscribers immediately on post()', () => {
    const broadcast = createQueueBroadcast(`test-channel-${Math.random()}`);
    let notified = 0;
    broadcast.subscribe(() => notified++);

    broadcast.post();

    expect(notified).toBe(1);
    broadcast.destroy();
  });

  it('notifies a second instance on the same channel name (cross-tab simulation)', async () => {
    const channelName = `test-channel-shared-${Math.random()}`;
    const tabA = createQueueBroadcast(channelName);
    const tabB = createQueueBroadcast(channelName);
    let bNotified = false;
    tabB.subscribe(() => {
      bNotified = true;
    });

    tabA.post();

    await waitForCondition(() => bNotified, { message: 'expected the other channel to be notified' });
    tabA.destroy();
    tabB.destroy();
  });

  it('post() after destroy() is a silent no-op, not a thrown error', () => {
    const broadcast = createQueueBroadcast(`test-channel-post-after-destroy-${Math.random()}`);
    broadcast.destroy();
    expect(() => broadcast.post()).not.toThrow();
  });

  it('unsubscribe stops further notifications', () => {
    const broadcast = createQueueBroadcast(`test-channel-unsub-${Math.random()}`);
    let notified = 0;
    const unsubscribe = broadcast.subscribe(() => notified++);

    broadcast.post();
    unsubscribe();
    broadcast.post();

    expect(notified).toBe(1);
    broadcast.destroy();
  });
});
