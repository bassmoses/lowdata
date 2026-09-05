import { LOWDATA_DB_NAME, LOWDATA_DB_VERSION, LOWDATA_STORES } from '../core/idb.js';
import { createIndexedDbStorageAdapter } from '../core/storageAdapter.js';
import type { FormRecord } from './types.js';

const STORE = 'formDrafts';

function draftKey(formId: string): string {
  return `draft:${formId}`;
}

// Goes through the same pooled/reference-counted IndexedDB connection `LowdataClient` uses for its
// default (unnamespaced) queue — one physical connection to the shared `lowdata` database, not two
// independent ones, since both target the same dbName.
const adapter = createIndexedDbStorageAdapter({
  dbName: LOWDATA_DB_NAME,
  dbVersion: LOWDATA_DB_VERSION,
  stores: LOWDATA_STORES,
});

/** Autosave-before-send: the recoverable "currently being typed" draft for a form, one per formId. */
export async function saveDraft<T>(formId: string, values: T): Promise<FormRecord<T>> {
  const key = draftKey(formId);
  const now = Date.now();
  const existing = await getSubmission<T>(key);
  const record: FormRecord<T> = {
    submissionId: key,
    formId,
    kind: 'draft',
    values,
    status: 'saved',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveSubmission(record);
  return record;
}

export async function loadDraft<T>(formId: string): Promise<FormRecord<T> | undefined> {
  return getSubmission<T>(draftKey(formId));
}

export async function discardDraft(formId: string): Promise<void> {
  await adapter.delete(STORE, draftKey(formId));
}

export async function saveSubmission<T>(record: FormRecord<T>): Promise<void> {
  await adapter.put(STORE, record);
}

export async function getSubmission<T>(submissionId: string): Promise<FormRecord<T> | undefined> {
  return adapter.get<FormRecord<T>>(STORE, submissionId);
}
