import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events.js';

describe('Emitter', () => {
  it('calls every subscribed listener with the emitted value', () => {
    const emitter = new Emitter<number>();
    const received: number[] = [];
    emitter.subscribe((v) => received.push(v));
    emitter.subscribe((v) => received.push(v * 10));

    emitter.emit(5);

    expect(received).toEqual([5, 50]);
  });

  it('unsubscribe stops that listener without affecting others', () => {
    const emitter = new Emitter<number>();
    const a: number[] = [];
    const b: number[] = [];
    const unsubscribeA = emitter.subscribe((v) => a.push(v));
    emitter.subscribe((v) => b.push(v));

    emitter.emit(1);
    unsubscribeA();
    emitter.emit(2);

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('clear() removes all listeners and reports size 0', () => {
    const emitter = new Emitter<number>();
    emitter.subscribe(() => {});
    emitter.subscribe(() => {});
    expect(emitter.size).toBe(2);

    emitter.clear();

    expect(emitter.size).toBe(0);
    expect(() => emitter.emit(1)).not.toThrow();
  });

  it('size reflects subscribe/unsubscribe as they happen', () => {
    const emitter = new Emitter<number>();
    expect(emitter.size).toBe(0);
    const unsubscribe = emitter.subscribe(() => {});
    expect(emitter.size).toBe(1);
    unsubscribe();
    expect(emitter.size).toBe(0);
  });

  it('a listener that unsubscribes itself mid-emit does not disrupt the other listeners in that same emit', () => {
    const emitter = new Emitter<number>();
    const calls: string[] = [];
    let unsubscribeSelf: () => void = () => {};
    unsubscribeSelf = emitter.subscribe(() => {
      calls.push('self');
      unsubscribeSelf();
    });
    emitter.subscribe(() => calls.push('other'));

    expect(() => emitter.emit(1)).not.toThrow();
    expect(calls).toEqual(['self', 'other']);

    // Subsequent emit no longer invokes the self-unsubscribed listener.
    calls.length = 0;
    emitter.emit(2);
    expect(calls).toEqual(['other']);
  });

  it('a listener subscribed during an emit IS invoked within that same emit — live Set iteration, a footgun worth pinning down', () => {
    const emitter = new Emitter<number>();
    const calls: string[] = [];
    emitter.subscribe(() => {
      calls.push('first');
      emitter.subscribe((v2) => calls.push(`late-added:${v2}`));
    });

    emitter.emit(1);

    expect(calls).toEqual(['first', 'late-added:1']);
  });
});
