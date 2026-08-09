/**
 * The ADTS (raw AAC) container driver — hand-written TS. ADTS wraps each AAC frame in a 7- or 9-byte
 * header beginning with a 12-bit `0xFFF` syncword; the first header carries the audio object type,
 * sampling-frequency index, and channel configuration. Duration comes from walking the frames (each is
 * `frame_length` bytes and 1024 samples per raw block). Probe and framing are pure TS; AAC packet decode
 * is capability-routed through native WebCodecs first and the vendored `wasm-aac` tail second, except for
 * Firefox/force-software PCM extraction where the wasm tail owns the route up front. The
 * `decodePcm` bridge exposes ADTS → WAV extraction without pretending WAV is an `EncodedChunk` muxer.
 */

import { loadAacCore } from '../../codecs/wasm-aac/wasm-aac-driver.ts';
import { awaitAudioCodecQueueDrain } from '../../codecs/webcodecs-audio.ts';
import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DecryptParams,
  type Demuxer,
  type DriverModule,
  type MuxOptions,
  type Packet,
  type PacketInfoTable,
  type PacketMetadata,
  type PcmTransform,
  type Registry,
  type StageOptions,
  type StreamCopyOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import type { PcmAudio } from '../../dsp/index.ts';
import { audioDataToPcm } from '../../filters/audio-dsp.ts';
import { registerNativePacketSource } from '../../internal/packet-provenance.ts';
import { fromURL } from '../../sources/source.ts';
import { matchesAdts } from '../audio-container-sniff.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { writeWav } from '../wav/pcm.ts';
import {
  type AdtsWalkStats,
  adtsHeadOffset,
  probeAdtsStream,
  walkAdtsBuffer,
} from './adts-frames.ts';
import { AdtsMuxer } from './adts-mux.ts';

const NATIVE_AAC_TRIED = ['webcodecs-audio'] as const;
const WASM_AAC_TRIED = ['wasm-aac'] as const;
const PCM_OUTPUT_FORMAT = 's16' as const;
const AAC_PCM_NATIVE_FIRST_PLAN = ['webcodecs-audio', 'wasm-aac'] as const;
const AAC_PCM_WASM_ONLY_PLAN = ['wasm-aac'] as const;
const ADTS_TRIM_END_SLACK_SEC = 1;
const ADTS_TRIM_URL_CACHE_TTL_MS = 60_000;
const ADTS_TRIM_URL_CACHE_MAX_ENTRIES = 16;
const ADTS_TRIM_URL_CACHE_MAX_ENTRY_BYTES = 1 * 1024 * 1024;

export type AdtsAacPcmDecodeRung = (typeof AAC_PCM_NATIVE_FIRST_PLAN)[number];

export interface AdtsTrimRange {
  readonly startSec: number;
  readonly endSec: number;
}

