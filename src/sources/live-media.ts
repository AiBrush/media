/** Raw live `MediaStream` input (ADR-236): track processors → caller-owned WebCodecs frames. */

import type { MediaInfo, MediaInfoTrack, MediaStreams } from '../api/types.ts';
import type { TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type LiveMediaSource, isLiveMediaSource, isMediaStreamShape } from './live-source.ts';

export {
  captureElementMediaStream,
  fromMediaStream,
  isLiveMediaSource,
  mediaStreamOf,
  type LiveMediaSource,
} from './live-source.ts';

type LiveTrackKind = 'video' | 'audio';
type LiveFrame = VideoFrame | AudioData;
type ReaderResult = Awaited<ReturnType<ReadableStreamDefaultReader<unknown>['read']>>;

/** Injectable structural seam used by lifecycle tests; production uses `MediaStreamTrackProcessor`. */
export interface LiveTrackProcessorFactory {
  create(
    track: MediaStreamTrack,
    kind: LiveTrackKind,
    maxBufferSize: number,
  ): ReadableStream<unknown>;
}

/** Options for the raw live-frame bridge. */
export interface LiveMediaDecodeOptions {
  readonly signal?: AbortSignal;
  /** Internal validation seam; ordinary callers leave this unset. */
  readonly processorFactory?: LiveTrackProcessorFactory;
}

interface TrackProcessor {
  readonly readable: ReadableStream<unknown>;
}

interface TrackProcessorConstructor {
  new (init: { readonly track: MediaStreamTrack; readonly maxBufferSize: number }): TrackProcessor;
}

interface TrackReadOutcome {
  readonly kind: 'read';
  readonly result: ReaderResult;
}

interface TrackEndedOutcome {
  readonly kind: 'ended';
}

interface TrackAbortedOutcome {
  readonly kind: 'aborted';
  readonly error: MediaError;
}

type TrackOutcome = TrackReadOutcome | TrackEndedOutcome | TrackAbortedOutcome;

const defaultProcessorFactory: LiveTrackProcessorFactory = {
  create(track, kind, maxBufferSize): ReadableStream<unknown> {
    assertFrameConstructor(kind);
    const candidate = (globalThis as { readonly MediaStreamTrackProcessor?: unknown })
      .MediaStreamTrackProcessor;
    if (typeof candidate !== 'function') {
      throw liveCapability(kind, 'MediaStreamTrackProcessor is unavailable in this runtime');
    }
    let processor: TrackProcessor;
    try {
      const Processor = candidate as TrackProcessorConstructor;
      processor = new Processor({ track, maxBufferSize });
    } catch (error) {
      throw liveCapability(kind, `MediaStreamTrackProcessor rejected the ${kind} track`, error);
    }
    if (!isReadableStream(processor.readable)) {
      throw liveCapability(kind, 'MediaStreamTrackProcessor exposed no readable frame stream');
    }
    return processor.readable;
  },
};

/**
 * Report facts a live source actually exposes now. A live stream has no byte size, container codec, or
 * finite duration; `Infinity` follows the platform media-duration convention for an unbounded source.
 */
export function probeLiveMediaStream(input: MediaStream | LiveMediaSource): MediaInfo {
  const mediaStream = isLiveMediaSource(input) ? input.mediaStream : input;
  if (!isMediaStreamShape(mediaStream)) {
    throw new InputError('invalid MediaStream input');
  }
  const tracks: MediaInfoTrack[] = [];
  for (const track of mediaStream.getTracks()) {
    if (track.readyState === 'ended') continue;
    const settings = currentTrackSettings(track);
    const info: MediaInfoTrack = {
      id: tracks.length,
      type: track.kind === 'video' || track.kind === 'audio' ? track.kind : 'other',
      // A live processor exposes decoded frames, not its upstream encoded codec. Report that raw domain
      // explicitly; guessing H.264/VP9/AAC/etc. from labels or browser implementation would be false.
      codec:
        track.kind === 'video' ? 'raw-video' : track.kind === 'audio' ? 'raw-audio' : 'raw-track',
    };
    if (track.kind === 'video') {
      assignPositiveSetting(info, 'width', settings.width);
      assignPositiveSetting(info, 'height', settings.height);
      assignPositiveSetting(info, 'fps', settings.frameRate);
    } else if (track.kind === 'audio') {
      assignPositiveSetting(info, 'sampleRate', settings.sampleRate);
      assignPositiveSetting(info, 'channels', settings.channelCount);
    }
    tracks.push(info);
  }
  return {
    container: 'media-stream',
    durationSec: Number.POSITIVE_INFINITY,
    tracks,
    tags: { live: 'true', duration: 'unbounded' },
  };
}

