/**
 * Pure MP3-encode helpers and the typed contract implemented by `mp3-enc-core.js`.
 *
 * The lossy Layer-III encode (psychoacoustics, quantisation, Huffman coding, the bit reservoir) lives in
 * LAME compiled to WebAssembly and vendored beside this file (see `BUILD.md`). Everything here is
 * deterministic integer/byte logic with a real spec and a falsifiable oracle, so it is exhaustively
 * validated in Node (`mp3-enc.test.ts`):
 *
 *  - **config normalisation**: the MPEG-legal output sample rates, the per-version CBR bitrate tables, and
 *    the VBR quality range — all measured against the vendored core, not guessed;
 *  - the 20-byte little-endian **`enc_init` parameter block** the core reads;
 *  - **planar input validation** and sample→microsecond timing;
 *  - the **frame splitter**: LAME hands back an opaque byte run per `enc_encode`, whose boundaries do NOT
 *    align with MPEG frames, but every seam above wants one `EncodedAudioChunk` per frame with its own
 *    presentation timestamp. {@link Mp3FrameSplitter} re-frames that run using the shared header parser in
 *    {@link import('../wasm-mp3/mp3.ts')} — the same code the MP3 *decoder* is validated against.
 */

import { MediaError } from '../../contracts/errors.ts';
import {
  MP3_CODEC,
  MP3_MAX_CHANNELS,
  isFrameSync,
  isMp3Codec,
  parseMp3FrameHeader,
} from '../wasm-mp3/mp3.ts';

export { MP3_CODEC, MP3_MAX_CHANNELS, isMp3Codec };

// ============ MPEG Layer-III output legality ============

/**
 * Every sample rate an MPEG-audio Layer III bitstream can declare (ISO/IEC 11172-3 Table 8 for MPEG-1,
 * 13818-3 for MPEG-2, and the MPEG-2.5 extension). An encode request outside this set has no legal MP3
 * representation; we reject it rather than let LAME silently resample to a rate the published
 * `AudioDecoderConfig` would then misreport.
 */
export const MP3_SAMPLE_RATES: readonly number[] = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
] as const;

