/**
 * A bounded, one-shot-safe native-video runtime fallback seam (ADR-284).
 *
 * The primary decoder sees the caller's exact encoded-chunk objects. Until it produces its first frame,
 * a recording tap retains one reference to each submitted chunk. A typed native capability failure can
 * therefore restart a software decoder from that exact prefix and then continue from the same locked source
 * reader. No bytes are copied and the demuxer is never reopened. The first primary frame is the commit point:
 * retained references are released and a later failure remains terminal because already-emitted frames cannot
 * honestly be retracted. Retention is capped independently by packet count and bytes; crossing either cap also
 * commits the primary path without selecting WASM.
 */

import type { Determinism, EncodedChunk } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';

const MAX_REPLAY_PACKETS = 256;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;

export interface RuntimeVideoFallbackOptions {
  readonly signal?: AbortSignal;
  /** Add caller-owned stage evidence without weakening the fallback eligibility decision. */
  readonly mapTerminalError?: (error: unknown, context: RuntimeVideoTerminalContext) => unknown;
}

export interface RuntimeVideoTerminalContext {
  readonly attempt: 'primary' | 'fallback';
  readonly primaryFrameEmitted: boolean;
}

export type RuntimeVideoFallbackKind = 'wasm-vpx' | 'webcodecs-software';

export interface RuntimeVideoFallbackPlanOptions {
  readonly determinism?: Determinism;
  readonly pinDriver?: string;
}

/**
 * Select the bounded pre-output recovery tail without weakening an explicit routing request.
 * VPx keeps its proved WASM decoder tail; other native WebCodecs formats retry the same driver
 * with software acceleration after a transient hardware runtime miss.
 */
export function planRuntimeVideoFallback(
  driverId: string,
  codec: string,
  options: RuntimeVideoFallbackPlanOptions = {},
): RuntimeVideoFallbackKind | undefined {
  if (/^vp(?:8|9|09)/i.test(codec) && driverId !== 'wasm-vpx' && options.pinDriver !== driverId) {
    return 'wasm-vpx';
  }
  if (driverId === 'webcodecs-video' && options.determinism !== 'force-software') {
    return 'webcodecs-software';
  }
  return undefined;
}

type DecoderFactory = () => TransformStream<EncodedChunk, VideoFrame>;
type AsyncDecoderFactory = () => Promise<TransformStream<EncodedChunk, VideoFrame>>;
type DefaultReaderResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>;

/** Preserve the typed boundary across realms and independently emitted ESM chunks. */
function isCapabilityError(error: unknown): error is CapabilityError {
  const errorObject = typeof error === 'object' && error !== null ? error : undefined;
  return (
    error instanceof CapabilityError ||
    (errorObject !== undefined &&
      Object.prototype.toString.call(errorObject) === '[object Error]' &&
      'name' in errorObject &&
      errorObject.name === 'CapabilityError' &&
      'code' in errorObject &&
      errorObject.code === 'capability-miss')
  );
}

/**
 * Decode with a hardware/native primary and a miss-only software tail while preserving one-shot input.
 * Only a typed {@link CapabilityError} observed before the first emitted frame is eligible for replay.
 */
