import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { useOfflineForm } from '../../src/react/useOfflineForm.js';
import { resetSharedDb } from '../helpers/db.js';

describe('useOfflineForm', () => {
  let client: LowdataClient | undefined;

  beforeEach(async () => {
    await resetSharedDb();
  });

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('starts idle, then reflects submit() through to success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: `use-offline-form-test-${Math.random()}` });

    const { result } = renderHook(() =>
      useOfflineForm<{ name: string }>({ id: 'clinic-intake', endpoint: '/api/patients', client }),
    );
    expect(result.current.status).toBe('idle');

    await act(async () => {
      await result.current.submit({ name: 'Amina' });
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
  });

  it('wires save(), the submit() failure path, and retry() through to success — not just the happy path', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        // First attempt fails with a non-retryable status; retry() should be able to recover it.
        return new Response(null, { status: callCount === 1 ? 400 : 200 });
      }),
    );
    client = createLowdataClient({ namespace: `use-offline-form-test-${Math.random()}` });

    const { result } = renderHook(() =>
      useOfflineForm<{ name: string }>({ id: 'clinic-intake', endpoint: '/api/patients', client }),
    );

    await act(async () => {
      await result.current.save({ name: 'Amina (draft)' });
    });
    expect(result.current.status).toBe('saved');

    await act(async () => {
      await result.current.submit({ name: 'Amina' });
    });
    await waitFor(() => expect(result.current.status).toBe('failed'));

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(callCount).toBe(2);
  });
});
