import { describe, expect, it } from 'vitest';
import { h264AccessUnitIsKeyPicture, h264AccessUnitRangeIsKeyPicture } from './h264-access-unit.ts';

function unsignedExpGolomb(value: number): string {
  const codeNum = value + 1;
  const suffix = codeNum.toString(2);
  return `${'0'.repeat(suffix.length - 1)}${suffix}`;
}

function bits(bitsValue: string): Uint8Array {
  const padded = bitsValue.padEnd(Math.ceil(bitsValue.length / 8) * 8, '0');
  const out = new Uint8Array(padded.length / 8);
  for (let index = 0; index < out.byteLength; index++) {
    out[index] = Number.parseInt(padded.slice(index * 8, index * 8 + 8), 2);
  }
  return out;
}

function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeroRun = 0;
  for (const value of rbsp) {
    if (zeroRun >= 2 && value <= 3) {
      out.push(3);
      zeroRun = 0;
    }
    out.push(value);
    zeroRun = value === 0 ? zeroRun + 1 : 0;
  }
  return new Uint8Array(out);
}

function sliceNal(nalType: 1 | 2 | 5, sliceType: number, firstMacroblock = 0): Uint8Array {
  const rbsp = escapeRbsp(bits(unsignedExpGolomb(firstMacroblock) + unsignedExpGolomb(sliceType)));
  return new Uint8Array([nalType === 5 ? 0x65 : 0x40 | nalType, ...rbsp]);
}

function accessUnit(lengthSize: 1 | 2 | 4, ...nals: readonly Uint8Array[]): Uint8Array {
  const size = nals.reduce((total, nal) => total + lengthSize + nal.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    let length = nal.byteLength;
    for (let index = lengthSize - 1; index >= 0; index--) {
      out[offset + index] = length & 0xff;
      length >>>= 8;
    }
    offset += lengthSize;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

describe('H.264 AVC access-unit picture classification', () => {
  it.each([1, 2, 4] as const)(
    'recognizes non-IDR I pictures with %i-byte NAL lengths',
    (lengthSize) => {
      expect(h264AccessUnitIsKeyPicture(accessUnit(lengthSize, sliceNal(1, 2)), lengthSize)).toBe(
        true,
      );
      expect(h264AccessUnitIsKeyPicture(accessUnit(lengthSize, sliceNal(1, 7)), lengthSize)).toBe(
        true,
      ); // all-slice form I + 5
    },
  );

  it('recognizes SI and IDR pictures, and skips non-VCL prefixes', () => {
    const sei = new Uint8Array([0x06, 0x05, 0xff, 0x80]);
    expect(h264AccessUnitIsKeyPicture(accessUnit(4, sei, sliceNal(1, 4)), 4)).toBe(true);
    expect(h264AccessUnitIsKeyPicture(accessUnit(4, sei, sliceNal(5, 0)), 4)).toBe(true);
  });

  it('keeps P, B, and SP pictures non-key', () => {
    for (const sliceType of [0, 1, 3, 5, 6, 8]) {
      expect(h264AccessUnitIsKeyPicture(accessUnit(4, sliceNal(1, sliceType)), 4)).toBe(false);
    }
  });

  it('removes emulation-prevention bytes while decoding the slice header', () => {
    expect(h264AccessUnitIsKeyPicture(accessUnit(4, sliceNal(1, 2, 65_535)), 4)).toBe(true);
  });

  it('returns undefined for malformed lengths, truncated slice headers, and no VCL NAL', () => {
    expect(h264AccessUnitIsKeyPicture(new Uint8Array([0, 0, 0, 8, 0x41]), 4)).toBeUndefined();
    expect(h264AccessUnitIsKeyPicture(accessUnit(4, new Uint8Array([0x41])), 4)).toBeUndefined();
    expect(
      h264AccessUnitIsKeyPicture(accessUnit(4, new Uint8Array([0x67, 0x64, 0, 0x28])), 4),
    ).toBeUndefined();
    expect(h264AccessUnitIsKeyPicture(accessUnit(4, sliceNal(1, 2)), 3)).toBeUndefined();
  });

  it('classifies an exact byte range without treating adjacent storage as access-unit data', () => {
    const picture = accessUnit(4, sliceNal(1, 2));
    const storage = new Uint8Array(picture.byteLength + 7);
    storage.fill(0xff);
    storage.set(picture, 3);

    expect(h264AccessUnitRangeIsKeyPicture(storage, 3, picture.byteLength, 4)).toBe(true);
    expect(h264AccessUnitRangeIsKeyPicture(storage, 3, picture.byteLength - 1, 4)).toBeUndefined();
    expect(h264AccessUnitRangeIsKeyPicture(storage, -1, picture.byteLength, 4)).toBeUndefined();
    expect(h264AccessUnitRangeIsKeyPicture(storage, 3, Number.MAX_SAFE_INTEGER, 4)).toBeUndefined();
  });
});
