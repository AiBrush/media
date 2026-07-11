import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  Muxer,
  PacketInfoMetadata,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions, Output, Sink } from '../sinks/sink.ts';
import { isLiveMediaSource } from '../sources/live-source.ts';
import {
  type MediaInput,
  SOURCE_URL_KEY,
  type Source,
  from as normalizeInput,
} from '../sources/source.ts';
import { containerHasChunkMuxer, isPcmContainer } from './codec-routing.ts';
import type { AudioTarget, CallOptions, Container, TrimOptions, VideoTarget } from './types.ts';

const AUDIO_PACKET_TRIM_CONTAINERS = new Set<Container>(['mp3', 'adts', 'ogg']);
const TRIM_IDENTITY_START_EPSILON_SEC = 1e-9;
const TRIM_IDENTITY_END_EPSILON_SEC = 0.001;

const CONTAINER_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};

interface DemuxerWithPacketInfoTable extends Demuxer {
  packetInfoTable?: () => readonly PacketInfoMetadata[];
}

/** Engine-owned routing/codec capabilities used by the lazy trim implementation. */
export interface TrimRunnerContext {
  readonly container: (
    source: Source,
    direction: ContainerQuery['direction'],
    signal?: AbortSignal,
    pinDriver?: string,
  ) => Promise<ContainerDriver>;
  readonly muxer: (target: string, pinDriver?: string) => Promise<ContainerDriver>;
  readonly stage: (signal: AbortSignal, options: CallOptions) => StageOptions;
  readonly offload: (
    source: Source,
    kind: 'trim',
    opts: TrimOptions,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<ReadableStream<Uint8Array> | undefined>;
  readonly codec: (query: CodecQuery, options: CallOptions) => Promise<CodecDriver>;
  readonly decodeAudio: (
    demuxer: Demuxer,
    track: TrackInfo,
    stage: StageOptions,
    options: CallOptions,
  ) => Promise<ReadableStream<AudioData>>;
  readonly encodeVideo: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
  readonly encodeAudio: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
  readonly assertRange: (startSec: number, endSec: number, durationSec: number) => void;
}

/** Execute trim after the eager engine has established its cancellation and exact-pin domain. */
export async function runTrim(
  context: TrimRunnerContext,
  input: MediaInput,
  opts: TrimOptions,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  const source = cacheProbeRanges(normalizeByteInput(input, 'trim'));
  const container = await context.container(source, 'demux', signal, options.strategy?.pinDriver);
  const target = (container.formats[0] ?? 'mp4') as Container;

  if (opts.mode !== 'accurate' && container.streamCopy !== undefined) {
    if (target === 'flac') {
      const stream = await container.streamCopy(source, {
        ...context.stage(signal, options),
        trim: { startSec: opts.start, endSec: opts.end },
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
    if (container.validatesStreamCopyTrim) {
      const stream = await container.streamCopy(source, {
        ...context.stage(signal, options),
        trim: { startSec: opts.start, endSec: opts.end },
        ...streamCopySinkMode(opts.sink),
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
  }

  if (
    opts.mode !== 'accurate' &&
    isPcmContainer(target) &&
    container.transformPcm !== undefined &&
    container.validatesPcmTrim
  ) {
    const stream = await container.transformPcm(source, {
      ...context.stage(signal, options),
      container: target,
      timeBounds: { startSec: opts.start, endSec: opts.end },
    });
    return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
  }

  const durationSec = await probeDurationSec(context, container, source, signal, options);
  context.assertRange(opts.start, opts.end, durationSec);
  if (opts.mode === 'accurate' && isWholeSourceTrim(source, opts, durationSec)) {
    return materializeOutput(opts.sink ?? toBlob(), source.stream(), mimeOptions(signal, target));
  }
  if (opts.mode === 'accurate') {
    if (target === 'flac' && container.transformPcm !== undefined) {
      const stream = await container.transformPcm(source, {
        ...context.stage(signal, options),
        timeBounds: { startSec: opts.start, endSec: opts.end },
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
    const stream = await trimViaCodec(
      context,
      container,
      source,
      target,
      opts,
      durationSec,
      signal,
      options,
    );
    return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
  }

  if (isPcmContainer(target) && container.transformPcm !== undefined) {
    const stream = await container.transformPcm(source, {
      ...context.stage(signal, options),
      container: target,
      timeBounds: { startSec: opts.start, endSec: opts.end },
    });
    return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
  }
  if (AUDIO_PACKET_TRIM_CONTAINERS.has(target)) {
    const stream = await trimAudioPacketsViaSeam(
      context,
      container,
      source,
      target,
      opts,
      signal,
      options,
    );
    return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
  }
  const stream = await streamCopyOrThrow(container, source, target, 'trim', {
    ...context.stage(signal, options),
    trim: { startSec: opts.start, endSec: opts.end },
    ...streamCopySinkMode(opts.sink),
  });
  return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
}

async function trimAudioPacketsViaSeam(
  context: TrimRunnerContext,
  container: ContainerDriver,
  source: Source,
  target: Container,
  opts: TrimOptions,
  signal: AbortSignal,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError('capability-miss', 'audio trim needs EncodedAudioChunk', {
      op: 'trim',
      tried: [container.id, target],
    });
  }
  const { trimAudioPacketStream, trimBoundsUs, trimPacketCopyTrack } = await import(
    './trim-streams.ts'
  );
  const bounds = trimBoundsUs(opts.start, opts.end);
  const demuxer = await container.demux(source, context.stage(signal, options));
  const muxer = (await context.muxer(target, options.strategy?.pinDriver)).createMuxer({
    container: target,
  });
  try {
    if (demuxer.tracks.some((track) => track.mediaType === 'video')) {
      throw new CapabilityError('capability-miss', 'audio trim rejects video', {
        op: 'trim',
        tried: [container.id, target],
      });
    }
    const tracks = demuxer.tracks.filter(
      (track) => track.mediaType === 'audio' && track.config !== undefined,
    );
    if (tracks.length !== 1) {
      throw new CapabilityError(
        'capability-miss',
        `audio trim needs one track, found ${tracks.length}`,
        { op: 'trim', tried: [container.id, target] },
      );
    }
    const track = tracks[0];
    if (track === undefined) {
      throw new CapabilityError('capability-miss', 'no audio trim track', {
        op: 'trim',
        tried: [container.id, target],
      });
    }
    const packets = trimAudioPacketStream(demuxer.packets(track.id), bounds);
    const { drainEncoderToMuxer } = await import('./codec-pipeline.ts');
    await drainEncoderToMuxer(packets, muxer, trimPacketCopyTrack(track, bounds), signal);
    await muxer.finalize();
    return muxer.output;
  } finally {
    await demuxer.close();
  }
}

async function trimViaCodec(
  context: TrimRunnerContext,
  container: ContainerDriver,
  source: Source,
  target: Container,
  opts: TrimOptions,
  durationSec: number,
  signal: AbortSignal,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (!containerHasChunkMuxer(target)) {
    throw new CapabilityError('capability-miss', `accurate trim to '${target}' has no muxer`, {
      op: 'trim',
      tried: [target],
    });
  }
  const offloaded = await context.offload(source, 'trim', opts, signal, options);
  /* v8 ignore next -- requires a real worker bridge; worker-host owns its lifecycle oracle. */
  if (offloaded !== undefined) return offloaded;

  const {
    estimateTrackBitrateFromPacketInfo,
    restampAudioData,
    restampVideoFrame,
    planTrimAudioPacketInfoRows,
    planTrimVideoPacketInfoRows,
    trimAudioPacketInfoStream,
    trimAudioPacketInfoTrack,
    trimBoundsUs,
    trimEncodeTrack,
    trimTimedFrameStream,
    trimVideoEncodeTarget,
    trimVideoPacketInfoChunkStream,
  } = await import('./trim-streams.ts');
  const endSec = durationSec > 0 ? Math.min(opts.end, durationSec) : opts.end;
  const bounds = trimBoundsUs(opts.start, endSec);
  const demuxer = await container.demux(source, context.stage(signal, options));
  const muxer = (await context.muxer(target, options.strategy?.pinDriver)).createMuxer({
    container: target,
  });
  const { createDrainTaskGroup, drainEncoderToMuxer } = await import('./codec-pipeline.ts');
  const group = createDrainTaskGroup(signal);
  const taskSignal = group.signal;
  const tasks: Promise<void>[] = [];
  const openStreams: ReadableStream<unknown>[] = [];
  let drainsStarted = false;
  try {
    const packetInfoRows = (demuxer as DemuxerWithPacketInfoTable).packetInfoTable?.();
    const videoTrack = demuxer.tracks.find(
      (track) => track.mediaType === 'video' && track.config !== undefined,
    );
    const audioTrack = demuxer.tracks.find(
      (track) => track.mediaType === 'audio' && track.config !== undefined,
    );

    if (videoTrack !== undefined) {
      assertTrimTrackDecodable(videoTrack);
      const { decodeQueryFor, startAtSeekKeyframe, unwrapPackets } = await import(
        './codec-pipeline.ts'
      );
      const decodeQuery = await decodeQueryFor(videoTrack);
      const codec = await context.codec(decodeQuery, options);
      const videoTrackIndex = demuxer.tracks.findIndex((track) => track.id === videoTrack.id);
      const sourceBitrate =
        packetInfoRows === undefined || videoTrackIndex < 0
          ? undefined
          : estimateTrackBitrateFromPacketInfo(packetInfoRows, videoTrackIndex);
      const plannedVideoRows =
        typeof EncodedVideoChunk === 'undefined' ||
        source.range === undefined ||
        packetInfoRows === undefined ||
        videoTrackIndex < 0
          ? undefined
          : planTrimVideoPacketInfoRows(packetInfoRows, videoTrackIndex, bounds);
      /* v8 ignore start -- live decode/encode requires browser WebCodecs; lifecycle is browser-gated. */
      const packets =
        plannedVideoRows === undefined
          ? await startAtSeekKeyframe(unwrapPackets(demuxer.packets(videoTrack.id)), bounds.startUs)
          : trimVideoPacketInfoChunkStream(source, plannedVideoRows, taskSignal);
      const decoded = packets.pipeThrough(
        codec.createDecoder(decodeQuery.config, context.stage(taskSignal, options)),
      ) as ReadableStream<VideoFrame>;
      const trimmed = trimTimedFrameStream(decoded, bounds, restampVideoFrame);
      openStreams.push(trimmed);
      tasks.push(
        context.encodeVideo(
          trimmed,
          trimVideoEncodeTarget(videoTrack, sourceBitrate),
          trimEncodeTrack(videoTrack),
          muxer,
          taskSignal,
          options,
        ),
      );
      /* v8 ignore stop */
    }

    if (audioTrack !== undefined) {
      assertTrimTrackDecodable(audioTrack);
      const audioTrackIndex = demuxer.tracks.findIndex((track) => track.id === audioTrack.id);
      const plannedAudioRows =
        typeof EncodedAudioChunk === 'undefined' ||
        source.range === undefined ||
        audioTrackIndex < 0
          ? undefined
          : planTrimAudioPacketInfoRows(packetInfoRows ?? [], audioTrackIndex, bounds);
      if (plannedAudioRows !== undefined) {
        const packets = trimAudioPacketInfoStream(source, plannedAudioRows, taskSignal);
        openStreams.push(packets);
        tasks.push(
          drainEncoderToMuxer(
            packets,
            muxer,
            trimAudioPacketInfoTrack(audioTrack, bounds),
            taskSignal,
          ),
        );
      } else {
        /* v8 ignore start -- live decode/encode requires browser WebCodecs; lifecycle is browser-gated. */
        const programAudio = await context.decodeAudio(
          demuxer,
          audioTrack,
          context.stage(taskSignal, options),
          options,
        );
        const trimmed = trimTimedFrameStream(programAudio, bounds, restampAudioData);
        openStreams.push(trimmed);
        tasks.push(
          context.encodeAudio(trimmed, {}, trimEncodeTrack(audioTrack), muxer, taskSignal, options),
        );
        /* v8 ignore stop */
      }
    }

    if (tasks.length === 0) {
      throw new CapabilityError('capability-miss', 'accurate trim found no track', {
        op: 'trim',
        tried: [container.id],
      });
    }
    /* v8 ignore start -- reached only after live codec routes resolve; browser lifecycle-gated. */
    drainsStarted = true;
    await group.run(tasks);
    await muxer.finalize();
    return muxer.output;
    /* v8 ignore stop */
  } catch (error) {
    if (!drainsStarted) await Promise.all(openStreams.map((stream) => cancelStream(stream)));
    throw error;
  } finally {
    group.dispose();
    await demuxer.close();
  }
}

async function probeDurationSec(
  context: TrimRunnerContext,
  container: ContainerDriver,
  source: Source,
  signal: AbortSignal,
  options: CallOptions,
): Promise<number> {
  const stage = context.stage(signal, options);
  if (container.probe !== undefined) {
    return trimDurationSecFromTracks(await container.probe(source, stage));
  }
  const demuxer = await container.demux(source, stage);
  try {
    return trimDurationSecFromTracks(demuxer.tracks);
  } finally {
    await demuxer.close();
  }
}

async function streamCopyOrThrow(
  container: ContainerDriver,
  source: Source,
  target: string,
  op: string,
  opts: StreamCopyOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (container.streamCopy === undefined || !container.formats.includes(target)) {
    throw new CapabilityError('capability-miss', `${op} to '${target}' needs codec seam`, {
      op,
      tried: [container.id],
    });
  }
  return container.streamCopy(source, { ...opts, container: target });
}

function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    'capability-miss',
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op, tried: ['media-stream/raw-frames'] },
  );
}

function cacheProbeRanges(source: Source): Source {
  const range = source.range;
  if (range === undefined) return source;
  let cached: Uint8Array | undefined;
  let cachedSize: number | undefined;
  const wrapped: Source = {
    ...source,
    range: async (start, end) => {
      const sourceSize = source.size ?? cachedSize;
      const cachedCoversEnd =
        cached !== undefined &&
        (end <= cached.byteLength ||
          (sourceSize !== undefined && cached.byteLength >= sourceSize && end >= sourceSize));
      if (cached !== undefined && start >= 0 && cachedCoversEnd) {
        return cached.subarray(start, end);
      }
      const bytes = await range.call(source, start, end);
      cachedSize =
        source.size ??
        cachedSize ??
        (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(end))
          ? bytes.byteLength
          : undefined);
      if (start === 0 && (cached === undefined || bytes.byteLength > cached.byteLength)) {
        cached = bytes;
      }
      return bytes;
    },
  };
  Object.defineProperties(wrapped, {
    size: {
      configurable: true,
      enumerable: true,
      get: () => source.size ?? cachedSize,
    },
    [SOURCE_URL_KEY]: {
      configurable: true,
      enumerable: true,
      get: () => source[SOURCE_URL_KEY],
    },
  });
  return wrapped;
}

function isWholeSourceTrim(source: Source, opts: TrimOptions, durationSec: number): boolean {
  if (source.kind === 'stream' || durationSec <= 0) return false;
  return (
    Math.abs(opts.start) <= TRIM_IDENTITY_START_EPSILON_SEC &&
    Math.abs(opts.end - durationSec) <= TRIM_IDENTITY_END_EPSILON_SEC
  );
}

function trimDurationSecFromTracks(tracks: readonly TrackInfo[]): number {
  return tracks.reduce((max, track) => Math.max(max, trimDurationSecOfTrack(track)), 0);
}

function trimDurationSecOfTrack(track: TrackInfo): number {
  const totalSamples = track.gapless?.totalSamples;
  const config = track.config;
  const sampleRate = config !== undefined && 'sampleRate' in config ? config.sampleRate : undefined;
  if (
    track.mediaType === 'audio' &&
    totalSamples !== undefined &&
    sampleRate !== undefined &&
    sampleRate > 0
  ) {
    return totalSamples / sampleRate;
  }
  return track.durationSec !== undefined &&
    Number.isFinite(track.durationSec) &&
    track.durationSec > 0
    ? track.durationSec
    : 0;
}

function assertTrimTrackDecodable(track: TrackInfo): void {
  if (track.encrypted !== true) return;
  throw new MediaError('decode-error', `protected ${track.mediaType} trim needs decrypt()`);
}

async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  return materialize(sink, stream, opts);
}

function streamCopySinkMode(sink: Sink | undefined): { streaming?: true; buffered?: true } {
  return sink?.kind === 'stream-target' ? { streaming: true } : { buffered: true };
}

async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

function mimeOptions(signal: AbortSignal, container: string): MaterializeOptions {
  const mime = CONTAINER_MIME[container];
  return mime === undefined ? { signal } : { signal, mime };
}
