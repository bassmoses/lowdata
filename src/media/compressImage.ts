import { getConnectionQuality } from '../core/connection.js';
import { presetForQuality } from './qualityPolicy.js';
import type { CompressedImageResult, ImageCompressionOptions } from './types.js';

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_QUALITY = 0.6;
const DEFAULT_MIME: NonNullable<ImageCompressionOptions['mimeType']> = 'image/jpeg';
const MIN_QUALITY = 0.35;
const QUALITY_STEP = 0.1;
const MAX_QUALITY_ITERATIONS = 5;

type ImageSource = ImageBitmap | HTMLImageElement;

async function loadImageSource(file: File | Blob): Promise<ImageSource> {
  if (typeof createImageBitmap === 'function') {
    // `imageOrientation: 'from-image'` is the spec-defined way to force EXIF-orientation-correct
    // decoding regardless of a given browser's default — without it, a photo taken sideways on a
    // phone can come out of `drawImage()` still sideways, since canvas pixel data (unlike an
    // `<img>` element's own on-screen rendering) doesn't reliably apply EXIF orientation itself.
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  // Fallback for environments without createImageBitmap (older Safari).
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('lowdata: failed to load image for compression'));
    };
    img.src = url;
  });
}

function computeTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight?: number,
): { width: number; height: number } {
  let width = sourceWidth;
  let height = sourceHeight;

  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  if (maxHeight && height > maxHeight) {
    width = Math.round((width * maxHeight) / height);
    height = maxHeight;
  }
  return { width, height };
}

function drawToCanvas(source: ImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('lowdata: canvas 2D context is not available in this environment');
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('lowdata: canvas failed to produce an image blob'));
      },
      mimeType,
      quality,
    );
  });
}

/**
 * Client-side image compression via the Canvas API: downscales to a max dimension and re-encodes
 * at a target quality, optionally iterating quality further down to hit a byte budget. No
 * dependency — avoids pulling in a native/wasm image library, keeping the `lowdata/media` subpath
 * tiny. Known v1 limitation: EXIF orientation can be lost on re-encode in some browsers.
 */
export async function compressImage(
  file: File | Blob,
  options: ImageCompressionOptions = {},
): Promise<CompressedImageResult> {
  const preset = options.connectionAware
    ? presetForQuality(getConnectionQuality().quality)
    : undefined;
  const maxWidth = options.maxWidth ?? preset?.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight;
  const mimeType = options.mimeType ?? DEFAULT_MIME;
  const targetSizeKB = options.targetSizeKB ?? preset?.targetSizeKB;
  let quality = options.quality ?? preset?.quality ?? DEFAULT_QUALITY;

  const source = await loadImageSource(file);
  const { width, height } = computeTargetDimensions(
    source.width,
    source.height,
    maxWidth,
    maxHeight,
  );
  const canvas = drawToCanvas(source, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();

  let blob = await canvasToBlob(canvas, mimeType, quality);

  if (targetSizeKB) {
    const targetBytes = targetSizeKB * 1024;
    let iterations = 0;
    while (
      blob.size > targetBytes &&
      quality > MIN_QUALITY &&
      iterations < MAX_QUALITY_ITERATIONS
    ) {
      quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
      blob = await canvasToBlob(canvas, mimeType, quality);
      iterations++;
    }
  }

  return { blob, width, height, sizeBytes: blob.size, quality };
}
