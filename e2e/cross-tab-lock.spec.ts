import { expect, test } from '@playwright/test';
import type { LowdataClient } from '../src/network/client.js';

declare global {
  interface Window {
    __lowdata: { client: LowdataClient };
  }
}

test('two tabs sharing storage never both send the same queued item', async ({ context }) => {
  let requestCount = 0;
  await context.route('**/api/echo', (route) => {
    requestCount++;
    return route.fulfill({ status: 200, body: 'ok' });
  });

  // Both tabs open and loaded while still online — context.setOffline() blocks *all* navigation
  // for the context (not just page-initiated fetches), so both tabs need to exist before it's
  // engaged. This is also a realistic scenario in its own right: two tabs already open, then
  // connectivity drops.
  const tabA = await context.newPage();
  await tabA.goto('/e2e/fixtures/queue.html');
  await tabA.waitForFunction(() => Boolean(window.__lowdata?.client));

  const tabB = await context.newPage();
  await tabB.goto('/e2e/fixtures/queue.html');
  await tabB.waitForFunction(() => Boolean(window.__lowdata?.client));

  await context.setOffline(true);

  await tabA.evaluate(async () => {
    await window.__lowdata.client.fetch('/api/echo', { method: 'POST', body: '{}' });
  });

  await context.setOffline(false);
  // Both tabs race to drain the same queued item the moment connectivity returns — the core
  // cross-tab-lock guarantee under test.
  await tabA.evaluate(() => window.dispatchEvent(new Event('online')));
  await tabB.evaluate(() => window.dispatchEvent(new Event('online')));

  // Wait for confirmation the item actually finished syncing (not just "didn't have time to
  // double-send yet") before asserting on the request count.
  await expect
    .poll(
      async () => {
        const items = await tabA.evaluate(() => window.__lowdata.client.queue.list());
        return items.length;
      },
      { timeout: 5_000 },
    )
    .toBe(0);

  expect(requestCount).toBe(1);

  await tabA.close();
  await tabB.close();
});
