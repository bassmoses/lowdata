import { onScopeDispose, ref, type Ref } from 'vue';
import { createOfflineForm, type OfflineForm } from '../forms/offlineForm.js';
import type { FormStatus, OfflineFormConfig } from '../forms/types.js';

export interface UseOfflineFormResult<T> {
  status: Ref<FormStatus>;
  save: (values: T) => Promise<void>;
  submit: (values: T) => Promise<void>;
  retry: () => Promise<void>;
}

/** Vue binding over `createOfflineForm`. The form instance is created once, on setup. */
export function useOfflineForm<T = Record<string, unknown>>(
  config: OfflineFormConfig<T>,
): UseOfflineFormResult<T> {
  const form: OfflineForm<T> = createOfflineForm(config);
  const status = ref<FormStatus>(form.getStatus()) as Ref<FormStatus>;
  const unsubscribe = form.subscribe((next) => {
    status.value = next;
  });

  onScopeDispose(() => {
    unsubscribe();
    // Releases the form's own onSync subscription — otherwise it leaks on the shared/default
    // client every time the component unmounts.
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