/**
 * Build raw source facts for live filter/encode planning. Output targets are deliberately not accepted:
 * unknown source geometry/layout must fail before consumption, never inherit requested output facts.
 */
export function liveTrackInfo(
  input: MediaStream | LiveMediaSource,
  kind: LiveTrackKind,
): TrackInfo | undefined {
  const mediaStream = isLiveMediaSource(input) ? input.mediaStream : input;
  if (!isMediaStreamShape(mediaStream)) {
    throw new InputError('invalid MediaStream input');
  }
  const track = singleLiveTrack(
    kind === 'video' ? mediaStream.getVideoTracks() : mediaStream.getAudioTracks(),
    kind,
  );
  if (track === undefined) return undefined;
  const settings = currentTrackSettings(track);
  if (kind === 'video') {
    const width = positiveSafeInteger(settings.width);
    const height = positiveSafeInteger(settings.height);
    if (width === undefined || height === undefined) {
      throw new InputError('live video source track settings must expose width and height');
    }
    const fps = positiveSetting(settings.frameRate);
    return {
      id: 0,
      mediaType: 'video',
      codec: 'raw-video',
      config: { codec: 'raw-video', codedWidth: width, codedHeight: height },
      ...(fps === undefined ? {} : { fps }),
    };
  }
  const sampleRate = positiveSafeInteger(settings.sampleRate);
  const channels = positiveSafeInteger(settings.channelCount);
  if (sampleRate === undefined || channels === undefined) {
    throw new InputError(
      'live audio source track settings must expose sampleRate and channelCount',
    );
  }
  return {
    id: 0,
    mediaType: 'audio',
    codec: 'raw-audio',
    config: { codec: 'raw-audio', sampleRate, numberOfChannels: channels },
  };
}

/**
 * Expose one live video and/or audio track as raw frame streams. Work starts on first pull; cancelling a
 * result detaches the processor but never stops the caller-owned track.
 */
export function decodeLiveMediaStream(
  input: MediaStream | LiveMediaSource,
  options: LiveMediaDecodeOptions = {},
): MediaStreams {
  const mediaStream = isLiveMediaSource(input) ? input.mediaStream : input;
  if (!isMediaStreamShape(mediaStream)) {
    throw new InputError('invalid MediaStream input');
  }
  const videoTrack = singleLiveTrack(mediaStream.getVideoTracks(), 'video');
  const audioTrack = singleLiveTrack(mediaStream.getAudioTracks(), 'audio');
  const factory = options.processorFactory ?? defaultProcessorFactory;
  return {
    ...(videoTrack === undefined
      ? {}
      : {
          video: liveTrackFrames(
            videoTrack,
            'video',
            factory,
            options.signal,
          ) as ReadableStream<VideoFrame>,
        }),
    ...(audioTrack === undefined
      ? {}
      : {
          audio: liveTrackFrames(
            audioTrack,
            'audio',
            factory,
            options.signal,
          ) as ReadableStream<AudioData>,
        }),
  };
}

/** Typed decline for operations whose byte/container contract cannot represent a raw live source. */
export function rejectLiveByteOperation(op: string): never {
  throw new CapabilityError(`${op} is unavailable for a raw live MediaStream`, {
    op: { kind: 'route', id: op },
    tried: ['media-stream/raw-frames'],
    ...(op === 'convert' ? { suggestion: 'use the dedicated live decode→encode path' } : {}),
  });
}

function singleLiveTrack(
  tracks: readonly MediaStreamTrack[],
  kind: LiveTrackKind,
): MediaStreamTrack | undefined {
  const live = tracks.filter((track) => track.readyState !== 'ended');
  if (live.length > 1) {
    throw new InputError(`MediaStreams cannot represent ${live.length} live ${kind} tracks`, {
      kind,
      trackCount: live.length,
    });
  }
  return live[0];
}

