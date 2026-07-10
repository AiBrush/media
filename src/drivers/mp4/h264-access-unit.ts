/**
 * Classify an AVC-format H.264 access unit from its actual primary slice header.
 *
 * `stss` is a sync/random-access table, not a complete picture-type table: encoders can emit
 * non-IDR I pictures (commonly at scene cuts) without listing them as sync samples. Packet metadata
 * that promises ffprobe-style key-picture flags therefore has to inspect `slice_type` for samples not
 * named by `stss`. This parser is deliberately narrow: it reads only the first two unsigned
 * Exp-Golomb fields of the first base-AVC VCL NAL and allocates nothing.
 */

const NAL_TYPE_CODED_SLICE_NON_IDR = 1;
const NAL_TYPE_CODED_SLICE_DATA_PARTITION_A = 2;
const NAL_TYPE_CODED_SLICE_IDR = 5;
const NAL_TYPE_CODED_SLICE_AUXILIARY = 19;
const I_SLICE_TYPE = 2;
const SI_SLICE_TYPE = 4;

/**
 * `true` for IDR/I/SI, `false` for a well-formed P/B/SP primary slice, and `undefined` when the
 * access unit is malformed, unsupported, or has no base-AVC VCL NAL. Only legal avcC length sizes
 * (1, 2, or 4 bytes) are accepted.
 */
export function h264AccessUnitIsKeyPicture(
  accessUnit: Uint8Array,
  lengthSize: number,
): boolean | undefined {
  if (lengthSize !== 1 && lengthSize !== 2 && lengthSize !== 4) return undefined;

  let offset = 0;
  while (offset < accessUnit.byteLength) {
    if (offset + lengthSize > accessUnit.byteLength) return undefined;
    let nalLength = 0;
    for (let index = 0; index < lengthSize; index++) {
      nalLength = nalLength * 256 + (accessUnit[offset + index] as number);
    }
    offset += lengthSize;
    if (nalLength <= 0 || offset + nalLength > accessUnit.byteLength) return undefined;

    const header = accessUnit[offset] as number;
    if ((header & 0x80) !== 0) return undefined; // forbidden_zero_bit
    const nalType = header & 0x1f;
    if (nalType === NAL_TYPE_CODED_SLICE_IDR) return true;
    if (
      nalType === NAL_TYPE_CODED_SLICE_NON_IDR ||
      nalType === NAL_TYPE_CODED_SLICE_DATA_PARTITION_A ||
      nalType === NAL_TYPE_CODED_SLICE_AUXILIARY
    ) {
      try {
        const reader = new EbspBitReader(accessUnit, offset + 1, offset + nalLength);
        reader.unsignedExpGolomb(); // first_mb_in_slice
        const sliceType = reader.unsignedExpGolomb() % 5;
        return sliceType === I_SLICE_TYPE || sliceType === SI_SLICE_TYPE;
      } catch {
        return undefined;
      }
    }
    offset += nalLength;
  }
  return undefined;
}

/** Bit reader over EBSP bytes that removes `00 00 03` emulation-prevention bytes on demand. */
class EbspBitReader {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  #offset: number;
  #zeroRun = 0;
  #currentByte = 0;
  #remainingBits = 0;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.#bytes = bytes;
    this.#offset = start;
    this.#end = end;
  }

  bit(): number {
    if (this.#remainingBits === 0) {
      this.#currentByte = this.#nextRbspByte();
      this.#remainingBits = 8;
    }
    this.#remainingBits--;
    return (this.#currentByte >> this.#remainingBits) & 1;
  }

  unsignedExpGolomb(): number {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) throw new Error('H.264 Exp-Golomb overflow');
    }
    let suffix = 0;
    for (let index = 0; index < leadingZeros; index++) suffix = suffix * 2 + this.bit();
    return 2 ** leadingZeros - 1 + suffix;
  }

  #nextRbspByte(): number {
    while (this.#offset < this.#end) {
      const value = this.#bytes[this.#offset] as number;
      this.#offset++;
      if (this.#zeroRun >= 2 && value === 3) {
        const escaped = this.#bytes[this.#offset];
        if (escaped === undefined || this.#offset >= this.#end || escaped > 3) {
          throw new Error('invalid H.264 emulation-prevention sequence');
        }
        this.#zeroRun = 0;
        continue;
      }
      this.#zeroRun = value === 0 ? this.#zeroRun + 1 : 0;
      return value;
    }
    throw new Error('truncated H.264 slice header');
  }
}
