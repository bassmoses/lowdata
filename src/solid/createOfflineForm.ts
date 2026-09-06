import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { createOfflineForm as createForm, type OfflineForm } from '../forms/offlineForm.js';
import type { FormStatus, OfflineFormConfig } from '../forms/types.js';

export interface SolidOfflineForm<T> {
  status: Accessor<FormStatus>;
  save: (values: T) => Promise<void>;
  submit: (values: T) => Promise<void>;
  retry: () => Promise<void>;
}

/** Solid binding over `createOfflineForm` (from `lowdata`) — status as a reactive signal. */
export function createOfflineForm<T = Record<string, unknown>>(
  config: OfflineFormConfig<T>,
): SolidOfflineForm<T> {
  const form: OfflineForm<T> = createForm<T>(config);
  const [status, setStatus] = createSignal<FormStatus>(form.getStatus());
  const unsubscribe = form.subscribe((next) => setStatus(() => next));

  onCleanup(() => {
    unsubscribe();
    // Releases the form's own onSync subscription — otherwise it leaks on the shared/default
    // client every time this reactive scope is disposed.
    form.destroy();
  });

  return {
    status,
    save: (values: T) => form.save(values),
    submit: async (values: T) => {
      await form.submit(values);
    },
    retry: () => form.retry(),
  };
}
