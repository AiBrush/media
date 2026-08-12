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
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
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
import { assertTrimRange } from './trim-range.ts';
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
    sourceContainerId: string,
  ) => Promise<{
    readonly frames: ReadableStream<AudioData>;
    readonly leadingSamplesRemoved: number;
  }>;
  readonly encodeVideo: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
    capabilityFallbackTarget?: VideoTarget,
  ) => Promise<void>;
  readonly encodeAudio: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
}

/** Execute trim after the eager engine has established its cancellation and exact-pin domain. */
export async function runTrim(
  context: TrimRunnerContext,
  input: MediaInput,
  opts: TrimOptions,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  // These guards are independent of media duration, so reject before normalizing, sniffing, routing, or
  // reading the source. Duration-relative bounds are checked again below once probe truth is available.
  assertTrimRange(opts.start, opts.end, 0);
  const source = cacheProbeRanges(normalizeByteInput(input, 'trim'));
  const container = await context.container(source, 'demux', signal, options.strategy?.pinDriver);
  const target = (container.formats[0] ?? 'mp4') as Container;
  if (opts.fragmented === true && target !== 'mp4') {
    throw new InputError('fragmented trim output requires an MP4 input container');
  }
  const fragmented = opts.fragmented === true ? { fragmented: true as const } : {};

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
        identitySourceIfFullRange: true,
        ...fragmented,
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
  assertTrimRange(opts.start, opts.end, durationSec);
  if (opts.mode === 'accurate' && isWholeSourceTrim(source, opts, durationSec)) {
    if (opts.fragmented === true && container.streamCopy !== undefined) {
      const stream = await container.streamCopy(source, {
        ...context.stage(signal, options),
        fragmented: true,
        ...streamCopySinkMode(opts.sink),
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
    return materializeOutput(opts.sink ?? toBlob(), source.stream(), mimeOptions(signal, target));
  }
  if (opts.mode === 'accurate') {
    if (target === 'adts' || target === 'aac') {
      const exactPrefix = await tryAccurateAdtsPrefixCopy(
        context,
        container,
        source,
        target,
        opts,
        signal,
        options,
      );
      if (exactPrefix !== undefined) {
        return materializeOutput(opts.sink ?? toBlob(), exactPrefix, mimeOptions(signal, target));
      }
      // AAC ADTS can carry only complete access units. Unlike MP4 edit lists or Ogg Opus
      // pre-skip/EOS granules, the elementary stream has no standardized leading- or trailing-discard
      // field. Re-encoding therefore still adds/rounds priming and padding; a hybrid that retains a
      // history access unit cannot hide its decoded samples. Never publish that rounded file for an
      // operation that promises accuracy.
      throw new CapabilityError(
        'accurate ADTS trim can carry only whole AAC access units and has no presentation discard metadata',
        {
          op: {
            kind: 'route',
            id: 'trim',
            facts: { container: target, codec: 'aac', mode: 'accurate' },
          },
          tried: ['adts-access-unit-copy', 'aac-full-reencode'],
          suggestion:
            "use mode:'keyframe' and accept whole-access-unit alignment, or author AAC in a container with explicit presentation timing",
        },
      );
    }
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
    ...fragmented,
    ...streamCopySinkMode(opts.sink),
  });
  return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
}

/**
 * Losslessly satisfy the one non-identity ADTS shape that needs no discard signalling: keep the original
 * decoder origin and end exactly before a proved access unit. A non-zero start is intentionally excluded.
 * Although WebCodecs labels every AAC chunk `key`, the AAC registration warns that decoding an arbitrary
 * packet may not reproduce the expected audio; its transform overlap needs earlier decoder state. ADTS
 * cannot retain that history and then suppress its presentation, so only a start-at-zero prefix is exact.
 * Packet-info PTS is derived from each ADTS header's raw-data-block count, rather than assuming 1,024
 * samples for every physical frame.
 */
async function tryAccurateAdtsPrefixCopy(
  context: TrimRunnerContext,
  container: ContainerDriver,
  source: Source,
  target: Container,
  opts: TrimOptions,
  signal: AbortSignal,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (
    container.id !== 'adts' ||
    container.packetInfo === undefined ||
    container.streamCopy === undefined ||
    Math.round(opts.start * 1_000_000) !== 0
  ) {
    return undefined;
  }
  const table = await container.packetInfo(source, context.stage(signal, options));
  const audioTrackIndex = table.tracks.findIndex(
    (track) => track.mediaType === 'audio' && /^mp4a\./i.test(track.codec),
  );
  if (audioTrackIndex < 0 || table.tracks.some((_, index) => index !== audioTrackIndex)) {
    return undefined;
  }
  const endUs = Math.round(opts.end * 1_000_000);
  const packets = table.packets.filter((packet) => packet.trackIndex === audioTrackIndex);
  if (
    packets[0]?.ptsUs !== 0 ||
    !packets.some((packet, index) => index > 0 && Math.round(packet.ptsUs) === endUs)
  ) {
    return undefined;
  }
  return container.streamCopy(source, {
    ...context.stage(signal, options),
    container: target,
    trim: { startSec: opts.start, endSec: opts.end },
    ...streamCopySinkMode(opts.sink),
  });
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
    throw new CapabilityError('audio trim needs EncodedAudioChunk', {
      op: { kind: 'route', id: 'trim' },
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
      throw new CapabilityError('audio trim rejects video', {
        op: { kind: 'route', id: 'trim' },
        tried: [container.id, target],
      });
    }
    const tracks = demuxer.tracks.filter(
      (track) => track.mediaType === 'audio' && track.config !== undefined,
    );
    if (tracks.length !== 1) {
      throw new CapabilityError(`audio trim needs one track, found ${tracks.length}`, {
        op: { kind: 'route', id: 'trim' },
        tried: [container.id, target],
      });
    }
    const track = tracks[0];
    if (track === undefined) {
      throw new CapabilityError('no audio trim track', {
        op: { kind: 'route', id: 'trim' },
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
    throw new CapabilityError(`accurate trim to '${target}' has no muxer`, {
      op: { kind: 'route', id: 'trim' },
      tried: [target],
    });
  }
  const offloaded = await context.offload(source, 'trim', opts, signal, options);
  /* v8 ignore next -- requires a real worker bridge; worker-host owns its lifecycle oracle. */
  if (offloaded !== undefined) return offloaded;

  const {
    canUseMp4AacPacketInfoTrim,
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
    trimVideoEncodeFallbackTarget,
    trimVideoEncodeTarget,
    trimVideoPacketInfoChunkStream,
  } = await import('./trim-streams.ts');
  const endSec = durationSec > 0 ? Math.min(opts.end, durationSec) : opts.end;
  const bounds = trimBoundsUs(opts.start, endSec);
  const demuxer = await container.demux(source, context.stage(signal, options));
  const muxer = (await context.muxer(target, options.strategy?.pinDriver)).createMuxer({
    container: target,
    ...(opts.fragmented === true ? { fragmented: true } : {}),
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
          trimVideoEncodeFallbackTarget(videoTrack, sourceBitrate),
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
        audioTrackIndex < 0 ||
        !canUseMp4AacPacketInfoTrim(audioTrack, target)
          ? undefined
          : planTrimAudioPacketInfoRows(packetInfoRows ?? [], audioTrackIndex, bounds);
      const packetInfoAudioTrack =
        plannedAudioRows === undefined
          ? undefined
          : trimAudioPacketInfoTrack(audioTrack, bounds, plannedAudioRows, target);
      if (
        plannedAudioRows !== undefined &&
        packetInfoAudioTrack?.gapless?.basis === 'mp4-edit-list'
      ) {
        const packets = trimAudioPacketInfoStream(source, plannedAudioRows, taskSignal);
        openStreams.push(packets);
        tasks.push(drainEncoderToMuxer(packets, muxer, packetInfoAudioTrack, taskSignal));
      } else {
        /* v8 ignore start -- live decode/encode requires browser WebCodecs; lifecycle is browser-gated. */
        const decodedAudio = await context.decodeAudio(
          demuxer,
          audioTrack,
          context.stage(taskSignal, options),
          options,
          container.id,
        );
        const programAudio = decodedAudio.frames;
        const trimmed = trimTimedFrameStream(programAudio, bounds, restampAudioData);
        openStreams.push(trimmed);
        tasks.push(
          context.encodeAudio(trimmed, {}, trimEncodeTrack(audioTrack), muxer, taskSignal, options),
        );
        /* v8 ignore stop */
      }
    }

    if (tasks.length === 0) {
      throw new CapabilityError('accurate trim found no track', {
        op: { kind: 'route', id: 'trim' },
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
    throw new CapabilityError(`${op} to '${target}' needs codec seam`, {
      op: { kind: 'route', id: op },
      tried: [container.id],
    });
  }
  return container.streamCopy(source, { ...opts, container: target });
}

function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op: { kind: 'route', id: op }, tried: ['media-stream/raw-frames'] },
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
