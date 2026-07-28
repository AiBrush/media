import { describe, expect, it } from 'vitest';
import type { Source } from '../sources/source.ts';
import { readAllSource } from './source-io.ts';

async function expectPromptAbort(pending: Promise<unknown>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('source range abort timed out')), 100);
      }),
    ]);
    await expect(timed).rejects.toMatchObject({ code: 'aborted' });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe('readAllSource cancellation', () => {
  it('passes the operation signal to a pending full-range read and rejects promptly on abort', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markRangeStarted: (() => void) | undefined;
    const rangeStarted = new Promise<void>((resolve) => {
      markRangeStarted = resolve;
    });
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: 1024,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable source must not open its stream');
      },
      range(_start, _end, signal): Promise<Uint8Array> {
        observedSignal = signal;
        markRangeStarted?.();
        // Deliberately ignore cancellation: readAllSource must still settle its outer operation.
        return new Promise<Uint8Array>(() => undefined);
      },
    };

    const pending = readAllSource(source, controller.signal);
    await rangeStarted;
    controller.abort('stop full-range read');

    await expectPromptAbort(pending);
    expect(observedSignal).toBe(controller.signal);
  });
});
