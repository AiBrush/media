import { MediaError } from '../../contracts/errors.ts';
import type { WavPcmCopyPlan } from './pcm.ts';

const OPERATION_ABORTED = 'operation aborted';

/** Pull-driven canonical WAV copy: a fresh header first, then the validated immutable PCM payload view. */
export function streamWavPcmCopy(
  plan: WavPcmCopyPlan,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let header: Uint8Array<ArrayBuffer> | undefined = plan.header;
  let payload: Uint8Array | undefined = plan.payload;
  let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const release = (): void => {
    signal?.removeEventListener('abort', abort);
    activeController = undefined;
    header = undefined;
    payload = undefined;
  };
  const abort = (): void => {
    const controller = activeController;
    release();
    controller?.error(new MediaError('aborted', OPERATION_ABORTED));
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller): void {
        activeController = controller;
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      },
      pull(controller): void {
        try {
          if (signal?.aborted === true) throw new MediaError('aborted', OPERATION_ABORTED);
          const nextHeader = header;
          if (nextHeader !== undefined) {
            header = undefined;
            controller.enqueue(nextHeader);
            return;
          }
          const nextPayload = payload;
          if (nextPayload !== undefined) {
            payload = undefined;
            controller.enqueue(nextPayload);
          }
          release();
          controller.close();
        } catch (error) {
          release();
          throw error;
        }
      },
      cancel(): void {
        release();
      },
    },
    { highWaterMark: 0 },
  );
}
