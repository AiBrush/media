/**
 * Pure, Node-testable AAC helpers for the WASM decode driver (docs/architecture/04 wasm tier, 05
 * §CodecDriver, ADR-037). The lossy MDCT/Huffman decode lives in Symphonia compiled to wasm (see
 * `BUILD.md`); this module holds the deterministic, spec-defined glue validated in Node:
 *
 *  - **ADTS frame parsing** (ISO/IEC 13818-7 §6.2): split a self-framing ADTS stream into raw AAC
 *    payloads (header stripped) and read the profile / sampling-frequency-index / channel-config the
 *    container would otherwise carry as an AudioSpecificConfig. Symphonia's `AacDecoder` decodes the raw
 *    payload, so the ADTS header must be removed first.
 *  - **AudioSpecificConfig basics** (ISO/IEC 14496-3 §1.6.2.1): the 4-bit sampling-frequency index table
 *    and the channel-configuration field, shared by ADTS and the MP4 `esds` ASC (the WebCodecs
 *    `description`).
 *  - **planar↔interleaved f32**, config validation, and the {@link AacWasmCore} contract.
 *
 * Everything here is integer/byte logic with a real spec and a falsifiable oracle — no oracle that cannot
 * fail (directive 6).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';
import { MPEG4_SAMPLE_RATES, parseAsc, sampleRateForIndex } from '../aac-config.ts';

export { MPEG4_SAMPLE_RATES, parseAsc, sampleRateForIndex };
export type { AscFields } from '../aac-config.ts';

// ============ AAC invariants ============

/** The AAC codec id prefix WebCodecs / RFC 6381 use (`mp4a.40.2` = AAC-LC). */
export const AAC_CODEC_PREFIX = 'mp4a' as const;

/** AAC-LC emits exactly 1024 PCM samples per channel per frame (ISO/IEC 14496-3). */
export const AAC_LC_FRAME_SAMPLES = 1024 as const;

/** This driver decodes AAC-LC mono/stereo (Symphonia's AAC scope; it rejects SBR/HE/>2ch). */
export const AAC_MAX_CHANNELS = 2 as const;

/**
 * MPEG-4 audio object types that layer SBR/PS on top of the AAC-LC core and so exceed this LC-only wasm
 * decoder (ISO/IEC 14496-3 Table 1.17): 5 = SBR (HE-AAC v1), 29 = PS (HE-AAC v2). Symphonia rejects an
 * *explicit* SBR/PS `AudioSpecificConfig` as "too complex" at construction, so the driver declines these
 * honestly up front (a typed capability miss) instead of advertising support and hard-crashing on init.
 * Implicit (in-band) SBR — an AAC-LC ASC (`mp4a.40.2`) whose bitstream carries an SBR extension — is NOT
 * flagged here: its ASC object type is 2 and Symphonia decodes the LC core, so it stays on the LC path.
 */
export const HE_AAC_OBJECT_TYPES: ReadonlySet<number> = new Set([5, 29]);

/** True when a codec string names AAC (`mp4a.40.x`, or the bare `mp4a`). */
export function isAacCodec(codec: string): boolean {
  return codec === AAC_CODEC_PREFIX || codec.startsWith(`${AAC_CODEC_PREFIX}.`);
}

// ============ ADTS framing (ISO/IEC 13818-7 §6.2) ============

/** One parsed ADTS frame: the raw AAC payload (header stripped) + the geometry from its header. */
export interface AdtsFrame {
  /** The AAC payload with the 7- or 9-byte ADTS header removed (what Symphonia's decoder wants). */
  payload: Uint8Array;
  sampleRate: number;
  channels: number;
  /** MPEG-4 audio object type (profile + 1): 2 = AAC-LC. */
  objectType: number;
}

const ADTS_SYNC = 0xfff; // 12-bit syncword at the start of every ADTS frame

/**
 * Parse one ADTS frame starting at `offset`. Header layout (the first 7 bytes, +2 if CRC present):
 * syncword(12) | MPEG version(1) | layer(2) | protection-absent(1) | profile(2) | sampling-freq-index(4)
 * | private(1) | channel-config(3) | … | frame-length(13) | … . `protection-absent==0` means a 2-byte
 * CRC follows the 7-byte header. Returns the frame and the offset just past it. Throws a typed error on a
 * lost syncword or a length that overruns the buffer.
 */
