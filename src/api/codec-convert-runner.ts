/**
 * Cold decode/filter/encode/mux orchestration for `convert()`.
 *
 * The default engine imports this module only after the PCM-family and other earlier conversion routes
 * have declined. The residual conversion route still proves semantic stream-copy before constructing
 * the live codec graph. Keeping both decisions here prevents metadata-only startup from carrying browser
 * codec, two-pass, runtime-fallback, and stream-lifetime orchestration in the eager kernel.
 */

import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  Demuxer,
  EncodedChunk,
  MuxOptions,
  Muxer,
  Packet,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { lazyPipeThrough } from '../kernel/executor.ts';
import type { Sink } from '../sinks/sink.ts';
import { toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions } from '../sinks/sink.ts';
import type { MediaInput, Source } from '../sources/source.ts';
import {
  type SourceGeometry,
  buildVideoEncoderConfigForRuntime,
  canCopyAudioTrackToContainer,
  canUseVpxAlphaGeometryPacketTranscode,
  canUseVpxAlphaPacketTranscode,
  decodeQueryFor,
  decodeVideoPacketsWithAlpha,
  drainEncoderToMuxer,
  qualifiedVideoSourceCodec,
  resolveAudioEncodeTargetForRuntime,
  sourceVideoBitrateFromPacketTable,
  unwrapPackets,
} from './codec-pipeline.ts';
import { chooseOutputContainer, containerHasChunkMuxer } from './codec-routing.ts';
import type { AudioTarget, CallOptions, ConvertOptions, Output, VideoTarget } from './types.ts';
import type { H264TwoPassRunnerContext } from './video-two-pass-runner.ts';
import type { H264TwoPassPlan } from './video-two-pass.ts';