export interface AdtsTrimFromUrlOptions extends AdtsTrimRange {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface CachedAdtsTrimBytes {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const adtsTrimUrlByteCache = new Map<string, CachedAdtsTrimBytes>();
let adtsPcmDirectModule: typeof import('./adts-pcm-direct.ts') | undefined;
let adtsPcmDirectModulePromise: Promise<typeof import('./adts-pcm-direct.ts')> | undefined;

async function loadAdtsPcmDirectModule(): Promise<typeof import('./adts-pcm-direct.ts')> {
  if (adtsPcmDirectModule !== undefined) return adtsPcmDirectModule;
  adtsPcmDirectModulePromise ??= import('./adts-pcm-direct.ts').then((module) => {
    adtsPcmDirectModule = module;
    return module;
  });
  return adtsPcmDirectModulePromise;
}

// channel_configuration → channel count (0 = AOT-specific; 7 = 7.1 → 8 channels).
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

/**
 * One enumerated ADTS frame, as the pure framer sees it. `size` is the FULL frame length (header + CRC +
 * payload) — the same unit ffprobe reports for an ADTS packet, so the oracle can assert byte-exactness.
 * `headerBytes` (7 or 9) is the prefix to strip when emitting a RAW AAC access unit to WebCodecs:
 * `data = frame[offset + headerBytes : offset + size]`. `ptsUs`/`durationUs` come from cumulative samples.
 */
export interface AdtsPacket {
  /** Byte offset of the frame's first header byte (the 0xFF sync) within the input buffer. */
  readonly offset: number;
  /** Full frame length in bytes (header + optional 2-byte CRC + AAC payload) — matches ffprobe `size`. */
  readonly size: number;
  /** ADTS header length: 7 bytes, or 9 when CRC is present (protection_absent == 0). */
  readonly headerBytes: number;
  /** Presentation timestamp in microseconds (cumulative samples ÷ sampleRate). */
  readonly ptsUs: number;
  /** Frame duration in microseconds (rawBlocks · 1024 ÷ sampleRate). */
  readonly durationUs: number;
  /** Decoded PCM samples per channel carried by this ADTS frame. */
  readonly samples: number;
}

/**
 * PURE framer (Node-testable, no WebCodecs): walk EVERY ADTS frame across the whole buffer and return its
 * byte geometry + timing. This is the load-bearing logic the oracle validates; `packets()` only maps it to
 * `EncodedAudioChunk`s. Throws {@link InputError} when the head is not ADTS (so truncated/garbage rejects),
 * and {@link MediaError} on a reserved sampling-frequency index. The walk resyncs across mid-stream junk
 * (double-syncword confirmed) and ends cleanly at trailing tags or a truncated final frame — packets are
 * exactly the decodable frames, never estimated (see {@link walkAdtsBuffer}).
 */
export function enumerateAdtsFrames(bytes: Uint8Array): readonly AdtsPacket[] {
  const packets: AdtsPacket[] = [];
  walkAdtsBuffer(bytes, (frame) => packets.push(frame));
  return packets;
}

/**
 * Synthesize the 2-byte AudioSpecificConfig (Aac `config.description`) from an ADTS header's fields. Some
 * browsers' AAC decoders need the explicit ASC even though ADTS is self-describing; supplying it makes the
 * decode robust cross-browser. Layout: 5 bits AOT, 4 bits samplingFrequencyIndex, 4 bits channelConfig.
 */
function audioSpecificConfig(aot: number, freqIndex: number, channelConfig: number): Uint8Array {
  return new Uint8Array([
    (aot << 3) | (freqIndex >> 1),
    ((freqIndex & 1) << 7) | (channelConfig << 3),
  ]);
}

export interface AdtsLayout {
  readonly info: AdtsInfo;
  readonly frames: readonly AdtsPacket[];
  readonly asc: Uint8Array;
}

export interface AdtsInfo {
  codec: string; // RFC 6381, e.g. mp4a.40.2 (AAC-LC) — matches the mp4 driver
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number;
}

/** The stream-level {@link AdtsInfo} facts derived from an exact walk's totals. */
function infoFromWalkStats(stats: AdtsWalkStats): AdtsInfo {
  const { aot, sampleRate, channelConfig } = stats.firstHeader;
  return {
    codec: `mp4a.40.${aot}`,
    sampleRate,
    channels: CHANNELS[channelConfig] ?? 0,
    durationSec: stats.durationSec,
    frames: stats.frames,
  };
}

/**
 * Parse ADTS headers into the audio layout + EXACT duration (every frame header is visited; trailing
 * tags/junk and a truncated final frame contribute zero seconds — see {@link walkAdtsBuffer}).
 *
 * @param _totalSize Deprecated and ignored: the walk is exact, never a byte-density extrapolation.
 *   Accepted so existing `parseAdts(bytes, bytes.byteLength)` call sites stay source-compatible.
 */
export function parseAdts(bytes: Uint8Array, _totalSize?: number): AdtsInfo {
  return infoFromWalkStats(walkAdtsBuffer(bytes));
}

/** Read the ENTIRE source — `packets()` must enumerate every frame, not just the probed head. */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}

function errName(e: unknown): string {
  if (e instanceof Error) return e.name;
  return 'Error';
}

function decodeCapabilityMiss(message: string, tried: readonly string[]): CapabilityError {
  return new CapabilityError(message, {
    op: { kind: 'route', id: 'decode' },
    tried,
    suggestion: 'use a browser with AAC AudioDecoder support or the vendored wasm-aac tail',
  });
}

export function adtsAacPcmDecodePlan(
  firefoxRuntime: boolean,
  determinism?: StageOptions['determinism'],
): readonly AdtsAacPcmDecodeRung[] {
  if (firefoxRuntime || determinism === 'force-software') return AAC_PCM_WASM_ONLY_PLAN;
  return AAC_PCM_NATIVE_FIRST_PLAN;
}

/** Reject the PCE-carried `channel_configuration 0` (no inline channel map to decode with). */
function assertKnownChannels(channels: number): void {
  if (channels <= 0) {
    throw new MediaError('demux-error', 'ADTS: unsupported channel configuration 0');
  }
}

function readLayout(bytes: Uint8Array): AdtsLayout {
  const frames: AdtsPacket[] = [];
  const stats = walkAdtsBuffer(bytes, (frame) => frames.push(frame));
  const info = infoFromWalkStats(stats);
  assertKnownChannels(info.channels);
  const { aot, freqIndex, channelConfig } = stats.firstHeader;
  return {
    info,
    frames,
    asc: audioSpecificConfig(aot, freqIndex, channelConfig),
  };
}

/** A decrypt oracle is intentionally stricter than resilient demux: no arbitrary pre-frame resync. */
function assertDecryptedAdtsSegment(bytes: Uint8Array): void {
  const expectedFirstOffset = adtsHeadOffset(bytes);
  let actualFirstOffset: number | undefined;
  const stats = walkAdtsBuffer(bytes, (frame) => {
    actualFirstOffset ??= frame.offset;
  });
  if (
    expectedFirstOffset === undefined ||
    actualFirstOffset !== expectedFirstOffset ||
    stats.truncated
  ) {
    throw new InputError(
      'HLS AES-128 plaintext is not a complete ADTS segment with a valid leading frame or ID3 prefix',
    );
  }
}

export function adtsPacketInfoFromBytes(bytes: Uint8Array): PacketInfoTable {
  const layout = readLayout(bytes);
  return {
    tracks: [trackInfoFromLayout(layout)],
    packets: layout.frames.map((frame) => ({
      trackIndex: 0,
      offset: frame.offset,
      size: frame.size,
      ptsUs: frame.ptsUs,
      dtsUs: frame.ptsUs,
      durationUs: frame.durationUs,
      keyframe: true,
    })),
  };
}

function adtsPacketMetadataFromFrames(frames: readonly AdtsPacket[]): readonly PacketMetadata[] {
  return frames.map((frame) => ({
    trackId: 0,
    sizeBytes: frame.size,
    ptsUs: frame.ptsUs,
    dtsUs: frame.ptsUs,
    durationUs: frame.durationUs,
    keyframe: true,
  }));
}

function trackInfoFromLayout(layout: AdtsLayout): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: layout.info.codec,
    durationSec: layout.info.durationSec,
    config: {
      codec: layout.info.codec,
      sampleRate: layout.info.sampleRate,
      numberOfChannels: layout.info.channels,
      description: layout.asc,
    },
  };
}