// Constant bitrates (kbps) the vendored LAME core actually honours, per MPEG version. These are the
// spec tables narrowed to what LAME accepts without silently substituting another value: anything outside
// the table comes back clamped to the nearest end (see BUILD.md "Measured legality"), so we clamp first
// and keep the published config truthful.
const CBR_KBPS_MPEG1: readonly number[] = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;
const CBR_KBPS_MPEG2: readonly number[] = [
  8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const;
const CBR_KBPS_MPEG2_5: readonly number[] = [8, 16, 24, 32, 40, 48, 56, 64] as const;

/** LAME's VBR quality scale: 0.0 (best) … 9.999 (worst); 10 and above is rejected by the core. */
export const MP3_VBR_QUALITY_MIN = 0;
export const MP3_VBR_QUALITY_MAX = 10; // exclusive
/** LAME's own default VBR quality, mirrored so an unrated request behaves like `lame -V4`. */
export const MP3_DEFAULT_VBR_QUALITY = 4;

/** The `vbrQuality` sentinel that tells the core to use the constant bitrate instead. */
const VBR_DISABLED = -1;

/** True when `sampleRate` is one of the nine rates an MP3 frame header can encode. */
export function isMp3SampleRate(sampleRate: number): boolean {
  return MP3_SAMPLE_RATES.includes(sampleRate);
}

/** Samples per channel one Layer-III frame carries: 1152 for MPEG-1, 576 for MPEG-2/2.5. */
export function mp3SamplesPerFrame(sampleRate: number): number {
  return sampleRate >= 32000 ? 1152 : 576;
}

/** The constant bitrates (kbps) legal at `sampleRate`, ascending. Empty for a non-MP3 rate. */
export function mp3CbrBitratesKbps(sampleRate: number): readonly number[] {
  if (!isMp3SampleRate(sampleRate)) return [];
  if (sampleRate >= 32000) return CBR_KBPS_MPEG1;
  if (sampleRate >= 16000) return CBR_KBPS_MPEG2;
  if (sampleRate >= 8000) return CBR_KBPS_MPEG2_5;
  return [];
}

/**
 * Snap a WebCodecs `bitrate` hint (bits/second) to the nearest constant bitrate legal at `sampleRate`,
 * breaking ties upward. MPEG Layer III has only a handful of coded bitrates per version, so an arbitrary
 * hint cannot be honoured exactly; snapping here (rather than letting LAME clamp internally) keeps the
 * frame headers we emit and the config we publish in agreement.
 */
export function snapMp3BitrateKbps(bitsPerSecond: number, sampleRate: number): number {
  const table = mp3CbrBitratesKbps(sampleRate);
  const first = table[0];
  if (first === undefined) {
    throw new MediaError('encode-error', `mp3: no constant bitrate table for ${sampleRate} Hz`);
  }
  const wanted = bitsPerSecond / 1000;
  let best = first;
  for (const candidate of table) {
    const delta = Math.abs(candidate - wanted);
    const bestDelta = Math.abs(best - wanted);
    if (delta < bestDelta || (delta === bestDelta && candidate > best)) best = candidate;
  }
  return best;
}

// ============ destination gapless timing ============

/**
 * Samples a conformant Layer III decoder emits **before** the first sample this encoder was handed —
 * the destination priming a muxer must trim to make the encode gapless.
 *
 * MP3 is a lapped transform: LAME primes its analysis window ahead of the first program sample, and
 * the decoder's synthesis filterbank adds its own latency, so decoding our own output yields exactly
 * this many samples of lead-in in front of the program. The core exposes no accessor for either
 * number, and — unlike a `lame`-CLI stream — the bitstream it emits carries **no Xing/LAME info
 * frame** to signal them: its first byte run is an ordinary audio frame, which `mp3-enc.test.ts`
 * asserts across the whole CBR matrix. So this is not the usual `576 + 529` folklore taken on faith:
 * it is **measured** against the vendored core by encoding broadband noise, decoding it back with the
 * independent `wasm-mp3` Symphonia core, and taking the lag that maximises the normalised
 * cross-correlation against the input. That measurement is pinned as a test across every MPEG version
 * (1 / 2 / 2.5), both channel modes, and CBR and VBR — it is 1105 in every case, because neither
 * component scales with the 1152 ↔ 576 frame geometry.
 *
 * It is expressed in the **decoder's** domain, which is the domain `TrackInfo.gapless.leadingSamples`
 * is defined in; the MP3 muxer converts it back to the Xing/LAME tag's encoder-delay field by removing
 * the Layer III synthesis delay (`MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES`), recovering LAME's own 576.
 */
export const MP3_ENCODER_LEAD_IN_SAMPLES = 1105;

// ============ encoder configuration ============

/** The exact five values the vendored core's `enc_init` parameter block carries. */
export interface Mp3EncoderInit {
  /** 1 (mono) or 2 (stereo) — MP3 carries no more. */
  readonly channels: number;
  /** Input PCM rate; also the emitted bitstream's rate (we never let LAME resample). */
  readonly sampleRate: number;
  /** Constant bitrate in kbps, or `0` to encode VBR at {@link Mp3EncoderInit.vbrQuality}. */
  readonly cbrBitrateKbps: number;
  /** VBR quality 0..<10, or `-1` when {@link Mp3EncoderInit.cbrBitrateKbps} is set. */
  readonly vbrQuality: number;
  /**
   * The bitstream sample rate, pinned to {@link Mp3EncoderInit.sampleRate}. Left at the core's `0`
   * ("pick one") LAME downsamples whenever it judges the requested bitrate too low for the input rate —
   * e.g. 56 kbps at 44100 Hz silently becomes a 24000 Hz stream — which would make the published
   * `AudioDecoderConfig` a lie. Pinning it is what makes this driver honest.
   */
  readonly outputSampleRate: number;
}

/** Optional MP3-specific tuning a caller may attach to a WebCodecs `AudioEncoderConfig`. */
interface Mp3EncoderTuning {
  /** LAME VBR quality (0 best … 9.999 worst); used only when no `bitrate` is requested. */
  readonly vbrQuality?: number;
}

type Mp3AudioEncoderConfig = AudioEncoderConfig & {
  readonly mp3?: Mp3EncoderTuning;
};

/**
 * Validate + normalise a WebCodecs `AudioEncoderConfig` into the core's init values. A `bitrate` hint
 * selects CBR (snapped to the nearest legal rate); its absence selects LAME VBR at
 * {@link MP3_DEFAULT_VBR_QUALITY}, overridable via the `mp3.vbrQuality` tuning field. Rejects anything
 * MP3 cannot represent — a non-MP3 codec string, >2 channels, or a sample rate with no frame-header code.
 */
export function normalizeMp3EncoderConfig(config: AudioEncoderConfig): Mp3EncoderInit {
  if (!isMp3Codec(config.codec)) {
    throw new MediaError('encode-error', `mp3: wasm-mp3-enc cannot encode codec '${config.codec}'`);
  }
  const sampleRate = config.sampleRate;
  if (!isMp3SampleRate(sampleRate)) {
    throw new MediaError(
      'encode-error',
      `mp3: ${sampleRate} Hz has no MPEG Layer III representation (legal: ${MP3_SAMPLE_RATES.join(
        ', ',
      )})`,
    );
  }
  const channels = config.numberOfChannels;
  if (!Number.isInteger(channels) || channels < 1 || channels > MP3_MAX_CHANNELS) {
    throw new MediaError(
      'encode-error',
      `mp3: wasm-mp3-enc supports 1-${MP3_MAX_CHANNELS} channels, got ${channels}`,
    );
  }
  const bitrate = config.bitrate;
  const wantsCbr = bitrate !== undefined && Number.isFinite(bitrate) && bitrate > 0;
  if (wantsCbr) {
    return {
      channels,
      sampleRate,
      cbrBitrateKbps: snapMp3BitrateKbps(bitrate, sampleRate),
      vbrQuality: VBR_DISABLED,
      outputSampleRate: sampleRate,
    };
  }
  const requested = (config as Mp3AudioEncoderConfig).mp3?.vbrQuality;
  const vbrQuality =
    requested !== undefined &&
    Number.isFinite(requested) &&
    requested >= MP3_VBR_QUALITY_MIN &&
    requested < MP3_VBR_QUALITY_MAX
      ? requested
      : MP3_DEFAULT_VBR_QUALITY;
  return { channels, sampleRate, cbrBitrateKbps: 0, vbrQuality, outputSampleRate: sampleRate };
}

/** Byte length of the `enc_init` parameter block (5 fields, 4 bytes each). */
export const MP3_ENC_PARAMS_BYTES = 20;

/**
 * Serialise {@link Mp3EncoderInit} into the little-endian block the core's `enc_init` reads: four int32
 * fields around one **float32** (`vbrQuality`) at offset 12. WebAssembly memory is always little-endian,
 * so the layout is fixed regardless of host byte order.
 */
export function buildMp3EncoderParams(init: Mp3EncoderInit): Uint8Array {
  const out = new Uint8Array(MP3_ENC_PARAMS_BYTES);
  const view = new DataView(out.buffer);
  view.setInt32(0, init.channels, true);
  view.setInt32(4, init.sampleRate, true);
  view.setInt32(8, init.cbrBitrateKbps, true);
  view.setFloat32(12, init.vbrQuality, true);
  view.setInt32(16, init.outputSampleRate, true);
  return out;
}

// ============ PCM input ============

/**
 * Check that `planes` is exactly `channels` planar f32 buffers of `frames` samples each — the shape the
 * core's `enc_get_pcm` buffers expect. LAME reads planar channels directly, so unlike Vorbis there is no
 * interleave step; this is the only guard between an `AudioData` copy-out and a wasm memory write.
 */
export function validateMp3Planes(
  planes: readonly Float32Array[],
  frames: number,
  channels: number,
): void {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new MediaError('encode-error', `mp3: invalid frame count ${frames}`);
  }
  if (planes.length !== channels) {
    throw new MediaError(
      'encode-error',
      `mp3: expected ${channels} planar channel(s), got ${planes.length}`,
    );
  }
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    if (plane === undefined || plane.length !== frames) {
      throw new MediaError('encode-error', `mp3: plane ${c} is not ${frames} frames`);
    }
  }
}

