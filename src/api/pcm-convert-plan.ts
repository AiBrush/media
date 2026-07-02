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
import { CapabilityError } from '../contracts/errors.ts';
import { rewriteWavPcmCopy, writeWavHeader } from '../drivers/wav/pcm.ts';
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { Sink } from '../sinks/sink.ts';
import type { Source } from '../sources/source.ts';
import { isPcmContainer } from './codec-routing.ts';
import type { AudioTarget, CallOptions, Container, ConvertOptions, Output } from './types.ts';

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

export interface WavPcmPacketCopyInput {
  readonly payload: Uint8Array;
  readonly sourceBytes?: Uint8Array;
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
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
  const pcmOpts = pcmTransformOptions(deps, audio, target, signal, o);
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

function isPcmCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'pcm' || codec.startsWith('pcm-');
}

function pcmTransformOptions(
  deps: PcmConvertDeps,
  audio: AudioTarget | undefined,
  target: PcmContainer,
  signal: AbortSignal,
  o: CallOptions,
): PcmTransform {
  const sampleFormat = deps.pcmSampleFormat(audio?.codec);
  const endian = deps.pcmEndian(audio?.codec);
  return {
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
}

export async function pcm(
  deps: PcmConvertDeps,
  routeContainerToken: (container: string, direction: 'demux') => Promise<ContainerDriver>,
  src: Source | Uint8Array,
  sourceContainer: string,
  opts: { readonly to: Container; readonly audio?: AudioTarget | false; readonly sink?: Sink },
  signal: AbortSignal | undefined,
  o: CallOptions,
): Promise<Output | Uint8Array> {
  const target = opts.to;
  if (!isPcmContainer(target)) {
    throw new CapabilityError('capability-miss', 'target is not a raw PCM container', {
      op: 'convert',
      tried: [target],
    });
  }
  const audio = opts.audio;
  if (audio === false || !isPcmCodec(audio?.codec)) {
    throw new CapabilityError(
      'capability-miss',
      'PCM container transform requires a PCM audio target',
      {
        op: 'convert',
        tried: [target],
      },
    );
  }
  if (src instanceof Uint8Array) {
    if (sourceContainer === 'wav' && target === 'wav' && opts.sink?.kind !== 'stream-target') {
      const copied = rewriteWavPcmCopy(
        src,
        deps.pcmSampleFormat(audio?.codec),
        deps.pcmEndian(audio?.codec),
      );
      if (copied !== undefined) return copied;
    }
    throw new CapabilityError('capability-miss', 'PCM byte rewrite path not registered', {
      op: 'convert',
      tried: [sourceContainer, target],
    });
  }
  const container = await routeContainerToken(sourceContainer, 'demux');
  const activeSignal = signal ?? new AbortController().signal;
  const pcmOpts = pcmTransformOptions(deps, audio, target, activeSignal, o);
  const stream = container.transformPcm
    ? await container.transformPcm(src, pcmOpts)
    : target === 'wav' && container.decodePcm
      ? await container.decodePcm(src, pcmOpts)
      : undefined;
  if (stream === undefined) {
    throw new CapabilityError('capability-miss', 'container PCM transform path not registered', {
      op: 'convert',
      tried: [container.id, target],
    });
  }
  return materialize(opts.sink ?? toBlob(), stream, deps.mimeOpts(activeSignal, target));
}

export function wavPcmPacketCopy(
  deps: Pick<PcmConvertDeps, 'pcmSampleFormat' | 'pcmEndian'>,
  input: WavPcmPacketCopyInput,
): Uint8Array<ArrayBuffer> {
  const format = deps.pcmSampleFormat(input.codec);
  const endian = deps.pcmEndian(input.codec) ?? 'le';
  if (format === undefined || endian !== 'le') {
    throw new CapabilityError(
      'capability-miss',
      'WAV packet copy requires little-endian PCM packets',
      {
        op: 'mux',
        tried: [input.codec],
      },
    );
  }
  if (!Number.isSafeInteger(input.sampleRate) || input.sampleRate <= 0) {
    throw new CapabilityError(
      'capability-miss',
      'WAV packet copy requires a positive sample rate',
      {
        op: 'mux',
        tried: [input.codec],
      },
    );
  }
  if (!Number.isSafeInteger(input.channels) || input.channels <= 0) {
    throw new CapabilityError(
      'capability-miss',
      'WAV packet copy requires a positive channel count',
      {
        op: 'mux',
        tried: [input.codec],
      },
    );
  }
  const sourceBytes = input.sourceBytes;
  if (sourceBytes !== undefined && input.payload.buffer === sourceBytes.buffer) {
    const payloadOffset = input.payload.byteOffset - sourceBytes.byteOffset;
    if (payloadOffset === 44 && sourceBytes.byteLength === 44 + input.payload.byteLength) {
      const out = sourceBytes.slice() as Uint8Array<ArrayBuffer>;
      writeWavHeader(out, input.payload.byteLength, input.channels, input.sampleRate, format);
      return out;
    }
  }
  const out = new Uint8Array(44 + input.payload.byteLength);
  writeWavHeader(out, input.payload.byteLength, input.channels, input.sampleRate, format);
  out.set(input.payload, 44);
  return out;
}
