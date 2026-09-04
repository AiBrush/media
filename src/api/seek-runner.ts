/**
 * Random-access seek orchestration, kept behind the public seek operation's lazy edge.
 */

import type { WarmVideoDecoderPool } from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  Demuxer,
  EncodedChunk,
  Packet,
  PacketInfoMetadata,
  StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import type { CodecRoute } from '../kernel/router.ts';
import type { Source } from '../sources/source.ts';
import { memoizeAsync } from '../util/memoize-async.ts';
import { decoderConfigWithRoutedAcceleration, supportsWarmDecoderReuse } from './codec-route.ts';
import { normalizeByteInput } from './op-support.ts';
import { peekSeekHead, seekNearestFrame } from './seek-frames.ts';
import type { CallOptions, SeekMode, SeekOptions } from './types.ts';

/** Memoized lazy chunks: one dynamic import per module, not per call. */
const loadCodecPipelineModule = memoizeAsync(() => import('./codec-pipeline.ts'));
const loadTrimStreamsModule = memoizeAsync(() => import('./trim-streams.ts'));

interface DemuxerWithPacketInfoTable extends Demuxer {
  packetInfoTable?: () => readonly PacketInfoMetadata[];
}

export interface SeekRunnerContext {
  routeContainer(
    source: Source,
    signal: AbortSignal,
    pinDriver: string | undefined,
  ): Promise<ContainerDriver>;
  stage(signal: AbortSignal, options: CallOptions): StageOptions;
  probeCodec(query: CodecQuery, options: CallOptions): Promise<CodecRoute>;
  decoderPool(): Promise<WarmVideoDecoderPool>;
}

export async function runSeek(
  context: SeekRunnerContext,
  input: Parameters<typeof normalizeByteInput>[0],
  timeUs: number,
  options: SeekOptions,
  signal: AbortSignal,
): Promise<VideoFrame> {
  if (!Number.isFinite(timeUs) || timeUs < 0) {
    throw new InputError(`bad seek ${timeUs}`);
  }
  const source = normalizeByteInput(input, 'seek');
  const container = await context.routeContainer(source, signal, options.strategy?.pinDriver);
  const stage = context.stage(signal, options);
  const indexed = await tryIndexedSeek(context, container, source, timeUs, options, stage);
  if (indexed !== undefined) return indexed;
  const demuxer = await container.demux(source, stage);
  try {
    const track = demuxer.tracks.find(
      (candidate) => candidate.mediaType === 'video' && candidate.config !== undefined,
    );
    if (!track) {
      throw new CapabilityError('no seek video', {
        op: { kind: 'route', id: 'seek' },
        tried: [container.id],
      });
    }
    if (track.encrypted === true) {
      throw new MediaError('decode-error', 'encrypted seek');
    }

    const {
      decodeQueryFor,
      decodeVideoPacketsWithAlpha,
      seekFrame,
      startAtSeekKeyframe,
      startAtSeekKeyframePackets,
      unwrapPackets,
    } = await loadCodecPipelineModule();
    const decodeQuery = await decodeQueryFor(track);
    const route = await context.probeCodec(decodeQuery, options);
    const codec = route.driver;
    const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
    const decoderPool = supportsWarmDecoderReuse(codec) ? await context.decoderPool() : undefined;

    /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
    const makeSeekDecoder = (): ReturnType<CodecDriver['createDecoder']> =>
      decoderPool?.borrow(config, stage) ?? codec.createDecoder(config, stage);
    const packetInfoRows = (demuxer as DemuxerWithPacketInfoTable).packetInfoTable?.();
    const trackIndex = demuxer.tracks.findIndex((candidate) => candidate.id === track.id);
    let packetInfoSeekStream: ReadableStream<EncodedVideoChunk> | undefined;
    if (
      track.alpha !== true &&
      source.range !== undefined &&
      packetInfoRows !== undefined &&
      trackIndex >= 0
    ) {
      const { planSeekVideoPacketInfoRows, trimVideoPacketInfoChunkStream } =
        await loadTrimStreamsModule();
      const packetInfoSeekRows = planSeekVideoPacketInfoRows(packetInfoRows, trackIndex, timeUs);
      if (packetInfoSeekRows !== undefined) {
        packetInfoSeekStream = trimVideoPacketInfoChunkStream(source, packetInfoSeekRows, signal);
      }
    }
    const mode = options.mode ?? 'exact';
    if (packetInfoSeekStream !== undefined) {
      return await landSeek(packetInfoSeekStream, makeSeekDecoder, timeUs, mode, seekFrame);
    }
    if (track.alpha === true) {
      return await landAlphaSeek(
        await startAtSeekKeyframePackets(demuxer.packets(track.id), timeUs),
        (packets) => decodeVideoPacketsWithAlpha(packets, () => codec.createDecoder(config, stage)),
        timeUs,
        mode,
        seekFrame,
      );
    }
    return await landSeek(
      await startAtSeekKeyframe(unwrapPackets(demuxer.packets(track.id)), timeUs),
      makeSeekDecoder,
      timeUs,
      mode,
      seekFrame,
    );
    /* v8 ignore stop */
  } finally {
    await demuxer.close();
  }
}

