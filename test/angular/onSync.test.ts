import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSync$ } from '../../src/angular/onSync.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { waitForCondition } from '../helpers/wait.js';

describe('onSync$ (angular/rxjs)', () => {
  let client: LowdataClient | undefined;

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('emits sync events as an Observable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: `angular-sync-test-${Math.random()}` });

    const eventTypes: string[] = [];
    const subscription = onSync$(client).subscribe((event) => eventTypes.push(event.type));

    await client.queue.add({ url: '/api/x', method: 'POST', priority: 'normal', body: '{}' });
    await waitForCondition(() => eventTypes.includes('item-success'), {
      message: `expected an 'item-success' sync event, got: ${eventTypes.join(', ') || '(none)'}`,
    });

    expect(eventTypes).toContain('item-success');
    subscription.unsubscribe();
  });
});
