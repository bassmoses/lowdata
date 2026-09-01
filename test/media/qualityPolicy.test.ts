import { describe, expect, it } from 'vitest';
import { presetForQuality } from '../../src/media/qualityPolicy.js';

describe('presetForQuality', () => {
  it('gets progressively smaller and more aggressive as connection quality degrades', () => {
    const online = presetForQuality('online');
    const slow = presetForQuality('slow');
    const offline = presetForQuality('offline');

    expect(online.maxWidth).toBeGreaterThan(slow.maxWidth);
    expect(slow.maxWidth).toBeGreaterThan(offline.maxWidth);
    expect(online.quality).toBeGreaterThan(slow.quality);
    expect(slow.quality).toBeGreaterThan(offline.quality);
  });

  it('only sets a byte budget (targetSizeKB) for degraded connections', () => {
    expect(presetForQuality('online').targetSizeKB).toBeUndefined();
    expect(presetForQuality('slow').targetSizeKB).toBeDefined();
    expect(presetForQuality('offline').targetSizeKB).toBeDefined();
  });
});
