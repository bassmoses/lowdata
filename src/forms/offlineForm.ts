import { Emitter } from '../core/events.js';
import { createId } from '../core/id.js';
import type { Unsubscribe } from '../core/types.js';
import { createLowdataClient, type LowdataClient } from '../network/client.js';
import { isQueued } from '../network/types.js';
import { discardDraft, getSubmission, loadDraft, saveDraft, saveSubmission } from './storage.js';
import type { FormRecord, FormStatus, FormSubmissionDetail, OfflineFormConfig } from './types.js';

export interface OfflineForm<T = Record<string, unknown>> {
  /** Persist values locally without submitting — the safety net against reload wiping input. */
  save(values: T): Promise<void>;
  /** Save, then attempt delivery now (live) or queue it for automatic sync when back online. */
  submit(values: T): Promise<{ status: FormStatus }>;
  /** Re-attempt the last submission (only meaningful after `status` is `'failed'`). */
  retry(): Promise<void>;
  getStatus(): FormStatus;
  subscribe(callback: (status: FormStatus, detail?: FormSubmissionDetail) => void): Unsubscribe;
  /** Clear the saved draft/submission record and reset to `'idle'`. */
  discard(): Promise<void>;
  /**
   * Stop listening for this form's sync events. `submit()` subscribes to the client's `onSync`
   * stream lazily on first use and never unsubscribes on its own — call `destroy()` when the form
   * is no longer needed (e.g. on unmount, or before creating a replacement instance for the same
   * id) to avoid leaking that subscription on a long-lived shared/default client.
   */
  destroy(): void;
}

let defaultClient: LowdataClient | undefined;
function getDefaultClient(): LowdataClient {
  if (!defaultClient) defaultClient = createLowdataClient();
  return defaultClient;
}

export function createOfflineForm<T = Record<string, unknown>>(
  config: OfflineFormConfig<T>,
): OfflineForm<T> {
  const client = config.client ?? getDefaultClient();
  // Drafts/submissions are stored through *this client's own* adapter — not a hardcoded shared
  // one — so two tenants with two differently-namespaced clients never share a draft just because
  // they both happen to use a form with the same `id`.
  const storage = client.storage;
  const emitter = new Emitter<{ status: FormStatus; detail?: FormSubmissionDetail }>();

  let status: FormStatus = 'idle';
  let lastValues: T | undefined;
  let activeSubmissionId: string | undefined;
  let unsubscribeSync: Unsubscribe | undefined;

  // Recover any draft left over from a previous session (e.g. the page reloaded mid-type).
  void loadDraft<T>(storage, config.id).then((draft) => {
    if (draft && status === 'idle') {
      lastValues = draft.values;
      setStatus('saved');
    }
  });

  function setStatus(next: FormStatus, detail?: FormSubmissionDetail): void {
    status = next;
    config.onStatusChange?.(next, detail);
    emitter.emit({ status: next, detail });
  }

  async function patchSubmission(
    submissionId: string,
    patch: Partial<FormRecord<T>>,
  ): Promise<void> {
    const existing = await getSubmission<T>(storage, submissionId);
    if (!existing) return;
    await saveSubmission<T>(storage, { ...existing, ...patch, updatedAt: Date.now() });
  }

  async function onSubmissionSettled(
    submissionId: string,
    next: 'success' | 'failed',
    error?: string,
  ): Promise<void> {
    await patchSubmission(submissionId, { status: next, lastError: error });
    // Guard against a stale/superseded submission (e.g. submit() was called again before this one
    // settled) discarding the draft for whatever the CURRENT submission holds — only the active
    // submission's success should clear the recoverable draft.
    const isActive = submissionId === activeSubmissionId;
    if (next === 'success' && isActive) {
      await discardDraft(storage, config.id);
    }
    if (isActive) {
      setStatus(next, { submissionId, error });
    }
  }

  function ensureSyncSubscription(): void {
    if (unsubscribeSync) return;
    unsubscribeSync = client.onSync((event) => {
      // Narrow by the presence of a single `item`, rather than naming every event *without* one —
      // an inclusion check here doesn't silently stop working the next time a new event variant
      // (like 'items-blocked', which carries `items` plural, not `item`) is added to SyncEvent.
      if (!('item' in event)) return;
      const submissionId = event.item.meta?.['submissionId'];
      if (typeof submissionId !== 'string' || submissionId !== activeSubmissionId) return;

      if (event.type === 'item-start') {
        void patchSubmission(submissionId, { status: 'syncing' });
        setStatus('syncing', { submissionId });
      } else if (event.type === 'item-success') {
        void onSubmissionSettled(submissionId, 'success');
      } else if (event.type === 'item-failed') {
        if (event.willRetry) {
          void patchSubmission(submissionId, {
            status: 'pending',
            lastError: event.item.lastError,
          });
          setStatus('pending', { submissionId, error: event.item.lastError });
        } else {
          void onSubmissionSettled(submissionId, 'failed', event.item.lastError);
        }
      }
    });
  }

  async function save(values: T): Promise<void> {
    lastValues = values;
    await saveDraft(storage, config.id, values);
    setStatus('saved');
  }

  async function submit(values: T): Promise<{ status: FormStatus }> {
    await save(values);

    const submissionId = createId();
    activeSubmissionId = submissionId;
    const payload = config.transform ? config.transform(values) : JSON.stringify(values);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

    await saveSubmission<T>(storage, {
      submissionId,
      formId: config.id,
      kind: 'submission',
      values,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setStatus('pending', { submissionId });
    ensureSyncSubscription();

    const result = await client.fetch(config.endpoint, {
      method: config.method ?? 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      meta: { formId: config.id, submissionId },
      idempotencyKey: submissionId,
    });

    if (isQueued(result)) {
      await patchSubmission(submissionId, { status: 'pending', queueId: result.id });
      setStatus('pending', { submissionId });
    } else if (result.ok) {
      await onSubmissionSettled(submissionId, 'success');
    } else {
      await onSubmissionSettled(
        submissionId,
        'failed',
        `Request failed with status ${result.status}`,
      );
    }

    return { status };
  }

  async function retry(): Promise<void> {
    if (!lastValues) return;
    await submit(lastValues);
  }

  function destroy(): void {
    unsubscribeSync?.();
    unsubscribeSync = undefined;
  }

  async function discard(): Promise<void> {
    await discardDraft(storage, config.id);
    lastValues = undefined;
    activeSubmissionId = undefined;
    destroy();
    setStatus('idle');
  }

  return {
    save,
    submit,
    retry,
    getStatus: () => status,
    subscribe: (callback) => emitter.subscribe(({ status: s, detail }) => callback(s, detail)),
    discard,
    destroy,
  };
}