export function parseAdtsFrame(
  bytes: Uint8Array,
  offset: number,
): { frame: AdtsFrame; next: number } {
  if (offset + 7 > bytes.length) {
    throw new InputError('aac: ADTS frame truncated (header)');
  }
  const b0 = bytes[offset] as number;
  const b1 = bytes[offset + 1] as number;
  const sync = (b0 << 4) | (b1 >> 4);
  if (sync !== ADTS_SYNC) {
    throw new InputError(`aac: lost ADTS sync at byte ${offset}`);
  }
  const protectionAbsent = b1 & 0x01;
  const b2 = bytes[offset + 2] as number;
  const profile = (b2 >> 6) & 0x03; // 0=Main,1=LC,2=SSR,3=LTP → objectType = profile + 1
  const freqIndex = (b2 >> 2) & 0x0f;
  const b3 = bytes[offset + 3] as number;
  const channelConfig = ((b2 & 0x01) << 2) | (b3 >> 6);
  const frameLength =
    ((b3 & 0x03) << 11) |
    ((bytes[offset + 4] as number) << 3) |
    ((bytes[offset + 5] as number) >> 5);

  const sampleRate = sampleRateForIndex(freqIndex);
  if (sampleRate === undefined) {
    throw new MediaError(
      'decode-error',
      `aac: reserved ADTS sampling-frequency index ${freqIndex}`,
    );
  }
  const headerLen = protectionAbsent === 1 ? 7 : 9; // +2 bytes for the CRC when protection present
  if (frameLength < headerLen || offset + frameLength > bytes.length) {
    throw new MediaError('decode-error', `aac: ADTS frame length ${frameLength} overruns buffer`);
  }
  return {
    frame: {
      payload: bytes.subarray(offset + headerLen, offset + frameLength),
      sampleRate,
      channels: channelConfig,
      objectType: profile + 1,
    },
    next: offset + frameLength,
  };
}

/**
 * De-frame an entire ADTS stream into raw AAC payloads + shared geometry (from the first frame). Used to
 * feed Symphonia's AAC decoder (which wants payloads, not ADTS) and by the Node validation. Throws on the
 * first lost syncword. An optional `id3`-style prefix is the caller's concern; ADTS itself has no header.
 */
export function readAdtsFrames(bytes: Uint8Array): {
  frames: Uint8Array[];
  sampleRate: number;
  channels: number;
  objectType: number;
} {
  const frames: Uint8Array[] = [];
  let offset = skipId3(bytes);
  let sampleRate = 0;
  let channels = 0;
  let objectType = 0;
  while (offset + 7 <= bytes.length) {
    const { frame, next } = parseAdtsFrame(bytes, offset);
    if (frames.length === 0) {
      sampleRate = frame.sampleRate;
      channels = frame.channels;
      objectType = frame.objectType;
    }
    frames.push(frame.payload);
    offset = next;
  }
  if (frames.length === 0) {
    throw new InputError('aac: no ADTS frames found');
  }
  return { frames, sampleRate, channels, objectType };
}

/** Skip a leading ID3v2 tag if present (`'ID3'` + a syncsafe 28-bit size), returning the start offset. */
export function skipId3(bytes: Uint8Array): number {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] as number) & 0x7f) * 0x200000 +
      ((bytes[7] as number) & 0x7f) * 0x4000 +
      ((bytes[8] as number) & 0x7f) * 0x80 +
      ((bytes[9] as number) & 0x7f);
    return 10 + size;
  }
  return 0;
}

// ============ planar ↔ interleaved f32 ============

/**
 * Split an interleaved `[c0,c1,…]` f32 buffer (what the wasm decoder returns) into `channels` per-channel
 * planes — the shape an `f32-planar` `AudioData` is built from. `interleaved.length` must be `frames ×
 * channels`.
 */
export function deinterleaveF32(
  interleaved: Float32Array,
  channels: number,
  frames: number,
): Float32Array[] {
  if (interleaved.length !== frames * channels) {
    throw new MediaError(
      'decode-error',
      `aac: interleaved length ${interleaved.length} ≠ ${frames}×${channels}`,
    );
  }
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let c = 0; c < channels; c++) {
    const plane = planes[c] as Float32Array;
    for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c] as number;
  }
  return planes;
}

// ============ config validation ============

/** A validated decode configuration (channels/rate the driver shapes its `AudioData` from). */
export interface AacDecodeConfig {
  channels: number;
  sampleRate: number;
  /** The AudioSpecificConfig (`esds`/`description`), or empty when an ADTS source carries none. */
  extraData: Uint8Array;
}

/** The AAC audio object type an RFC 6381 codec string pins (`mp4a.40.<oti>` → `<oti>`), or `undefined`. */
export function aacObjectTypeFromCodecString(codec: string): number | undefined {
  const match = /^mp4a\.40\.(\d+)$/.exec(codec);
  if (match === null) return undefined;
  const oti = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(oti) ? oti : undefined;
}

