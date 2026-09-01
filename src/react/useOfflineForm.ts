import { useEffect, useMemo, useState } from 'react';
import { createOfflineForm, type OfflineForm } from '../forms/offlineForm.js';
import type { FormStatus, OfflineFormConfig } from '../forms/types.js';

export interface UseOfflineFormResult<T> {
  status: FormStatus;
  save: (values: T) => Promise<void>;
  submit: (values: T) => Promise<void>;
  retry: () => Promise<void>;
}

/**
 * React binding over `createOfflineForm`. The form instance is created once per `config.id` —
 * other config fields (endpoint, client, transform) are read on creation only.
 */
export function useOfflineForm<T = Record<string, unknown>>(
  config: OfflineFormConfig<T>,
): UseOfflineFormResult<T> {
  const form = useMemo<OfflineForm<T>>(() => createOfflineForm(config), [config.id]);
  const [status, setStatus] = useState<FormStatus>(() => form.getStatus());

  useEffect(() => {
    setStatus(form.getStatus());
    const unsubscribe = form.subscribe((next) => setStatus(next));
    return () => {
      unsubscribe();
      // Releases the form's own onSync subscription — otherwise it leaks on the shared/default
      // client every time `config.id` changes (each change creates a fresh form via useMemo) or
      // the component unmounts.
      form.destroy();
    };
  }, [form]);

  return {
    status,
    save: (values: T) => form.save(values),
    submit: async (values: T) => {
      await form.submit(values);
    },
    retry: () => form.retry(),
  };
}
