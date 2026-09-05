/**
 * Cross-tab "something changed" signal, built on `BroadcastChannel`. Deliberately carries no
 * payload — it's a ping, not a data channel — so every tab reacts by re-reading its own queue
 * (via its own `StorageAdapter`) rather than trusting a broadcast value that might race the write
 * that triggered it. Feature-detected: environments without `BroadcastChannel` (very old browsers,
 * some SSR contexts) get a no-op that only ever notifies the current tab.
 */
export interface QueueBroadcast {
  /** Tell other tabs the queue changed. */
  post(): void;
  /** React to a change signalled by any tab, including this one (call sites don't need a separate local path). */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

export function createQueueBroadcast(channelName = 'lowdata-queue'): QueueBroadcast {
  const listeners = new Set<() => void>();
  const channel = hasBroadcastChannel() ? new BroadcastChannel(channelName) : undefined;
  let destroyed = false;

  const handleMessage = () => {
    for (const listener of listeners) listener();
  };
  channel?.addEventListener('message', handleMessage);

  return {
    post(): void {
      // A background sync can still be mid-flight when destroy() runs (e.g. a client destroyed
      // right after enqueueing something, before its background drain() completed) — silently
      // drop the post rather than throw on an already-closed channel.
      if (destroyed) return;
      // Notify this tab's own subscribers immediately — a same-tab `queue.add()` shouldn't have
      // to wait on the channel round-trip (which also never loops back to its own sender anyway).
      handleMessage();
      channel?.postMessage('changed');
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      channel?.removeEventListener('message', handleMessage);
      channel?.close();
      listeners.clear();
    },
  };
}
