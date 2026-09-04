/**
 * Codec-tier pipeline facade (docs/architecture/codec-pipeline.md) — the single lazily-imported entry
 * (`engine.ts` `loadCodecPipeline()`) over the S13 layer modules, re-exported by name so no consumer
 * changes while the layers stay independently testable:
 *
 *   1. **Pure config synthesis** (Node-tested, no WebCodecs, no frames, no browser/runtime names):
 *      `codec-strings.ts` (level tables + codec-string math + avcC/hvcC parsers), `codec-queries.ts`
 *      (`*QueryFor` + decode-string normalization), `audio-target-defaults.ts` + `encoder-config.ts`
 *      (portable target shaping, `build*Config`, rate/latency, and the ONE video codec-string resolver),
 *      `mux-trackinfo.ts` (mux `TrackInfo` builders).
 *   2. **Capability routing** — NOT here: the S01 router ranks the emitted `CodecQuery` across tiers.
 *      The interim browser-quirk classifiers are quarantined in `codec-runtime-quirks.ts` pending their
 *      router move (§5 item 2); they never leak into the pure modules (grep-enforced).
 *   3. **Live composition** (browser-gated; constructs real `VideoFrame`s and drives real streams):
 *      `vpx-alpha.ts` (split/merge + bounded pairing), `vpx-alpha-geometry.ts` (full-swing filtered
 *      alpha), and `codec-live.ts` (drains/seek/pairing), Node-tested for ownership/backpressure.
 *
 * This file is re-exports ONLY — the layering (and the eager kernel's freedom from all of it) is pinned
 * by tests, not prose: `codec-routing.ts` alone is eager; everything here arrives via `import()`.
 */

export { defaultOpusAudioEncodeTarget } from './audio-target-defaults.ts';

export { audioTargetCanBypassFilterPlanner } from './audio-stream-plan.ts';
export {
  createDrainTaskGroup,
  decodedAudioStreamWithGapless,
  type DrainTaskGroup,
  drainEncoderToMuxer,
  encodeVideoFramesWithAlpha,
  encodeVpxAlphaFrameStreams,
  frameSatisfiesSeek,
  type MuxerSink,
  seekFrame,
  startAtSeekKeyframe,
  startAtSeekKeyframePackets,
  transcodeVpxAlphaPackets,
  type VpxAlphaEncodeOptions,
  type VpxAlphaFrameTranscodeOptions,
  type VpxAlphaPacketTranscodeOptions,
} from './codec-live.ts';
export {
  canCopyVpxAlphaSideData,
  canUseVpxAlphaGeometryPacketTranscode,
  canUseVpxAlphaPacketTranscode,
  decodeQueryFor,
  encodeQueryFor,
  normalizeDecoderCodec,
  outputDimensions,
  outputVideoRotation,
  qualifiedVideoSourceCodec,
  requireEncoderConfig,
  type SourceGeometry,
  sourceVideoBitrateFromPacketStats,
  sourceVideoBitrateFromPacketTable,
  videoPixelRotation,
} from './codec-queries.ts';
export {
  chooseOutputContainer,
  containerHasChunkMuxer,
  isPcmContainer,
} from './codec-routing.ts';
export {
  audioDecodeLeadingSamplesForRuntime,
  audioDecodeNativeGaplessSuppressionForRuntime,
  audioEncodeNeedsSoftwareRuntime,
  audioEncodeSoftwareDriverForRuntime,
  audioTrackAfterLeadingSampleTrim,
  audioTrackAfterNativeGaplessSuppression,
  buildVideoEncoderConfigForRuntime,
  FIREFOX_ADTS_AAC_LEADING_SAMPLES,
  firefoxAdtsAacLeadingSamples,
  firefoxAudioTranscodeDeclineReason,
  firefoxOpusAudioEncodeTarget,
  firefoxOpusEncodeUsesWasm,
  firefoxVorbisEncodeUsesWasm,
  firefoxVideoTranscodeDeclineReason,
  resolveAudioEncodeTargetForRuntime,
  vpxAlphaDecodeSoftwareDriverForRuntime,
  webkitCrossCodecH264Config,
  webkitAdtsAacLeadingSamples,
  webkitVideoTranscodeDeclineReason,
} from './codec-runtime-quirks.ts';
export {
  av1CodecStringForConfig,
  h264CodecStringForDimensions,
  h264LevelIdcForDimensions,
  isUnsupportedHevcEncodeProfile,
  videoCodecToken,
  vp9CodecStringForConfig,
} from './codec-strings.ts';
export {
  audioCodecToken,
  audioEncoderCodecString,
  buildAudioEncoderConfig,
  buildVideoEncoderConfig,
  periodicVideoKeyFrameInterval,
  resolveVideoEncoderCodecString,
  videoAlphaOption,
  videoLatencyMode,
} from './encoder-config.ts';
export {
  assertVideoEncoderOutputBitDepth,
  audioTrackInfoFromDecoderConfig,
  canCopyAudioTrackToContainer,
  canCopyVideoTrackToContainer,
  outputGaplessForAudioEncoder,
  videoTrackInfoFromDecoderConfig,
} from './mux-trackinfo.ts';
export { isPureStreamCopy } from './semantic-stream-copy.ts';
export { hasTrackSelection, selectTrackInfos } from './track-select.ts';
export {
  canDeferVpxAlphaFrameRepack,
  prepareVpxAlphaFramesForEncode,
  vpxAlphaFrameForEncode,
} from './vpx-alpha-geometry.ts';
export {
  decodeVideoPacketsWithAlpha,
  decodeVpxAlphaPacketStreams,
  type RgbaFramePixels,
  splitRgbaForVpxAlpha,
  unwrapPackets,
  type VpxAlphaSplitPixels,
} from './vpx-alpha.ts';
export {
  mergeVpxAlphaLuma,
  mergeVpxAlphaRgba,
  type VpxAlphaI420Plane,
  type VpxAlphaPackedSourceFormat,
  vpxAlphaI420FromPackedGrayscale,
  vpxAlphaI420FromPackedRgba,
  vpxAlphaI420FromPlane,
} from './vpx-alpha-pixels.ts';
