import { describe, expect, it, vi } from 'vitest';
import closeThenCancelDeferredStream from './deferred-stream-cleanup.ts';

describe('closeThenCancelDeferredStream terminal ownership', () => {
  it('claims and closes one already-queued value before cancelling the producer', async () => {
    const frame = { id: 7 };
    const reasons: unknown[] = [];
    const stream = new ReadableStream<typeof frame>({
      start(controller): void {
        controller.enqueue(frame);
      },
      cancel(reason): void {
        reasons.push(reason);
      },
    });
    const close = vi.fn();

    await closeThenCancelDeferredStream(stream, 'downstream stopped', close);

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(frame);
    expect(reasons).toEqual(['downstream stopped']);
    expect(stream.locked).toBe(false);
  });

  it('does not invent a value when the producer has already reached EOF', async () => {
    const close = vi.fn();
    const stream = new ReadableStream<object>({
      start(controller): void {
        controller.close();
      },
    });

    await closeThenCancelDeferredStream(stream, undefined, close);

    expect(close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('swallows a producer read failure while still releasing the reader lock', async () => {
    const close = vi.fn();
    const stream = new ReadableStream<object>({
      start(controller): void {
        controller.error(new Error('producer failed'));
      },
    });

    await expect(closeThenCancelDeferredStream(stream, 'teardown', close)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('bounds a pending read by one task, then cancellation resolves the pending ownership claim', async () => {
    const reasons: unknown[] = [];
    const close = vi.fn();
    const stream = new ReadableStream<object>({
      pull(): void {
        // Intentionally stays pending until cancel.
      },
      cancel(reason): void {
        reasons.push(reason);
      },
    });

    await closeThenCancelDeferredStream(stream, 'cancel pending pull', close);

    expect(reasons).toEqual(['cancel pending pull']);
    expect(close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('contains a rejecting producer cancel hook and never leaks the lock', async () => {
    const close = vi.fn();
    const stream = new ReadableStream<object>({
      pull(): void {},
      cancel(): Promise<void> {
        return Promise.reject(new Error('cancel hook failed'));
      },
    });

    await expect(closeThenCancelDeferredStream(stream, 'stop', close)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
});
