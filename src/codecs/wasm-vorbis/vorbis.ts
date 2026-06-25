/**
 * Pure, Node-testable Vorbis helpers for the WASM decode driver (docs/architecture/04 wasm tier, 05
 * §CodecDriver, ADR-032). The lossy MDCT/floor/residue decode lives in Symphonia compiled to wasm (see
 * `BUILD.md`); this module holds the deterministic, spec-defined glue that is validated in Node:
 *
 *  - **Xiph header lacing** (RFC 5215 / WebM `CodecPrivate`): build/parse the `0x02`-led `[ident][comment]
 *    [setup]` extra-data blob that Symphonia's Vorbis decoder consumes — exactly the form a WebCodecs
 *    `AudioDecoderConfig.description` and a WebM Vorbis private carry. Round-trips bit-exactly.
 *  - **Ogg page → packet** de-lacing (RFC 3533 §6): split an Ogg logical bitstream into its packets, so
 *    an Ogg-framed Vorbis source yields the 3 setup packets + audio packets the wasm core wants.
 *  - **planar↔interleaved f32**, channel/rate validation, and the {@link VorbisWasmCore} contract.
 *
 * Everything here is integer/byte logic with a real spec and a falsifiable oracle — no oracle that cannot
 * fail (directive 6).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';

// ============ Vorbis invariants ============

/** The Vorbis codec id WebCodecs / RFC 6381 use. */
export const VORBIS_CODEC = 'vorbis' as const;

/** Leading byte of a Xiph-laced Vorbis extra-data blob: `0x02` = "3 packets" (count − 1). */
export const XIPH_LACED_LEADING = 0x02 as const;

/** Vorbis identification-header packet type (RFC 5215 §3): the first setup packet. */
export const VORBIS_IDENT_PACKET = 0x01 as const;
/** Vorbis setup-header packet type (RFC 5215 §3): the third setup packet. */
export const VORBIS_SETUP_PACKET = 0x05 as const;

/** This driver bridges mono…surround Vorbis to WebCodecs `AudioData`; Vorbis allows up to 255 channels. */
export const VORBIS_MAX_CHANNELS = 8 as const;

// ============ Xiph header lacing (RFC 5215 / WebM CodecPrivate) ============

/** Encode a length as Xiph lacing: floor(len/255) bytes of 0xFF then `len mod 255` (RFC 3533 §6). */
export function xiphLaceLength(len: number): number[] {
  if (len < 0 || !Number.isInteger(len)) {
    throw new MediaError('demux-error', `vorbis: invalid lacing length ${len}`);
  }
  const out: number[] = [];
  let remaining = len;
  while (remaining >= 255) {
    out.push(255);
    remaining -= 255;
  }
  out.push(remaining);
  return out;
}

/**
 * Build the `0x02`-led Xiph-laced extra-data blob Symphonia expects from the three Vorbis header packets
 * (identification, comment, setup). Layout: `0x02`, lace(ident.length), lace(comment.length), then
 * `ident ‖ comment ‖ setup` (the setup length is implicit — the remainder). This is the canonical
 * `CodecPrivate` form; the WebCodecs `description` for Ogg/WebM Vorbis is normally already in it.
 */
export function buildVorbisExtradata(
  ident: Uint8Array,
  comment: Uint8Array,
  setup: Uint8Array,
): Uint8Array {
  const lace = [
    XIPH_LACED_LEADING,
    ...xiphLaceLength(ident.length),
    ...xiphLaceLength(comment.length),
  ];
  const out = new Uint8Array(lace.length + ident.length + comment.length + setup.length);
  out.set(lace, 0);
  let o = lace.length;
  out.set(ident, o);
  o += ident.length;
  out.set(comment, o);
  o += comment.length;
  out.set(setup, o);
  return out;
}

/** The three Vorbis header packets carried by a Xiph-laced extra-data blob. */
export interface VorbisHeaders {
  ident: Uint8Array;
  comment: Uint8Array;
  setup: Uint8Array;
}

