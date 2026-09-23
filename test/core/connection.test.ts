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

  it('reportStatus() merges over the last known info and notifies subscribers — for hosts (React Native, Electron main, Node) with no window/navigator.onLine to observe', () => {
    const monitor = new ConnectionMonitor();
    const listener = vi.fn();
    monitor.subscribe(listener);

    const result = monitor.reportStatus({ quality: 'offline', online: false });

    expect(result).toEqual({ quality: 'offline', online: false });
    expect(monitor.getStatus()).toEqual({ quality: 'offline', online: false });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'offline' }));
    monitor.destroy();
  });

  it('does not crash in a host where `window` exists but has no working addEventListener (e.g. React Native/Hermes)', () => {
    // React Native defines a `window` global for library-compatibility reasons, but it isn't a
    // real DOM window — `window.addEventListener` is simply absent. `typeof window !== 'undefined'`
    // alone doesn't catch this; reproduce that exact shape rather than just asserting on the
    // production code's own logic.
    const originalAddEventListener = window.addEventListener;
    const originalRemoveEventListener = window.removeEventListener;
    // @ts-expect-error -- deliberately simulating a host where these are missing, not functions
    delete window.addEventListener;
    // @ts-expect-error -- see above
    delete window.removeEventListener;

    try {
      expect(() => {
        const monitor = new ConnectionMonitor();
        monitor.destroy();
      }).not.toThrow();
    } finally {
      window.addEventListener = originalAddEventListener;
      window.removeEventListener = originalRemoveEventListener;
    }
  });

  it('still supports reportStatus() as the manual fallback when window.addEventListener is missing', () => {
    const originalAddEventListener = window.addEventListener;
    delete (window as { addEventListener?: unknown }).addEventListener;

    try {
      const monitor = new ConnectionMonitor();
      const listener = vi.fn();
      monitor.subscribe(listener);

      monitor.reportStatus({ quality: 'offline', online: false });

      expect(monitor.getStatus()).toEqual({ quality: 'offline', online: false });
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'offline' }));
      monitor.destroy();
    } finally {
      window.addEventListener = originalAddEventListener;
    }
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

  it('assumes the best case (online) in an SSR context with no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);

    const monitor = new ConnectionMonitor();

    expect(monitor.getStatus()).toEqual({ quality: 'online', online: true });
    expect(() => monitor.destroy()).not.toThrow();
  });

  describe('navigator.connection (Network Information API) shapes', () => {
    afterEach(() => {
      Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
    });

    it('classifies as slow when saveData is true, even with an otherwise fast-looking connection', () => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { saveData: true, effectiveType: '4g', downlink: 10, rtt: 20 },
      });

      const monitor = new ConnectionMonitor();

      expect(monitor.getStatus()).toEqual(
        expect.objectContaining({ quality: 'slow', saveData: true, effectiveType: '4g' }),
      );
      monitor.destroy();
    });

    it("classifies as slow when effectiveType is '2g' or 'slow-2g'", () => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { effectiveType: 'slow-2g' },
      });

      const monitor = new ConnectionMonitor();

      expect(monitor.getStatus().quality).toBe('slow');
      monitor.destroy();
    });

    it('classifies as slow when downlink is below the configured threshold', () => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { downlink: 0.2 },
      });

      const monitor = new ConnectionMonitor({ slowDownlinkMbps: 0.5 });

      expect(monitor.getStatus()).toEqual(
        expect.objectContaining({ quality: 'slow', downlinkMbps: 0.2 }),
      );
      monitor.destroy();
    });

    it('classifies as slow when rtt is above the configured threshold', () => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { rtt: 900 },
      });

      const monitor = new ConnectionMonitor({ slowRttThresholdMs: 600 });

      expect(monitor.getStatus()).toEqual(expect.objectContaining({ quality: 'slow', rttMs: 900 }));
      monitor.destroy();
    });

    it('classifies as online when connection fields are present but none cross a slow threshold', () => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
      });

      const monitor = new ConnectionMonitor();

      expect(monitor.getStatus()).toEqual({
        quality: 'online',
        online: true,
        effectiveType: '4g',
        downlinkMbps: 10,
        rttMs: 50,
        saveData: false,
      });
      monitor.destroy();
    });

    it('classifies as online when the connection object has none of the known fields set (all undefined)', () => {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: {} });

      const monitor = new ConnectionMonitor();

      expect(monitor.getStatus()).toEqual({
        quality: 'online',
        online: true,
        effectiveType: undefined,
        downlinkMbps: undefined,
        rttMs: undefined,
        saveData: undefined,
      });
      monitor.destroy();
    });

    it('re-derives quality from navigator.connection on a connection "change" event', () => {
      const connectionListeners = new Map<string, () => void>();
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: {
          effectiveType: '4g',
          addEventListener: (type: string, listener: () => void) => {
            connectionListeners.set(type, listener);
          },
          removeEventListener: (type: string) => {
            connectionListeners.delete(type);
          },
        },
      });

      const monitor = new ConnectionMonitor();
      const listener = vi.fn();
      monitor.subscribe(listener);
      expect(monitor.getStatus().quality).toBe('online');

      // Simulate the underlying connection object mutating (as the real Network Information API
      // does) and then firing its own 'change' event.
      (navigator as unknown as { connection: { effectiveType: string } }).connection.effectiveType =
        '2g';
      connectionListeners.get('change')?.();

      expect(monitor.getStatus().quality).toBe('slow');
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'slow' }));
      monitor.destroy();
    });
  });
});
