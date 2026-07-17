/**
 * Raw-PCM-container convert route (ADR-022/059) — the PCM-native path that re-serializes a raw-PCM target
 * (WAV/AIFF/CAF) straight through the TS audio-dsp `transformPcm` (channel up/down-mix, sample format,
 * sample-rate, gain/fade/dynamics/biquad), never the WebCodecs chunk seam. Identity WAV copies and
 * identity AIFF→WAV byte-order rewrites can author the target buffer before the sample-domain path. A WAV
 * target may also be produced by a compressed-audio source's `decodePcm` bridge (FLAC→WAV, ADR-024; ADTS
 * AAC→WAV, ADR-050).
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
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import {
  type WavPcmCopyPlan,
  planWavPcmCopy,
  rewriteWavPcmCopy,
  writeWavHeader,
} from '../drivers/wav/pcm.ts';
import { streamWavPcmCopy } from '../drivers/wav/wav-copy-stream.ts';
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { Sink } from '../sinks/sink.ts';
import { SOURCE_CACHE_KEY, type Source } from '../sources/source.ts';
import { isPcmContainer } from './codec-routing.ts';
import type { AudioTarget, CallOptions, Container, ConvertOptions, Output } from './types.ts';

const PCM_REWRITE_SOURCE_CACHE_TTL_MS = 60_000;
const PCM_REWRITE_SOURCE_CACHE_MAX_ENTRIES = 32;
const PCM_REWRITE_SOURCE_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const PCM_REWRITE_SOURCE_CACHE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

interface PcmRewriteSourceCacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const pcmRewriteSourceCache = new Map<string, PcmRewriteSourceCacheEntry>();
let pcmRewriteSourceCacheBytes = 0;

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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function canRewritePcmBytes(o: PcmTransform): boolean {
  return (
    o.container === 'wav' &&
    o.gainDb === undefined &&
    o.fade === undefined &&
    o.dynamics === undefined &&
    o.biquad === undefined &&
    o.timeBounds === undefined &&
    (o.endian === undefined || o.endian === 'le')
  );
}

function wavHint(src: Source): boolean {
  const mime = src.mimeHint?.toLowerCase();
  if (
    mime !== undefined &&
    (mime === 'audio/wav' || mime === 'audio/wave' || mime === 'audio/x-wav')
  ) {
    return true;
  }
  const filename = src.filename?.toLowerCase();
  return filename !== undefined && (filename.endsWith('.wav') || filename.endsWith('.wave'));
}

function aiffHint(src: Source): boolean {
  const mime = src.mimeHint?.toLowerCase();
  if (
    mime !== undefined &&
    (mime === 'audio/aiff' ||
      mime === 'audio/x-aiff' ||
      mime === 'audio/aifc' ||
      mime === 'audio/x-aifc')
  ) {
    return true;
  }
  const filename = src.filename?.toLowerCase();
  return (
    filename !== undefined &&
    (filename.endsWith('.aiff') || filename.endsWith('.aif') || filename.endsWith('.aifc'))
  );
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function blobParts(type: string | undefined): BlobPropertyBag | undefined {
  return type ? { type } : undefined;
}

function outputBytes(
  sink: Sink,
  bytes: Uint8Array<ArrayBuffer>,
  opts: { readonly signal?: AbortSignal; readonly mime?: string },
): Promise<Output> | Output {
  switch (sink.kind) {
    case 'blob':
      return new Blob([bytes], blobParts(opts.mime));
    case 'file':
      return new File([bytes], sink.name, blobParts(opts.mime));
    case 'stream':
      return oneChunk(bytes);
    case 'opfs':
    case 'opfs-target':
    case 'element':
    case 'stream-target':
      return materialize(sink, oneChunk(bytes), opts);
  }
}

function blobPayloadPart(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return payload.buffer instanceof ArrayBuffer
    ? (payload as Uint8Array<ArrayBuffer>)
    : (payload.slice() as Uint8Array<ArrayBuffer>);
}

/** WAV-specific multipart output: Blob/File snapshot parts; streaming sinks pull header then payload. */
function outputWavPcmCopy(
  sink: Sink,
  plan: WavPcmCopyPlan,
  opts: { readonly signal?: AbortSignal; readonly mime?: string },
): Promise<Output> | Output {
  switch (sink.kind) {
    case 'blob':
      return new Blob([plan.header, blobPayloadPart(plan.payload)], blobParts(opts.mime));
    case 'file':
      return new File(
        [plan.header, blobPayloadPart(plan.payload)],
        sink.name,
        blobParts(opts.mime),
      );
    case 'stream':
      return streamWavPcmCopy(plan, opts.signal);
    case 'opfs':
    case 'opfs-target':
    case 'element':
    case 'stream-target':
      return materialize(sink, streamWavPcmCopy(plan, opts.signal), opts);
  }
}