/**
 * Parse a `0x02`-led Xiph-laced extra-data blob back into its three packets — the inverse of
 * {@link buildVorbisExtradata}, mirroring Symphonia's `unpack_xiph_laced_extradata`. Used to validate the
 * builder and to inspect a `description`. Rejects a non-`0x02` lead or truncated lacing with a typed error.
 */
export function parseVorbisExtradata(blob: Uint8Array): VorbisHeaders {
  const lead = blob[0];
  if (lead !== XIPH_LACED_LEADING) {
    throw new InputError('unsupported-input', `vorbis: extradata is not Xiph-laced (lead ${lead})`);
  }
  let i = 1;
  const readLen = (): number => {
    let len = 0;
    for (;;) {
      const v = blob[i++];
      if (v === undefined) throw new MediaError('demux-error', 'vorbis: truncated length lacing');
      len += v;
      if (v < 255) return len;
    }
  };
  const identLen = readLen();
  const commentLen = readLen();
  const body = blob.subarray(i);
  if (identLen + commentLen > body.length) {
    throw new MediaError('demux-error', 'vorbis: header lengths exceed buffer');
  }
  return {
    ident: body.subarray(0, identLen),
    comment: body.subarray(identLen, identLen + commentLen),
    setup: body.subarray(identLen + commentLen),
  };
}

// ============ Ogg page → packet de-lacing (RFC 3533) ============

/** A demuxed Ogg packet plus the page's granule position (when the packet ends a page). */
export interface OggPacket {
  data: Uint8Array;
  /** Absolute granule position of the page this packet completed, or `undefined` mid-page. */
  granulePosition?: number;
}

const OGG_CAPTURE = 0x4f676753; // 'OggS'

/**
 * De-lace an entire Ogg logical bitstream into its packets (RFC 3533 §6). Each page header is 27 bytes +
 * a `segments`-long lacing table; a packet is the concatenation of segments until one whose lacing value
 * is < 255 (a 255 segment continues the packet, possibly onto the next page's first segment). This is the
 * minimal demux the wasm Vorbis core needs (the codec wants packets, not pages); it ignores the multiplex
 * of multiple logical streams by reading every page in order (single-stream Vorbis files, the common case).
 */
export function readOggPackets(bytes: Uint8Array): OggPacket[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: OggPacket[] = [];
  let offset = 0;
  let pending: Uint8Array[] = []; // segments of a packet still being assembled across 255-continuations

  while (offset + 27 <= bytes.length) {
    if (view.getUint32(offset) !== OGG_CAPTURE) {
      throw new InputError('unsupported-input', `vorbis: lost Ogg capture at byte ${offset}`);
    }
    const granuleLo = view.getUint32(offset + 6, true);
    const granuleHi = view.getUint32(offset + 10, true);
    const granulePosition = granuleHi * 2 ** 32 + granuleLo;
    const segCount = bytes[offset + 26] ?? 0;
    const lacingStart = offset + 27;
    const dataStart = lacingStart + segCount;
    if (dataStart > bytes.length) throw new MediaError('demux-error', 'vorbis: truncated Ogg page');

    let dataPos = dataStart;
    let segLen = 0;
    for (let s = 0; s < segCount; s++) {
      const lace = bytes[lacingStart + s] ?? 0;
      segLen += lace;
      if (lace < 255) {
        // Packet boundary: gather [pending… + this run] into one packet.
        const run = bytes.subarray(dataPos, dataPos + segLen);
        const data = pending.length === 0 ? run : concat([...pending, run]);
        packets.push({ data, granulePosition });
        pending = [];
        dataPos += segLen;
        segLen = 0;
      }
    }
    if (segLen > 0) {
      // Trailing 255-run with no terminator: packet continues onto the next page.
      pending.push(bytes.subarray(dataPos, dataPos + segLen));
    }
    offset = dataPos + segLen; // next page begins just past this page's segment data
  }
  return packets;
}

