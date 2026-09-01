// jsdom implements <canvas> elements but not their drawing/encoding APIs. These fakes are just
// enough for compressImage()'s tests: a no-op 2D context, and a toBlob() whose output size is a
// deterministic (monotonic in `quality`) function of canvas dimensions, so tests can assert on
// resizing and the iterative quality-search loop without needing a real image codec.
import { vi } from 'vitest';

class FakeCanvasRenderingContext2D {
  drawImage(): void {
    // no-op — dimensions/quality are all this test double needs to simulate
  }
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement, type: string) {
    if (type === '2d') {
      return new FakeCanvasRenderingContext2D() as unknown as CanvasRenderingContext2D;
    }
    return null;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type = 'image/png',
    quality = 1,
  ): void {
    const width = this.width || 1;
    const height = this.height || 1;
    const bytes = Math.max(100, Math.round(width * height * 3 * quality));
    const blob = new Blob([new Uint8Array(bytes)], { type });
    setTimeout(() => callback(blob), 0);
  };
}

if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = vi.fn(async () => ({
    width: 2000,
    height: 1000,
    close: () => {},
  })) as unknown as typeof createImageBitmap;
}