function pcmRewriteSourceCacheKey(src: Source): string | undefined {
  const key = src[SOURCE_CACHE_KEY];
  const size = src.size;
  if (key === undefined || size === undefined || size > PCM_REWRITE_SOURCE_CACHE_MAX_ENTRY_BYTES) {
    return undefined;
  }
  return `${key}#${size}`;
}

function deletePcmRewriteSourceCacheEntry(key: string): void {
  const entry = pcmRewriteSourceCache.get(key);
  if (entry === undefined) return;
  pcmRewriteSourceCache.delete(key);
  pcmRewriteSourceCacheBytes = Math.max(0, pcmRewriteSourceCacheBytes - entry.bytes.byteLength);
}

function deleteExpiredPcmRewriteSourceCacheEntries(now: number): void {
  for (const [key, entry] of pcmRewriteSourceCache) {
    if (entry.expiresAtMs <= now) deletePcmRewriteSourceCacheEntry(key);
  }
}

function cachedPcmRewriteSourceBytes(src: Source): Uint8Array | undefined {
  const key = pcmRewriteSourceCacheKey(src);
  if (key === undefined) return undefined;
  const entry = pcmRewriteSourceCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    deletePcmRewriteSourceCacheEntry(key);
    return undefined;
  }
  pcmRewriteSourceCache.delete(key);
  pcmRewriteSourceCache.set(key, entry);
  return entry.bytes;
}

function rememberPcmRewriteSourceBytes(src: Source, bytes: Uint8Array): void {
  const key = pcmRewriteSourceCacheKey(src);
  if (key === undefined || bytes.byteLength !== src.size) return;
  const now = Date.now();
  deleteExpiredPcmRewriteSourceCacheEntries(now);
  deletePcmRewriteSourceCacheEntry(key);
  while (
    pcmRewriteSourceCache.size >= PCM_REWRITE_SOURCE_CACHE_MAX_ENTRIES ||
    pcmRewriteSourceCacheBytes + bytes.byteLength > PCM_REWRITE_SOURCE_CACHE_MAX_TOTAL_BYTES
  ) {
    const oldestKey = pcmRewriteSourceCache.keys().next().value;
    if (oldestKey === undefined) break;
    deletePcmRewriteSourceCacheEntry(oldestKey);
  }
  if (pcmRewriteSourceCacheBytes + bytes.byteLength > PCM_REWRITE_SOURCE_CACHE_MAX_TOTAL_BYTES)
    return;
  pcmRewriteSourceCache.set(key, {
    bytes,
    expiresAtMs: now + PCM_REWRITE_SOURCE_CACHE_TTL_MS,
  });
  pcmRewriteSourceCacheBytes += bytes.byteLength;
}

interface PcmRewriteSourceRead {
  readonly bytes: Uint8Array;
  readonly cached: boolean;
}

async function readPcmRewriteSourceBytes(
  src: Source,
  signal?: AbortSignal,
): Promise<PcmRewriteSourceRead> {
  const cached = cachedPcmRewriteSourceBytes(src);
  if (cached !== undefined) return { bytes: cached, cached: true };
  const size = src.size;
  if (src.range === undefined || size === undefined) {
    return { bytes: new Uint8Array(0), cached: false };
  }
  const bytes = await src.range(0, size);
  throwIfAborted(signal);
  return { bytes, cached: false };
}

type PcmCopySourceKind = 'wav' | 'aiff';

function hintedPcmCopySourceKind(src: Source): PcmCopySourceKind | undefined {
  if (wavHint(src)) return 'wav';
  if (aiffHint(src)) return 'aiff';
  return undefined;
}

