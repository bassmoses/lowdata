import { createDbFallbackAccessor, getSharedDb, idbDelete, idbGet, idbPut } from '../core/idb.js';
import type { FormRecord } from './types.js';

const STORE = 'formDrafts';

function draftKey(formId: string): string {
  return `draft:${formId}`;
}

const memory = new Map<string, FormRecord<unknown>>();
const accessor = createDbFallbackAccessor(getSharedDb);

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
  const key = draftKey(formId);
  await accessor.run(
    (db) => idbDelete(db, STORE, key),
    () => {
      memory.delete(key);
    },
  );
}

export async function saveSubmission<T>(record: FormRecord<T>): Promise<void> {
  await accessor.run(
    (db) => idbPut<FormRecord<T>>(db, STORE, record),
    () => {
      memory.set(record.submissionId, record as FormRecord<unknown>);
    },
  );
}

export async function getSubmission<T>(submissionId: string): Promise<FormRecord<T> | undefined> {
  return accessor.run(
    (db) => idbGet<FormRecord<T>>(db, STORE, submissionId),
    () => memory.get(submissionId) as FormRecord<T> | undefined,
  );
}
