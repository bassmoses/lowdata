import type { LowdataClient } from '../network/client.js';

export type FormStatus = 'idle' | 'saved' | 'pending' | 'syncing' | 'failed' | 'success';

export interface FormSubmissionDetail {
  submissionId: string;
  error?: string;
}

export interface OfflineFormConfig<T = Record<string, unknown>> {
  /** Stable identifier for this form (e.g. `'clinic-intake'`). Used as the draft storage key. */
  id: string;
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Reuse an existing `LowdataClient`; otherwise a lazily-created shared default client is used. */
  client?: LowdataClient;
  /** Convert form values into a request payload. Default: `JSON.stringify(values)`. */
  transform?: (values: T) => unknown;
  onStatusChange?: (status: FormStatus, detail?: FormSubmissionDetail) => void;
}

export type FormRecordKind = 'draft' | 'submission';

/** Row shape stored in the `formDrafts` IndexedDB store — used for both drafts and submissions. */
export interface FormRecord<T = Record<string, unknown>> {
  submissionId: string;
  formId: string;
  kind: FormRecordKind;
  values: T;
  status: FormStatus;
  queueId?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}
