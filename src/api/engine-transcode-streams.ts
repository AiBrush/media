/**
 * Transcode-only stream stages (audio encode, packet-plane audio decode with gapless handling, VP8/VP9
 * alpha transcodes). They run only inside `convert()`/`encode()`, so they live behind this lazy chunk
 * instead of the eager engine kernel; the engine passes the few private capabilities they need.
 */

import type { AudioEncoderStageOptions } from '../codecs/webcodecs-audio.ts';
import type {
  VideoDecoderStageOptions,
  VideoEncoderStageOptions,
} from '../codecs/webcodecs-video.ts';
import type {
  AudioEncoderOutputTiming,
  CodecDriver,
  CodecQuery,
  Demuxer,
  Muxer,
  Packet,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { CodecRoute } from '../kernel/router.ts';
import { decoderConfigWithRoutedAcceleration } from './codec-route.ts';
import { memoizeAsync } from './frame-streams.ts';
import { audioGeometryOf, forceSoftware, sourceGeometryOf } from './op-support.ts';
import type { AudioTarget, CallOptions, VideoTarget } from './types.ts';

const loadCodecPipeline = memoizeAsync(() => import('./codec-pipeline.ts'));
const loadTrimStreamsModule = memoizeAsync(() => import('./trim-streams.ts'));

/** The engine capabilities these stages borrow. */
export interface TranscodeStreamDeps {
  stageOptions(signal: AbortSignal, o: CallOptions): StageOptions;
  probeCodec(q: CodecQuery, o: CallOptions): Promise<CodecRoute>;
  routeCodec(q: CodecQuery, o: CallOptions): Promise<CodecDriver>;
  applyVideoFilters(
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    track: TrackInfo,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<VideoFrame>>;
}

export async function decodeAudioTrackPackets(
  deps: TranscodeStreamDeps,
  demuxer: Demuxer,
  track: TrackInfo,
  stage: StageOptions,
  o: CallOptions,
  sourceContainerId?: string,
): Promise<{
  readonly frames: ReadableStream<AudioData>;
  readonly leadingSamplesRemoved: number;
}> {
  const {
    audioDecodeLeadingSamplesForRuntime,
    audioDecodeNativeGaplessSuppressionForRuntime,
    audioTrackAfterNativeGaplessSuppression,
    decodeQueryFor,
    decodedAudioStreamWithGapless,
    unwrapPackets,
  } = await loadCodecPipeline();
  const decodeQuery = await decodeQueryFor(track);
  const route = await deps.probeCodec(decodeQuery, o);
  const codec = route.driver;
  const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
  const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(
    codec.createDecoder(config, stage),
  ) as ReadableStream<AudioData>;
  const nativeGaplessSuppression = await audioDecodeNativeGaplessSuppressionForRuntime(
    sourceContainerId,
    track,
    codec.id,
  );
  const presentedTrack = audioTrackAfterNativeGaplessSuppression(track, nativeGaplessSuppression);
  const presented = await decodedAudioStreamWithGapless(decoded, presentedTrack, {
    packets: demuxer.packets(track.id),
    createDecoder: () => codec.createDecoder(config, stage),
    signal: stage.signal,
  });
  const leadingSamples = await audioDecodeLeadingSamplesForRuntime(
    sourceContainerId,
    track.codec,
    codec.id,
  );
  if (leadingSamples === 0) return { frames: presented, leadingSamplesRemoved: 0 };
  const { restampAudioDataRange, trimAudioGaplessFrameStream } = await loadTrimStreamsModule();
  return {
    frames: trimAudioGaplessFrameStream(presented, { leadingSamples }, restampAudioDataRange),
    leadingSamplesRemoved: leadingSamples,
  };
}

/** Resize VPx colour and alpha planes independently, avoiding an intermediate merged RGBA frame. */
export async function transcodeVpxAlphaGeometryPacketStream(
  deps: TranscodeStreamDeps,
  packets: ReadableStream<Packet>,
  target: VideoTarget,
  sourceTrack: TrackInfo,
  muxer: Muxer,
  signal: AbortSignal,
  o: CallOptions,
): Promise<void> {
  const {
    buildVideoEncoderConfig,
    decodeQueryFor,
    decodeVpxAlphaPacketStreams,
    drainEncoderToMuxer,
    encodeVpxAlphaFrameStreams,
    encodeQueryFor,
    prepareVpxAlphaFramesForEncode,
    requireEncoderConfig,
    videoTrackInfoFromDecoderConfig,
  } = await loadCodecPipeline();
  const decodeQuery = await decodeQueryFor(sourceTrack);
  const decodeRoute = await deps.probeCodec(decodeQuery, o);
  const decodeCodec = decodeRoute.driver;
  const decodeConfig = decoderConfigWithRoutedAcceleration(
    decodeQuery.config,
    decodeRoute.support,
  );
  const encodeConfig = buildVideoEncoderConfig(
    target,
    sourceGeometryOf(sourceTrack),
    sourceTrack.codec,
  );
  const encoderConfig: VideoEncoderConfig = {
    ...encodeConfig,
    alpha: 'discard',
  };
  const decodeStage: VideoDecoderStageOptions = {
    ...deps.stageOptions(signal, o),
    alpha: 'discard',
  };
  const planes = decodeVpxAlphaPacketStreams(packets, () =>
    decodeCodec.createDecoder(decodeConfig, decodeStage),
  );
  const colorFrames = await deps.applyVideoFilters(planes.color, target, sourceTrack, signal, o);
  const filteredAlphaFrames = await deps.applyVideoFilters(
    planes.alpha,
    target,
    sourceTrack,
    signal,
    o,
  );
  const alphaFrames = prepareVpxAlphaFramesForEncode(filteredAlphaFrames);
  /* v8 ignore start -- requires live WebCodecs decode/filter/encode; browser-harness validated. */
  let decoderConfig: VideoDecoderConfig | undefined;
  const colorStage: VideoEncoderStageOptions = {
    ...deps.stageOptions(signal, o),
    onDecoderConfig: (config) => {
      decoderConfig = config;
    },
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
  };
  const alphaStage: VideoEncoderStageOptions = {
    ...deps.stageOptions(signal, o),
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
  };
  const encodeCodec = await deps.routeCodec(encodeQueryFor(encoderConfig), o);
  const chunks = encodeVpxAlphaFrameStreams(colorFrames, alphaFrames, {
    encodeConfig: encoderConfig,
    createEncoder: (config, stageOptions) => encodeCodec.createEncoder(config, stageOptions),
    colorStage,
    alphaStage,
  });
  await drainEncoderToMuxer(
    chunks,
    muxer,
    () =>
      videoTrackInfoFromDecoderConfig(
        requireEncoderConfig(decoderConfig, 'video'),
        target.fps,
        sourceTrack.durationSec,
        sourceTrack.rotation,
      ),
    signal,
  );
  /* v8 ignore stop */
}

/** Transcode an unfiltered VPx-alpha packet stream without merging/splitting RGBA frames. */
export async function transcodeVpxAlphaPacketStream(
  deps: TranscodeStreamDeps,
  packets: ReadableStream<Packet>,
  target: VideoTarget,
  sourceTrack: TrackInfo,
  muxer: Muxer,
  signal: AbortSignal,
  o: CallOptions,
): Promise<void> {
  const {
    buildVideoEncoderConfig,
    canCopyVpxAlphaSideData,
    decodeQueryFor,
    drainEncoderToMuxer,
    encodeQueryFor,
    requireEncoderConfig,
    transcodeVpxAlphaPackets,
    videoTrackInfoFromDecoderConfig,
  } = await loadCodecPipeline();
  const decodeQuery = await decodeQueryFor(sourceTrack);
  // Packet-plane VPx alpha decodes colour and alpha elementary streams independently. Route the exact
  // `alpha:'discard'` config those decoders receive; probing implicit `keep` here made a discard-capable
  // browser miss before construction (and a coarse Router cache made the result operation-order dependent).
  const decodeConfig: VideoDecoderConfig & { readonly alpha: AlphaOption } = {
    ...(decodeQuery.config as VideoDecoderConfig),
    alpha: 'discard',
  };
  const decodeRoute = await deps.probeCodec({ ...decodeQuery, config: decodeConfig }, o);
  const decodeCodec = decodeRoute.driver;
  const routedDecodeConfig = decoderConfigWithRoutedAcceleration(
    decodeConfig,
    decodeRoute.support,
  );
  const encodeConfig = buildVideoEncoderConfig(
    target,
    sourceGeometryOf(sourceTrack),
    sourceTrack.codec,
  );
  const encoderConfig: VideoEncoderConfig = {
    ...encodeConfig,
    alpha: 'discard',
  };
  const encodeCodec = await deps.routeCodec(encodeQueryFor(encoderConfig), o);
  /* v8 ignore start -- requires live WebCodecs decoders/encoders; browser-harness validated. */
  let decoderConfig: VideoDecoderConfig | undefined;
  const colorStage: VideoEncoderStageOptions = {
    ...deps.stageOptions(signal, o),
    onDecoderConfig: (c) => {
      decoderConfig = c;
    },
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
  };
  const alphaStage: VideoEncoderStageOptions = {
    ...deps.stageOptions(signal, o),
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
  };
  const decodeStage: VideoDecoderStageOptions = {
    ...deps.stageOptions(signal, o),
    alpha: 'discard',
  };
  const chunks = transcodeVpxAlphaPackets(packets, {
    decodeConfig: routedDecodeConfig,
    encodeConfig: encoderConfig,
    createDecoder: (c, stageOptions) => decodeCodec.createDecoder(c, stageOptions),
    createEncoder: (c, stageOptions) => encodeCodec.createEncoder(c, stageOptions),
    decodeStage,
    colorStage,
    alphaStage,
    copyAlpha: canCopyVpxAlphaSideData(target, decodeConfig.codec, encoderConfig.codec),
  });
  await drainEncoderToMuxer(
    chunks,
    muxer,
    () =>
      videoTrackInfoFromDecoderConfig(
        requireEncoderConfig(decoderConfig, 'video'),
        target.fps,
        sourceTrack.durationSec,
        sourceTrack.rotation,
      ),
    signal,
  );
  /* v8 ignore stop */
}

/** Encode one audio stream and drain its chunks into the muxer (with the encoder→muxer config bridge). */
export async function encodeAudioStream(
  deps: TranscodeStreamDeps,
  frames: ReadableStream<AudioData>,
  target: AudioTarget,
  sourceTrack: TrackInfo | undefined,
  muxer: Muxer,
  signal: AbortSignal,
  o: CallOptions,
): Promise<void> {
  const {
    audioEncodeSoftwareDriverForRuntime,
    audioCodecToken,
    audioTrackInfoFromDecoderConfig,
    buildAudioEncoderConfig,
    drainEncoderToMuxer,
    encodeQueryFor,
    outputGaplessForAudioEncoder,
    requireEncoderConfig,
  } = await loadCodecPipeline();
  const config = buildAudioEncoderConfig(
    target,
    audioGeometryOf(sourceTrack),
    sourceTrack?.codec,
  );
  const softwareDriver = await audioEncodeSoftwareDriverForRuntime(config);
  let encodeOptions = o;
  if (softwareDriver !== undefined) {
    const softwareOptions = forceSoftware(o);
    encodeOptions =
      o.strategy?.pinDriver === undefined
        ? {
            ...softwareOptions,
            strategy: { ...softwareOptions.strategy, pinDriver: softwareDriver },
          }
        : softwareOptions;
  }
  const codec = await deps.routeCodec(encodeQueryFor(config), encodeOptions);
  // Past here is the live WebCodecs path — unreachable in Node (the route above throws first).
  /* v8 ignore start -- requires a real AudioEncoder; validated in the browser harness (BUILD §6.1). */
  let decoderConfig: AudioDecoderConfig | undefined;
  let encoderTiming: AudioEncoderOutputTiming | undefined;
  const stage: AudioEncoderStageOptions = {
    ...deps.stageOptions(signal, encodeOptions),
    onConfig: (c) => {
      decoderConfig = c;
    },
    onTiming: (timing) => {
      encoderTiming = timing;
    },
  };
  const chunks = frames.pipeThrough(codec.createEncoder(config, stage));
  let outputTrackId: number | undefined;
  await drainEncoderToMuxer(
    chunks,
    {
      addTrack: (info) => {
        const id = muxer.addTrack(info);
        outputTrackId = id;
        return id;
      },
      write: (trackId, packet) => muxer.write(trackId, packet),
    },
    () =>
      audioTrackInfoFromDecoderConfig(
        requireEncoderConfig(decoderConfig, 'audio'),
        sourceTrack?.durationSec,
      ),
    signal,
  );
  const publishedConfig = requireEncoderConfig(decoderConfig, 'audio') as AudioDecoderConfig;
  const outputCodec = audioCodecToken(publishedConfig.codec);
  if (
    outputTrackId !== undefined &&
    muxer.setTrackGapless !== undefined &&
    (outputCodec === 'aac' || outputCodec === 'opus' || outputCodec === 'mp3')
  ) {
    const gapless = outputGaplessForAudioEncoder(publishedConfig, encoderTiming);
    if (gapless === undefined) {
      // AAC and MP3 are lapped transforms with no in-band delay signalling: without the encoder's
      // own timing there is nothing to author, and the muxed program would silently run long by the
      // encoder's priming. Opus still carries its pre-skip in OpusHead, so it degrades honestly.
      if (outputCodec === 'aac' || outputCodec === 'mp3') {
        throw new CapabilityError(
          `sample-accurate ${outputCodec.toUpperCase()} muxing requires destination encoder-delay timing that ${codec.id} did not prove on this runtime`,
          {
            op: {
              kind: 'route',
              id: 'mux',
              facts: { mediaType: 'audio', codec: publishedConfig.codec },
            },
            tried: [codec.id],
            suggestion:
              'use a runtime with a proven encoder-delay fact or an encoder that publishes one',
          },
        );
      }
    } else {
      muxer.setTrackGapless(outputTrackId, gapless);
    }
  }
  /* v8 ignore stop */
}