async function tryDirectWavPcmCopy(
  src: Source,
  o: PcmTransform,
  sourceKind = hintedPcmCopySourceKind(src),
): Promise<WavPcmCopyPlan | Uint8Array<ArrayBuffer> | undefined> {
  if (
    sourceKind === undefined ||
    !canRewritePcmBytes(o) ||
    src.range === undefined ||
    src.size === undefined
  ) {
    return undefined;
  }
  throwIfAborted(o.signal);
  const read = await readPcmRewriteSourceBytes(src, o.signal);
  throwIfAborted(o.signal);
  let copied: WavPcmCopyPlan | Uint8Array<ArrayBuffer> | undefined;
  if (sourceKind === 'wav') {
    copied = planWavPcmCopy(read.bytes, o.sampleFormat, o.endian, o.channels, o.sampleRate);
  } else {
    const { rewriteAiffPcmToWav } = await import('../drivers/aiff/aiff-wav-rewrite.ts');
    copied = rewriteAiffPcmToWav(read.bytes, o.sampleFormat, o.endian, o.channels, o.sampleRate);
  }
  throwIfAborted(o.signal);
  if (copied !== undefined && !read.cached) rememberPcmRewriteSourceBytes(src, read.bytes);
  return copied;
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
  const pcmOpts = pcmTransformOptions(deps, audio, target, signal, o);
  const direct = await tryDirectWavPcmCopy(src, pcmOpts);
  if (direct !== undefined) {
    return direct instanceof Uint8Array
      ? outputBytes(opts.sink ?? toBlob(), direct, deps.mimeOpts(signal, target))
      : outputWavPcmCopy(opts.sink ?? toBlob(), direct, deps.mimeOpts(signal, target));
  }
  const container = await deps.routeContainer(src, 'demux');
  const routedCopyKind: PcmCopySourceKind | undefined = container.formats.includes('wav')
    ? 'wav'
    : container.formats.includes('aiff')
      ? 'aiff'
      : undefined;
  const routedDirect = await tryDirectWavPcmCopy(src, pcmOpts, routedCopyKind);
  if (routedDirect !== undefined) {
    return routedDirect instanceof Uint8Array
      ? outputBytes(opts.sink ?? toBlob(), routedDirect, deps.mimeOpts(signal, target))
      : outputWavPcmCopy(opts.sink ?? toBlob(), routedDirect, deps.mimeOpts(signal, target));
  }
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
    throw new CapabilityError('target is not a raw PCM container', {
      op: { kind: 'route', id: 'convert' },
      tried: [target],
    });
  }
  const audio = opts.audio;
  if (audio === false || !isPcmCodec(audio?.codec)) {
    throw new CapabilityError('PCM container transform requires a PCM audio target', {
      op: { kind: 'route', id: 'convert' },
      tried: [target],
    });
  }
  const activeSignal = signal ?? new AbortController().signal;
  if (src instanceof Uint8Array) {
    const pcmOpts = pcmTransformOptions(deps, audio, target, activeSignal, o);
    if (sourceContainer === 'wav' && canRewritePcmBytes(pcmOpts)) {
      const copied = rewriteWavPcmCopy(
        src,
        pcmOpts.sampleFormat,
        pcmOpts.endian,
        pcmOpts.channels,
        pcmOpts.sampleRate,
      );
      if (copied !== undefined) {
        if (opts.sink === undefined) return copied;
        return outputBytes(opts.sink, copied, deps.mimeOpts(activeSignal, target));
      }
    }
    if (sourceContainer === 'aiff' && canRewritePcmBytes(pcmOpts)) {
      const { rewriteAiffPcmToWav } = await import('../drivers/aiff/aiff-wav-rewrite.ts');
      const copied = rewriteAiffPcmToWav(
        src,
        pcmOpts.sampleFormat,
        pcmOpts.endian,
        pcmOpts.channels,
        pcmOpts.sampleRate,
      );
      if (copied !== undefined) {
        if (opts.sink === undefined) return copied;
        return outputBytes(opts.sink, copied, deps.mimeOpts(activeSignal, target));
      }
    }
    throw new CapabilityError('PCM byte rewrite path not registered', {
      op: { kind: 'route', id: 'convert' },
      tried: [sourceContainer, target],
    });
  }
  const container = await routeContainerToken(sourceContainer, 'demux');
  const pcmOpts = pcmTransformOptions(deps, audio, target, activeSignal, o);
  const stream = container.transformPcm
    ? await container.transformPcm(src, pcmOpts)
    : target === 'wav' && container.decodePcm
      ? await container.decodePcm(src, pcmOpts)
      : undefined;
  if (stream === undefined) {
    throw new CapabilityError('container PCM transform path not registered', {
      op: { kind: 'route', id: 'convert' },
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
    throw new CapabilityError('WAV packet copy requires little-endian PCM packets', {
      op: { kind: 'route', id: 'mux' },
      tried: [input.codec],
    });
  }
  if (!Number.isSafeInteger(input.sampleRate) || input.sampleRate <= 0) {
    throw new CapabilityError('WAV packet copy requires a positive sample rate', {
      op: { kind: 'route', id: 'mux' },
      tried: [input.codec],
    });
  }
  if (!Number.isSafeInteger(input.channels) || input.channels <= 0) {
    throw new CapabilityError('WAV packet copy requires a positive channel count', {
      op: { kind: 'route', id: 'mux' },
      tried: [input.codec],
    });
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