/** Convert interleaved f32 decoder output into the engine's canonical planar Float64 PCM. */
export function pcmFromInterleavedF32(
  interleaved: Float32Array,
  channels: number,
  sampleRate: number,
): PcmAudio {
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new MediaError('decode-error', `aac: invalid decoded channel count ${channels}`);
  }
  if (interleaved.length % channels !== 0) {
    throw new MediaError(
      'decode-error',
      `aac: decoded interleaved length ${interleaved.length} is not divisible by ${channels}`,
    );
  }
  const frames = interleaved.length / channels;
  const planar = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const plane = planar[channel];
      if (plane === undefined)
        throw new MediaError('decode-error', `aac: missing plane ${channel}`);
      plane[frame] = interleaved[frame * channels + channel] ?? 0;
    }
  }
  return { sampleRate, channels, frames, planar };
}

/** Concatenate sequential decoded PCM blocks, rejecting geometry drift instead of silently corrupting WAV. */
export function concatPcmChunks(
  chunks: readonly PcmAudio[],
  sampleRate: number,
  channels: number,
): PcmAudio {
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new MediaError('decode-error', `aac: invalid channel count ${channels}`);
  }
  let frames = 0;
  for (const chunk of chunks) {
    if (chunk.sampleRate !== sampleRate || chunk.channels !== channels) {
      throw new MediaError(
        'decode-error',
        `aac: decoded geometry changed (${chunk.channels}ch/${chunk.sampleRate}Hz ` +
          `inside ${channels}ch/${sampleRate}Hz stream)`,
      );
    }
    frames += chunk.frames;
  }
  const planar = Array.from({ length: channels }, () => new Float64Array(frames));
  let offset = 0;
  for (const chunk of chunks) {
    for (let channel = 0; channel < channels; channel++) {
      const dst = planar[channel];
      const src = chunk.planar[channel];
      if (dst === undefined || src === undefined) {
        throw new MediaError('decode-error', `aac: missing decoded plane ${channel}`);
      }
      dst.set(src, offset);
    }
    offset += chunk.frames;
  }
  return { sampleRate, channels, frames, planar };
}

