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
  PacketMetadataStats,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { lazyPipeThrough } from '../kernel/executor-cancellable.ts';
import type { Sink } from '../sinks/sink.ts';
import { toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions } from '../sinks/sink.ts';
import type { MediaInput, Source } from '../sources/source.ts';
import {
  assertBufferedMp4ConvertProjection,
  isBuiltInBufferedMp4MuxDriverId,
  packetStatsPresentationSpanSec,
} from './buffered-mp4-convert.ts';
import {
  type SourceGeometry,
  audioTrackAfterLeadingSampleTrim,
  buildVideoEncoderConfigForRuntime,
  canCopyAudioTrackToContainer,
  canUseVpxAlphaGeometryPacketTranscode,
  canUseVpxAlphaPacketTranscode,
  decodeQueryFor,
  decodeVideoPacketsWithAlpha,
  drainEncoderToMuxer,
  qualifiedVideoSourceCodec,
  resolveAudioEncodeTargetForRuntime,
  sourceVideoBitrateFromPacketStats,
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
    sourceContainerId: string,
  ) => Promise<{
    readonly frames: ReadableStream<AudioData>;
    readonly leadingSamplesRemoved: number;
  }>;
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
  const qualityRequest =
    opts.video === false
      ? undefined
      : (await import('./video-quality-constraint.ts')).assertH264QualityConstraintPreflight(
          opts.video ?? {},
          src,
        );
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
    throw new CapabilityError(`convert to '${target}' has no muxer`, {
      op: { kind: 'route', id: 'convert' },
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

  const demuxer = await container.demux(src, context.stageOptions(signal, callOptions));
  try {
    // Route once and retain the exact output driver so projection, quality audit, and final mux cannot
    // diverge under a pinned/custom route.
    const outputContainer = await context.routeMuxer(target, callOptions.strategy?.pinDriver);
    const outputMuxOptions = context.muxOptions(opts, target);
    const qualityVideoTarget = opts.video === false ? undefined : opts.video;
    const usesQualityCandidate = qualityRequest !== undefined && qualityVideoTarget !== undefined;
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
    const packetStatsCache = new Map<number, PacketMetadataStats | undefined>();
    const packetStatsFor = (trackId: number): PacketMetadataStats | undefined => {
      if (packetStatsCache.has(trackId)) return packetStatsCache.get(trackId);
      const stats = demuxer.packetStats?.(trackId);
      packetStatsCache.set(trackId, stats);
      return stats;
    };

    let videoTrack: TrackInfo | undefined;
    let videoTarget: VideoTarget | undefined;
    let videoEncoderConfig: VideoEncoderConfig | undefined;
    if (selectedVideoTrack !== undefined && !usesQualityCandidate) {
      const measuredBitrate =
        selectedVideoTrack.bitrate ??
        sourceVideoBitrateFromPacketStats(packetStatsFor(selectedVideoTrack.id));
      videoTrack =
        measuredBitrate === undefined
          ? selectedVideoTrack
          : { ...selectedVideoTrack, bitrate: measuredBitrate };
      videoTarget = opts.video || {};
      videoEncoderConfig = await buildVideoEncoderConfigForRuntime(
        videoTarget,
        context.sourceGeometry(videoTrack),
        videoTrack.codec,
      );
    }
    const audioTarget =
      audioTrack === undefined || copyAudioPackets
        ? undefined
        : await resolveAudioEncodeTargetForRuntime(opts.audio || {}, audioTrack.codec);

    // The built-in MP4/MOV chunk muxer retains every encoded payload until finalize and its ordinary
    // publication path ultimately needs one ArrayBuffer. Reject only projections beyond the portable
    // 31-bit allocation ceiling (with 64 MiB of box/table headroom): this catches the 3.67 GiB long-form
    // plan without pre-rejecting the ~1.4 GiB plan whose VBR encoder has already proven it can underspend.
    // The muxer's independent 1 GiB actual-retention cap remains authoritative when rate evidence is
    // absent or an encoder overshoots/underspends its plan.
    if (
      (target === 'mp4' || target === 'mov') &&
      isBuiltInBufferedMp4MuxDriverId(outputContainer.id) &&
      outputMuxOptions.fragmented !== true &&
      outputMuxOptions.faststart !== 'reserve'
    ) {
      const plannedVideoBitrate =
        selectedVideoTrack === undefined
          ? undefined
          : (videoEncoderConfig?.bitrate ??
            (opts.video === false
              ? undefined
              : (opts.video?.maxAverageBitrate ?? opts.video?.bitrate)));
      const plannedAudioBitrate = copyAudioPackets ? audioTrack?.bitrate : audioTarget?.bitrate;
      const selectedTrackIds = [selectedVideoTrack?.id, audioTrack?.id].filter(isDefinedNumber);
      const selectedPacketStats = selectedTrackIds.map((trackId) => packetStatsFor(trackId));
      const packetStatsSpanSec = packetStatsPresentationSpanSec(selectedPacketStats);
      // Legacy third-party demuxers may expose only a row-materializing packetTable. Never call it for
      // planning: if bounded stats are absent, also avoid treating an absolute container endpoint as
      // elapsed work. The muxer's retained-byte cap remains the correctness authority.
      const projectedDurationSec =
        packetStatsSpanSec ??
        (demuxer.packetTable === undefined
          ? maximumTrackDurationSec(selectedVideoTrack, audioTrack)
          : undefined);
      assertBufferedMp4ConvertProjection(
        target,
        outputContainer.id,
        projectedDurationSec,
        [plannedVideoBitrate, plannedAudioBitrate].filter(isPositiveFiniteNumber),
      );
    }

    // These finite replay passes may pull decoder/encoder streams, so they deliberately occur only after
    // the buffer-all projection has accepted the resolved source duration and actual planned rate.
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
    const qualityCandidate =
      !usesQualityCandidate || qualityVideoTarget === undefined
        ? undefined
        : await (await import('./video-quality-runner.ts')).analyzeH264QualityConstrained(
            src,
            container,
            qualityVideoTarget,
            qualityRequest,
            signal,
            callOptions,
            opts.fragmented === true,
            {
              driver: outputContainer,
              format: target,
              muxOptions: outputMuxOptions as MuxOptions,
            },
            context.videoRunnerContext(),
          );

    const muxer = outputContainer.createMuxer(outputMuxOptions);
    const tasks: Promise<void>[] = [];
    const openStreams: ReadableStream<unknown>[] = [];

    if (selectedVideoTrack !== undefined) {
      if (qualityCandidate !== undefined) {
        const chunks = streamOf(qualityCandidate.chunks);
        openStreams.push(chunks);
        tasks.push(drainEncoderToMuxer(chunks, muxer, qualityCandidate.track, signal));
      } else {
        const plannedVideoTrack = videoTrack as TrackInfo;
        const plannedVideoTarget = videoTarget as VideoTarget;
        const plannedVideoEncoderConfig = videoEncoderConfig as VideoEncoderConfig;
        const sourceVideoCodec = qualifiedVideoSourceCodec(plannedVideoTrack);
        if (
          canUseVpxAlphaGeometryPacketTranscode(
            plannedVideoTarget,
            plannedVideoTrack.alpha === true,
            sourceVideoCodec,
            plannedVideoEncoderConfig.codec,
          )
        ) {
          const packets = demuxer.packets(plannedVideoTrack.id);
          openStreams.push(packets);
          tasks.push(
            context.transcodeVpxAlphaGeometry(
              packets,
              plannedVideoTarget,
              plannedVideoTrack,
              muxer,
              signal,
              callOptions,
            ),
          );
        } else if (
          canUseVpxAlphaPacketTranscode(
            plannedVideoTarget,
            plannedVideoTrack.alpha === true,
            sourceVideoCodec,
            plannedVideoEncoderConfig.codec,
          )
        ) {
          const packets = demuxer.packets(plannedVideoTrack.id);
          openStreams.push(packets);
          tasks.push(
            context.transcodeVpxAlpha(
              packets,
              plannedVideoTarget,
              plannedVideoTrack,
              muxer,
              signal,
              callOptions,
            ),
          );
        } else {
          const decodeQuery = await decodeQueryFor(plannedVideoTrack);
          const videoCodec = await context.routeCodec(decodeQuery, callOptions);
          const config = decodeQuery.config;
          const decodeStage = context.stageOptions(signal, callOptions);
          const runtimeFallback =
            plannedVideoTrack.alpha === true
              ? undefined
              : await import('./replayable-video-decoder.ts');
          const fallbackKind = runtimeFallback?.planRuntimeVideoFallback(
            videoCodec.id,
            config.codec,
            callOptions.strategy,
          );
          /* v8 ignore start -- live decode→filter→encode requires WebCodecs; browser-harness validated. */
          const decoded =
            plannedVideoTrack.alpha === true
              ? decodeVideoPacketsWithAlpha(demuxer.packets(plannedVideoTrack.id), () =>
                  videoCodec.createDecoder(config, decodeStage),
                )
              : runtimeFallback !== undefined && fallbackKind !== undefined
                ? runtimeFallback.decodeVideoWithRuntimeFallback(
                    unwrapPackets(demuxer.packets(plannedVideoTrack.id)),
                    () =>
                      videoCodec.createDecoder(config, decodeStage) as TransformStream<
                        EncodedChunk,
                        VideoFrame
                      >,
                    async () => {
                      if (fallbackKind === 'wasm-vpx') {
                        const fallback = await context.routeCodec(decodeQuery, {
                          ...callOptions,
                          strategy: {
                            ...callOptions.strategy,
                            pinDriver: 'wasm-vpx',
                          },
                        });
                        return fallback.createDecoder(config, decodeStage) as TransformStream<
                          EncodedChunk,
                          VideoFrame
                        >;
                      }
                      const softwareOptions: CallOptions = {
                        ...callOptions,
                        strategy: {
                          ...callOptions.strategy,
                          determinism: 'force-software',
                        },
                      };
                      return videoCodec.createDecoder(
                        config,
                        context.stageOptions(signal, softwareOptions),
                      ) as TransformStream<EncodedChunk, VideoFrame>;
                    },
                    { signal },
                  )
                : lazyPipeThrough<EncodedChunk, VideoFrame>(
                    unwrapPackets(demuxer.packets(plannedVideoTrack.id)),
                    () =>
                      videoCodec.createDecoder(config, decodeStage) as TransformStream<
                        EncodedChunk,
                        VideoFrame
                      >,
                    { closeValue: context.closeIfClosable },
                  );
          const filtered = await context.applyVideoFilters(
            decoded as ReadableStream<VideoFrame>,
            plannedVideoTarget,
            plannedVideoTrack,
            signal,
            callOptions,
          );
          openStreams.push(filtered);
          tasks.push(
            context.encodeVideoStream(
              filtered,
              plannedVideoTarget,
              plannedVideoTrack,
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
    }

    if (audioTrack !== undefined) {
      if (copyAudioPackets) {
        const packets = demuxer.packets(audioTrack.id);
        openStreams.push(packets);
        tasks.push(drainEncoderToMuxer(packets, muxer, audioTrack, signal));
      } else {
        const plannedAudioTarget = audioTarget as AudioTarget;
        const stage = context.stageOptions(signal, callOptions);
        let decoded: ReadableStream<AudioData>;
        let decodedSourceTrack = audioTrack;
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
          const decodedPackets = await context.decodeAudioTrackPackets(
            demuxer,
            audioTrack,
            stage,
            callOptions,
            container.id,
          );
          decoded = decodedPackets.frames;
          decodedSourceTrack = audioTrackAfterLeadingSampleTrim(
            audioTrack,
            decodedPackets.leadingSamplesRemoved,
          );
        }
        /* v8 ignore start -- live decode→filter→encode requires AudioData/WebCodecs; browser-validated. */
        const shaped = await context.applyAudioFilters(
          decoded,
          plannedAudioTarget,
          decodedSourceTrack,
          signal,
          callOptions,
        );
        openStreams.push(shaped);
        tasks.push(
          context.encodeAudioStream(
            shaped,
            plannedAudioTarget,
            decodedSourceTrack,
            muxer,
            signal,
            callOptions,
          ),
        );
        /* v8 ignore stop */
      }
    }

    if (tasks.length === 0) {
      throw new CapabilityError('convert found no decodable track', {
        op: { kind: 'route', id: 'convert' },
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

function maximumTrackDurationSec(...tracks: Array<TrackInfo | undefined>): number | undefined {
  const durations = tracks.map((track) => track?.durationSec).filter(isPositiveFiniteNumber);
  return durations.length === 0 ? undefined : Math.max(...durations);
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function isDefinedNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function streamOf<T>(values: readonly T[]): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>(
    {
      pull(controller): void {
        const value = values[index++];
        if (value === undefined) controller.close();
        else controller.enqueue(value);
      },
    },
    { highWaterMark: 0 },
  );
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
