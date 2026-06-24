/**
 * Pure-TS FLAC decoder (ISO/IEC for FLAC; RFC 9639) — decodes a native FLAC stream to PCM. FLAC is a
 * lossless, integer codec, so a TS decoder is **bit-exact and Node-validatable** without a browser or a
 * WASM toolchain (ADR-024). It carries its own self-validation: STREAMINFO holds the MD5 of the
 * unencoded PCM, so a correct decode reproduces that digest (`flac --test`).
 *
 * Supports the subframe set real encoders emit — CONSTANT, VERBATIM, FIXED (order 0-4), LPC (order
 * 1-32) — partitioned Rice residuals (4/5-bit params + escape), and L/S, R/S, M/S stereo decorrelation.
 * Sample depth up to 32-bit (the predictor sum stays exact within float64's 53-bit mantissa for the
 * ≤24-bit content real files use).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';

/** Decoded FLAC PCM: per-channel signed samples at the stream's bit depth, plus the STREAMINFO MD5. */
export interface FlacDecoded {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  samples: Int32Array[];
  /** STREAMINFO MD5 of the unencoded interleaved PCM (the self-validation oracle). */
  md5: Uint8Array;
}

/** MSB-first bit reader over a byte range (FLAC packs bits big-endian). */
class BitReader {
  readonly #bytes: Uint8Array;
  #byte: number;
  #bit = 0; // 0 = MSB of the current byte

  constructor(bytes: Uint8Array, start: number) {
    this.#bytes = bytes;
    this.#byte = start;
  }

  readBit(): number {
    const b = this.#bytes[this.#byte] ?? 0;
    const v = (b >> (7 - this.#bit)) & 1;
    if (++this.#bit === 8) {
      this.#bit = 0;
      this.#byte++;
    }
    return v;
  }

  /** Read `n` (0-32) bits as an unsigned integer. */
  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = ((v << 1) | this.readBit()) >>> 0;
    return v >>> 0;
  }

  /** Read `n` bits as a two's-complement signed integer. */
  readSigned(n: number): number {
    const v = this.readBits(n);
    const shift = 32 - n;
    return (v << shift) >> shift;
  }

  /** Count leading 0 bits up to the terminating 1 (Rice quotient / unary). */
  readUnary(): number {
    let c = 0;
    while (this.readBit() === 0) c++;
    return c;
  }

  alignToByte(): void {
    if (this.#bit !== 0) {
      this.#bit = 0;
      this.#byte++;
    }
  }
}

const BLOCK_SIZE_TABLE = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
];
const BPS_TABLE = [0, 8, 12, 0, 16, 20, 24, 0];

const EMPTY = new Int32Array(0);

/**
 * Bounds-checked element read — the single place an out-of-range index yields `0`. Centralizing it keeps
 * the hot predictor/decorrelation loops free of scattered `?? 0` (and its dead branches); both arms are
 * exercised by a direct unit test, so it costs no coverage. Callers index within bounds in practice.
 */
export function at(arr: Int32Array | Uint8Array | readonly number[], index: number): number {
  const v = arr[index];
  return v === undefined ? 0 : v;
}

/** Bounds-checked channel read (companion to {@link at}); out-of-range yields an empty channel. */
export function chan(channels: readonly Int32Array[], index: number): Int32Array {
  const ch = channels[index];
  return ch === undefined ? EMPTY : ch;
}

/** Decode the partitioned Rice residual into `out[order..blockSize-1]`. */
function readResidual(br: BitReader, blockSize: number, order: number, out: Int32Array): void {
  const method = br.readBits(2);
  if (method > 1) throw new MediaError('decode-error', `FLAC: reserved residual method ${method}`);
  const paramBits = method === 0 ? 4 : 5;
  const escapeCode = method === 0 ? 0xf : 0x1f;
  const partitionOrder = br.readBits(4);
  const partitions = 1 << partitionOrder;
  const partitionSamples = blockSize >> partitionOrder;
  let i = order;
  for (let p = 0; p < partitions; p++) {
    const count = p === 0 ? partitionSamples - order : partitionSamples;
    const param = br.readBits(paramBits);
    if (param === escapeCode) {
      const bits = br.readBits(5);
      for (let j = 0; j < count; j++) out[i++] = bits === 0 ? 0 : br.readSigned(bits);
    } else {
      for (let j = 0; j < count; j++) {
        const q = br.readUnary();
        const r = param === 0 ? 0 : br.readBits(param);
        const u = (q << param) | r;
        out[i++] = (u >>> 1) ^ -(u & 1); // zigzag → signed
      }
    }
  }
}