function liveTrackFrames(
  track: MediaStreamTrack,
  kind: LiveTrackKind,
  factory: LiveTrackProcessorFactory,
  signal: AbortSignal | undefined,
): ReadableStream<LiveFrame> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let activeRead: Promise<ReaderResult> | undefined;
  let lastTimestamp: number | undefined;
  let closed = false;
  let lockReleased = false;
  let listenerAttached = false;
  let disposeTask: Promise<void> | undefined;
  let markTrackEnded: (() => void) | undefined;
  const trackEnded = new Promise<void>((resolve) => {
    markTrackEnded = resolve;
  });
  const onTrackEnded = (): void => markTrackEnded?.();

  const release = (): void => {
    if (reader === undefined || lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };
  const detach = (): void => {
    if (!listenerAttached) return;
    listenerAttached = false;
    track.removeEventListener('ended', onTrackEnded);
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    detach();
    release();
  };
  const ensureReader = (): ReadableStreamDefaultReader<unknown> => {
    if (reader !== undefined) return reader;
    let readable: ReadableStream<unknown>;
    try {
      readable = factory.create(track, kind, 1);
    } catch (error) {
      throw error instanceof CapabilityError
        ? error
        : liveCapability(kind, `live ${kind} processor construction failed`, error);
    }
    if (!isReadableStream(readable)) {
      throw liveCapability(kind, `live ${kind} processor returned an invalid stream`);
    }
    try {
      reader = readable.getReader();
    } catch (error) {
      throw liveCapability(kind, `live ${kind} processor stream is already locked`, error);
    }
    track.addEventListener('ended', onTrackEnded, { once: true });
    listenerAttached = true;
    if (trackHasEnded(track)) onTrackEnded();
    return reader;
  };
  const dispose = (
    reason: MediaError,
    pending: Promise<ReaderResult> | undefined = activeRead,
  ): Promise<void> => {
    if (disposeTask !== undefined) return disposeTask;
    closed = true;
    detach();
    disposeTask = (async (): Promise<void> => {
      const ownedReader = reader;
      if (ownedReader === undefined) return;
      await ownedReader.cancel(reason).catch(() => {});
      if (pending !== undefined) {
        const late = await pending.catch(() => undefined);
        if (late !== undefined && !late.done) closeUntransferred(late.value);
      }
      release();
    })();
    return disposeTask;
  };

  return new ReadableStream<LiveFrame>(
    {
      async pull(controller): Promise<void> {
        if (closed) return;
        if (signalHasAborted(signal)) {
          const primary = abortError(signal);
          await dispose(primary);
          controller.error(primary);
          return;
        }
        if (trackHasEnded(track)) {
          finish();
          controller.close();
          return;
        }

        try {
          const ownedReader = ensureReader();
          const pending = ownedReader.read();
          activeRead = pending;
          const outcome = await waitForTrackOutcome(pending, trackEnded, signal);
          if (outcome.kind === 'aborted') {
            await dispose(outcome.error, pending);
            controller.error(outcome.error);
            return;
          }
          if (outcome.kind === 'ended') {
            await dispose(new MediaError('aborted', `live ${kind} track ended`), pending);
            controller.close();
            return;
          }
          // A concurrent output cancel owns `pending` and closes any late value while draining it.
          if (closed) return;

          activeRead = undefined;
          const { done, value } = outcome.result;
          if (done) {
            finish();
            controller.close();
            return;
          }
          if (signalHasAborted(signal)) {
            const primary = abortError(signal);
            closeUntransferred(value);
            await dispose(primary, undefined);
            controller.error(primary);
            return;
          }
          if (trackHasEnded(track)) {
            closeUntransferred(value);
            await dispose(new MediaError('aborted', `live ${kind} track ended`), undefined);
            controller.close();
            return;
          }
          if (!isExpectedFrame(value, kind)) {
            const primary = liveCapability(
              kind,
              `live ${kind} processor emitted ${frameKind(value)} instead of ${expectedFrameName(kind)}`,
            );
            closeUntransferred(value);
            await dispose(primary, undefined);
            controller.error(primary);
            return;
          }
          const timestamp = value.timestamp;
          if (
            !Number.isFinite(timestamp) ||
            (lastTimestamp !== undefined && timestamp < lastTimestamp)
          ) {
            const primary = new MediaError(
              'decode-error',
              `live ${kind} timestamp regressed from ${lastTimestamp ?? 'none'} to ${timestamp}`,
            );
            closeUntransferred(value);
            await dispose(primary, undefined);
            controller.error(primary);
            return;
          }
          lastTimestamp = timestamp;
          try {
            controller.enqueue(value);
          } catch (error) {
            closeUntransferred(value);
            const primary = liveDecodeError(kind, 'could not transfer a live frame', error);
            await dispose(primary, undefined);
            controller.error(primary);
          }
        } catch (error) {
          const primary =
            error instanceof MediaError
              ? error
              : liveDecodeError(kind, `live ${kind} processor read failed`, error);
          await dispose(primary);
          controller.error(primary);
        }
      },
      async cancel(reason): Promise<void> {
        await dispose(new MediaError('aborted', `live ${kind} frame stream cancelled`, reason));
      },
    },
    { highWaterMark: 0 },
  );
}

