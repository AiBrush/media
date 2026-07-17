/** Lifecycle coordinator for one-shot live MediaStream conversion (ADR-236). */

import type { Muxer, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { decodeLiveMediaStream, liveTrackInfo } from '../sources/live-media.ts';
import { type LiveMediaSource, mediaStreamOf } from '../sources/live-source.ts';
import type {
  AudioTarget,
  Cancellable,
  Container,
  ConvertOptions,
  MediaStreams,
  VideoTarget,
} from './types.ts';

type LiveInput = MediaStream | LiveMediaSource;
type LiveFrame = VideoFrame | AudioData;

/** Engine-owned callback that applies requested filters, encodes, finalizes the muxer, then resolves. */
export type LiveConvertRunner<Output> = (
  frames: MediaStreams,
  options: ConvertOptions,
  signal: AbortSignal,
) => Promise<Output>;

/** Injectable decode seam keeps lifecycle tests deterministic; production leaves it absent. */
export interface LiveConvertDependencies<Output> {
  readonly run: LiveConvertRunner<Output>;
  readonly decode?: (input: LiveInput, signal: AbortSignal) => MediaStreams;
}

/** Lazy live filter/encode/mux callbacks bound to one engine instance. */
export interface LiveFramePipelineDependencies<Output> {
  readonly supportsContainer: (target: Container) => boolean;
  readonly createMuxer: (target: Container, options: ConvertOptions) => Promise<Muxer>;
  readonly applyVideoFilters: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    source: TrackInfo,
    signal: AbortSignal,
  ) => Promise<ReadableStream<VideoFrame>>;
  readonly applyAudioFilters: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    source: TrackInfo,
    signal: AbortSignal,
  ) => Promise<ReadableStream<AudioData>>;
  readonly resolveAudioTarget: (target: AudioTarget, sourceCodec: string) => Promise<AudioTarget>;
  readonly encodeVideo: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    source: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
    fragmented: boolean,
  ) => Promise<void>;
  readonly encodeAudio: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    source: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly materialize: (
    muxer: Muxer,
    target: Container,
    options: ConvertOptions,
    signal: AbortSignal,
  ) => Promise<Output>;
}

interface FrameRelay<T extends LiveFrame> {
  readonly stream: ReadableStream<T>;
  readonly completed: Promise<void>;
  cancel(reason: unknown): Promise<void>;
}

type AnyFrameRelay = FrameRelay<VideoFrame> | FrameRelay<AudioData>;

/**
 * Coordinate a raw live decode → filter/encode/mux run under one abort domain. The runner must resolve
 * only after final mux/sink completion; this wrapper additionally waits until every selected input track
 * reaches end-of-stream. On any failure it aborts the shared signal and cancels both relays before
 * preserving the primary error.
 */
export function convertLiveMediaStream<Output>(
  input: LiveInput,
  options: ConvertOptions,
  dependencies: LiveConvertDependencies<Output>,
  externalSignal?: AbortSignal,
): Cancellable<Output> {
  const controller = new AbortController();
  let relays: readonly AnyFrameRelay[] = [];
  let externalAbortAttached = false;
  const abort = (reason: unknown): MediaError => {
    const error = liveAbortError(reason);
    if (!controller.signal.aborted) controller.abort(error);
    return error;
  };
  const cancelRelays = async (reason: unknown): Promise<void> => {
    await Promise.all(relays.map((relay) => relay.cancel(reason).catch(() => {})));
  };
  const onExternalAbort = (): void => {
    const primary = abort(externalSignal?.reason);
    void cancelRelays(primary);
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) abort(externalSignal.reason);
    else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      externalAbortAttached = true;
    }
  }

  const task = (async (): Promise<Output> => {
    try {
      const stream = requireLiveStream(input);
      validateLiveConvertOptions(stream, options);
      if (controller.signal.aborted) throw liveAbortError(controller.signal.reason);
      const decoded = (dependencies.decode ?? defaultLiveDecode)(input, controller.signal);
      const selected: MediaStreams = {
        ...(options.video === false || decoded.video === undefined ? {} : { video: decoded.video }),
        ...(options.audio === false || decoded.audio === undefined ? {} : { audio: decoded.audio }),
      };
      await cancelUnselected(decoded, selected);
      const videoRelay = selected.video === undefined ? undefined : relayFrames(selected.video);
      const audioRelay = selected.audio === undefined ? undefined : relayFrames(selected.audio);
      relays = [
        ...(videoRelay === undefined ? [] : [videoRelay]),
        ...(audioRelay === undefined ? [] : [audioRelay]),
      ];
      if (controller.signal.aborted) {
        const primary = liveAbortError(controller.signal.reason);
        await cancelRelays(primary);
        throw primary;
      }
      const output = await dependencies.run(
        {
          ...(videoRelay === undefined ? {} : { video: videoRelay.stream }),
          ...(audioRelay === undefined ? {} : { audio: audioRelay.stream }),
        },
        options,
        controller.signal,
      );
      if (controller.signal.aborted) throw liveAbortError(controller.signal.reason);
      await Promise.all(relays.map((relay) => relay.completed));
      if (controller.signal.aborted) throw liveAbortError(controller.signal.reason);
      return output;
    } catch (error) {
      const primary = normalizeLiveConvertError(error, controller.signal);
      if (!controller.signal.aborted) controller.abort(primary);
      await cancelRelays(primary);
      throw primary;
    } finally {
      if (externalAbortAttached) externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  })() as Cancellable<Output>;

  task.cancel = (): void => {
    const primary = abort(new MediaError('aborted', 'live conversion cancelled'));
    void cancelRelays(primary);
  };
  return task;
}

