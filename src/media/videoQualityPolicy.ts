import type { ConnectionQuality } from '../core/types.js';
import type { VideoSource } from './resilientVideo.js';

/**
 * Picks the starting index into `sources[]` for a given connection quality. Pure and
 * connection-monitor-free — unit-testable directly, unlike the live loader (which reads quality
 * from the shared connection singleton and would need real `navigator.connection` stubbing to
 * exercise the 'slow' branch end-to-end).
 *
 * `'offline'` never attempts a source (-1): pointing a `<video>` at any URL while offline just
 * burns a full stall timeout for a guaranteed failure — the connection state already answers the
 * question. `'slow'`/`'online'` prefer a source explicitly tagged for that tier, then an untagged
 * ("any tier") source, then the first candidate rather than nothing.
 */
export function pickInitialSourceIndex(sources: VideoSource[], quality: ConnectionQuality): number {
  if (quality === 'offline' || sources.length === 0) return -1;
  const tagged = sources.findIndex((s) => s.quality === quality);
  if (tagged !== -1) return tagged;
  const untagged = sources.findIndex((s) => s.quality === undefined);
  if (untagged !== -1) return untagged;
  return 0;
}
