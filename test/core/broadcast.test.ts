import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueueBroadcast } from '../../src/core/broadcast.js';
import { waitForCondition } from '../helpers/wait.js';

describe('createQueueBroadcast', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    await waitForCondition(() => bNotified, {
      message: 'expected the other channel to be notified',
    });
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

  it('destroy() is idempotent — calling it twice does not throw', () => {
    const broadcast = createQueueBroadcast(`test-channel-double-destroy-${Math.random()}`);
    broadcast.destroy();
    expect(() => broadcast.destroy()).not.toThrow();
  });

  it('still notifies local subscribers on post() when BroadcastChannel is unsupported (old browser / some SSR contexts)', () => {
    vi.stubGlobal('BroadcastChannel', undefined);

    const broadcast = createQueueBroadcast(`test-channel-no-bc-${Math.random()}`);
    let notified = 0;
    broadcast.subscribe(() => notified++);

    broadcast.post();

    expect(notified).toBe(1);
    expect(() => broadcast.destroy()).not.toThrow();
  });

  it('does not cross-notify between two instances when BroadcastChannel is unsupported (falls back to same-tab only)', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);

    const channelName = `test-channel-no-bc-shared-${Math.random()}`;
    const tabA = createQueueBroadcast(channelName);
    const tabB = createQueueBroadcast(channelName);
    let bNotified = false;
    tabB.subscribe(() => {
      bNotified = true;
    });

    tabA.post();
    // Give any (unexpected) async notification a chance to land before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bNotified).toBe(false);
    tabA.destroy();
    tabB.destroy();
  });
});
