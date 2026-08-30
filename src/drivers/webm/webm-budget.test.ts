import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { MAX_EBML_ELEMENTS_PER_CONTAINER, elements } from './ebml.ts';
import { parseWebm } from './webm-driver.ts';

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function sizeVint(n: number, width?: number): number[] {
  const w = width ?? (n < 0x7f ? 1 : n < 0x3fff ? 2 : n < 0x1fffff ? 3 : n < 0xfffffff ? 4 : 5);
  const out: number[] = [];
  for (let i = w - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) & 0xff);
  out[0] = (out[0] ?? 0) | (0x80 >> (w - 1));
  return out;
}
function uintN(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(value / 256 ** i) & 0xff);
  return out;
}
const el = (id: readonly number[], data: readonly number[]): number[] => [
  ...id,
  ...sizeVint(data.length),
  ...data,
];
function join(parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), off);
    off += part.length;
  }
  return out;
}

const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Void: [0xec],
} as const;

function minimalWebmWithVoids(voidCount: number): Uint8Array {
  const header = el(E.EBML, [
    ...el(E.EBMLVersion, [1]),
    ...el(E.EBMLReadVersion, [1]),
    ...el(E.EBMLMaxIDLength, [4]),
    ...el(E.EBMLMaxSizeLength, [8]),
    ...el(E.DocType, str('webm')),
    ...el(E.DocTypeVersion, [2]),
    ...el(E.DocTypeReadVersion, [2]),
  ]);
  const info = el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 3)));
  const tracks = el(
    E.Tracks,
    el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(640, 2)), ...el(E.PixelHeight, uintN(360, 2))]),
    ]),
  );
  const voids: number[][] = [];
  for (let i = 0; i < voidCount; i++) voids.push(el(E.Void, [0x00]));
  const segmentBody = join([info, tracks, ...voids.map((v) => Uint8Array.from(v))]);
  const segment = [...E.Segment, ...sizeVint(segmentBody.byteLength), ...segmentBody];
  return join([Uint8Array.from(header), Uint8Array.from(segment)]);
}

function elementsCount(bytes: Uint8Array, start: number, end: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let n = 0;
  for (const _el of elements(dv, start, end)) n++;
  return n;
}

describe('WebM EBML element-count budget — malformed-input protection (REQUIREMENTS §8.4)', () => {
  it('rejects >MAX elements with typed demux-error and budget message', () => {
    // base 2 (Info+Tracks) + MAX voids = MAX+2 > MAX
    const bytes = minimalWebmWithVoids(MAX_EBML_ELEMENTS_PER_CONTAINER);
    expect(() => parseWebm(bytes)).toThrow(MediaError);
    try {
      parseWebm(bytes);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
      expect((e as Error).message).toMatch(/budget exceeded/);
    }
    // Direct elements() path also budget-enforced (on Segment payload)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Find Segment
    let segStart = -1;
    let segEnd = -1;
    for (const el of elements(dv, 0, dv.byteLength)) {
      if (el.id === 0x18538067) {
        segStart = el.dataStart;
        segEnd = el.dataEnd;
        break;
      }
    }
    if (segStart !== -1) {
      expect(() => elementsCount(bytes, segStart, segEnd)).toThrowError(/budget exceeded/);
    }
  });

  it('accepts exactly MAX elements at the boundary', () => {
    // 2 base + (MAX-2) voids = MAX
    const bytes = minimalWebmWithVoids(MAX_EBML_ELEMENTS_PER_CONTAINER - 2);
    const info = parseWebm(bytes);
    expect(info.tracks.length).toBe(1);
    expect(info.tracks[0]?.codec).toBe('vp8');
    // Also elements() boundary should not throw
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const el of elements(dv, 0, dv.byteLength)) {
      if (el.id === 0x18538067) {
        expect(() => elementsCount(bytes, el.dataStart, el.dataEnd)).not.toThrow();
        break;
      }
    }
  });

  it('20× randomized 0–9 voids stay bit-exact on tracks', () => {
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let iter = 0; iter < 20; iter++) {
      const n = next() % 10;
      const bytes = minimalWebmWithVoids(n);
      const info = parseWebm(bytes);
      expect(info.tracks.length).toBe(1);
      expect(info.tracks[0]?.width).toBe(640);
    }
  });

  it('rejects truncated/malformed without OOM', () => {
    const valid = minimalWebmWithVoids(1);
    const truncated = valid.subarray(0, 10);
    expect(() => parseWebm(truncated)).toThrow();
    expect(() => parseWebm(new Uint8Array([0, 1, 2, 3]))).toThrow();
    // Truncated tail inside last Void may still parse in non-strict mode; ensure no OOM either way
    const cut = valid.subarray(0, valid.byteLength - 3);
    try {
      parseWebm(cut);
    } catch (e) {
      expect((e as Error).message).toMatch(/WebM|EBML|budget|truncated|not a WebM/i);
    }
  });
});
