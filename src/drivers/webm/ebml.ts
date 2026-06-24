/**
 * Minimal EBML reader for WebM/MKV (ISO/Matroska). EBML elements are `ID(vint) · size(vint) · data`;
 * a vint's first byte's leading-zero count gives its length, and the leading 1 is a marker. The ID
 * keeps the marker (it identifies the element); the size strips it (it's a magnitude). Pure TS.
 */

export interface EbmlElement {
  id: number;
  dataStart: number;
  dataEnd: number;
}

/** A variable-length integer. `keepMarker` true for element IDs, false for sizes. */
export function readVint(
  dv: DataView,
  at: number,
  keepMarker: boolean,
): { value: number; length: number } | undefined {
  if (at >= dv.byteLength) return undefined;
  const first = dv.getUint8(at);
  if (first === 0) return undefined;
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || at + length > dv.byteLength) return undefined;

  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (keepMarker ? first & (mask - 1) : value) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = dv.getUint8(at + i);
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  // A size whose value bits are all 1 means "unknown size" (streamed). Signal with -1.
  if (!keepMarker && allOnes) return { value: -1, length };
  return { value, length };
}

/** Iterate the child elements within `[start, end)`. An unknown-size element runs to `end`. */
export function* elements(dv: DataView, start: number, end: number): Generator<EbmlElement> {
  let at = start;
  const limit = Math.min(end, dv.byteLength);
  while (at < limit) {
    const id = readVint(dv, at, true);
    if (!id) return;
    const size = readVint(dv, at + id.length, false);
    if (!size) return;
    const dataStart = at + id.length + size.length;
    const dataEnd = size.value < 0 ? limit : Math.min(dataStart + size.value, limit);
    if (dataEnd < dataStart) return;
    yield { id: id.value, dataStart, dataEnd };
    at = dataEnd;
  }
}

/** Big-endian unsigned integer over an element's data. */
export function readUint(dv: DataView, el: EbmlElement): number {
  let value = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) value = value * 256 + dv.getUint8(i);
  return value;
}

/** IEEE float over an element's data (4 or 8 bytes; 0 otherwise). */
export function readFloat(dv: DataView, el: EbmlElement): number {
  const len = el.dataEnd - el.dataStart;
  if (len === 4) return dv.getFloat32(el.dataStart, false);
  if (len === 8) return dv.getFloat64(el.dataStart, false);
  return 0;
}

/** ASCII string over an element's data (trailing NULs trimmed). */
export function readAscii(dv: DataView, el: EbmlElement): string {
  let out = '';
  for (let i = el.dataStart; i < el.dataEnd; i++) {
    const b = dv.getUint8(i);
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

/** Find the first child element of `id` within `[start, end)`. */
export function findChild(
  dv: DataView,
  start: number,
  end: number,
  id: number,
): EbmlElement | undefined {
  for (const el of elements(dv, start, end)) {
    if (el.id === id) return el;
  }
  return undefined;
}
