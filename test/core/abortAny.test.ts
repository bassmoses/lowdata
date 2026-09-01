import { describe, expect, it } from 'vitest';
import { combineSignals } from '../../src/core/abortAny.js';

describe('combineSignals', () => {
  it('aborts the combined signal when any input signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = combineSignals([a.signal, b.signal]);

    expect(signal.aborted).toBe(false);
    b.abort('b-reason');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('b-reason');
    dispose();
  });

  it('is immediately aborted if an input signal is already aborted', () => {
    const a = new AbortController();
    a.abort('already-aborted');
    const { signal } = combineSignals([a.signal]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('already-aborted');
  });

  it('ignores undefined entries and stays unaborted if nothing aborts', () => {
    const { signal } = combineSignals([undefined, undefined]);
    expect(signal.aborted).toBe(false);
  });

  it('dispose() stops listening, so a later abort no longer propagates', () => {
    const a = new AbortController();
    const { signal, dispose } = combineSignals([a.signal]);
    dispose();
    a.abort();
    expect(signal.aborted).toBe(false);
  });
});