/** Concatenate byte chunks into one buffer. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ============ planar ↔ interleaved f32 ============

/**
 * Split an interleaved `[c0,c1,…]` f32 buffer (what the wasm Vorbis core returns) into `channels`
 * per-channel planes — the shape an `f32-planar` `AudioData` is built from. `interleaved.length` must be
 * `frames × channels`.
 */
export function deinterleaveF32(
  interleaved: Float32Array,
  channels: number,
  frames: number,
): Float32Array[] {
  if (interleaved.length !== frames * channels) {
    throw new MediaError(
      'decode-error',
      `vorbis: interleaved length ${interleaved.length} ≠ ${frames}×${channels}`,
    );
  }
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    if (plane === undefined) throw new MediaError('decode-error', `vorbis: missing plane ${c}`);
    for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c] ?? 0;
  }
  return planes;
}

// ============ config validation ============

/** A validated decode configuration (channels/rate the driver shapes its `AudioData` from). */
export interface VorbisDecodeConfig {
  channels: number;
  sampleRate: number;
  /** The Vorbis codec-private (Xiph-laced ident‖comment‖setup) — Symphonia's `extra_data`. */
  extraData: Uint8Array;
}

/**
 * Validate + normalize an {@link AudioDecoderConfig} for the wasm Vorbis core. Requires the Vorbis codec
 * id and a non-empty `description` (the codec-private headers — Symphonia cannot init a Vorbis decoder
 * without them). Channel count is bounded to this driver's range. A bad config is a typed
 * {@link MediaError} (`decode-error`) — never a silent misconfigure.
 */
export function normalizeVorbisDecoderConfig(config: AudioDecoderConfig): VorbisDecodeConfig {
  if (config.codec !== VORBIS_CODEC) {
    throw new MediaError(
      'decode-error',
      `vorbis: wasm-vorbis cannot decode codec '${config.codec}'`,
    );
  }
  const extraData = descriptionBytes(config.description);
  if (extraData.length === 0) {
    throw new MediaError(
      'decode-error',
      'vorbis: AudioDecoderConfig.description (codec-private headers) is required',
    );
  }
  const channels = config.numberOfChannels;
  if (channels < 1 || channels > VORBIS_MAX_CHANNELS) {
    throw new MediaError(
      'decode-error',
      `vorbis: wasm-vorbis supports 1–${VORBIS_MAX_CHANNELS} channels, got ${channels}`,
    );
  }
  return { channels, sampleRate: config.sampleRate, extraData };
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
 * The surface the Symphonia-in-wasm glue exposes (see `BUILD.md`), wrapping `symphonia-codec-vorbis`. The
 * driver constructs one {@link VorbisWasmDecoder} per stream from the codec-private headers, decodes each
 * audio packet to interleaved f32, and `free()`s on teardown. Mirrors the generated `VorbisWasm` class.
 */
export interface VorbisWasmCore {
  /**
   * Construct a decoder from the Xiph-laced (or concatenated) Vorbis `extra_data`, seeded with the
   * container-declared `channels`/`sampleRate` (reconciled with the decoded buffer's own spec on the
   * first non-empty block, so the values are authoritative either way).
   */
  createDecoder(extraData: Uint8Array, channels: number, sampleRate: number): VorbisWasmDecoder;
}

/** A live Symphonia Vorbis decoder: packets in, interleaved f32 out. */
export interface VorbisWasmDecoder {
  /** Channel count parsed from the identification header. */
  readonly channels: number;
  /** Sample rate (Hz) parsed from the identification header. */
  readonly sampleRate: number;
  /** Decode one Vorbis audio packet → interleaved f32 (`frames × channels`); may be empty (overlap priming). */
  decode(packet: Uint8Array): Float32Array;
  /** Reset overlap-add state at a seek/discontinuity. */
  reset(): void;
  /** Release the native decoder. Idempotent. */
  free(): void;
}
