/**
 * Pure, Node-testable Opus helpers for the WASM fallback codec driver (docs/architecture/04 wasm tier,
 * 05 §CodecDriver, ADR-026). This module holds the parts of the Opus path that are **bit-exact integer
 * logic with a real spec** — packet framing (RFC 6716 §3), the 32-config sample-rate/frame-size table
 * (RFC 6716 Table 2), the encoder re-chunking math (Opus only accepts fixed 2.5/5/10/20/40/60 ms frames
 * at 48 kHz), config validation/normalization, and planar↔interleaved f32 PCM conversion — so they are
 * validated in Node without a browser or the wasm core (which carries the lossy CELT/SILK math).
 *
 * The actual entropy-coded decode/encode lives in libopus compiled to wasm (see `BUILD.md`); this file
 * defines {@link OpusWasmCore}, the narrow contract that wasm glue must satisfy, so the driver skeleton
 * is fully typed against it and the build recipe has a precise target. Everything here is deterministic
 * and falsifiable — no oracle that cannot fail (directive 6).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';

// ============ Opus invariants (RFC 6716, RFC 7845) ============

/** Opus runs its internal math at 48 kHz; every frame size below is expressed in 48 kHz samples. */
export const OPUS_RATE = 48_000 as const;

/** Decoder output sample rates libopus can resample to (RFC 7845 §4 / `opus_decoder_create`). */
export const OPUS_DECODE_RATES = [8_000, 12_000, 16_000, 24_000, 48_000] as const;
export type OpusDecodeRate = (typeof OPUS_DECODE_RATES)[number];

/** Opus frame durations an encoder accepts, in milliseconds (RFC 6716 §2.1.4). */
export const OPUS_FRAME_MS = [2.5, 5, 10, 20, 40, 60] as const;
export type OpusFrameMs = (typeof OPUS_FRAME_MS)[number];

/** This driver targets mono/stereo Opus (the WebCodecs `AudioData` channel range it bridges). */
export const OPUS_MAX_CHANNELS = 2 as const;

/** Default encoder frame duration: 20 ms is the Opus/WebRTC default — best quality/latency tradeoff. */
export const DEFAULT_FRAME_MS: OpusFrameMs = 20;

// ============ TOC byte (RFC 6716 §3.1) ============

/** The Opus mode a `config` selects (RFC 6716 §3.1, Table 2). */
export type OpusMode = 'silk' | 'hybrid' | 'celt';

/** Decoded fields of an Opus TOC (table-of-contents) byte — the first byte of every Opus packet. */
export interface OpusToc {
  /** TOC `config` field, bits 7..3 (0–31): selects mode, audio bandwidth, and frame size. */
  config: number;
  /** Coding mode the `config` selects. */
  mode: OpusMode;
  /** Per-frame duration in 48 kHz samples (RFC 6716 Table 2). */
  frameSamples: number;
  /** True when the packet carries two channels (TOC bit 2, `s`). */
  stereo: boolean;
  /** Frame-count code, TOC bits 1..0 (`c`): 0→1 frame, 1→2 equal, 2→2 different, 3→arbitrary (byte 2). */
  frameCountCode: 0 | 1 | 2 | 3;
}

/**
 * Per-`config` frame size in 48 kHz samples (RFC 6716 Table 2). Index = TOC `config` (0–31). SILK at
 * 10/20/40/60 ms across NB/MB/WB (configs 0–11), Hybrid at 10/20 ms SWB/FB (12–15), CELT at 2.5/5/10/20
 * ms across NB/WB/SWB/FB (16–31). 2.5 ms→120, 5→240, 10→480, 20→960, 40→1920, 60→2880 samples @ 48 kHz.
 */
