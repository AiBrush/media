/**
 * Raw-PCM-container convert route (ADR-022/059) — the PCM-native path that re-serializes a raw-PCM target
 * (WAV/AIFF/CAF) straight through the TS audio-dsp `transformPcm` (channel up/down-mix, sample format,
 * sample-rate, gain/fade/dynamics/biquad), never the WebCodecs chunk seam. A WAV target may also be produced
 * by a compressed-audio source's `decodePcm` bridge (FLAC→WAV, ADR-024; ADTS AAC→WAV, ADR-050).
 *
 * Why a SEPARATE module (split out of `engine.ts`): this routine runs ONLY for a raw-PCM-container target.
 * Keeping it behind the engine's lazy `import('./pcm-convert-plan.ts')` rather than inline in the engine
 * class keeps it (and the `pcmEndian`/transform-options assembly) OUT of the eager kernel closure (BUILD §2,
 * doc 08 §7 byte budget). The engine threads in the few capabilities this needs ({@link PcmConvertDeps}); the
 * tiny eligibility gate (`isPcmContainer` + `isPcmCodec`) stays inline-eager so a non-PCM convert never loads
 * this chunk. Pure control flow over the source container's own transform; the bytes-level transform lives in
 * the (already-loaded) container driver.
 */

import type {
  ContainerDriver,
  PcmContainer,
  PcmTransform,
  StageOptions,
} from '../contracts/driver.ts';
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { Source } from '../sources/source.ts';
import type { AudioTarget, CallOptions, ConvertOptions, Output } from './types.ts';

/**
 * The engine capabilities {@link convertPcmNative} needs, threaded in so the routine never reaches into the
 * engine's private state: route the source container, build a per-call {@link StageOptions}, build the
 * materialize MIME options, and map a `pcm-*` codec token to its on-wire {@link SampleFormat}/{@link
 * Endianness} (the shared helpers the eager path also uses — kept single-sourced in the engine).
 */
export interface PcmConvertDeps {
  routeContainer(src: Source, direction: 'demux'): Promise<ContainerDriver>;
  stageOptions(signal: AbortSignal, o: CallOptions): StageOptions;
  mimeOpts(signal: AbortSignal, container: string): { signal: AbortSignal; mime?: string };
  pcmSampleFormat(codec: string | undefined): SampleFormat | undefined;
  pcmEndian(codec: string | undefined): Endianness | undefined;
}

/**
 * Re-serialize a raw-PCM target (WAV/AIFF/CAF) through the source container's own `transformPcm` (or the
 * `decodePcm` bridge for a WAV target from a compressed source), returning the materialized {@link Output} —
 * or `undefined` when the source container exposes neither path (the caller then falls through to the codec
 * seam). The audio-dsp shaping ops carry over verbatim; `container`/`sampleFormat`/`endian` pin the target's
 * on-wire layout. The eligibility gate (raw-PCM container + PCM/no-codec audio) is the caller's, so this is
 * reached only when the route is actually requested.
 */
export async function convertPcmNative(
  deps: PcmConvertDeps,
  src: Source,
  opts: ConvertOptions,
  audio: AudioTarget | undefined,
  target: PcmContainer,
  signal: AbortSignal,
  o: CallOptions,
): Promise<Output | undefined> {
  const container = await deps.routeContainer(src, 'demux');
  const sampleFormat = deps.pcmSampleFormat(audio?.codec);
  const endian = deps.pcmEndian(audio?.codec);
  const pcmOpts: PcmTransform = {
    ...deps.stageOptions(signal, o),
    container: target,
    ...(sampleFormat !== undefined ? { sampleFormat } : {}),
    ...(endian !== undefined ? { endian } : {}),
    ...(audio?.channels !== undefined ? { channels: audio.channels } : {}),
    ...(audio?.sampleRate !== undefined ? { sampleRate: audio.sampleRate } : {}),
    ...(audio?.gainDb !== undefined ? { gainDb: audio.gainDb } : {}),
    ...(audio?.fade !== undefined ? { fade: audio.fade } : {}),
    ...(audio?.dynamics !== undefined ? { dynamics: audio.dynamics } : {}),
    ...(audio?.biquad !== undefined ? { biquad: audio.biquad } : {}),
  };
  // Raw-PCM transform (WAV/AIFF/CAF → WAV/AIFF/CAF, ADR-022/059): the source container parses its own bytes,
  // applies sample format / channel / rate transforms, then serializes the requested raw-PCM target. A WAV
  // target may also be produced by a compressed-audio source's `decodePcm` bridge (FLAC→WAV, ADTS AAC→WAV).
  const stream = container.transformPcm
    ? await container.transformPcm(src, pcmOpts)
    : target === 'wav' && container.decodePcm
      ? await container.decodePcm(src, pcmOpts)
      : undefined;
  if (stream) return materialize(opts.sink ?? toBlob(), stream, deps.mimeOpts(signal, target));
  return undefined;
}
