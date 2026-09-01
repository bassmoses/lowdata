import type { ConnectionQuality } from '../core/types.js';
import type { ImageCompressionOptions } from './types.js';

export type CompressionPreset = Required<Pick<ImageCompressionOptions, 'maxWidth' | 'quality'>> &
  Pick<ImageCompressionOptions, 'targetSizeKB'>;

/**
 * Aggressive-but-usable presets by connection quality. 'offline' is deliberately the smallest —
 * an image compressed while offline is headed straight into the persistent queue, where every
 * extra KB counts against storage quota and, eventually, the user's data bundle.
 */
const PRESETS: Record<ConnectionQuality, CompressionPreset> = {
  online: { maxWidth: 1600, quality: 0.72 },
  slow: { maxWidth: 1000, quality: 0.5, targetSizeKB: 150 },
  offline: { maxWidth: 800, quality: 0.4, targetSizeKB: 80 },
};

export function presetForQuality(quality: ConnectionQuality): CompressionPreset {
  return PRESETS[quality];
}