/**
 * The explicit HE-AAC/SBR (or HE-AACv2/PS) audio object type a decode config declares — read from the
 * AudioSpecificConfig's leading 5-bit object type when a `description` is present, else the RFC 6381
 * codec string (`mp4a.40.5`/`mp4a.40.29`) — or `undefined` for plain AAC-LC. The ASC is authoritative
 * (the container's `esds`), so it wins over the codec string. Used to decline HE-AAC honestly: the wasm
 * core is AAC-LC only (see {@link HE_AAC_OBJECT_TYPES}).
 */
export function explicitHeAacObjectType(codec: string, asc: Uint8Array): number | undefined {
  const ascObjectType = asc.length >= 1 ? (asc[0] as number) >> 3 : undefined;
  if (ascObjectType !== undefined && HE_AAC_OBJECT_TYPES.has(ascObjectType)) return ascObjectType;
  const codecObjectType = aacObjectTypeFromCodecString(codec);
  if (codecObjectType !== undefined && HE_AAC_OBJECT_TYPES.has(codecObjectType)) {
    return codecObjectType;
  }
  return undefined;
}

/**
 * Validate + normalize an {@link AudioDecoderConfig} for the wasm AAC core. Requires an AAC codec id and
 * a known sample rate + channel count (1–2). The `description` (ASC) is optional — Symphonia synthesizes
 * a default AAC-LC ASC from the rate/channels when it is absent (the ADTS case). Explicit HE-AAC/SBR
 * (`mp4a.40.5`) and HE-AACv2/PS (`mp4a.40.29`) are declined here: the LC-only core rejects them as "too
 * complex" at construction, so surfacing the miss *before* touching the wasm keeps `supports()` honest
 * (it answers `false`) and the router degrades to a typed capability miss instead of a hard crash. A bad
 * config is a typed {@link MediaError} (`decode-error`).
 */
export function normalizeAacDecoderConfig(config: AudioDecoderConfig): AacDecodeConfig {
  if (!isAacCodec(config.codec)) {
    throw new MediaError('decode-error', `aac: wasm-aac cannot decode codec '${config.codec}'`);
  }
  const extraData = descriptionBytes(config.description);
  const heAacObjectType = explicitHeAacObjectType(config.codec, extraData);
  if (heAacObjectType !== undefined) {
    throw new MediaError(
      'decode-error',
      `aac: wasm-aac (AAC-LC core) cannot decode HE-AAC/SBR (audioObjectType ${heAacObjectType}); a native AAC decoder is required`,
    );
  }
  const channels = config.numberOfChannels;
  if (channels < 1 || channels > AAC_MAX_CHANNELS) {
    throw new MediaError(
      'decode-error',
      `aac: wasm-aac supports 1–${AAC_MAX_CHANNELS} channels, got ${channels}`,
    );
  }
  if (!(config.sampleRate > 0)) {
    throw new MediaError('decode-error', `aac: invalid sampleRate ${config.sampleRate}`);
  }
  return {
    channels,
    sampleRate: config.sampleRate,
    extraData,
  };
}

/** Normalize a WebCodecs `description` (`AllowSharedBufferSource`) to a `Uint8Array` (empty if absent). */
export function descriptionBytes(description: AllowSharedBufferSource | undefined): Uint8Array {
  if (description === undefined) return new Uint8Array(0);
  if (description instanceof Uint8Array) return description;
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  }
  return new Uint8Array(description);
}

// ============ the wasm-core contract (what BUILD.md produces) ============

/**
 * The surface the Symphonia-in-wasm glue exposes (see `BUILD.md`), wrapping `symphonia-codec-aac`. The
 * driver constructs one {@link AacWasmDecoder} per stream from the ASC + geometry, decodes each raw AAC
 * packet to interleaved f32, and `free()`s on teardown. Mirrors the generated `AacWasm` class.
 */
export interface AacWasmCore {
  /** Construct a decoder from the ASC `extraData` (may be empty for ADTS) + container geometry. */
  createDecoder(extraData: Uint8Array, channels: number, sampleRate: number): AacWasmDecoder;
}

/** A live Symphonia AAC-LC decoder: raw packets in, interleaved f32 out. */
export interface AacWasmDecoder {
  /** Channel count (container-declared, reconciled with the decoded spec). */
  readonly channels: number;
  /** Sample rate (Hz) (container-declared, reconciled with the decoded spec). */
  readonly sampleRate: number;
  /** Decode one raw AAC packet (no ADTS header) → interleaved f32 (`frames × channels`). */
  decode(packet: Uint8Array): Float32Array;
  /** Decode many concatenated raw AAC packets using a packet-boundary offset table. */
  decodeMany(packets: Uint8Array, offsets: Uint32Array): Float32Array;
  /** Reset decoder state at a seek/discontinuity. */
  reset(): void;
  /** Release the native decoder. Idempotent. */
  free(): void;
}
