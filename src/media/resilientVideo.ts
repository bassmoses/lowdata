import { Emitter } from '../core/events.js';
import { computeBackoffDelay } from '../core/backoff.js';
import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import { DEFAULT_RETRY_CONFIG } from '../core/types.js';
import type { ConnectionQuality, RetryBackoffConfig, Unsubscribe } from '../core/types.js';
import { createProgressiveImageLoader } from './progressiveImage.js';
import type { ProgressiveImageState } from './progressiveImage.js';
import { pickInitialSourceIndex } from './videoQualityPolicy.js';

export interface VideoSource {
  src: string;
  /** MIME hint, e.g. 'video/mp4'. Informational — forwarded on `ResilientVideoState.videoType`. */
  type?: string;
  /** Informational only (debug UI, telemetry) — e.g. '1080p', 'CDN A'. */
  label?: string;
  /** Which connection tier this source targets. Omit for "any tier". Never `'offline'` — a source
   * is by definition something to fetch over the network; offline has no source at all. */
  quality?: 'online' | 'slow';
}

export type ResilientVideoStatus = 'offline' | 'loading' | 'playable' | 'retrying' | 'exhausted';

export interface ResilientVideoState {
  status: ResilientVideoStatus;
  /** `<video src>` to render right now, or `undefined` when nothing is playable (offline/exhausted/retrying). */
  videoSrc: string | undefined;
  videoType: string | undefined;
  sourceLabel: string | undefined;
  /** Index into `options.sources` of the current/last-attempted source, or -1 if none was ever attempted. */
  sourceIndex: number;
  /** Failure streak feeding `computeBackoffDelay`; resets to 0 on `reportPlayable()`/`retry()`/reconnect. */
  attempt: number;
  /**
   * Poster sub-state, present whenever `options.poster` was given — independent of `status`, so a
   * `<video poster>` (or a standalone `<img>` fallback) can use it in every state, not just when
   * exhausted/offline.
   */
  poster: ProgressiveImageState | undefined;
}

export interface ResilientVideoLoaderOptions {
  sources: VideoSource[];
  /** Full poster image. Optional. */
  poster?: string;
  /** Tiny inline placeholder for the poster's blur-up preload. Requires `poster`; ignored without it. */
  posterPlaceholder?: string;
  /** Time to wait for `reportPlayable()` after a source is armed before treating it as stalled. Default 8000. */
  stallTimeoutMs?: number;
  /**
   * Paces backoff between a failed/stalled source and the next one via `computeBackoffDelay`. Only
   * `baseDelayMs`/`maxDelayMs`/`jitter` are read — `maxRetries` is deliberately ignored. Every
   * source in `sources[]` always gets exactly one attempt per fallback sequence regardless of
   * `maxRetries`; that field exists elsewhere in lowdata for HTTP retry budgets, not for capping
   * how many caller-listed mirrors get tried.
   */
  retry?: Partial<RetryBackoffConfig>;
}

export interface ResilientVideoLoader {
  subscribe(callback: (state: ResilientVideoState) => void): Unsubscribe;
  getState(): ResilientVideoState;
  /** Wire to the real `<video>` element's `onCanPlay`/`onLoadedData`. No-op unless currently `'loading'`. */
  reportPlayable(): void;
  /** Wire to `onError`/`onStalled`. `reason` is optional, for logging only. No-op unless currently
   * `'loading'` or `'playable'` — guards against duplicate/late DOM events double-advancing the fallback. */
  reportError(reason?: string): void;
  /** Manual "tap to retry" — re-reads current connection quality and restarts the fallback sequence from the top. */
  retry(): void;
  destroy(): void;
}

const DEFAULT_STALL_TIMEOUT_MS = 8000;

function buildFallbackOrder(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => (start + i) % length);
}

/**
 * Multi-source, connection-aware video loader: picks a starting source for the current connection
 * quality, falls back through the rest of `sources[]` on error or stall (via the same
 * `computeBackoffDelay` pacing `lowdata`'s request queue uses), and settles into a poster-only
 * terminal state once every source has failed — auto-retrying once on the next offline→online
 * reconnect edge, plus an explicit `retry()` for a "tap to retry" affordance.
 *
 * Unlike `createProgressiveImageLoader`, this loader never owns a real element — an actual
 * `<video>` must live in the consumer's own DOM. `reportPlayable()`/`reportError()` are the manual
 * escape hatch a consumer wires to that element's DOM events, mirroring
 * `ConnectionMonitor.reportStatus()`'s pattern for hosts/events it can't observe directly itself.
 */