function mayUseAdtsDirectWasmS16Wav(
  byteLength: number,
  o: PcmTransform | undefined,
  wasmOnlyRuntime: boolean,
): boolean {
  if (!Number.isFinite(byteLength) || byteLength < 0) return false;
  return wasmOnlyRuntime || o?.determinism === 'force-software';
}

function payload(bytes: Uint8Array, frame: AdtsPacket): Uint8Array {
  return bytes.subarray(frame.offset + frame.headerBytes, frame.offset + frame.size);
}

function assertAdtsStreamCopyTarget(container: string | undefined): void {
  if (container === undefined || container === 'adts' || container === 'aac') return;
  throw new CapabilityError(`ADTS stream-copy cannot write '${container}'`, {
    op: { kind: 'route', id: 'streamCopy', facts: { container } },
    tried: ['adts'],
  });
}

function assertAdtsTrimRange(
  trim: StreamCopyOptions['trim'] | undefined,
  durationSec: number,
): void {
  if (trim === undefined) return;
  if (!Number.isFinite(trim.startSec) || !Number.isFinite(trim.endSec)) {
    throw new InputError('bad trim');
  }
  if (trim.startSec < 0) {
    throw new InputError('start<0');
  }
  if (trim.endSec <= trim.startSec) {
    throw new InputError('empty trim');
  }
  if (durationSec > 0) {
    if (trim.startSec >= durationSec) {
      throw new InputError('start>=duration');
    }
    if (trim.endSec > durationSec + ADTS_TRIM_END_SLACK_SEC) {
      throw new InputError('end>duration');
    }
  }
}

function selectAdtsFrames(
  frames: readonly AdtsPacket[],
  trim: StreamCopyOptions['trim'] | undefined,
): readonly AdtsPacket[] {
  if (trim === undefined) return frames;
  const startUs = Math.round(trim.startSec * 1_000_000);
  const endUs = Math.round(trim.endSec * 1_000_000);
  return frames.filter((frame) => frame.ptsUs + frame.durationUs > startUs && frame.ptsUs < endUs);
}

function adtsFramesDurationSec(frames: readonly AdtsPacket[]): number {
  const last = frames[frames.length - 1];
  return last === undefined ? 0 : (last.ptsUs + last.durationUs) / 1_000_000;
}