export interface CodecConvertRunnerContext {
  readonly routeContainer: (
    src: Source,
    direction: 'demux' | 'mux',
    signal?: AbortSignal,
    pinDriver?: string,
  ) => Promise<ContainerDriver>;
  readonly stageOptions: (signal: AbortSignal, options: CallOptions) => StageOptions;
  readonly offloadStream: (
    src: Source,
    kind: 'convert' | 'trim',
    publicOptions: ConvertOptions,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<ReadableStream<Uint8Array> | undefined>;
  readonly videoRunnerContext: () => H264TwoPassRunnerContext;
  readonly routeMuxer: (target: string, pinDriver?: string) => Promise<ContainerDriver>;
  readonly muxOptions: (options: ConvertOptions, container: string) => MuxOptions;
  readonly materializeOutput: (
    sink: Sink,
    stream: ReadableStream<Uint8Array>,
    options: MaterializeOptions,
  ) => Promise<Output>;
  readonly mimeOptions: (
    signal: AbortSignal,
    container: string,
  ) => { signal: AbortSignal; mime?: string };
  readonly sourceGeometry: (track: TrackInfo) => SourceGeometry;
  readonly transcodeVpxAlphaGeometry: (
    packets: ReadableStream<Packet>,
    target: VideoTarget,
    sourceTrack: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
  readonly transcodeVpxAlpha: (
    packets: ReadableStream<Packet>,
    target: VideoTarget,
    sourceTrack: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
  readonly routeCodec: (query: CodecQuery, options: CallOptions) => Promise<CodecDriver>;
  readonly closeIfClosable: (value: unknown) => void;
  readonly applyVideoFilters: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    track: TrackInfo,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<ReadableStream<VideoFrame>>;
  readonly encodeVideoStream: (
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
    fragmented?: boolean,
    twoPassPlan?: H264TwoPassPlan,
  ) => Promise<void>;
  readonly isRawPcmTrack: (track: TrackInfo) => boolean;
  readonly decodeAudioTrackPackets: (
    demuxer: Demuxer,
    track: TrackInfo,
    stage: StageOptions,
    options: CallOptions,
  ) => Promise<ReadableStream<AudioData>>;
  readonly applyAudioFilters: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    track: TrackInfo,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<ReadableStream<AudioData>>;
  readonly encodeAudioStream: (
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ) => Promise<void>;
}

/** Run the full codec-seam conversion graph behind the engine's cold module boundary. */
export async function runCodecConvert(
  src: Source,
  opts: ConvertOptions,
  signal: AbortSignal,
  callOptions: CallOptions,
  input: MediaInput,
  context: CodecConvertRunnerContext,
): Promise<Output> {
  const container = await context.routeContainer(
    src,
    'demux',
    signal,
    callOptions.strategy?.pinDriver,
  );
  const target = chooseOutputContainer(opts.to, container.formats[0]);

  const copied = await (await import('./convert-stream-copy.ts')).tryConvertStreamCopy(
    container,
    target,
    src,
    opts,
    context.stageOptions(signal, callOptions),
    input,
  );
  if (copied !== undefined) {
    if ('output' in copied) return copied.output;
    return context.materializeOutput(
      opts.sink ?? toBlob(),
      copied.stream,
      context.mimeOptions(signal, target),
    );
  }

  if (!containerHasChunkMuxer(target)) {
    throw new CapabilityError('capability-miss', `convert to '${target}' has no muxer`, {
      op: 'convert',
      tried: [target],
    });
  }

  const offloaded = await context.offloadStream(src, 'convert', opts, signal, callOptions);
  /* v8 ignore next -- the offload branch needs a live worker bridge (browser); harness validated. */
  if (offloaded !== undefined) {
    return context.materializeOutput(
      opts.sink ?? toBlob(),
      offloaded,
      context.mimeOptions(signal, target),
    );
  }

  const twoPassPlan =
    opts.video !== false && opts.video?.twoPass === true
      ? await (await import('./video-two-pass-runner.ts')).analyzeH264TwoPass(
          src,
          container,
          opts.video,
          signal,
          callOptions,
          opts.fragmented === true,
          context.videoRunnerContext(),
        )
      : undefined;
  const demuxer = await container.demux(src, context.stageOptions(signal, callOptions));
  const muxer = (await context.routeMuxer(target, callOptions.strategy?.pinDriver)).createMuxer(
    context.muxOptions(opts, target),
  );
  const tasks: Promise<void>[] = [];
  const openStreams: ReadableStream<unknown>[] = [];
  try {
    const selectedVideoTrack =
      opts.video === false
        ? undefined
        : demuxer.tracks.find((track) => track.mediaType === 'video' && track.config !== undefined);
    const audioTrack =
      opts.audio === false
        ? undefined
        : demuxer.tracks.find((track) => track.mediaType === 'audio' && track.config !== undefined);
    const copyAudioPackets =
      audioTrack !== undefined &&
      opts.audio === undefined &&
      canCopyAudioTrackToContainer(target, audioTrack);

    if (selectedVideoTrack !== undefined) {
      const measuredBitrate = sourceVideoBitrateFromPacketTable(
        demuxer.packetTable?.(),
        selectedVideoTrack.id,
      );
      const videoTrack: TrackInfo =
        measuredBitrate === undefined
          ? selectedVideoTrack
          : { ...selectedVideoTrack, bitrate: measuredBitrate };
      const videoTarget = opts.video || {};
      const sourceGeometry = context.sourceGeometry(videoTrack);
      const videoEncoderConfig = await buildVideoEncoderConfigForRuntime(
        videoTarget,
        sourceGeometry,
        videoTrack.codec,
      );
      const sourceVideoCodec = qualifiedVideoSourceCodec(videoTrack);
      if (
        canUseVpxAlphaGeometryPacketTranscode(
          videoTarget,
          videoTrack.alpha === true,
          sourceVideoCodec,
          videoEncoderConfig.codec,
        )
      ) {
        const packets = demuxer.packets(videoTrack.id);
        openStreams.push(packets);
        tasks.push(
          context.transcodeVpxAlphaGeometry(
            packets,
            videoTarget,
            videoTrack,
            muxer,
            signal,
            callOptions,
          ),
        );
      } else if (
        canUseVpxAlphaPacketTranscode(
          videoTarget,
          videoTrack.alpha === true,
          sourceVideoCodec,
          videoEncoderConfig.codec,
        )
      ) {
        const packets = demuxer.packets(videoTrack.id);
        openStreams.push(packets);
        tasks.push(
          context.transcodeVpxAlpha(packets, videoTarget, videoTrack, muxer, signal, callOptions),
        );
      } else {
        const decodeQuery = await decodeQueryFor(videoTrack);
        const videoCodec = await context.routeCodec(decodeQuery, callOptions);
        const config = decodeQuery.config;
        const decodeStage = context.stageOptions(signal, callOptions);
        /* v8 ignore start -- live decode→filter→encode requires WebCodecs; browser-harness validated. */
        const decoded =
          videoTrack.alpha === true
            ? decodeVideoPacketsWithAlpha(demuxer.packets(videoTrack.id), () =>
                videoCodec.createDecoder(config, decodeStage),
              )
            : callOptions.strategy?.pinDriver !== videoCodec.id &&
                videoCodec.id !== 'wasm-vpx' &&
                /^vp(?:8|9|09)/.test(config.codec)
              ? (await import('./replayable-video-decoder.ts')).decodeVideoWithRuntimeFallback(
                  unwrapPackets(demuxer.packets(videoTrack.id)),
                  () =>
                    videoCodec.createDecoder(config, decodeStage) as TransformStream<
                      EncodedChunk,
                      VideoFrame
                    >,
                  async () => {
                    const fallback = await context.routeCodec(decodeQuery, {
                      ...callOptions,
                      strategy: { ...callOptions.strategy, pinDriver: 'wasm-vpx' },
                    });
                    return fallback.createDecoder(config, decodeStage) as TransformStream<
                      EncodedChunk,
                      VideoFrame
                    >;
                  },
                  { signal },
                )
              : lazyPipeThrough<EncodedChunk, VideoFrame>(
                  unwrapPackets(demuxer.packets(videoTrack.id)),
                  () =>
                    videoCodec.createDecoder(config, decodeStage) as TransformStream<
                      EncodedChunk,
                      VideoFrame
                    >,
                  { closeValue: context.closeIfClosable },
                );
        const filtered = await context.applyVideoFilters(
          decoded as ReadableStream<VideoFrame>,
          videoTarget,
          videoTrack,
          signal,
          callOptions,
        );
        openStreams.push(filtered);
        tasks.push(
          context.encodeVideoStream(
            filtered,
            videoTarget,
            videoTrack,
            muxer,
            signal,
            callOptions,
            opts.fragmented === true,
            twoPassPlan,
          ),
        );
        /* v8 ignore stop */
      }
    }

    if (audioTrack !== undefined) {
      if (copyAudioPackets) {
        const packets = demuxer.packets(audioTrack.id);
        openStreams.push(packets);
        tasks.push(drainEncoderToMuxer(packets, muxer, audioTrack, signal));
      } else {
        const audioTarget = await resolveAudioEncodeTargetForRuntime(
          opts.audio || {},
          audioTrack.codec,
        );
        const stage = context.stageOptions(signal, callOptions);
        let decoded: ReadableStream<AudioData>;
        if (
          (context.isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac') &&
          container.decodePcmInterleavedStream !== undefined
        ) {
          const chunks = await container.decodePcmInterleavedStream(src, stage);
          decoded = (await import('../dsp/audio-data.ts')).interleavedPcmChunksToAudioDataStream(
            chunks,
            stage,
            audioTrack.codec,
          );
        } else if (
          (context.isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac') &&
          container.decodePcmAudioStream !== undefined
        ) {
          const chunks = await container.decodePcmAudioStream(src, stage);
          decoded = (await import('../dsp/audio-data.ts')).pcmAudioChunksToAudioDataStream(
            chunks,
            stage,
            audioTrack.codec,
            'f32',
          );
        } else if (
          container.decodePcmAudio !== undefined &&
          (context.isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac')
        ) {
          decoded = (await import('../dsp/audio-data.ts')).pcmAudioToAudioDataStream(
            await container.decodePcmAudio(src, stage),
            stage,
            audioTrack.codec,
            'f32',
          );
        } else {
          decoded = await context.decodeAudioTrackPackets(demuxer, audioTrack, stage, callOptions);
        }
        /* v8 ignore start -- live decode→filter→encode requires AudioData/WebCodecs; browser-validated. */
        const shaped = await context.applyAudioFilters(
          decoded,
          audioTarget,
          audioTrack,
          signal,
          callOptions,
        );
        openStreams.push(shaped);
        tasks.push(
          context.encodeAudioStream(shaped, audioTarget, audioTrack, muxer, signal, callOptions),
        );
        /* v8 ignore stop */
      }
    }

    if (tasks.length === 0) {
      throw new CapabilityError('capability-miss', 'convert found no decodable track', {
        op: 'convert',
        tried: [container.id],
      });
    }
    /* v8 ignore start -- reached only when a live codec was resolved (browser); harness-validated. */
    await allOrCancelStreams(tasks, openStreams);
    await muxer.finalize();
    return await context.materializeOutput(
      opts.sink ?? toBlob(),
      muxer.output,
      context.mimeOptions(signal, target),
    );
    /* v8 ignore stop */
  } finally {
    await demuxer.close();
  }
}

async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

async function allOrCancelStreams(
  tasks: readonly Promise<void>[],
  streams: readonly ReadableStream<unknown>[],
): Promise<void> {
  try {
    await Promise.all(tasks);
  } catch (error) {
    await Promise.all(streams.map((stream) => cancelStream(stream)));
    throw error;
  }
}
