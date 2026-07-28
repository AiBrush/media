/**
 * `@aibrush/media/wav` — lightweight, synchronous WAV PCM utilities.
 *
 * This subpath intentionally excludes the media engine, driver registry, codecs, workers, and WASM.
 * It is suitable for short-lived workers and other startup-sensitive callers that only need to verify,
 * bounded-prefix decode, or re-author PCM without constructing the full media engine.
 */

export {
  type WavPcmInterleavedPrefix,
  type WavPcmCopyPlan,
  decodeWavPcmInterleavedPrefix,
  planWavPcmCopy,
  rewriteEmptyWavPcm,
  rewriteOwnedWavPcmCopy,
  rewriteWavPcmCopy,
} from './drivers/wav/pcm.ts';
export {
  type ParsedWavHeader,
  type WavFormat,
  type WavInfo,
  parseWavHeader,
} from './drivers/wav/wav-probe.ts';
export { VERSION } from './version.ts';