function writeAdtsPacketCopy(
  bytes: Uint8Array,
  trim: StreamCopyOptions['trim'] | undefined,
): Uint8Array {
  const frames = enumerateAdtsFrames(bytes);
  assertAdtsTrimRange(trim, adtsFramesDurationSec(frames));
  const selected = selectAdtsFrames(frames, trim);
  if (selected.length === 0) {
    throw new InputError('ADTS trim selected no audio frames');
  }
  let total = 0;
  for (const frame of selected) total += frame.size;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of selected) {
    const packet = bytes.subarray(frame.offset, frame.offset + frame.size);
    out.set(packet, offset);
    offset += packet.byteLength;
  }
  return out;
}

function adtsTrimUrlCacheKey(url: string | URL, opts: AdtsTrimFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function getCachedAdtsTrimBytes(key: string, nowMs: number): Uint8Array | undefined {
  const cached = adtsTrimUrlByteCache.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAtMs <= nowMs) {
    adtsTrimUrlByteCache.delete(key);
    return undefined;
  }
  adtsTrimUrlByteCache.delete(key);
  adtsTrimUrlByteCache.set(key, cached);
  return cached.bytes;
}

function rememberAdtsTrimBytes(key: string, bytes: Uint8Array, nowMs: number): void {
  if (bytes.byteLength > ADTS_TRIM_URL_CACHE_MAX_ENTRY_BYTES) return;
  adtsTrimUrlByteCache.set(key, {
    bytes,
    expiresAtMs: nowMs + ADTS_TRIM_URL_CACHE_TTL_MS,
  });
  while (adtsTrimUrlByteCache.size > ADTS_TRIM_URL_CACHE_MAX_ENTRIES) {
    const oldest = adtsTrimUrlByteCache.keys().next().value;
    if (oldest === undefined) break;
    adtsTrimUrlByteCache.delete(oldest);
  }
}

export function adtsTrimFromBytes(bytes: Uint8Array, trim: AdtsTrimRange): Uint8Array {
  return writeAdtsPacketCopy(bytes, trim);
}

export async function adtsTrimFromUrl(
  url: string | URL,
  opts: AdtsTrimFromUrlOptions,
): Promise<Uint8Array> {
  throwIfAborted(opts.signal);
  const key = adtsTrimUrlCacheKey(url, opts);
  const nowMs = Date.now();
  const cached = getCachedAdtsTrimBytes(key, nowMs);
  if (cached !== undefined) {
    return writeAdtsPacketCopy(cached, { startSec: opts.startSec, endSec: opts.endSec });
  }
  const source = fromURL(url, {
    rangeRequests: true,
    ...(opts.mime !== undefined ? { mime: opts.mime } : {}),
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  const bytes = await readAll(source);
  throwIfAborted(opts.signal);
  rememberAdtsTrimBytes(key, bytes, Date.now());
  return writeAdtsPacketCopy(bytes, { startSec: opts.startSec, endSec: opts.endSec });
}

function nativeDecoderUnavailable(reason: string): CapabilityError {
  return decodeCapabilityMiss(`webcodecs-audio cannot decode ADTS AAC to PCM (${reason})`, [
    ...NATIVE_AAC_TRIED,
  ]);
}

function webCodecsAudioAvailable(): boolean {
  return (
    typeof AudioDecoder !== 'undefined' &&
    typeof EncodedAudioChunk !== 'undefined' &&
    typeof AudioData !== 'undefined'
  );
}

/* v8 ignore start -- live ADTS AAC decode uses WebCodecs AudioDecoder or the wasm-aac core; browser harness / clean-process codec tests validate it. */

async function decodeNativeAacToPcm(
  bytes: Uint8Array,
  layout: AdtsLayout,
  signal: AbortSignal | undefined,
): Promise<PcmAudio> {
  if (!webCodecsAudioAvailable()) {
    throw nativeDecoderUnavailable(
      'WebCodecs AudioDecoder/EncodedAudioChunk/AudioData is unavailable',
    );
  }
  const config: AudioDecoderConfig = {
    codec: layout.info.codec,
    sampleRate: layout.info.sampleRate,
    numberOfChannels: layout.info.channels,
    description: layout.asc,
  };
  let support: AudioDecoderSupport;
  try {
    support = await AudioDecoder.isConfigSupported(config);
  } catch (e) {
    throw nativeDecoderUnavailable(`${errName(e)}: ${errMessage(e)}`);
  }
  if (!support.supported) throw nativeDecoderUnavailable(`unsupported config ${layout.info.codec}`);

  const chunks: PcmAudio[] = [];
  let callbackError: MediaError | undefined;
  const decoder = new AudioDecoder({
    output(data): void {
      try {
        chunks.push(audioDataToPcm(data));
      } catch (e) {
        callbackError = new MediaError('decode-error', `aac native output: ${errMessage(e)}`, e);
      } finally {
        data.close();
      }
    },
    error(e): void {
      callbackError = nativeDecoderUnavailable(`${e.name}: ${e.message}`);
    },
  });
  try {
    decoder.configure(config);
    for (const frame of layout.frames) {
      throwIfAborted(signal);
      if (callbackError !== undefined) throw callbackError;
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: frame.ptsUs,
          duration: frame.durationUs,
          data: payload(bytes, frame),
        }),
      );
      await awaitAudioCodecQueueDrain(decoder, () => decoder.decodeQueueSize, signal, 8);
    }
    await decoder.flush();
    if (callbackError !== undefined) throw callbackError;
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw nativeDecoderUnavailable(`${errName(e)}: ${errMessage(e)}`);
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  return concatPcmChunks(chunks, layout.info.sampleRate, layout.info.channels);
}