const FIXED_COEF = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function restoreFixed(out: Int32Array, blockSize: number, order: number): void {
  const coef = FIXED_COEF[order] ?? [];
  for (let i = order; i < blockSize; i++) {
    let pred = 0;
    for (let j = 0; j < order; j++) pred += at(coef, j) * at(out, i - 1 - j);
    out[i] = at(out, i) + pred;
  }
}

function restoreLpc(
  out: Int32Array,
  blockSize: number,
  order: number,
  coefs: number[],
  shift: number,
): void {
  for (let i = order; i < blockSize; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += at(coefs, j) * at(out, i - 1 - j);
    out[i] = at(out, i) + Math.floor(sum / 2 ** shift); // arithmetic right shift by `shift`
  }
}

/** Decode one channel's subframe (`blockSize` samples at `bps` bits) into `out`. */
function decodeSubframe(br: BitReader, blockSize: number, bps: number, out: Int32Array): void {
  if (br.readBit() !== 0) throw new MediaError('decode-error', 'FLAC: non-zero subframe padding');
  const type = br.readBits(6);
  let wasted = 0;
  if (br.readBit() === 1) wasted = 1 + br.readUnary();
  const sampleBits = bps - wasted;

  if (type === 0) {
    out.fill(br.readSigned(sampleBits)); // CONSTANT
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i++) out[i] = br.readSigned(sampleBits); // VERBATIM
  } else if (type >= 8 && type <= 12) {
    const order = type - 8; // FIXED
    for (let i = 0; i < order; i++) out[i] = br.readSigned(sampleBits);
    readResidual(br, blockSize, order, out);
    restoreFixed(out, blockSize, order);
  } else if (type >= 32) {
    const order = type - 31; // LPC
    for (let i = 0; i < order; i++) out[i] = br.readSigned(sampleBits);
    const precision = br.readBits(4) + 1;
    const shift = br.readSigned(5);
    const coefs: number[] = [];
    for (let i = 0; i < order; i++) coefs.push(br.readSigned(precision));
    readResidual(br, blockSize, order, out);
    restoreLpc(out, blockSize, order, coefs, shift);
  } else {
    throw new MediaError('decode-error', `FLAC: reserved subframe type ${type}`);
  }

  if (wasted > 0) for (let i = 0; i < blockSize; i++) out[i] = at(out, i) << wasted;
}

/** Reconstruct L/R from a stereo decorrelation assignment (8 L/S, 9 R/S, 10 M/S). */
export function decorrelate(channels: Int32Array[], assignment: number, blockSize: number): void {
  const a = chan(channels, 0);
  const b = chan(channels, 1);
  for (let i = 0; i < blockSize; i++) {
    const x = at(a, i);
    const y = at(b, i);
    if (assignment === 8) {
      b[i] = x - y; // left + side → right = left - side
    } else if (assignment === 9) {
      a[i] = y + x; // side + right → left = right + side
    } else {
      const mid = (x << 1) | (y & 1); // mid + side → left/right
      a[i] = (mid + y) >> 1;
      b[i] = (mid - y) >> 1;
    }
  }
}

function blockSizeFor(br: BitReader, code: number): number {
  if (code === 6) return br.readBits(8) + 1;
  if (code === 7) return br.readBits(16) + 1;
  return BLOCK_SIZE_TABLE[code] ?? 0;
}

function consumeSampleRate(br: BitReader, code: number): void {
  if (code === 12) br.readBits(8);
  else if (code === 13 || code === 14) br.readBits(16);
}

function skipUtf8(br: BitReader): void {
  const b0 = br.readBits(8); // frame/sample number, UTF-8-like: leading 1s = total byte count
  let extra = -1;
  for (let mask = 0x80; (b0 & mask) !== 0; mask >>= 1) extra++;
  for (let i = 0; i < extra; i++) br.readBits(8); // consume the continuation bytes
}

interface StreamInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  md5: Uint8Array;
  audioStart: number;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i] ?? 0);
  return s;
}