const CONFIG_FRAME_SAMPLES: readonly number[] = [
  // SILK-only — NB (configs 0..3), MB (4..7), WB (8..11): 10, 20, 40, 60 ms
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  // Hybrid — SWB (12..13), FB (14..15): 10, 20 ms
  480, 960, 480, 960,
  // CELT-only — NB (16..19), WB (20..23), SWB (24..27), FB (28..31): 2.5, 5, 10, 20 ms
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** The coding mode for a TOC `config` (RFC 6716 §3.1): 0–11 SILK, 12–15 Hybrid, 16–31 CELT. */
export function modeForConfig(config: number): OpusMode {
  if (config < 0 || config > 31) {
    throw new MediaError('decode-error', `opus: TOC config ${config} out of range (0–31)`);
  }
  if (config < 12) return 'silk';
  if (config < 16) return 'hybrid';
  return 'celt';
}

/** Per-frame 48 kHz sample count for a TOC `config` (RFC 6716 Table 2). */
export function frameSamplesForConfig(config: number): number {
  const n = CONFIG_FRAME_SAMPLES[config];
  if (n === undefined) {
    throw new MediaError('decode-error', `opus: TOC config ${config} out of range (0–31)`);
  }
  return n;
}

/**
 * Parse an Opus packet's TOC byte (its first byte) into {@link OpusToc}. The TOC layout (RFC 6716 §3.1):
 * `config` = bits 7..3, `s` (stereo) = bit 2, `c` (frame-count code) = bits 1..0. An empty packet has no
 * TOC and is rejected as malformed input.
 */
export function parseToc(packet: Uint8Array): OpusToc {
  const toc = packet[0];
  if (toc === undefined) {
    throw new InputError('unsupported-input', 'opus: empty packet has no TOC byte');
  }
  const config = toc >> 3;
  return {
    config,
    mode: modeForConfig(config),
    frameSamples: frameSamplesForConfig(config),
    stereo: (toc & 0x04) !== 0,
    frameCountCode: (toc & 0x03) as 0 | 1 | 2 | 3,
  };
}

/**
 * Total decoded 48 kHz sample count a packet yields = per-frame size × frame count. Frame count comes
 * from the TOC code `c` (RFC 6716 §3.2): code 0 → 1 frame; 1 or 2 → 2 frames; 3 → an arbitrary count in
 * the low 6 bits of byte 2 (frame-count byte). Used to size the decode output buffer and to advance the
 * presentation clock; the per-frame audio decode itself is the wasm core's job.
 */
export function packetFrameCount(packet: Uint8Array): number {
  const toc = parseToc(packet);
  switch (toc.frameCountCode) {
    case 0:
      return 1;
    case 1:
    case 2:
      return 2;
    case 3: {
      const fc = packet[1];
      if (fc === undefined) {
        throw new InputError('unsupported-input', 'opus: code-3 packet missing frame-count byte');
      }
      const count = fc & 0x3f; // M: low 6 bits (bit 7 = VBR, bit 6 = padding)
      if (count < 1 || count > 48) {
        throw new MediaError('decode-error', `opus: illegal code-3 frame count ${count}`);
      }
      return count;
    }
    default: {
      const exhaustive: never = toc.frameCountCode;
      throw new MediaError(
        'decode-error',
        `opus: unreachable frame-count code ${String(exhaustive)}`,
      );
    }
  }
}

/** Decoded 48 kHz sample count for a whole packet (per-frame size × {@link packetFrameCount}). */
export function packetDurationSamples(packet: Uint8Array): number {
  const toc = parseToc(packet);
  return toc.frameSamples * packetFrameCount(packet);
}

// ============ frame-size math (encoder re-chunking) ============

/** 48 kHz samples in a frame of the given Opus duration (RFC 6716 §2.1.4). 20 ms → 960 samples. */
export function frameSamplesAt48k(ms: OpusFrameMs): number {
  return (OPUS_RATE * ms) / 1000;
}

/**
 * Samples per Opus frame at an arbitrary input `sampleRate`. libopus' float encoder accepts input at the
 * decoder rates {8,12,16,24,48} kHz and re-chunking must align to its frame grid: e.g. 20 ms at 48 kHz =
 * 960, at 24 kHz = 480. The product is always integer for the allowed (rate, duration) pairs.
 */
export function frameSamplesAtRate(sampleRate: number, ms: OpusFrameMs): number {
  const exact = (sampleRate * ms) / 1000;
  if (!Number.isInteger(exact)) {
    throw new MediaError(
      'encode-error',
      `opus: ${ms}ms is not an integer number of samples at ${sampleRate}Hz`,
    );
  }
  return exact;
}

/** True for an Opus-legal encoder frame duration in ms (RFC 6716 §2.1.4). */
export function isValidFrameMs(ms: number): ms is OpusFrameMs {
  return (OPUS_FRAME_MS as readonly number[]).includes(ms);
}

/**
 * A bounded queue of interleaved f32 PCM that hands out exactly-`frameSamples`-per-channel frames to the
 * encoder. An `AudioData` carries an arbitrary number of samples, but Opus encodes only fixed frames, so
 * input is appended here and drained one full frame at a time; the remainder waits for more input. On end
 * of stream {@link drainFinal} zero-pads the partial tail to one last frame (silence padding is the
 * standard way to flush an Opus encoder). Pure arithmetic over `Float32Array`s — fully Node-testable.
 */
export class FrameAccumulator {
  readonly #channels: number;
  readonly #frameSamples: number;
  /** Interleaved f32 backlog: [c0,c1,…][c0,c1,…]… — `length` is a multiple of `channels`. */
  #buf: Float32Array;
  #len = 0;

  constructor(channels: number, frameSamples: number) {
    if (channels < 1)
      throw new MediaError('encode-error', `opus: invalid channel count ${channels}`);
    if (frameSamples < 1) {
      throw new MediaError('encode-error', `opus: invalid frame size ${frameSamples}`);
    }
    this.#channels = channels;
    this.#frameSamples = frameSamples;
    this.#buf = new Float32Array(frameSamples * channels * 2);
  }

  /** Samples per channel currently buffered. */
  get bufferedSamples(): number {
    return this.#len / this.#channels;
  }

  /** Append interleaved f32 samples (`length` must be a multiple of `channels`). */
  push(interleaved: Float32Array): void {
    if (interleaved.length % this.#channels !== 0) {
      throw new MediaError(
        'encode-error',
        `opus: input length ${interleaved.length} not a multiple of ${this.#channels} channels`,
      );
    }
    const need = this.#len + interleaved.length;
    if (need > this.#buf.length) {
      const grown = new Float32Array(Math.max(need, this.#buf.length * 2));
      grown.set(this.#buf.subarray(0, this.#len));
      this.#buf = grown;
    }
    this.#buf.set(interleaved, this.#len);
    this.#len = need;
  }

  /**
   * Pull one full interleaved frame (`frameSamples × channels` values) if enough is buffered, else
   * `undefined`. The returned array is a fresh copy; the backlog shifts the consumed samples off the
   * front. Callers loop until `undefined` to drain every complete frame after each `push`.
   */
  pull(): Float32Array | undefined {
    const frameLen = this.#frameSamples * this.#channels;
    if (this.#len < frameLen) return undefined;
    const frame = this.#buf.slice(0, frameLen);
    this.#buf.copyWithin(0, frameLen, this.#len);
    this.#len -= frameLen;
    return frame;
  }

  /**
   * Flush the partial tail as one final frame, zero-padded to `frameSamples × channels`, or `undefined`
   * when nothing remains. The pad length (in samples per channel) is the encoder's pre-skip-symmetric
   * trailing delay the container drops; we surface it so the caller can trim the decoded output exactly.
   */
  drainFinal(): { frame: Float32Array; padSamples: number } | undefined {
    if (this.#len === 0) return undefined;
    const frameLen = this.#frameSamples * this.#channels;
    const frame = new Float32Array(frameLen); // zero-filled → silence padding
    frame.set(this.#buf.subarray(0, this.#len));
    const padSamples = (frameLen - this.#len) / this.#channels;
    this.#len = 0;
    return { frame, padSamples };
  }
}

// ============ planar ↔ interleaved f32 ============

/**
 * Interleave per-channel f32 planes into a single `[c0,c1,…]` buffer (libopus' float API is interleaved;
 * WebCodecs `AudioData` with `f32-planar` is per-channel). All planes must share `frames` length.
 */
export function interleaveF32(planes: readonly Float32Array[], frames: number): Float32Array {
  const channels = planes.length;
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    if (plane === undefined) throw new MediaError('encode-error', `opus: missing plane ${c}`);
    for (let i = 0; i < frames; i++) out[i * channels + c] = plane[i] ?? 0;
  }
  return out;
}

/**
 * Split an interleaved `[c0,c1,…]` f32 buffer into `channels` per-channel planes (the inverse of
 * {@link interleaveF32}) — the shape an `f32-planar` `AudioData` is constructed from after the wasm
 * decoder returns interleaved PCM. `interleaved.length` must be `frames × channels`.
 */
export function deinterleaveF32(
  interleaved: Float32Array,
  channels: number,
  frames: number,
): Float32Array[] {
  if (interleaved.length !== frames * channels) {
    throw new MediaError(
      'decode-error',
      `opus: interleaved length ${interleaved.length} ≠ ${frames}×${channels}`,
    );
  }
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    if (plane === undefined) throw new MediaError('decode-error', `opus: missing plane ${c}`);
    for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c] ?? 0;
  }
  return planes;
}

// ============ config validation / normalization ============

/** A validated, wasm-core-ready Opus decoder configuration (derived from {@link AudioDecoderConfig}). */
export interface OpusDecoderInit {
  /** Output sample rate the libopus decoder resamples to (one of {@link OPUS_DECODE_RATES}). */
  sampleRate: OpusDecodeRate;
  /** 1 (mono) or 2 (stereo). */
  channels: number;
  /** Encoder pre-skip in 48 kHz samples to drop from the head (RFC 7845 §4; from the OpusHead). */
  preSkip: number;
}

/** A validated, wasm-core-ready Opus encoder configuration (derived from {@link AudioEncoderConfig}). */
export interface OpusEncoderInit {
  /** Input sample rate (one of {@link OPUS_DECODE_RATES}; libopus' float encoder accepts these). */
  sampleRate: number;
  /** 1 (mono) or 2 (stereo). */
  channels: number;
  /** Target bitrate in bits/s, or `'auto'` to let libopus choose (`OPUS_SET_BITRATE` / OPUS_AUTO). */
  bitrate: number | 'auto';
  /** Encoder frame duration in ms (one of {@link OPUS_FRAME_MS}); defaults to {@link DEFAULT_FRAME_MS}. */
  frameMs: OpusFrameMs;
  /** Samples per frame at `sampleRate` (= `frameSamplesAtRate(sampleRate, frameMs)`), precomputed. */
  frameSamples: number;
}

const HEAD_PRESKIP_OFFSET = 10; // OpusHead: "OpusHead"(8) + version(1) + channelCount(1) → pre-skip @10 (LE)

/**
 * Read the encoder pre-skip from an OpusHead (RFC 7845 §5.1) when the config `description` carries one.
 * WebCodecs passes the OpusHead as the `AudioDecoderConfig.description`; libopus needs the pre-skip to
 * know how many leading 48 kHz samples are decoder warm-up to discard. Returns 0 when there is no (or a
 * too-short) head — a valid Opus stream still decodes; only the head trim is then unavailable here.
 */
export function preSkipFromDescription(description: AllowSharedBufferSource | undefined): number {
  if (description === undefined) return 0;
  const bytes =
    description instanceof Uint8Array
      ? description
      : ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description);
  if (bytes.length < HEAD_PRESKIP_OFFSET + 2) return 0;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== 'OpusHead') return 0;
  return (bytes[HEAD_PRESKIP_OFFSET] ?? 0) | ((bytes[HEAD_PRESKIP_OFFSET + 1] ?? 0) << 8); // u16 LE
}

/** Narrow an arbitrary number to an {@link OpusDecodeRate}, or `undefined` if Opus can't output it. */
export function asDecodeRate(rate: number): OpusDecodeRate | undefined {
  return (OPUS_DECODE_RATES as readonly number[]).includes(rate)
    ? (rate as OpusDecodeRate)
    : undefined;
}

/**
 * Validate + normalize an {@link AudioDecoderConfig} for the Opus wasm decoder. Enforces Opus codec id,
 * a supported output rate, and mono/stereo; extracts the pre-skip from the OpusHead `description`. A bad
 * config is a typed {@link MediaError} (`decode-error`) — never a silent wrong-rate decode.
 */
export function normalizeOpusDecoderConfig(config: AudioDecoderConfig): OpusDecoderInit {
  if (config.codec !== 'opus') {
    throw new MediaError('decode-error', `opus: wasm-opus cannot decode codec '${config.codec}'`);
  }
  const sampleRate = asDecodeRate(config.sampleRate);
  if (sampleRate === undefined) {
    throw new MediaError(
      'decode-error',
      `opus: unsupported output sampleRate ${config.sampleRate} (allowed: ${OPUS_DECODE_RATES.join('/')})`,
    );
  }
  const channels = config.numberOfChannels;
  if (channels < 1 || channels > OPUS_MAX_CHANNELS) {
    throw new MediaError('decode-error', `opus: wasm-opus supports 1–2 channels, got ${channels}`);
  }
  return { sampleRate, channels, preSkip: preSkipFromDescription(config.description) };
}

/**
 * Validate + normalize an {@link AudioEncoderConfig} for the Opus wasm encoder. Enforces Opus codec id, a
 * libopus-acceptable input rate, mono/stereo, and an Opus-legal frame duration (default 20 ms via the
 * optional `opus.frameDuration` µs hint WebCodecs defines); precomputes the per-frame sample count used
 * by {@link FrameAccumulator}. A bad config is a typed {@link MediaError} (`encode-error`).
 */
export function normalizeOpusEncoderConfig(config: AudioEncoderConfig): OpusEncoderInit {
  if (config.codec !== 'opus') {
    throw new MediaError('encode-error', `opus: wasm-opus cannot encode codec '${config.codec}'`);
  }
  if (asDecodeRate(config.sampleRate) === undefined) {
    throw new MediaError(
      'encode-error',
      `opus: unsupported input sampleRate ${config.sampleRate} (allowed: ${OPUS_DECODE_RATES.join('/')})`,
    );
  }
  const channels = config.numberOfChannels;
  if (channels < 1 || channels > OPUS_MAX_CHANNELS) {
    throw new MediaError('encode-error', `opus: wasm-opus supports 1–2 channels, got ${channels}`);
  }
  const frameMs = frameMsFromConfig(config);
  return {
    sampleRate: config.sampleRate,
    channels,
    bitrate: typeof config.bitrate === 'number' && config.bitrate > 0 ? config.bitrate : 'auto',
    frameMs,
    frameSamples: frameSamplesAtRate(config.sampleRate, frameMs),
  };
}

/**
 * The WebCodecs `AudioEncoderConfig` carries an optional Opus-specific `opus: { frameDuration }` (in
 * microseconds) the spec defines; the bundled `lib.dom` type omits it, so read it through a typed local
 * view (no `any`). Falls back to {@link DEFAULT_FRAME_MS}; a non-Opus-legal value is a typed error.
 */
type AudioEncoderConfigOpus = AudioEncoderConfig & { opus?: { frameDuration?: number } };

export function frameMsFromConfig(config: AudioEncoderConfig): OpusFrameMs {
  const micros = (config as AudioEncoderConfigOpus).opus?.frameDuration;
  if (micros === undefined) return DEFAULT_FRAME_MS;
  const ms = micros / 1000;
  if (!isValidFrameMs(ms)) {
    throw new MediaError(
      'encode-error',
      `opus: frameDuration ${micros}µs is not an Opus frame size (${OPUS_FRAME_MS.join('/')} ms)`,
    );
  }
  return ms;
}

// ============ the wasm-core contract (what BUILD.md must produce) ============

/**
 * The narrow, synchronous surface the libopus-in-wasm glue must expose for the driver to drive it
 * (see `BUILD.md`). It is deliberately tiny — one decoder and one encoder object, each holding native
 * (wasm-heap) state — so the JS glue produced by `wasm-pack build --target web` maps to it directly.
 *
 * Lifetime: the driver constructs exactly one {@link OpusWasmDecoder}/{@link OpusWasmEncoder} per stream
 * and calls `free()` once on teardown (cancel, flush, or error); the wasm module owns the heap buffers.
 */
export interface OpusWasmCore {
  /** Create a libopus decoder (`opus_decoder_create`) for the validated init. */
  createDecoder(init: OpusDecoderInit): OpusWasmDecoder;
  /** Create a libopus encoder (`opus_encoder_create` + `OPUS_SET_BITRATE`) for the validated init. */
  createEncoder(init: OpusEncoderInit): OpusWasmEncoder;
}

/** A live libopus decoder: feed Opus packets, get interleaved f32 PCM at the configured output rate. */
export interface OpusWasmDecoder {
  /**
   * Decode one Opus packet (`opus_decode_float`) into interleaved f32 PCM. `samples` is the per-channel
   * sample count the caller expects ({@link packetDurationSamples} rescaled to the output rate); the
   * returned array length is `samples × channels`.
   */
  decode(packet: Uint8Array, samples: number): Float32Array;
  /** Release the native decoder (`opus_decoder_destroy`). Idempotent. */
  free(): void;
}

/** A live libopus encoder: feed fixed-size interleaved f32 frames, get Opus packets. */
export interface OpusWasmEncoder {
  /**
   * Encode one interleaved f32 frame of exactly `frameSamples × channels` values (`opus_encode_float`)
   * into a single Opus packet. Returns the packet bytes (a fresh `Uint8Array`).
   */
  encode(frame: Float32Array): Uint8Array;
  /** Release the native encoder (`opus_encoder_destroy`). Idempotent. */
  free(): void;
}