export function decodeVideoWithRuntimeFallback(
  source: ReadableStream<EncodedChunk>,
  createPrimary: DecoderFactory,
  createFallback: AsyncDecoderFactory | undefined,
  options: RuntimeVideoFallbackOptions = {},
): ReadableStream<VideoFrame> {
  const signal = options.signal;
  const recorded: EncodedChunk[] = [];
  let recordedBytes = 0;
  let sourceReader: ReadableStreamDefaultReader<EncodedChunk> | undefined;
  let sourceRead: Promise<DefaultReaderResult<EncodedChunk>> | undefined;
  let sourceDone = false;
  let sourceReleased = false;
  let sourceCancelPromise: Promise<void> | undefined;
  let primaryInputStoppedResolve: (() => void) | undefined;
  const primaryInputStopped = new Promise<void>((resolve) => {
    primaryInputStoppedResolve = resolve;
  });
  let primaryInputSettled = false;
  let activeReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let mode: 'unstarted' | 'primary' | 'fallback' | 'terminal' = 'unstarted';
  let fallbackEligible = true;
  let primaryFrameEmitted = false;
  let teardownPromise: Promise<void> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const stopPrimaryInput = (): void => {
    if (primaryInputSettled) return;
    primaryInputSettled = true;
    primaryInputStoppedResolve?.();
    primaryInputStoppedResolve = undefined;
  };

  const readerForSource = (): ReadableStreamDefaultReader<EncodedChunk> => {
    sourceReader ??= source.getReader();
    return sourceReader;
  };

  const releaseSource = (): void => {
    if (sourceReleased || sourceReader === undefined) return;
    sourceReleased = true;
    sourceReader.releaseLock();
  };

  const cancelSource = (reason: unknown): Promise<void> => {
    if (sourceDone || sourceReleased) return Promise.resolve();
    const reader = sourceReader;
    if (reader === undefined) {
      sourceCancelPromise ??= source.cancel(reason).catch(() => {});
      return sourceCancelPromise;
    }
    sourceCancelPromise ??= reader
      .cancel(reason)
      .catch(() => {})
      .finally(releaseSource);
    return sourceCancelPromise;
  };

  const readSource = async (): Promise<DefaultReaderResult<EncodedChunk>> => {
    const pending = readerForSource().read();
    sourceRead = pending;
    try {
      const result = await pending;
      if (result.done) {
        sourceDone = true;
        releaseSource();
      }
      return result;
    } finally {
      if (sourceRead === pending) sourceRead = undefined;
    }
  };

  const dropReplay = (): void => {
    fallbackEligible = false;
    recorded.length = 0;
    recordedBytes = 0;
  };

  const retainForReplay = (chunk: EncodedChunk): void => {
    if (!fallbackEligible) return;
    const nextBytes = recordedBytes + chunk.byteLength;
    if (recorded.length >= MAX_REPLAY_PACKETS || nextBytes > MAX_REPLAY_BYTES) {
      dropReplay();
      return;
    }
    recorded.push(chunk);
    recordedBytes = nextBytes;
  };

  const primaryInput = (): ReadableStream<EncodedChunk> =>
    new ReadableStream<EncodedChunk>(
      {
        async pull(controller): Promise<void> {
          const result = await readSource();
          if (result.done) {
            stopPrimaryInput();
            controller.close();
            return;
          }
          retainForReplay(result.value);
          controller.enqueue(result.value);
        },
        async cancel(reason): Promise<void> {
          // A decoder-readable failure cancels its input before the outer reader observes that failure.
          // Keep the sole source reader alive during this narrow pre-commit window; the outer catch either
          // replays it after a typed miss or cancels it for every other terminal condition.
          const preserve =
            mode === 'primary' &&
            fallbackEligible &&
            !primaryFrameEmitted &&
            signal?.aborted !== true;
          try {
            await sourceRead?.catch(() => {});
            if (!preserve) await cancelSource(reason);
          } finally {
            stopPrimaryInput();
          }
        },
      },
      { highWaterMark: 0 },
    );

  const fallbackInput = (): ReadableStream<EncodedChunk> => {
    let replayIndex = 0;
    return new ReadableStream<EncodedChunk>(
      {
        async pull(controller): Promise<void> {
          const replay = recorded[replayIndex];
          if (replay !== undefined) {
            replayIndex++;
            controller.enqueue(replay);
            if (replayIndex === recorded.length) {
              recorded.length = 0;
              recordedBytes = 0;
            }
            return;
          }
          if (sourceDone) {
            controller.close();
            return;
          }
          const result = await readSource();
          if (result.done) {
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        },
        async cancel(reason): Promise<void> {
          recorded.length = 0;
          recordedBytes = 0;
          await cancelSource(reason);
        },
      },
      { highWaterMark: 0 },
    );
  };

  const ensurePrimary = (): ReadableStreamDefaultReader<VideoFrame> => {
    if (activeReader !== undefined) return activeReader;
    const decoder = createPrimary();
    mode = 'primary';
    activeReader = primaryInput().pipeThrough(decoder).getReader();
    return activeReader;
  };

  const teardown = (reason: unknown): Promise<void> => {
    if (teardownPromise !== undefined) return teardownPromise;
    mode = 'terminal';
    fallbackEligible = false;
    recorded.length = 0;
    recordedBytes = 0;
    removeAbortListener?.();
    removeAbortListener = undefined;
    teardownPromise = Promise.allSettled([
      activeReader?.cancel(reason) ?? Promise.resolve(),
      cancelSource(reason),
    ]).then(() => undefined);
    return teardownPromise;
  };

  const switchToFallback = async (
    primaryError: CapabilityError,
  ): Promise<ReadableStreamDefaultReader<VideoFrame>> => {
    const fallbackFactory = createFallback;
    if (fallbackFactory === undefined) throw primaryError;
    await activeReader?.cancel(primaryError).catch(() => {});
    await primaryInputStopped;
    if (signal?.aborted) {
      throw new MediaError('aborted', 'operation aborted', signal.reason);
    }
    mode = 'fallback';
    const decoder = await fallbackFactory();
    activeReader = fallbackInput().pipeThrough(decoder).getReader();
    return activeReader;
  };

  const readOutput = async (): Promise<DefaultReaderResult<VideoFrame>> => {
    let reader = ensurePrimary();
    try {
      return await reader.read();
    } catch (error) {
      if (
        mode !== 'primary' ||
        primaryFrameEmitted ||
        !fallbackEligible ||
        createFallback === undefined ||
        !isCapabilityError(error) ||
        signal?.aborted
      ) {
        throw error;
      }
      reader = await switchToFallback(error);
      return reader.read();
    }
  };

  return new ReadableStream<VideoFrame>(
    {
      start(controller): void {
        if (signal === undefined) return;
        const onAbort = (): void => {
          const error = new MediaError('aborted', 'operation aborted', signal.reason);
          controller.error(error);
          void teardown(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      },
      async pull(controller): Promise<void> {
        let result: DefaultReaderResult<VideoFrame>;
        try {
          result = await readOutput();
        } catch (error) {
          const terminalError =
            options.mapTerminalError?.(error, {
              attempt: mode === 'fallback' ? 'fallback' : 'primary',
              primaryFrameEmitted,
            }) ?? error;
          await teardown(terminalError);
          throw terminalError;
        }
        if (mode === 'terminal') {
          if (!result.done) result.value.close();
          return;
        }
        if (result.done) {
          await teardown('video decode completed');
          controller.close();
          return;
        }
        if (mode === 'primary' && !primaryFrameEmitted) {
          primaryFrameEmitted = true;
          dropReplay();
        }
        try {
          controller.enqueue(result.value);
        } catch (error) {
          result.value.close();
          await teardown(error);
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        await teardown(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
