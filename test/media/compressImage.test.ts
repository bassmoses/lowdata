import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from '../../src/media/compressImage.js';

function stubImageSource(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: () => {} })),
  );
}

describe('compressImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downscales an oversized image to maxWidth, preserving aspect ratio', async () => {
    stubImageSource(4000, 2000);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 1000 });
    expect(result.width).toBe(1000);
    expect(result.height).toBe(500);
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it('leaves a small image at its original dimensions', async () => {
    stubImageSource(400, 300);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 1000 });
    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
  });

  it('also respects maxHeight when set', async () => {
    stubImageSource(1000, 4000);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 2000, maxHeight: 1000 });
    expect(result.height).toBe(1000);
    expect(result.width).toBe(250);
  });

  it('iterates quality downward when a targetSizeKB budget is set, shrinking the result', async () => {
    stubImageSource(1000, 1000);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const withoutBudget = await compressImage(file, { quality: 0.9 });
    const withBudget = await compressImage(file, {
      quality: 0.9,
      targetSizeKB: Math.round(withoutBudget.sizeBytes / 1024 / 2),
    });

    expect(withBudget.quality).toBeLessThan(0.9);
    expect(withBudget.blob.size).toBeLessThan(withoutBudget.blob.size);
  });

  it('applies a connection-aware preset when requested', async () => {
    stubImageSource(3000, 3000);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    // Default connection quality in this jsdom test environment is 'online'.
    const result = await compressImage(file, { connectionAware: true });
    expect(result.width).toBeLessThanOrEqual(1600);
  });

  it('returns dimensions and a sensible default quality when no options are given', async () => {
    stubImageSource(800, 600);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.quality).toBeGreaterThan(0);
    expect(result.quality).toBeLessThanOrEqual(1);
  });
});