/** Validate facts unavailable from a raw stream before an encoder or muxer is constructed. */
export function validateLiveConvertOptions(input: LiveInput, options: ConvertOptions): void {
  const stream = requireLiveStream(input);
  if (options.to === undefined) {
    throw new InputError('live conversion requires an explicit output container');
  }
  const videoTracks = liveTracks(stream.getVideoTracks());
  const audioTracks = liveTracks(stream.getAudioTracks());
  if (videoTracks.length > 1 || audioTracks.length > 1) {
    throw new InputError('live conversion supports at most one video and one audio track');
  }
  const includesVideo = videoTracks.length === 1 && options.video !== false;
  const includesAudio = audioTracks.length === 1 && options.audio !== false;
  if (!includesVideo && !includesAudio) {
    throw new InputError('live conversion selected no active tracks');
  }
  if (includesVideo) {
    liveTrackInfo(stream, 'video');
    const target = options.video || {};
    if (target.codec === undefined) {
      throw new InputError(
        'live video target codec is required because raw frames expose no encoded source codec',
      );
    }
    requirePositiveInteger(target.width, 'live video target width');
    requirePositiveInteger(target.height, 'live video target height');
    if (target.twoPass === true) {
      throw new CapabilityError(
        'two-pass video encode requires a finite replayable source, not a live MediaStream',
        { op: { kind: 'route', id: 'convert' }, tried: ['media-stream', 'two-pass'] },
      );
    }
  }
  if (includesAudio) {
    liveTrackInfo(stream, 'audio');
    const target = options.audio || {};
    if (target.codec === undefined) {
      throw new InputError(
        'live audio target codec is required because raw frames expose no encoded source codec',
      );
    }
    requirePositiveInteger(target.sampleRate, 'live audio target sample rate');
    requirePositiveInteger(target.channels, 'live audio target channels');
  }
}

/** Heavy live filter→encode→mux runner kept in this lazy chunk, outside the eager engine closure. */
export async function runLiveFramePipeline<Output>(
  mediaStream: MediaStream,
  frames: MediaStreams,
  options: ConvertOptions,
  signal: AbortSignal,
  dependencies: LiveFramePipelineDependencies<Output>,
): Promise<Output> {
  const target = options.to;
  if (target === undefined) {
    throw new InputError('live conversion requires an output container');
  }
  if (!dependencies.supportsContainer(target)) {
    throw new CapabilityError(`convert to '${target}' has no muxer`, {
      op: { kind: 'route', id: 'convert' },
      tried: [target],
    });
  }
  const muxer = await dependencies.createMuxer(target, options);
  const tasks: Promise<void>[] = [];
  const openStreams: ReadableStream<LiveFrame>[] = [];
  try {
    if (frames.video !== undefined && options.video !== false) {
      const videoTarget = options.video || {};
      const source = liveTrackInfo(mediaStream, 'video');
      if (source === undefined) {
        throw new InputError('live video frame stream has no active track');
      }
      const filtered = await dependencies.applyVideoFilters(
        frames.video,
        videoTarget,
        source,
        signal,
      );
      openStreams.push(filtered);
      tasks.push(
        dependencies.encodeVideo(
          filtered,
          videoTarget,
          source,
          muxer,
          signal,
          options.fragmented === true,
        ),
      );
    }
    if (frames.audio !== undefined && options.audio !== false) {
      const source = liveTrackInfo(mediaStream, 'audio');
      if (source === undefined) {
        throw new InputError('live audio frame stream has no active track');
      }
      const audioTarget = await dependencies.resolveAudioTarget(options.audio || {}, source.codec);
      const filtered = await dependencies.applyAudioFilters(
        frames.audio,
        audioTarget,
        source,
        signal,
      );
      openStreams.push(filtered);
      tasks.push(dependencies.encodeAudio(filtered, audioTarget, source, muxer, signal));
    }
    if (tasks.length === 0) {
      throw new InputError('live conversion selected no active frame streams');
    }
    await allOrCancelPipelineStreams(tasks, openStreams);
    await muxer.finalize();
    return await dependencies.materialize(muxer, target, options, signal);
  } catch (error) {
    // Do not await an already-started encoder here: its stream may be locked and it needs the outer
    // coordinator to observe this rejection, abort the shared signal, and cancel the retained relays.
    for (const task of tasks) void task.catch(() => {});
    await Promise.all(openStreams.map((stream) => cancelPipelineStream(stream)));
    throw error;
  }
}