export function createResilientVideoLoader(
  options: ResilientVideoLoaderOptions,
): ResilientVideoLoader {
  const emitter = new Emitter<ResilientVideoState>();
  const retryConfig: RetryBackoffConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retry };
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  let disposed = false;
  let sourceOrder: number[] = [];
  let cursorPos = -1;
  let attempt = 0;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  let posterLoader: ReturnType<typeof createProgressiveImageLoader> | undefined;
  let posterUnsubscribe: Unsubscribe | undefined;
  let initialPoster: ProgressiveImageState | undefined;
  if (options.poster && options.posterPlaceholder) {
    posterLoader = createProgressiveImageLoader({
      src: options.poster,
      placeholder: options.posterPlaceholder,
    });
    initialPoster = posterLoader.getState();
  } else if (options.poster) {
    // No placeholder to blur up from — showing the final poster immediately beats blocking on a
    // preload with nothing to show meanwhile. Mirrors progressiveImage.ts's own no-preload branch.
    initialPoster = { src: options.poster, isLoaded: true };
  }

  let current: ResilientVideoState = {
    status: 'offline',
    videoSrc: undefined,
    videoType: undefined,
    sourceLabel: undefined,
    sourceIndex: -1,
    attempt: 0,
    poster: initialPoster,
  };

  function emit(): void {
    if (disposed) return;
    emitter.emit(current);
  }

  if (posterLoader) {
    posterUnsubscribe = posterLoader.subscribe((posterState) => {
      current = { ...current, poster: posterState };
      emit();
    });
  }

  function clearStallTimer(): void {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  }

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function armAt(orderPos: number): void {
    const srcIdx = sourceOrder[orderPos];
    if (srcIdx === undefined) return; // invalid orderPos — defensive guard, should never happen
    const source = options.sources[srcIdx];
    if (source === undefined) return;
    cursorPos = orderPos;
    current = {
      ...current,
      status: 'loading',
      videoSrc: source.src,
      videoType: source.type,
      sourceLabel: source.label,
      sourceIndex: srcIdx,
      attempt,
    };
    emit();
    stallTimer = setTimeout(() => advance('stall-timeout'), stallTimeoutMs);
  }

  /** Fully restarts the fallback sequence for the given quality — used by construction, `retry()`,
   * and the offline→online reconnect edge. Never resumes mid-sequence; always re-evaluates from scratch. */
  function resetAndArm(quality: ConnectionQuality): void {
    clearStallTimer();
    clearRetryTimer();
    attempt = 0;

    if (quality === 'offline') {
      cursorPos = -1;
      current = {
        ...current,
        status: 'offline',
        videoSrc: undefined,
        videoType: undefined,
        sourceLabel: undefined,
        sourceIndex: -1,
        attempt: 0,
      };
      emit();
      return;
    }

    const start = pickInitialSourceIndex(options.sources, quality);
    if (start === -1) {
      // Only reachable here via an empty sources[] — 'offline' quality was already handled above.
      cursorPos = -1;
      current = {
        ...current,
        status: 'exhausted',
        videoSrc: undefined,
        videoType: undefined,
        sourceLabel: undefined,
        sourceIndex: -1,
        attempt: 0,
      };
      emit();
      return;
    }

    sourceOrder = buildFallbackOrder(start, options.sources.length);
    armAt(0);
  }

  /** Shared by `reportError()` and the stall timeout — advances to the next source in
   * `sourceOrder`, or settles into `'exhausted'` once none remain. */
  function advance(_reason?: string): void {
    if (disposed) return;
    if (current.status !== 'loading' && current.status !== 'playable') return;
    clearStallTimer();

    const nextPos = cursorPos + 1;
    if (nextPos < sourceOrder.length) {
      const delay = computeBackoffDelay(attempt, retryConfig);
      attempt += 1;
      cursorPos = nextPos;
      current = {
        ...current,
        status: 'retrying',
        videoSrc: undefined,
        videoType: undefined,
        sourceLabel: undefined,
        attempt,
      };
      emit();
      retryTimer = setTimeout(() => armAt(cursorPos), delay);
    } else {
      cursorPos = -1;
      current = {
        ...current,
        status: 'exhausted',
        videoSrc: undefined,
        videoType: undefined,
        sourceLabel: undefined,
        sourceIndex: -1,
      };
      emit();
    }
  }

  let lastQuality: ConnectionQuality = getConnectionQuality().quality;

  // Auto-retry, once, on the offline→online/slow edge — never on a repeating timer (matching the
  // restraint of the connection monitor's own opt-in ping probe, which also never auto-repeats).
  // Deliberately ignored while 'loading'/'retrying'/'playable': an in-progress or already-succeeding
  // sequence shouldn't be interrupted just because a (possibly noisy) connection-quality event fired.
  const unsubscribeConnection = onConnectionChange((info) => {
    if (disposed) return;
    const prevQuality = lastQuality;
    lastQuality = info.quality;
    const reconnectEdge = prevQuality === 'offline' && info.quality !== 'offline';
    if (!reconnectEdge) return;
    if (current.status !== 'offline' && current.status !== 'exhausted') return;
    resetAndArm(info.quality);
  });

  resetAndArm(lastQuality);

  return {
    subscribe: (callback) => emitter.subscribe(callback),
    getState: () => current,
    reportPlayable() {
      if (disposed) return;
      if (current.status !== 'loading') return;
      clearStallTimer();
      attempt = 0;
      current = { ...current, status: 'playable', attempt: 0 };
      emit();
    },
    reportError(reason) {
      advance(reason);
    },
    retry() {
      if (disposed) return;
      const quality = getConnectionQuality().quality;
      lastQuality = quality;
      resetAndArm(quality);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clearStallTimer();
      clearRetryTimer();
      unsubscribeConnection();
      posterUnsubscribe?.();
      posterLoader?.destroy();
      emitter.clear();
    },
  };
}
