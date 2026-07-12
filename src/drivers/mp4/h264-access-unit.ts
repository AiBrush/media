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
  return h264AccessUnitRangeIsKeyPicture(accessUnit, 0, accessUnit.byteLength, lengthSize);
}

/**
 * Classify one exact access-unit range inside retained storage without allocating a typed-array view.
 * Invalid or escaping intervals are unknown, matching a malformed/truncated standalone access unit.
 */
export function h264AccessUnitRangeIsKeyPicture(
  storage: Uint8Array,
  start: number,
  length: number,
  lengthSize: number,
): boolean | undefined {
  if (lengthSize !== 1 && lengthSize !== 2 && lengthSize !== 4) return undefined;
  const end = start + length;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    length < 0 ||
    end > storage.byteLength
  ) {
    return undefined;
  }

  let offset = start;
  while (offset < end) {
    if (offset + lengthSize > end) return undefined;
    let nalLength = 0;
    for (let index = 0; index < lengthSize; index++) {
      nalLength = nalLength * 256 + (storage[offset + index] as number);
    }
    offset += lengthSize;
    if (nalLength <= 0 || offset + nalLength > end) return undefined;

    const header = storage[offset] as number;
    if ((header & 0x80) !== 0) return undefined; // forbidden_zero_bit
    const nalType = header & 0x1f;
    if (nalType === NAL_TYPE_CODED_SLICE_IDR) return true;
    if (
      nalType === NAL_TYPE_CODED_SLICE_NON_IDR ||
      nalType === NAL_TYPE_CODED_SLICE_DATA_PARTITION_A ||
      nalType === NAL_TYPE_CODED_SLICE_AUXILIARY
    ) {
      return sliceHeaderIsKeyPicture(storage, offset + 1, offset + nalLength);
    }
    offset += nalLength;
  }
  return undefined;
}

/** Read only `first_mb_in_slice` and `slice_type` while removing EBSP prevention bytes on demand. */
function sliceHeaderIsKeyPicture(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean | undefined {
  let offset = start;
  let zeroRun = 0;
  let currentByte = 0;
  let remainingBits = 0;
  let sliceType = 0;
  for (let field = 0; field < 2; field++) {
    let leadingZeros = 0;
    while (true) {
      if (remainingBits === 0) {
        let found = false;
        while (offset < end) {
          const value = bytes[offset] as number;
          offset++;
          if (zeroRun >= 2 && value === 3) {
            const escaped = bytes[offset];
            if (escaped === undefined || offset >= end || escaped > 3) return undefined;
            zeroRun = 0;
            continue;
          }
          zeroRun = value === 0 ? zeroRun + 1 : 0;
          currentByte = value;
          remainingBits = 8;
          found = true;
          break;
        }
        if (!found) return undefined;
      }
      remainingBits--;
      if (((currentByte >> remainingBits) & 1) !== 0) break;
      leadingZeros++;
      if (leadingZeros > 31) return undefined;
    }
    let suffix = 0;
    for (let index = 0; index < leadingZeros; index++) {
      if (remainingBits === 0) {
        let found = false;
        while (offset < end) {
          const value = bytes[offset] as number;
          offset++;
          if (zeroRun >= 2 && value === 3) {
            const escaped = bytes[offset];
            if (escaped === undefined || offset >= end || escaped > 3) return undefined;
            zeroRun = 0;
            continue;
          }
          zeroRun = value === 0 ? zeroRun + 1 : 0;
          currentByte = value;
          remainingBits = 8;
          found = true;
          break;
        }
        if (!found) return undefined;
      }
      remainingBits--;
      suffix = suffix * 2 + ((currentByte >> remainingBits) & 1);
    }
    const value = 2 ** leadingZeros - 1 + suffix;
    if (field === 1) sliceType = value % 5;
  }
  return sliceType === I_SLICE_TYPE || sliceType === SI_SLICE_TYPE;
}