function requireLiveStream(input: LiveInput): MediaStream {
  const stream = mediaStreamOf(input);
  if (stream === undefined) throw new InputError('invalid MediaStream input');
  return stream;
}

function liveTracks(tracks: readonly MediaStreamTrack[]): readonly MediaStreamTrack[] {
  return tracks.filter((track) => track.readyState !== 'ended');
}

function requirePositiveInteger(value: number | undefined, name: string): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${name} must be a positive integer`);
  }
}

function defaultLiveDecode(input: LiveInput, signal: AbortSignal): MediaStreams {
  return decodeLiveMediaStream(input, { signal });
}

async function cancelUnselected(decoded: MediaStreams, selected: MediaStreams): Promise<void> {
  await Promise.all([
    decoded.video !== undefined && selected.video === undefined
      ? decoded.video
          .cancel(new MediaError('aborted', 'live video track not selected'))
          .catch(() => {})
      : Promise.resolve(),
    decoded.audio !== undefined && selected.audio === undefined
      ? decoded.audio
          .cancel(new MediaError('aborted', 'live audio track not selected'))
          .catch(() => {})
      : Promise.resolve(),
  ]);
}

async function cancelPipelineStream(stream: ReadableStream<LiveFrame>): Promise<void> {
  await stream
    .cancel(new MediaError('aborted', 'live conversion stream cancelled'))
    .catch(() => {});
}

async function allOrCancelPipelineStreams(
  tasks: readonly Promise<void>[],
  streams: readonly ReadableStream<LiveFrame>[],
): Promise<void> {
  try {
    await Promise.all(tasks);
  } catch (error) {
    await Promise.all(streams.map((stream) => cancelPipelineStream(stream)));
    throw error;
  }
}

function relayFrames<T extends LiveFrame>(source: ReadableStream<T>): FrameRelay<T> {
  const reader = source.getReader();
  let finished = false;
  let cancelTask: Promise<void> | undefined;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    resolveCompleted?.();
  };
  const cancel = (reason: unknown): Promise<void> => {
    cancelTask ??= (async (): Promise<void> => {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    })();
    return cancelTask;
  };
  const stream = new ReadableStream<T>(
    {
      async pull(streamController): Promise<void> {
        if (finished) {
          streamController.close();
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            finish();
            streamController.close();
            return;
          }
          try {
            streamController.enqueue(next.value);
          } catch (error) {
            closeFrame(next.value);
            await cancel(error).catch(() => {});
            streamController.error(error);
          }
        } catch (error) {
          finish();
          streamController.error(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, completed, cancel };
}

function closeFrame(frame: LiveFrame): void {
  try {
    frame.close();
  } catch {
    // The enqueue/cancellation failure remains primary.
  }
}

function liveAbortError(reason: unknown): MediaError {
  return reason instanceof MediaError && reason.code === 'aborted'
    ? reason
    : new MediaError('aborted', 'live conversion aborted', reason);
}

function normalizeLiveConvertError(error: unknown, signal: AbortSignal): MediaError {
  if (error instanceof MediaError) return error;
  return signal.aborted
    ? liveAbortError(signal.reason)
    : new MediaError('encode-error', 'live conversion pipeline failed', error);
}