type SeekFrameFn = (frames: ReadableStream<VideoFrame>, targetUs: number) => Promise<VideoFrame>;

/**
 * Decode a GOP-aligned chunk stream and land per {@link SeekMode}: `'exact'` returns the first frame at
 * or after the target, `'nearest'` the closest frame, `'keyframe'` the random-access frame the stream
 * starts on (decoded alone, since it is the first chunk).
 */
async function landSeek(
  chunks: ReadableStream<EncodedChunk>,
  makeDecoder: () => ReturnType<CodecDriver['createDecoder']>,
  timeUs: number,
  mode: SeekMode,
  seekFrame: SeekFrameFn,
): Promise<VideoFrame> {
  /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
  if (mode === 'keyframe') {
    const { first, stream } = await peekSeekHead(chunks);
    const output = stream.pipeThrough(makeDecoder()) as ReadableStream<VideoFrame>;
    return seekFrame(output, first?.timestamp ?? timeUs);
  }
  const output = chunks.pipeThrough(makeDecoder()) as ReadableStream<VideoFrame>;
  return mode === 'nearest' ? seekNearestFrame(output, timeUs) : seekFrame(output, timeUs);
  /* v8 ignore stop */
}

/** {@link landSeek} for VP8/VP9 alpha tracks, whose colour and alpha planes decode from packets. */
async function landAlphaSeek(
  packets: ReadableStream<Packet>,
  decode: (packets: ReadableStream<Packet>) => ReadableStream<VideoFrame>,
  timeUs: number,
  mode: SeekMode,
  seekFrame: SeekFrameFn,
): Promise<VideoFrame> {
  /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
  if (mode === 'keyframe') {
    const { first, stream } = await peekSeekHead(packets);
    return seekFrame(decode(stream), first?.chunk.timestamp ?? timeUs);
  }
  const output = decode(packets);
  return mode === 'nearest' ? seekNearestFrame(output, timeUs) : seekFrame(output, timeUs);
  /* v8 ignore stop */
}

/**
 * Index-driven seek: when the container can start a track's packet stream at the index's last
 * random-access point through bounded ranges (WebM Cues, …), decode from there instead of demuxing
 * the whole file. `undefined` hands the request to the whole-file path unchanged.
 */
async function tryIndexedSeek(
  context: SeekRunnerContext,
  container: ContainerDriver,
  source: Source,
  timeUs: number,
  options: SeekOptions,
  stage: StageOptions,
): Promise<VideoFrame | undefined> {
  if (
    container.seekPackets === undefined ||
    container.probe === undefined ||
    source.range === undefined
  ) {
    return undefined;
  }
  const tracks = await container.probe(source, stage);
  const track = tracks.find(
    (candidate) => candidate.mediaType === 'video' && candidate.config !== undefined,
  );
  if (track === undefined || track.encrypted === true) return undefined;
  const packets = await container.seekPackets(source, track.id, timeUs, stage);
  if (packets === undefined) return undefined;
  /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
  try {
    const {
      decodeQueryFor,
      decodeVideoPacketsWithAlpha,
      seekFrame,
      startAtSeekKeyframe,
      startAtSeekKeyframePackets,
      unwrapPackets,
    } = await loadCodecPipelineModule();
    const decodeQuery = await decodeQueryFor(track);
    const route = await context.probeCodec(decodeQuery, options);
    const codec = route.driver;
    const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
    const decoderPool = supportsWarmDecoderReuse(codec) ? await context.decoderPool() : undefined;
    const makeSeekDecoder = (): ReturnType<CodecDriver['createDecoder']> =>
      decoderPool?.borrow(config, stage) ?? codec.createDecoder(config, stage);
    const mode = options.mode ?? 'exact';
    if (track.alpha === true) {
      return await landAlphaSeek(
        await startAtSeekKeyframePackets(packets, timeUs),
        (started) => decodeVideoPacketsWithAlpha(started, () => codec.createDecoder(config, stage)),
        timeUs,
        mode,
        seekFrame,
      );
    }
    return await landSeek(
      await startAtSeekKeyframe(unwrapPackets(packets), timeUs),
      makeSeekDecoder,
      timeUs,
      mode,
      seekFrame,
    );
  } catch (error) {
    await packets.cancel(error).catch(() => {});
    throw error;
  }
  /* v8 ignore stop */
}
