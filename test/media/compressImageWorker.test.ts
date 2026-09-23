import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from '../../src/media/compressImage.js';
import { _resetCompressionWorkerForTests } from '../../src/media/compressImageWorker.js';

class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  postMessage = vi.fn((data: { requestId: number; file: Blob }) => {
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          requestId: data.requestId,
          ok: true,
          blob: new Blob(['ok']),
          width: 111,
          height: 222,
          sizeBytes: 2,
          quality: 0.42,
        },
      } as MessageEvent);
    });
  });
  terminate = vi.fn();
  constructor(public url: string) {}
}

function stubWorkerEnvironment(WorkerImpl: typeof FakeWorker = FakeWorker): void {
  vi.stubGlobal('Worker', WorkerImpl);
  vi.stubGlobal('OffscreenCanvas', { prototype: { convertToBlob: () => {} } });
  if (!('createObjectURL' in URL)) {
    // jsdom doesn't implement these at all — define them for the duration of the test.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
}

describe('compressImage — Worker/OffscreenCanvas path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCompressionWorkerForTests();
  });

  it('uses the worker result untouched, and never touches the main-thread canvas path, when supported', async () => {
    stubWorkerEnvironment();
    const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 800 });

    expect(result).toEqual({
      blob: expect.any(Blob),
      width: 111,
      height: 222,
      sizeBytes: 2,
      quality: 0.42,
    });
    expect(toBlobSpy).not.toHaveBeenCalled();
  });

  it('fails open to the main-thread path when the worker reports an error', async () => {
    class FailingWorker extends FakeWorker {
      override postMessage = vi.fn((data: { requestId: number }) => {
        queueMicrotask(() =>
          this.onmessage?.({
            data: { requestId: data.requestId, ok: false, error: 'boom' },
          } as MessageEvent),
        );
      });
    }
    stubWorkerEnvironment(FailingWorker);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 800 });

    expect(result.quality).toBeGreaterThan(0); // resolved via the ordinary main-thread path, not rejected
  });

  it('fails open to the main-thread path when Worker construction itself throws (e.g. CSP blocking blob workers)', async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('CSP violation');
      }
    }
    stubWorkerEnvironment(ThrowingWorker as unknown as typeof FakeWorker);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    await expect(compressImage(file, { maxWidth: 800 })).resolves.toEqual(
      expect.objectContaining({ width: expect.any(Number) }),
    );
  });

  it('falls open to the main-thread path, and never retries the worker again, when the worker crashes mid-flight (onerror)', async () => {
    const ctorSpy = vi.fn();
    class CrashingWorker extends FakeWorker {
      constructor(url: string) {
        super(url);
        ctorSpy();
      }
      override postMessage = vi.fn(() => {
        // Simulate the whole worker dying before it ever replies — never calls onmessage.
        queueMicrotask(() => this.onerror?.(new Event('error')));
      });
    }
    stubWorkerEnvironment(CrashingWorker);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result1 = await compressImage(file, { maxWidth: 800 });
    expect(result1.quality).toBeGreaterThan(0); // resolved via main-thread fallback, not hung/rejected

    // A second call must not attempt to construct another worker — `workerUnavailable` is sticky
    // for the rest of the session once the worker has crashed once.
    const result2 = await compressImage(file, { maxWidth: 800 });
    expect(result2.quality).toBeGreaterThan(0);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
  });

  it('fails open to the main-thread path when postMessage itself throws', async () => {
    class ThrowingPostMessageWorker extends FakeWorker {
      override postMessage = vi.fn(() => {
        throw new Error('postMessage failed');
      });
    }
    stubWorkerEnvironment(ThrowingPostMessageWorker);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    const result = await compressImage(file, { maxWidth: 800 });

    expect(result.quality).toBeGreaterThan(0);
  });

  it('preferMainThread: true skips the worker entirely even when it is fully supported', async () => {
    const ctorSpy = vi.fn();
    class SpiedWorker extends FakeWorker {
      constructor(url: string) {
        super(url);
        ctorSpy();
      }
    }
    stubWorkerEnvironment(SpiedWorker);
    const file = new Blob(['fake'], { type: 'image/jpeg' });

    await compressImage(file, { maxWidth: 800, preferMainThread: true });

    expect(ctorSpy).not.toHaveBeenCalled();
  });
});
