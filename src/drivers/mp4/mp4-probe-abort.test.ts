import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { Mp4Driver } from './mp4-driver.ts';

async function expectPromptAbort(pending: Promise<unknown>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('MP4 probe range abort timed out')), 100);
      }),
    ]);
    await expect(timed).rejects.toMatchObject({ code: 'aborted' });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe('MP4 probe cancellation', () => {
  it('passes the operation signal to a pending random-access read and rejects promptly on abort', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markRangeStarted: (() => void) | undefined;
    const rangeStarted = new Promise<void>((resolve) => {
      markRangeStarted = resolve;
    });
    const source: ByteSource & { readonly kind: 'url'; readonly mimeHint: 'video/mp4' } = {
      kind: 'url',
      mimeHint: 'video/mp4',
      size: 1024,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable MP4 probe must not open its stream');
      },
      range(_start, _end, signal): Promise<Uint8Array> {
        observedSignal = signal;
        markRangeStarted?.();
        // Deliberately ignore cancellation: randomAccess must race the transport with the signal.
        return new Promise<Uint8Array>(() => undefined);
      },
    };
    const probe = Mp4Driver.probe;
    expect(probe).toBeDefined();
    if (probe === undefined) return;

    const pending = probe(source, { signal: controller.signal });
    await rangeStarted;
    controller.abort('stop MP4 probe');

    await expectPromptAbort(pending);
    expect(observedSignal).toBe(controller.signal);
  });
});