function wasmUnavailable(reason: string): CapabilityError {
  return decodeCapabilityMiss(`wasm-aac cannot decode ADTS AAC to PCM (${reason})`, [
    ...WASM_AAC_TRIED,
  ]);
}

async function decodeWasmAacToPcm(
  bytes: Uint8Array,
  layout: AdtsLayout,
  o: PcmTransform | undefined,
): Promise<PcmAudio> {
  const core = await loadAacCore(o?.wasmRuntime, o?.wasmAssetBaseUrl);
  if (core === null) throw wasmUnavailable('core is unavailable');
  const chunks: PcmAudio[] = [];
  let decoder: ReturnType<typeof core.createDecoder> | undefined;
  try {
    decoder = core.createDecoder(layout.asc, layout.info.channels, layout.info.sampleRate);
    const channels = decoder.channels;
    const sampleRate = decoder.sampleRate;
    for (const frame of layout.frames) {
      throwIfAborted(o?.signal);
      chunks.push(
        pcmFromInterleavedF32(decoder.decode(payload(bytes, frame)), channels, sampleRate),
      );
    }
    return concatPcmChunks(chunks, sampleRate, channels);
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError('decode-error', `wasm-aac decode: ${errMessage(e)}`, e);
  } finally {
    decoder?.free();
  }
}

function aacPcmPlanMiss(
  plan: readonly AdtsAacPcmDecodeRung[],
  nativeMiss: CapabilityError | undefined,
  wasmMiss: CapabilityError | undefined,
): CapabilityError {
  const details: string[] = [];
  if (nativeMiss !== undefined) {
    details.push(nativeMiss.message);
  } else if (!plan.includes('webcodecs-audio')) {
    details.push('webcodecs-audio was not attempted by this runtime/determinism decode plan');
  }
  if (wasmMiss !== undefined) details.push(wasmMiss.message);
  return new CapabilityError(`ADTS AAC → WAV PCM extract is unavailable (${details.join('; ')})`, {
    op: { kind: 'route', id: 'convert' },
    tried: plan,
    suggestion: 'enable native AAC AudioDecoder support or ship the vendored wasm-aac core',
  });
}

async function firefoxRuntimeForAdtsPcm(): Promise<boolean> {
  const runtime = await import('../../api/runtime-detect.ts');
  return runtime.isFirefoxRuntime();
}

