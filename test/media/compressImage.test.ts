import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from '../../src/media/compressImage.js';
import { MIN_QUALITY } from '../../src/media/compressionConstants.js';

function stubImageSource(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: () => {} })),
  );
}

/**
 * Minimal `<img>` stand-in for the `loadImageSource()` fallback path (no `createImageBitmap`) —
 * unlike `test/helpers/fakeImage.ts`'s `FakeImage`, this carries `width`/`height` so
 * `computeTargetDimensions()` has something to work with.
 */
class FakeHtmlImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width: number;
  height: number;
  private _src = '';

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }

  get src(): string {
    return this._src;
  }
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

  it('requests EXIF-orientation-correct decoding via createImageBitmap', async () => {
    const createImageBitmapSpy = vi.fn(async () => ({ width: 800, height: 600, close: () => {} }));
    vi.stubGlobal('createImageBitmap', createImageBitmapSpy);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    await compressImage(file);

    expect(createImageBitmapSpy).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
  });

  it('falls back to loading via an <img> element when createImageBitmap is unavailable (e.g. older Safari)', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal(
      'Image',
      class extends FakeHtmlImage {
        constructor() {
          super(1600, 800);
        }
      } as unknown as typeof Image,
    );
    // jsdom doesn't implement these; the fallback path needs them to build/release an object URL.
    if (!('createObjectURL' in URL)) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    }
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 800 });

    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it('rejects instead of hanging when the canvas fails to produce a blob', async () => {
    stubImageSource(800, 600);
    const toBlobSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback: BlobCallback) => callback(null));
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    await expect(compressImage(file)).rejects.toThrow(
      'lowdata: canvas failed to produce an image blob',
    );

    toBlobSpy.mockRestore();
  });

  it('gives up gracefully (rather than looping forever or throwing) when targetSizeKB can never be reached, returning its best attempt', async () => {
    stubImageSource(1000, 1000);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    // The fake toBlob() in test/setup/canvas.ts floors a blob at 100 bytes, so this budget is
    // unreachable at any quality — the iterative search must still terminate (bounded by
    // MAX_QUALITY_ITERATIONS) instead of spinning or rejecting.
    const result = await compressImage(file, { quality: 0.9, targetSizeKB: 0.001 });

    expect(result.quality).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(result.quality).toBeLessThan(0.9);
    expect(result.blob.size).toBeGreaterThan(0);
  });
});
