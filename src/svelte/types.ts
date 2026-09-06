/**
 * Svelte's store contract (what `$store` auto-subscription actually requires) is purely
 * structural — an object with `.subscribe(run)` returning an unsubscribe function. Defining it
 * here, rather than importing `Readable` from `svelte/store`, means this entire subpath needs no
 * dependency on the `svelte` package at all: any Svelte (or Svelte-store-compatible) consumer can
 * use these values directly.
 */
export interface SvelteReadable<T> {
  subscribe(run: (value: T) => void): () => void;
}