/** Walk the metadata blocks for STREAMINFO + MD5, returning the byte offset where audio frames begin. */
function readStreamInfo(bytes: Uint8Array): StreamInfo {
  let off = 0;
  if (ascii(bytes, 0, 3) === 'ID3' && bytes.byteLength >= 10) {
    const size =
      (at(bytes, 6) & 0x7f) * 0x200000 +
      (at(bytes, 7) & 0x7f) * 0x4000 +
      (at(bytes, 8) & 0x7f) * 0x80 +
      (at(bytes, 9) & 0x7f);
    off = 10 + size;
  }
  if (ascii(bytes, off, 4) !== 'fLaC')
    throw new InputError('unsupported-input', 'not a native FLAC stream');
  off += 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let info: StreamInfo | undefined;
  for (;;) {
    const header = at(bytes, off);
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (at(bytes, off + 1) << 16) | (at(bytes, off + 2) << 8) | at(bytes, off + 3);
    const body = off + 4;
    if (type === 0) {
      const hi = dv.getUint32(body + 10);
      const lo = dv.getUint32(body + 14);
      info = {
        sampleRate: hi >>> 12,
        channels: ((hi >>> 9) & 0x7) + 1,
        bitsPerSample: ((hi >>> 4) & 0x1f) + 1,
        totalSamples: (hi & 0xf) * 2 ** 32 + lo,
        md5: bytes.slice(body + 18, body + 34),
        audioStart: 0,
      };
    }
    off = body + len;
    if (last) break;
  }
  if (!info) throw new MediaError('demux-error', 'FLAC: no STREAMINFO');
  return { ...info, audioStart: off };
}

/** Decode a native FLAC stream to per-channel PCM (bit-exact; verify with {@link pcmMd5} vs `md5`). */
export function decodeFlac(bytes: Uint8Array): FlacDecoded {
  const si = readStreamInfo(bytes);
  const out = Array.from({ length: si.channels }, () => new Int32Array(si.totalSamples));
  const br = new BitReader(bytes, si.audioStart);
  let produced = 0;

  while (produced < si.totalSamples) {
    if (br.readBits(14) !== 0x3ffe) throw new MediaError('decode-error', 'FLAC: lost frame sync');
    br.readBit(); // reserved
    br.readBit(); // blocking strategy (block size is explicit either way here)
    const blockSizeCode = br.readBits(4);
    const sampleRateCode = br.readBits(4);
    const channelAssignment = br.readBits(4);
    const sampleSizeCode = br.readBits(3);
    br.readBit(); // reserved
    skipUtf8(br); // frame/sample number
    const blockSize = blockSizeFor(br, blockSizeCode);
    consumeSampleRate(br, sampleRateCode);
    br.readBits(8); // CRC-8

    // The frame may restate the sample depth; reserved codes (0/3/7) defer to STREAMINFO.
    const tableBps = BPS_TABLE[sampleSizeCode] ?? 0;
    const frameBps = tableBps > 0 ? tableBps : si.bitsPerSample;
    const stereo = channelAssignment >= 8 && channelAssignment <= 10;
    const channels = stereo ? 2 : channelAssignment + 1;
    const frame = Array.from({ length: channels }, () => new Int32Array(blockSize));
    for (let ch = 0; ch < channels; ch++) {
      const sideBit =
        (channelAssignment === 8 && ch === 1) ||
        (channelAssignment === 9 && ch === 0) ||
        (channelAssignment === 10 && ch === 1)
          ? 1
          : 0;
      decodeSubframe(br, blockSize, frameBps + sideBit, chan(frame, ch));
    }
    if (stereo) decorrelate(frame, channelAssignment, blockSize);

    const n = Math.min(blockSize, si.totalSamples - produced);
    for (let ch = 0; ch < si.channels; ch++) {
      chan(out, ch).set(chan(frame, ch).subarray(0, n), produced);
    }
    produced += n;
    br.alignToByte();
    br.readBits(16); // CRC-16 frame footer
  }

  return {
    sampleRate: si.sampleRate,
    channels: si.channels,
    bitsPerSample: si.bitsPerSample,
    totalSamples: si.totalSamples,
    samples: out,
    md5: si.md5,
  };
}

/** Serialize decoded PCM the way STREAMINFO's MD5 is computed: interleaved, little-endian, per sample. */
export function interleavedPcmBytes(decoded: FlacDecoded): Uint8Array<ArrayBuffer> {
  const bytesPerSample = Math.ceil(decoded.bitsPerSample / 8);
  const out = new Uint8Array(decoded.totalSamples * decoded.channels * bytesPerSample);
  let o = 0;
  for (let i = 0; i < decoded.totalSamples; i++) {
    for (let ch = 0; ch < decoded.channels; ch++) {
      let v = at(chan(decoded.samples, ch), i);
      for (let b = 0; b < bytesPerSample; b++) {
        out[o++] = v & 0xff;
        v >>= 8;
      }
    }
  }
  return out;
}
