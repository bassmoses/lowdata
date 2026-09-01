import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionMonitor } from '../../src/core/connection.js';
import { setOnline } from '../helpers/dom.js';

describe('ConnectionMonitor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('reports online by default in a jsdom environment', () => {
    const monitor = new ConnectionMonitor();
    expect(monitor.getStatus()).toEqual({ quality: 'online', online: true });
    monitor.destroy();
  });

  it('reports offline once navigator.onLine is false and the offline event fires', () => {
    const monitor = new ConnectionMonitor();
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(monitor.getStatus().quality).toBe('offline');
    expect(monitor.getStatus().online).toBe(false);
    monitor.destroy();
  });

  it('notifies subscribers on a connection change, and stops after unsubscribe', () => {
    const monitor = new ConnectionMonitor();
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'offline' }));

    unsubscribe();
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(listener).toHaveBeenCalledTimes(1);

    monitor.destroy();
  });

  it('uses the opt-in ping probe to classify a high-latency connection as slow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(null, { status: 200 });
      }),
    );

    const monitor = new ConnectionMonitor({ pingUrl: '/ping', slowRttThresholdMs: 1 });
    await monitor.probeNow();
    expect(monitor.getStatus().quality).toBe('slow');
    monitor.destroy();
  });

  it('does not probe while offline', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setOnline(false);

    const monitor = new ConnectionMonitor({ pingUrl: '/ping' });
    await monitor.probeNow();
    expect(fetchMock).not.toHaveBeenCalled();
    monitor.destroy();
  });

  it('stops emitting after destroy()', () => {
    const monitor = new ConnectionMonitor();
    const listener = vi.fn();
    monitor.subscribe(listener);
    monitor.destroy();

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(listener).not.toHaveBeenCalled();
  });
});