async function decodeAacToPcmWithLayout(
  bytes: Uint8Array,
  layout: AdtsLayout,
  firefoxRuntime: boolean,
  o: PcmTransform | undefined,
): Promise<PcmAudio> {
  throwIfAborted(o?.signal);
  const plan = adtsAacPcmDecodePlan(firefoxRuntime, o?.determinism);
  let nativeMiss: CapabilityError | undefined;
  let wasmMiss: CapabilityError | undefined;
  for (const rung of plan) {
    if (rung === 'webcodecs-audio') {
      try {
        return await decodeNativeAacToPcm(bytes, layout, o?.signal);
      } catch (e) {
        if (!(e instanceof CapabilityError)) throw e;
        nativeMiss = e;
      }
      continue;
    }
    if (rung === 'wasm-aac') {
      try {
        return await decodeWasmAacToPcm(bytes, layout, o);
      } catch (e) {
        if (!(e instanceof CapabilityError)) throw e;
        wasmMiss = e;
      }
      continue;
    }
    const exhaustive: never = rung;
    throw new MediaError('decode-error', `unknown ADTS AAC PCM decode rung ${exhaustive}`);
  }
  throw aacPcmPlanMiss(plan, nativeMiss, wasmMiss);
}

/* v8 ignore stop */

/**
 * Stream every ADTS frame of `bytes` as WebCodecs `EncodedAudioChunk`s. Browser-only: the `EncodedAudioChunk`
 * constructor exists only in a browser/worker, so we raise a typed {@link CapabilityError} in Node (mirroring
 * the mpegts/mp4 drivers) and istanbul-ignore the emission body (validated under browser-mode in the codec
 * phase). Audio has NO reordering — DTS == PTS — so each {@link Packet} omits `dtsUs`. Each frame is a sync
 * sample (`type:'key'`) and we emit the RAW AAC access unit (ADTS header + optional CRC stripped) so the
 * decoder consumes a bare access unit matched by the synthesized `config.description` ASC. `sizeBytes`
 * carries the full ADTS frame length so packet-size oracles can compare the on-disk packet unit.
 */
function packetStream(
  bytes: Uint8Array,
  frames: readonly AdtsPacket[],
  track: TrackInfo,
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError('WebCodecs EncodedAudioChunk is unavailable in this environment', {
      op: { kind: 'route', id: 'demux' },
      tried: ['adts'],
    });
  }
  /* v8 ignore start -- requires WebCodecs EncodedAudioChunk; validated under browser-mode (codec phase) */
  let i = 0;
  let claimed = false;
  const stream = new ReadableStream<Packet>(
    {
      pull(controller): void {
        if (signal?.aborted) {
          controller.error(new MediaError('aborted', 'operation aborted'));
          return;
        }
        const f = frames[i];
        if (f === undefined) {
          controller.close();
          return;
        }
        i++;
        const data = bytes.subarray(f.offset + f.headerBytes, f.offset + f.size);
        const chunk = new EncodedAudioChunk({
          type: 'key', // every AAC frame is independently decodable (a sync sample)
          timestamp: f.ptsUs,
          duration: f.durationUs,
          data,
        });
        controller.enqueue({ chunk, sizeBytes: f.size }); // no dtsUs: audio never reorders (DTS == PTS)
      },
    },
    { highWaterMark: 0 },
  );
  registerNativePacketSource(stream, {
    track,
    isClaimable: () => !claimed && i === 0 && !stream.locked,
    async claim(activeSignal) {
      if (claimed || i !== 0)
        throw new MediaError('mux-error', 'ADTS packet stream was already consumed');
      claimed = true;
      i = frames.length;
      const chunks = [];
      for (const frame of frames) {
        throwIfAborted(activeSignal);
        chunks.push({
          timestampUs: frame.ptsUs,
          durationUs: frame.durationUs,
          key: true,
          data: payload(bytes, frame),
        });
      }
      return chunks;
    },
  });
  return stream;
  /* v8 ignore stop */
}

