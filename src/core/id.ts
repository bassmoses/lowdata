/** Generate a reasonably unique id. Prefers `crypto.randomUUID`, falls back everywhere else. */
export function createId(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return `ld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
