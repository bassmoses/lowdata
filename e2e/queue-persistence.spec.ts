import { expect, test } from '@playwright/test';
import type { LowdataClient } from '../src/network/client.js';

declare global {
  interface Window {
    __lowdata: { client: LowdataClient };
  }
}

test('queues a request while offline, survives a reload, and auto-syncs once back online', async ({
  page,
  context,
}) => {
  let requestCount = 0;
  await context.route('**/api/echo', (route) => {
    requestCount++;
    return route.fulfill({ status: 200, body: 'ok' });
  });

  await page.goto('/e2e/fixtures/queue.html');
  await page.waitForFunction(() => Boolean(window.__lowdata?.client));

  // Real browser-level offline — not a mocked navigator.onLine property. Note this also blocks
  // *navigation* for the whole context, not just this page's own fetch calls (stricter than real
  // airplane mode, where localhost stays reachable) — so reload/goto only happen once we're back
  // online again, below.
  await context.setOffline(true);

  const queuedId = await page.evaluate(async () => {
    const result = await window.__lowdata.client.fetch('/api/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    return 'queued' in result && result.queued ? result.id : null;
  });
  expect(queuedId).toBeTruthy();
  expect(requestCount).toBe(0); // offline — nothing was actually sent yet

  // Destroy this page's client *before* going back online — Chromium fires a genuine 'online'
  // DOM event on setOffline(false) (confirms ConnectionMonitor's real-event approach works), and
  // without this the original client would auto-sync-and-purge the item right here, before the
  // reload ever gets a chance to prove persistence independently.
  await page.evaluate(() => window.__lowdata.client.destroy());
  await context.setOffline(false);

  // A fresh navigation = a fresh client instance, same origin's IndexedDB underneath — this is
  // the real guarantee under test: does the queued item survive a reload via real IndexedDB.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__lowdata?.client));

  const persistedAcrossReload = await page.evaluate(async (id) => {
    const items = await window.__lowdata.client.queue.list();
    return items.some((item) => item.id === id);
  }, queuedId);
  expect(persistedAcrossReload).toBe(true);

  // The reloaded page's client constructs already-online (no online *transition* occurred from
  // its point of view) — nudge its sync manager the same way a real reconnect event would.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(
      async () => {
        const items = await page.evaluate(() => window.__lowdata.client.queue.list());
        return items.length;
      },
      { timeout: 5_000 },
    )
    .toBe(0); // synced successfully and purged (see network/sync.ts)

  expect(requestCount).toBe(1);
});