/** Microseconds for a sample offset at a sample rate (WebCodecs timestamps are µs). */
export function samplesToMicros(samples: number, sampleRate: number): number {
  return Math.round((samples / sampleRate) * 1_000_000);
}

/** Extract a message from an unknown thrown value (the wasm glue rejects with a string or an Error). */
export function errMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'unknown error';
}

// ============ frame splitter ============

const EMPTY = new Uint8Array(0);

/**
 * Re-frame LAME's opaque output runs into whole MPEG-audio frames.
 *
 * `enc_encode` returns however many bytes the bit reservoir happened to flush; a run routinely ends
 * mid-frame and a single run may span several frames. Every downstream seam (`EncodedAudioChunk`, the MP4
 * and MP3 muxers, packet tables) is per-frame, so the driver feeds each run through this splitter and
 * emits one chunk per complete frame, holding the partial tail for the next run.
 *
 * Framing is decided solely by the shared header parser: a valid sync word plus a parseable
 * version/layer/bitrate/rate/padding, from which the frame's byte size follows. A byte that does not begin
 * a parseable header is skipped (resync), so a corrupt run cannot desynchronise the stream permanently.
 */
export class Mp3FrameSplitter {
  /** Bytes carried over from previous runs: a partial frame, and any leading unsynced garbage. */
  #tail: Uint8Array = EMPTY;

