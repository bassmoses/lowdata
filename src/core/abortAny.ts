/**
 * Combine multiple AbortSignals into one that aborts as soon as any input signal aborts.
 *
 * Hand-written because the build target (es2019) predates `AbortSignal.any()`, and this keeps
 * lowdata dependency-free rather than reaching for a polyfill.
 */
export function combineSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const active = signals.filter((s): s is AbortSignal => Boolean(s));

  const onAbort = (source: AbortSignal) => () => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };

  const cleanups: Array<() => void> = [];
  for (const s of active) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const handler = onAbort(s);
    s.addEventListener('abort', handler, { once: true });
    cleanups.push(() => s.removeEventListener('abort', handler));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
