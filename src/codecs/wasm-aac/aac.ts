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

// ============ AAC invariants ============

/** The AAC codec id prefix WebCodecs / RFC 6381 use (`mp4a.40.2` = AAC-LC). */
export const AAC_CODEC_PREFIX = 'mp4a' as const;

/** AAC-LC emits exactly 1024 PCM samples per channel per frame (ISO/IEC 14496-3). */
export const AAC_LC_FRAME_SAMPLES = 1024 as const;

/** This driver decodes AAC-LC mono/stereo (Symphonia's AAC scope; it rejects SBR/HE/>2ch). */
export const AAC_MAX_CHANNELS = 2 as const;

/** True when a codec string names AAC (`mp4a.40.x`, or the bare `mp4a`). */
export function isAacCodec(codec: string): boolean {
  return codec === AAC_CODEC_PREFIX || codec.startsWith(`${AAC_CODEC_PREFIX}.`);
}

/**
 * MPEG-4 sampling-frequency index → Hz (ISO/IEC 14496-3 Table 1.16). Index 15 is "explicit" (not in the
 * table); indices 13/14 are reserved. Shared by ADTS headers and the AudioSpecificConfig.
 */
export const MPEG4_SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Sample rate (Hz) for a 4-bit MPEG-4 sampling-frequency index, or `undefined` if reserved/explicit. */
export function sampleRateForIndex(index: number): number | undefined {
  return MPEG4_SAMPLE_RATES[index];
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
    throw new InputError('unsupported-input', 'aac: ADTS frame truncated (header)');
  }
  const b0 = bytes[offset] as number;
  const b1 = bytes[offset + 1] as number;
  const sync = (b0 << 4) | (b1 >> 4);
  if (sync !== ADTS_SYNC) {
    throw new InputError('unsupported-input', `aac: lost ADTS sync at byte ${offset}`);
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
    throw new InputError('unsupported-input', 'aac: no ADTS frames found');
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

// ============ AudioSpecificConfig (the WebCodecs `description`) ============

/** The minimal fields an AAC AudioSpecificConfig declares (ISO/IEC 14496-3 §1.6.2.1). */
export interface AscFields {
  objectType: number;
  sampleRate: number;
  channels: number;
}

/**
 * Parse the leading fields of an AudioSpecificConfig: 5-bit audioObjectType, 4-bit sampling-frequency
 * index (or a 24-bit explicit rate when the index is 15), 4-bit channelConfiguration. This is the
 * geometry the MP4 `esds` carries and WebCodecs passes as `description`; the wasm decoder reads the full
 * ASC itself, but the driver needs the rate/channels to shape `AudioData` before the first decode.
 */
export function parseAsc(asc: Uint8Array): AscFields {
  if (asc.length < 2)
    throw new InputError('unsupported-input', 'aac: AudioSpecificConfig too short');
  const b0 = asc[0] as number;
  const b1 = asc[1] as number;
  const objectType = b0 >> 3;
  const freqIndex = ((b0 & 0x07) << 1) | (b1 >> 7);
  if (freqIndex === 15) {
    if (asc.length < 5)
      throw new InputError('unsupported-input', 'aac: explicit-rate ASC too short');
    // Explicit 24-bit rate spanning b1[6:0] | b2 | b3 | b4[7]; channelConfig is the next 4 bits (b4[6:3]).
    const b2 = asc[2] as number;
    const b3 = asc[3] as number;
    const b4 = asc[4] as number;
    const sampleRate = ((b1 & 0x7f) << 17) | (b2 << 9) | (b3 << 1) | (b4 >> 7);
    return { objectType, sampleRate, channels: (b4 >> 3) & 0x0f };
  }
  const sampleRate = sampleRateForIndex(freqIndex);
  if (sampleRate === undefined) {
    throw new MediaError('decode-error', `aac: reserved ASC sampling-frequency index ${freqIndex}`);
  }
  return { objectType, sampleRate, channels: (b1 >> 3) & 0x0f }; // channelConfiguration: bits b1[6:3]
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

/**
 * Validate + normalize an {@link AudioDecoderConfig} for the wasm AAC core. Requires an AAC codec id and
 * a known sample rate + channel count (1–2). The `description` (ASC) is optional — Symphonia synthesizes
 * a default AAC-LC ASC from the rate/channels when it is absent (the ADTS case). A bad config is a typed
 * {@link MediaError} (`decode-error`).
 */
export function normalizeAacDecoderConfig(config: AudioDecoderConfig): AacDecodeConfig {
  if (!isAacCodec(config.codec)) {
    throw new MediaError('decode-error', `aac: wasm-aac cannot decode codec '${config.codec}'`);
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
    extraData: descriptionBytes(config.description),
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
  /** Reset decoder state at a seek/discontinuity. */
  reset(): void;
  /** Release the native decoder. Idempotent. */
  free(): void;
}