  /** Bytes still buffered because they do not yet form a complete frame. */
  get pendingBytes(): number {
    return this.#tail.length;
  }

  /** Append one encoder output run and return every complete frame it completed, in order. */
  push(run: Uint8Array): readonly Uint8Array[] {
    const buf = concatBytes(this.#tail, run);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const b0 = buf[offset] as number;
      const b1 = buf[offset + 1] as number;
      if (!isFrameSync(b0, b1)) {
        offset++;
        continue;
      }
      let size: number;
      try {
        size = parseMp3FrameHeader(buf, offset).frameSize;
      } catch {
        offset++; // a sync word whose header fields are not a real frame — keep scanning
        continue;
      }
      if (offset + size > buf.length) break; // incomplete: wait for the next run
      frames.push(buf.slice(offset, offset + size));
      offset += size;
    }
    this.#tail = offset === 0 ? buf : buf.slice(offset);
    return frames;
  }

  /**
   * Drain after the core's final flush. LAME emits whole frames, so a well-formed stream ends with
   * `pendingBytes === 0`; anything left over is a truncated frame the caller must surface rather than
   * quietly drop. Returns the leftover bytes (empty when the stream ended cleanly) and clears the buffer.
   */
  finish(): Uint8Array {
    const leftover = this.#tail;
    this.#tail = EMPTY;
    return leftover;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ============ the wasm core contract ============

/** One live LAME encoder over a single logical stream. */
export interface Mp3WasmEncoder {
  /** Encode `frames` samples of planar f32 (one buffer per channel); returns the raw output run. */
  encode(planes: readonly Float32Array[], frames: number): Uint8Array;
  /** Flush the bit reservoir and return the final run. Idempotent-safe: later calls return no bytes. */
  finish(): Uint8Array;
  /** Release the native encoder (safe to call more than once). */
  free(): void;
}

/**
 * The surface `mp3-enc-core.js` exposes to the driver once the vendored wasm has instantiated. The glue is
 * a pure ABI shim: it takes the already-validated {@link buildMp3EncoderParams} block rather than a config
 * object, so every encoding policy decision stays in this Node-tested module.
 */
export interface Mp3EncWasmCore {
  /** The MIME type the core reports (`audio/mpeg`) — the sanity check that the right wasm loaded. */
  readonly mimeType: string;
  /** The vendored core's own version string (`wasm-media-encoders-0.7.0`). */
  readonly version: string;
  createEncoder(params: Uint8Array, channels: number): Mp3WasmEncoder;
}
