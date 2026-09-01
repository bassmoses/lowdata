export interface ImageCompressionOptions {
  /** Longest edge in pixels; the image is downscaled proportionally to fit. Default 1280. */
  maxWidth?: number;
  maxHeight?: number;
  /** 0..1. Default 0.6, or a connection-aware preset when `connectionAware` is set. */
  quality?: number;
  mimeType?: 'image/jpeg' | 'image/webp';
  /** If set, quality is iteratively lowered (down to a floor) until the blob fits this budget. */
  targetSizeKB?: number;
  /** Pull `maxWidth`/`quality`/`targetSizeKB` defaults from the current connection quality. */
  connectionAware?: boolean;
}

export interface CompressedImageResult {
  blob: Blob;
  width: number;
  height: number;
  sizeBytes: number;
  quality: number;
}
