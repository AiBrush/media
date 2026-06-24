/**
 * A big-endian byte cursor + ISO-BMFF box iteration (ISO/IEC 14496-12). MP4/MOV are hand-written TS
 * (no browser dependency), so this parses in any environment. All multi-byte reads are big-endian, as
 * the format requires.
 */

/** Sequential big-endian reader over a byte range. */
export class Reader {
  readonly #u8: Uint8Array;
  readonly #view: DataView;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.#u8 = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.#u8.byteLength;
  }
  get remaining(): number {
    return this.length - this.pos;
  }
  seek(p: number): void {
    this.pos = p;
  }
  skip(n: number): void {
    this.pos += n;
  }

  u8(): number {
    const v = this.#view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.#view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.#view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u24(): number {
    const hi = this.u8();
    const mid = this.u8();
    const lo = this.u8();
    return (hi << 16) | (mid << 8) | lo;
  }
  u32(): number {
    const v = this.#view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.#view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  /** 64-bit unsigned as a JS number (safe up to 2^53; MP4 durations/offsets fit in practice). */
  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 2 ** 32 + lo;
  }
  /** 16.16 fixed-point. */
  fixed16(): number {
    return this.i32() / 65536;
  }
  fourcc(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
  /** A subarray view of `n` bytes (no copy), advancing the cursor. */
  bytes(n: number): Uint8Array {
    const b = this.#u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  /** A subarray view of `[start, end)` (no copy), without moving the cursor. */
  bytesAt(start: number, end: number): Uint8Array {
    return this.#u8.subarray(start, end);
  }
}

/** A parsed box header. `end` is the absolute offset of the byte after this box. */
export interface BoxHeader {
  type: string;
  /** Total box size including header. */
  size: number;
  headerSize: number;
  /** Absolute offset of the box start. */
  start: number;
  /** Absolute offset of the payload start. */
  payloadStart: number;
  /** Absolute offset of the byte after the box. */
  end: number;
}

/** Read a single box header at the cursor (handles 64-bit `largesize` and to-EOF `size==0`). */
export function readBoxHeader(r: Reader): BoxHeader {
  const start = r.pos;
  let size = r.u32();
  const type = r.fourcc();
  let headerSize = 8;
  if (size === 1) {
    size = r.u64();
    headerSize = 16;
  } else if (size === 0) {
    size = r.length - start;
  }
  return { type, size, headerSize, start, payloadStart: start + headerSize, end: start + size };
}

/** Iterate the boxes between the cursor and `end`, stopping on a malformed box. */
export function* boxes(r: Reader, end: number = r.length): Generator<BoxHeader> {
  while (r.pos + 8 <= end) {
    const h = readBoxHeader(r);
    if (h.size < h.headerSize || h.end > end || h.end <= h.start) return;
    yield h;
    r.seek(h.end);
  }
}

/** Read a full-box `version` + `flags` (the cursor must be at the payload start). */
export function readFullBoxHeader(r: Reader): { version: number; flags: number } {
  const version = r.u8();
  const flags = r.u24();
  return { version, flags };
}