export const AdtsDriver = {
  id: 'adts',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['adts', 'aac'],
  supports: matchesAdts,
  validatesStreamCopyTrim: true,
  /**
   * Metadata-only probe: EXACT duration from a bounded-read header walk — every ADTS frame header is
   * visited through fixed-size windows (leading/mid-stream tag bodies are seeked over on range-capable
   * sources), so huge files never materialize and trailing tags/junk never inflate the duration. Track
   * facts (codec/rate/channels/ASC) come from the first locked header, exactly like `demux()`.
   */
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const stats = await probeAdtsStream(src, o?.signal !== undefined ? { signal: o.signal } : {});
    const info = infoFromWalkStats(stats);
    assertKnownChannels(info.channels);
    const { aot, freqIndex, channelConfig } = stats.firstHeader;
    return [
      {
        id: 0,
        mediaType: 'audio',
        codec: info.codec,
        durationSec: info.durationSec,
        config: {
          codec: info.codec,
          sampleRate: info.sampleRate,
          numberOfChannels: info.channels,
          description: audioSpecificConfig(aot, freqIndex, channelConfig),
        },
      },
    ];
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const bytes = await readAll(src);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return adtsPacketInfoFromBytes(bytes);
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    // A raw ADTS stream has no front index — every frame's geometry lives inline, so `packets()` needs the
    // whole file. We read it once here and parse the head from it (the existing probe path is unchanged).
    const bytes = await readAll(src);
    const layout = readLayout(bytes);
    const signal = o?.signal;
    const track = trackInfoFromLayout(layout);
    return {
      tracks: [track],
      packets(trackId: number): ReadableStream<Packet> {
        if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(bytes, layout.frames, track, signal);
      },
      packetTable(): readonly PacketMetadata[] {
        return adtsPacketMetadataFromFrames(layout.frames);
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    assertAdtsStreamCopyTarget(o?.container);
    throwIfAborted(o?.signal);
    const out = writeAdtsPacketCopy(await readAll(src), o?.trim);
    throwIfAborted(o?.signal);
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
    if (o.scheme !== 'hls-aes128') {
      throw new CapabilityError(`ADTS decrypt does not support '${o.scheme}'`, {
        op: { kind: 'route', id: 'decrypt' },
        tried: ['adts'],
      });
    }
    const { decryptHlsAes128ContainerSegment } = await import('../hls-full-segment-decrypt.ts');
    return decryptHlsAes128ContainerSegment(src, o, {
      driverId: 'adts',
      containerLabel: 'ADTS',
      validate(clear): void {
        assertDecryptedAdtsSegment(clear);
      },
    });
  },
  createMuxer(o?: MuxOptions): AdtsMuxer {
    // ADTS is an elementary stream: wrap each raw AAC access unit in a 7-byte ADTS header (no re-encode;
    // the encoder/remux path feeds the access units + the ASC description). See {@link AdtsMuxer}.
    return new AdtsMuxer(o);
  },
  async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const bytes = await readAll(src);
    throwIfAborted(o?.signal);
    const layout = readLayout(bytes);
    const firefoxRuntime = await firefoxRuntimeForAdtsPcm();
    let directWav: Uint8Array<ArrayBuffer> | undefined;
    if (mayUseAdtsDirectWasmS16Wav(bytes.byteLength, o, firefoxRuntime)) {
      const direct = adtsPcmDirectModule ?? (await loadAdtsPcmDirectModule());
      directWav = direct.canUseAdtsWasmDirectS16Wav(
        bytes.byteLength,
        layout.info.sampleRate,
        layout.info.channels,
        o,
        firefoxRuntime,
      )
        ? await direct.tryDecodeWasmAacToS16Wav(bytes, layout, o)
        : undefined;
    }
    const out =
      directWav ??
      writeWav(
        applyPcmTransform(await decodeAacToPcmWithLayout(bytes, layout, firefoxRuntime, o), o),
        PCM_OUTPUT_FORMAT,
      );
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
} satisfies ContainerDriver;

export const AdtsModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AdtsDriver);
  },
};

export default AdtsModule;