async function waitForTrackOutcome(
  pending: Promise<ReaderResult>,
  trackEnded: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<TrackOutcome> {
  const readOutcome = pending.then((result): TrackReadOutcome => ({ kind: 'read', result }));
  const endedOutcome = trackEnded.then((): TrackEndedOutcome => ({ kind: 'ended' }));
  if (signal === undefined) return Promise.race([readOutcome, endedOutcome]);
  if (signal.aborted) return { kind: 'aborted', error: abortError(signal) };
  let resolveAbort: ((outcome: TrackAbortedOutcome) => void) | undefined;
  const aborted = new Promise<TrackAbortedOutcome>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.({ kind: 'aborted', error: abortError(signal) });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([readOutcome, endedOutcome, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isExpectedFrame(value: unknown, kind: LiveTrackKind): value is LiveFrame {
  return kind === 'video'
    ? typeof VideoFrame !== 'undefined' && value instanceof VideoFrame
    : typeof AudioData !== 'undefined' && value instanceof AudioData;
}

function assertFrameConstructor(kind: LiveTrackKind): void {
  if (kind === 'video' ? typeof VideoFrame === 'undefined' : typeof AudioData === 'undefined') {
    throw liveCapability(kind, `${expectedFrameName(kind)} is unavailable in this runtime`);
  }
}

function expectedFrameName(kind: LiveTrackKind): 'VideoFrame' | 'AudioData' {
  return kind === 'video' ? 'VideoFrame' : 'AudioData';
}

function frameKind(value: unknown): string {
  if (typeof VideoFrame !== 'undefined' && value instanceof VideoFrame) return 'VideoFrame';
  if (typeof AudioData !== 'undefined' && value instanceof AudioData) return 'AudioData';
  return value === null ? 'null' : typeof value;
}

function closeUntransferred(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const close = (value as { readonly close?: unknown }).close;
  if (typeof close !== 'function') return;
  try {
    close.call(value);
  } catch {
    // Preserve the primary typed lifecycle/decode error; a host close failure cannot be recovered here.
  }
}

function abortError(signal: AbortSignal): MediaError {
  return signal.reason instanceof MediaError && signal.reason.code === 'aborted'
    ? signal.reason
    : new MediaError('aborted', 'live MediaStream decode aborted', signal.reason);
}

function signalHasAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function trackHasEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended';
}

function liveCapability(kind: LiveTrackKind, message: string, cause?: unknown): CapabilityError {
  return new CapabilityError(message, {
    op: { kind: 'route', id: 'decode', facts: { input: 'media-stream', mediaType: kind } },
    tried: ['MediaStreamTrackProcessor'],
    ...(cause === undefined ? {} : { cause }),
  });
}

function liveDecodeError(kind: LiveTrackKind, message: string, cause?: unknown): MediaError {
  return new MediaError('decode-error', message, {
    mediaType: kind,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly getReader?: unknown }).getReader === 'function'
  );
}

function currentTrackSettings(track: MediaStreamTrack): MediaTrackSettings {
  try {
    return typeof track.getSettings === 'function' ? track.getSettings() : {};
  } catch {
    // Track identity/kind remain truthful even when a host refuses its optional current settings.
    return {};
  }
}

function assignPositiveSetting(
  target: MediaInfoTrack,
  key: 'width' | 'height' | 'fps' | 'sampleRate' | 'channels',
  value: number | undefined,
): void {
  if (value !== undefined && Number.isFinite(value) && value > 0) target[key] = value;
}

function positiveSetting(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveSafeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
