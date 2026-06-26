/**
 * FLAC-authoring convert route (ADR-024) — the PCM-native path that produces a native-FLAC output
 * losslessly from canonical PCM (a FLAC source re-encodes through its own `transformPcm`; a raw-PCM source
 * WAV/AIFF/CAF is decoded to PCM and FLAC-encoded). It shares the PCM audio-dsp path, never the WebCodecs
 * chunk seam.
 *
 * Why a SEPARATE module (split out of `engine.ts`): this routine — `convertToFlac` plus its flac-only
 * helpers (`flacPcmTransformOpts`/`isFlacAuthorCodec`) — runs ONLY for a `to:'flac'` convert. Keeping it
 * here, behind the engine's lazy `import('./flac-convert-plan.ts')` rather than inline in the engine class,
 * keeps it OUT of the eager kernel closure (BUILD §2, doc 08 §7 byte budget). The FLAC encoder itself stays
 * one further lazy hop away (`../drivers/flac/flac-driver.ts`), reached only when a raw-PCM source is
 * actually authored. The engine threads in the few capabilities this needs ({@link FlacConvertDeps}) so the
 * routine stays decoupled from the engine's private state. The tiny `to:'flac'` ELIGIBILITY gate
 * (`isFlacAuthorCodec`) stays inline-eager in the engine so a non-FLAC convert never loads this chunk.
 */

import type { ContainerDriver, PcmTransform, StageOptions } from '../contracts/driver.ts';
import type { SampleFormat } from '../dsp/pcm.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { Source } from '../sources/source.ts';
import type { AudioTarget, CallOptions, ConvertOptions, Output } from './types.ts';

/**
 * The engine capabilities {@link convertToFlac} needs, threaded in so the routine never reaches into the
 * engine's private state: route the source container, build a per-call {@link StageOptions}, build the
 * materialize MIME options, and map a `pcm-*` codec token to its {@link SampleFormat} (the shared helper the
 * eager PCM-native path also uses — kept single-sourced in the engine rather than duplicated here).
 */
export interface FlacConvertDeps {
  routeContainer(src: Source, direction: 'demux'): Promise<ContainerDriver>;
  stageOptions(signal: AbortSignal, o: CallOptions): StageOptions;
  mimeOpts(signal: AbortSignal, container: string): { signal: AbortSignal; mime?: string };
  pcmSampleFormat(codec: string | undefined): SampleFormat | undefined;
}

/**
 * Build the {@link PcmTransform} for FLAC authoring from the public {@link AudioTarget}: only the audio-dsp
 * shaping ops (channel remix / sample-rate / gain / fade / dynamics / biquad) carry over — there is no
 * `container`/`sampleFormat`/`endian`, since the FLAC encoder fixes the on-wire layout from the chosen bit
 * depth. Copies only the options actually set (exactOptionalPropertyTypes).
 */
function flacPcmTransformOpts(stage: StageOptions, audio: AudioTarget | undefined): PcmTransform {
  return {
    ...stage,
    ...(audio?.channels !== undefined ? { channels: audio.channels } : {}),
    ...(audio?.sampleRate !== undefined ? { sampleRate: audio.sampleRate } : {}),
    ...(audio?.gainDb !== undefined ? { gainDb: audio.gainDb } : {}),
    ...(audio?.fade !== undefined ? { fade: audio.fade } : {}),
    ...(audio?.dynamics !== undefined ? { dynamics: audio.dynamics } : {}),
    ...(audio?.biquad !== undefined ? { biquad: audio.biquad } : {}),
  };
}

/**
 * Author a native FLAC output (ADR-024) on the PCM-native path, returning the materialized {@link Output}
 * or `undefined` when no lossless PCM route reaches FLAC (the caller then falls through to the codec
 * seam, where a FLAC target is an honest miss). Two source shapes are served:
 *   - a **FLAC source** (its container `transformPcm` re-encodes FLAC → FLAC, applying the audio-dsp
 *     transform);
 *   - a **raw-PCM source** (WAV/AIFF/CAF) whose container exposes `decodePcmAudio`: its samples are
 *     decoded once, the on-wire {@link SampleFormat} is read from the demux track codec (an explicit
 *     `pcm-*` audio codec overrides the depth), and a fresh lossless FLAC is authored at that depth.
 * The FLAC encoder + audio-dsp wiring live in the lazily-loaded FLAC driver chunk, reached here only via
 * a dynamic `import()` so the eager kernel stays codec-free (docs/architecture/08).
 */
export async function convertToFlac(
  deps: FlacConvertDeps,
  src: Source,
  opts: ConvertOptions,
  audio: AudioTarget | undefined,
  signal: AbortSignal,
  o: CallOptions,
): Promise<Output | undefined> {
  const container = await deps.routeContainer(src, 'demux');
  const stage = deps.stageOptions(signal, o);
  const pcmOpts = flacPcmTransformOpts(stage, audio);
  // A FLAC source re-encodes through its own driver (decode → transform → FLAC), exactly like the
  // WAV/AIFF/CAF same-container PCM transform.
  if (container.formats.includes('flac') && container.transformPcm) {
    const stream = await container.transformPcm(src, pcmOpts);
    return materialize(opts.sink ?? toBlob(), stream, deps.mimeOpts(signal, 'flac'));
  }
  // A raw-PCM source (WAV/AIFF/CAF) is decoded to canonical PCM and FLAC-encoded at its on-wire depth.
  if (!container.decodePcmAudio) return undefined;
  const format = await sourcePcmFormat(deps, container, src, audio, signal, o);
  if (format === undefined) return undefined;
  const decoded = await container.decodePcmAudio(src, stage);
  const { authorFlacStream } = await import('../drivers/flac/flac-driver.ts');
  return materialize(
    opts.sink ?? toBlob(),
    authorFlacStream(decoded, format, pcmOpts),
    deps.mimeOpts(signal, 'flac'),
  );
}

/**
 * The on-wire {@link SampleFormat} a raw-PCM source's samples should be FLAC-encoded at: an explicit
 * caller `pcm-*` audio codec wins (a requested depth), else the source's native format read from its
 * demux track codec (`pcm-s16`/`pcm-s24be`/… → the matching {@link SampleFormat}). `undefined` ⇒ the
 * source has no PCM track this build can map, so FLAC authoring defers to the codec seam.
 */
async function sourcePcmFormat(
  deps: FlacConvertDeps,
  container: ContainerDriver,
  src: Source,
  audio: AudioTarget | undefined,
  signal: AbortSignal,
  o: CallOptions,
): Promise<SampleFormat | undefined> {
  const requested = deps.pcmSampleFormat(audio?.codec);
  if (requested !== undefined) return requested;
  const demuxer = await container.demux(src, deps.stageOptions(signal, o));
  try {
    const track = demuxer.tracks.find((t) => t.mediaType === 'audio');
    return track ? deps.pcmSampleFormat(track.codec) : undefined;
  } finally {
    await demuxer.close();
  }
}
