/**
 * Random-access seek orchestration, kept behind the public seek operation's lazy edge.
 */

import type { WarmVideoDecoderPool } from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  Demuxer,
  PacketInfoMetadata,
  StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import type { CodecRoute } from '../kernel/router.ts';
import type { Source } from '../sources/source.ts';
import { decoderConfigWithRoutedAcceleration, supportsWarmDecoderReuse } from './codec-route.ts';
import { normalizeByteInput } from './op-support.ts';
import type { CallOptions } from './types.ts';

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
  options: CallOptions,
  signal: AbortSignal,
): Promise<VideoFrame> {
  if (!Number.isFinite(timeUs) || timeUs < 0) {
    throw new InputError(`bad seek ${timeUs}`);
  }
  const source = normalizeByteInput(input, 'seek');
  const container = await context.routeContainer(source, signal, options.strategy?.pinDriver);
  const stage = context.stage(signal, options);
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
    } = await import('./codec-pipeline.ts');
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
      const { planSeekVideoPacketInfoRows, trimVideoPacketInfoChunkStream } = await import(
        './trim-streams.ts'
      );
      const packetInfoSeekRows = planSeekVideoPacketInfoRows(packetInfoRows, trackIndex, timeUs);
      if (packetInfoSeekRows !== undefined) {
        packetInfoSeekStream = trimVideoPacketInfoChunkStream(source, packetInfoSeekRows, signal);
      }
    }
    const output =
      packetInfoSeekStream !== undefined
        ? (packetInfoSeekStream.pipeThrough(makeSeekDecoder()) as ReadableStream<VideoFrame>)
        : track.alpha === true
          ? decodeVideoPacketsWithAlpha(
              await startAtSeekKeyframePackets(demuxer.packets(track.id), timeUs),
              () => codec.createDecoder(config, stage),
            )
          : ((
              await startAtSeekKeyframe(unwrapPackets(demuxer.packets(track.id)), timeUs)
            ).pipeThrough(makeSeekDecoder()) as ReadableStream<VideoFrame>);
    return await seekFrame(output, timeUs);
    /* v8 ignore stop */
  } finally {
    await demuxer.close();
  }
}
