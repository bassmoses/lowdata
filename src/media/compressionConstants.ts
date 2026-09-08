/**
 * Quality-search tuning shared between the main-thread canvas path (`compressImage.ts`) and the
 * off-main-thread OffscreenCanvas path (`compressImageWorker.ts`). The worker's script is a
 * hand-written JS string, not generated from these same TS functions (see that file's top comment
 * for why) — but these three numbers are interpolated into that string from here, not duplicated
 * by hand, so the two paths' quality-search behavior can never silently drift apart.
 */
export const MIN_QUALITY = 0.35;
export const QUALITY_STEP = 0.1;
export const MAX_QUALITY_ITERATIONS = 5;
