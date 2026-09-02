/**
 * Polls `predicate` until it returns true, instead of guessing a fixed sleep duration and hoping
 * async work finished by then — the source of flaky timing-based test failures on slower/loaded
 * machines. Throws if `predicate` hasn't become true within `timeout`.
 */
export async function waitForCondition(
  predicate: () => boolean,
  options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const timeout = options.timeout ?? 2000;
  const interval = options.interval ?? 10;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(options.message ?? `waitForCondition: condition not met within ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
