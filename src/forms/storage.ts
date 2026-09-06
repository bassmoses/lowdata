import type { StorageAdapter } from '../core/storageAdapter.js';
import type { FormRecord } from './types.js';

const STORE = 'formDrafts';

function draftKey(formId: string): string {
  return `draft:${formId}`;
}

/**
 * Every function here takes the owning client's `StorageAdapter` explicitly rather than reaching
 * for a hardcoded shared one — two tenants with two different (namespaced) clients must never see
 * each other's drafts just because they both happen to use a form with the same `id`. See
 * `offlineForm.ts`, which passes `(config.client ?? default client).storage`.
 */
export async function saveDraft<T>(
  adapter: StorageAdapter,
  formId: string,
  values: T,
): Promise<FormRecord<T>> {
  const key = draftKey(formId);
  const now = Date.now();
  const existing = await getSubmission<T>(adapter, key);
  const record: FormRecord<T> = {
    submissionId: key,
    formId,
    kind: 'draft',
    values,
    status: 'saved',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveSubmission(adapter, record);
  return record;
}

export async function loadDraft<T>(
  adapter: StorageAdapter,
  formId: string,
): Promise<FormRecord<T> | undefined> {
  return getSubmission<T>(adapter, draftKey(formId));
}

export async function discardDraft(adapter: StorageAdapter, formId: string): Promise<void> {
  await adapter.delete(STORE, draftKey(formId));
}

export async function saveSubmission<T>(
  adapter: StorageAdapter,
  record: FormRecord<T>,
): Promise<void> {
  await adapter.put(STORE, record);
}

export async function getSubmission<T>(
  adapter: StorageAdapter,
  submissionId: string,
): Promise<FormRecord<T> | undefined> {
  return adapter.get<FormRecord<T>>(STORE, submissionId);
}
