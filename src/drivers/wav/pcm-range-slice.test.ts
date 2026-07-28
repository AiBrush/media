import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { tryTimeSlice } from './pcm-range-slice.ts';

describe('WAV PCM range-slice materialization cancellation', () => {
  it('does not acquire a stream when the operation is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('before-read');
    let streamCalls = 0;
    const source: ByteSource = {
      stream(): ReadableStream<Uint8Array> {
        streamCalls++;
        return new ReadableStream<Uint8Array>();
      },
    };

    await expect(
      tryTimeSlice(source, {
        timeBounds: { startSec: 0, endSec: 0.5 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted', message: 'operation aborted' });
    expect(streamCalls).toBe(0);
  });

  it('cancels an in-flight read and releases the stream lock on abort', async () => {
    const controller = new AbortController();
    let pulls = 0;
    let cancelReason: unknown;
    let markSecondPull: (() => void) | undefined;
    const secondPullStarted = new Promise<void>((resolve) => {
      markSecondPull = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController): Promise<void> | void {
        pulls++;
        if (pulls === 1) {
          streamController.enqueue(Uint8Array.of(1, 2, 3, 4));
          return;
        }
        markSecondPull?.();
        return new Promise<void>(() => {});
      },
      cancel(reason): void {
        cancelReason = reason;
      },
    });
    const source: ByteSource = {
      stream: () => stream,
    };

    const materializing = tryTimeSlice(source, {
      timeBounds: { startSec: 0, endSec: 0.5 },
      signal: controller.signal,
    });
    await secondPullStarted;
    controller.abort('during-read');

    await expect(materializing).rejects.toMatchObject({
      code: 'aborted',
      message: 'operation aborted',
    });
    expect(cancelReason).toBe('during-read');
    expect(stream.locked).toBe(false);
  });

  it('passes the signal to a stalled range materialization and rejects promptly on abort', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markRangeStarted: (() => void) | undefined;
    const rangeStarted = new Promise<void>((resolve) => {
      markRangeStarted = resolve;
    });
    const source: ByteSource = {
      size: 4,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-capable source must not be streamed');
      },
      range(_start, _end, signal): Promise<Uint8Array> {
        receivedSignal = signal;
        markRangeStarted?.();
        return new Promise<Uint8Array>((_resolve, reject) => {
          const rejectAborted = (): void => {
            reject(new MediaError('aborted', 'operation aborted'));
          };
          if (signal?.aborted === true) {
            rejectAborted();
          } else {
            signal?.addEventListener('abort', rejectAborted, { once: true });
          }
        });
      },
    };

    const materializing = tryTimeSlice(source, {
      timeBounds: { startSec: 0, endSec: 0.5 },
      signal: controller.signal,
    });
    await rangeStarted;
    expect(receivedSignal).toBe(controller.signal);
    controller.abort('during-range');

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timed = Promise.race([
      materializing,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('range abort timed out')), 100);
      }),
    ]);
    await expect(timed).rejects.toMatchObject({
      code: 'aborted',
      message: 'operation aborted',
    });
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
});
