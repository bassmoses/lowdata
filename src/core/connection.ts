import { Emitter } from './events.js';
import type {
  ConnectionInfo,
  ConnectionListener,
  ConnectionQuality,
  Unsubscribe,
} from './types.js';

/**
 * The Network Information API (`navigator.connection`) is Chromium-only and not part of the
 * standard DOM lib types, hence this local shape instead of a global augmentation.
 */
interface NetworkInformationLike {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

type NavigatorWithConnection = Navigator & { connection?: NetworkInformationLike };

export interface ConnectionMonitorOptions {
  /**
   * Opt-in latency probe URL used to detect 'slow' connections on browsers without the Network
   * Information API (Safari, Firefox). Never probed automatically on a timer — only once on
   * startup and once per reconnect — because every probe costs a little data.
   */
  pingUrl?: string;
  /** Round-trip time above which the ping probe classifies the connection as 'slow'. Default 600ms. */
  slowRttThresholdMs?: number;
  /** downlink (Mbps) below which the Network Information API classifies as 'slow'. Default 0.5. */
  slowDownlinkMbps?: number;
  /** Timeout for the ping probe itself, in ms. Default 5000. */
  pingTimeoutMs?: number;
}

const DEFAULT_SLOW_RTT_MS = 600;
const DEFAULT_SLOW_DOWNLINK_MBPS = 0.5;
const DEFAULT_PING_TIMEOUT_MS = 5000;

function hasNavigator(): boolean {
  return typeof navigator !== 'undefined';
}

/**
 * Tracks connection quality (online / slow / offline) using the best signal available:
 * `navigator.onLine` + online/offline events as the universal baseline, `navigator.connection`
 * where present, and an optional opt-in ping probe as a cross-browser fallback for 'slow'.
 */
export class ConnectionMonitor {
  private emitter = new Emitter<ConnectionInfo>();
  private current: ConnectionInfo;
  private probedRttMs: number | undefined;
  private readonly options: Required<
    Pick<ConnectionMonitorOptions, 'slowRttThresholdMs' | 'slowDownlinkMbps' | 'pingTimeoutMs'>
  > &
    Pick<ConnectionMonitorOptions, 'pingUrl'>;
  private disposed = false;
  private onlineHandler?: () => void;
  private offlineHandler?: () => void;
  private connectionChangeHandler?: () => void;

  constructor(options: ConnectionMonitorOptions = {}) {
    this.options = {
      pingUrl: options.pingUrl,
      slowRttThresholdMs: options.slowRttThresholdMs ?? DEFAULT_SLOW_RTT_MS,
      slowDownlinkMbps: options.slowDownlinkMbps ?? DEFAULT_SLOW_DOWNLINK_MBPS,
      pingTimeoutMs: options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    };
    this.current = this.computeInfo();

    if (hasNavigator() && typeof window !== 'undefined') {
      this.onlineHandler = () => {
        this.refresh();
        void this.probeNow();
      };
      this.offlineHandler = () => this.refresh();
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);

      const conn = (navigator as NavigatorWithConnection).connection;
      if (conn?.addEventListener) {
        this.connectionChangeHandler = () => this.refresh();
        conn.addEventListener('change', this.connectionChangeHandler);
      }
    }

    if (this.options.pingUrl) {
      void this.probeNow();
    }
  }

  getStatus(): ConnectionInfo {
    return this.current;
  }

  subscribe(listener: ConnectionListener): Unsubscribe {
    return this.emitter.subscribe(listener);
  }

  /** Manually re-run the opt-in ping probe (no-op if no `pingUrl` was configured). */
  async probeNow(): Promise<ConnectionInfo> {
    if (!this.options.pingUrl || !hasNavigator() || navigator.onLine === false) {
      return this.current;
    }
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.pingTimeoutMs);
    try {
      await fetch(this.options.pingUrl, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      });
      this.probedRttMs = Date.now() - start;
    } catch {
      // A failed probe tells us nothing reliable about latency; leave prior measurement as-is.
    } finally {
      clearTimeout(timer);
    }
    return this.refresh();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') {
      if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
      if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
    }
    if (hasNavigator() && this.connectionChangeHandler) {
      const conn = (navigator as NavigatorWithConnection).connection;
      conn?.removeEventListener?.('change', this.connectionChangeHandler);
    }
    this.emitter.clear();
  }

  private refresh(): ConnectionInfo {
    this.current = this.computeInfo();
    this.emitter.emit(this.current);
    return this.current;
  }

  private computeInfo(): ConnectionInfo {
    if (!hasNavigator()) {
      // Server/SSR context: assume the best case rather than block anything.
      return { quality: 'online', online: true };
    }

    const online = navigator.onLine !== false;
    if (!online) {
      return { quality: 'offline', online: false };
    }

    const conn = (navigator as NavigatorWithConnection).connection;
    if (conn) {
      const info: ConnectionInfo = {
        quality: 'online',
        online: true,
        effectiveType: conn.effectiveType,
        downlinkMbps: conn.downlink,
        rttMs: conn.rtt,
        saveData: conn.saveData,
      };
      const isSlow =
        conn.saveData === true ||
        conn.effectiveType === '2g' ||
        conn.effectiveType === 'slow-2g' ||
        (typeof conn.downlink === 'number' && conn.downlink < this.options.slowDownlinkMbps) ||
        (typeof conn.rtt === 'number' && conn.rtt > this.options.slowRttThresholdMs);
      return { ...info, quality: isSlow ? 'slow' : 'online' };
    }

    // No Network Information API: fall back to the opt-in ping probe measurement, if any.
    const quality: ConnectionQuality =
      typeof this.probedRttMs === 'number' && this.probedRttMs > this.options.slowRttThresholdMs
        ? 'slow'
        : 'online';
    return {
      quality,
      online: true,
      rttMs: this.probedRttMs,
    };
  }
}

let sharedMonitor: ConnectionMonitor | undefined;

function getSharedMonitor(): ConnectionMonitor {
  if (!sharedMonitor) sharedMonitor = new ConnectionMonitor();
  return sharedMonitor;
}

/** Convenience one-shot read of connection quality, without owning a `LowdataClient`. */
export function getConnectionQuality(): ConnectionInfo {
  return getSharedMonitor().getStatus();
}

/** Convenience subscription to connection changes, without owning a `LowdataClient`. */
export function onConnectionChange(listener: ConnectionListener): Unsubscribe {
  return getSharedMonitor().subscribe(listener);
}
