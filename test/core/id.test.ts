import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../../src/core/id.js';

describe('createId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces a crypto.randomUUID-backed id when available', () => {
    const id = createId();
    // jsdom provides crypto.randomUUID, so the fast path is exercised here.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to a manual id when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);

    const id = createId();

    expect(id).toMatch(/^ld_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('falls back when crypto exists but randomUUID does not (older/partial crypto implementations)', () => {
    vi.stubGlobal('crypto', {});

    const id = createId();

    expect(id).toMatch(/^ld_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('fallback ids are sufficiently unique across many calls', () => {
    vi.stubGlobal('crypto', undefined);

    const ids = new Set(Array.from({ length: 200 }, () => createId()));

    expect(ids.size).toBe(200);
  });
});
