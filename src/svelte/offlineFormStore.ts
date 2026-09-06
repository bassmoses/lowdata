import { createOfflineForm } from '../forms/offlineForm.js';
import type { FormStatus, OfflineFormConfig } from '../forms/types.js';
import type { SvelteReadable } from './types.js';

export interface OfflineFormStore<T> extends SvelteReadable<FormStatus> {
  save(values: T): Promise<void>;
  submit(values: T): Promise<void>;
  retry(): Promise<void>;
  /**
   * Svelte's `$store` auto-subscription unsubscribes for you, but it has no concept of "this
   * component is gone, release the form's own onSync subscription too" — call this yourself
   * (e.g. in `onDestroy` from `'svelte'`) or it leaks on the shared/default client.
   */
  destroy(): void;
}

/** Svelte-store binding over `createOfflineForm`. */
export function createOfflineFormStore<T = Record<string, unknown>>(
  config: OfflineFormConfig<T>,
): OfflineFormStore<T> {
  const form = createOfflineForm<T>(config);
  return {
    subscribe(run) {
      run(form.getStatus());
      return form.subscribe((status) => run(status));
    },
    save: (values: T) => form.save(values),
    submit: async (values: T) => {
      await form.submit(values);
    },
    retry: () => form.retry(),
    destroy: () => form.destroy(),
  };
}
