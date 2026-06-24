import { describe, expect, it } from 'vitest';
import { av1CodecString, avcCodecString, hevcCodecString, parseEsds } from './codec-strings.ts';

describe('avcCodecString', () => {
  it('formats avc1.PPCCLL from the avcC record', () => {
    expect(avcCodecString(new Uint8Array([1, 0x42, 0xc0, 0x1e]))).toBe('avc1.42C01E');
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x28]))).toBe('avc1.640028');
  });
  it('defaults missing bytes to zero', () => {
    expect(avcCodecString(new Uint8Array([1]))).toBe('avc1.000000');
  });
});

// HEVC/AV1 oracles are hand-computed from RFC 6381 / the AV1-ISOBMFF binding applied to the real
// config bytes (independent of the parser), so a wrong parser fails — not a bake-what-I-parse gate.
describe('hevcCodecString (RFC 6381, independent)', () => {
  it("real h265.mp4 hvcC → 'hvc1.1.6.L60.90'", () => {
    // profile_space 0 / idc 1; compat 0x60000000 bit-reversed → 6; tier L; level 60; constraint 0x90.
    const hvcC = Uint8Array.from([0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x3c]);
    expect(hevcCodecString('hvc1', hvcC)).toBe('hvc1.1.6.L60.90');
  });

  it('encodes profile-space (A), high tier, and multiple constraint bytes', () => {
    // b1=0x62 → space 1 (A), tier H, idc 2; compat 0x00000001 reversed → 0x80000000; level 120; [40,00,80].
    const hvcC = Uint8Array.from([0x01, 0x62, 0x00, 0, 0, 0x01, 0x40, 0x00, 0x80, 0, 0, 0, 0x78]);
    expect(hevcCodecString('hev1', hvcC)).toBe('hev1.A2.80000000.H120.40.00.80');
  });
});

describe('av1CodecString (AV1-ISOBMFF, independent)', () => {
  it("real four-colors.mp4 av1C → 'av01.0.08M.08'", () => {
    expect(av1CodecString(Uint8Array.from([0x81, 0x08, 0x0c, 0x00]))).toBe('av01.0.08M.08');
  });
  it("real av1.mp4 av1C → 'av01.0.00M.08'", () => {
    expect(av1CodecString(Uint8Array.from([0x81, 0x00, 0x0c, 0x00]))).toBe('av01.0.00M.08');
  });
  it('encodes profile 2 / 10-bit / high tier', () => {
    // b1=0x45 → profile 2, level 5; b2=0xc0 → tier H + high_bitdepth (10-bit).
    expect(av1CodecString(Uint8Array.from([0x81, 0x45, 0xc0, 0x00]))).toBe('av01.2.05H.10');
  });
  it('encodes profile 2 / 12-bit', () => {
    // b2=0xe0 → high_bitdepth + twelve_bit → 12-bit.
    expect(av1CodecString(Uint8Array.from([0x81, 0x45, 0xe0, 0x00]))).toBe('av01.2.05H.12');
  });
  it('encodes high_bitdepth on a non-profile-2 stream as 10-bit', () => {
    // profile 0 + high_bitdepth (b2=0x40) → 10-bit (the twelve_bit flag only applies to profile 2).
    expect(av1CodecString(Uint8Array.from([0x81, 0x08, 0x40, 0x00]))).toBe('av01.0.08M.10');
  });
});

/** Assemble an `esds` payload with the given object-type indication and optional ASC + ES flags. */
function esds(
  opts: { oti?: number; asc?: number[]; esFlags?: number; extra?: number[] } = {},
): Uint8Array {
  const oti = opts.oti ?? 0x40;
  const esFlags = opts.esFlags ?? 0;
  const extra = opts.extra ?? [];
  const dsi = opts.asc ? [0x05, opts.asc.length, ...opts.asc] : [];
  const dcdPayload = [oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
  const dcd = [0x04, dcdPayload.length, ...dcdPayload];
  const esPayload = [0x00, 0x01, esFlags, ...extra, ...dcd];
  const es = [0x03, esPayload.length, ...esPayload];
  return new Uint8Array([0, 0, 0, 0, ...es]); // fullbox header + ES_Descriptor
}

describe('parseEsds', () => {
  it('parses AAC-LC into mp4a.40.2 with the AudioSpecificConfig', () => {
    const info = parseEsds(esds({ asc: [0x12, 0x10] }));
    expect(info.codec).toBe('mp4a.40.2');
    expect(info.objectTypeIndication).toBe(0x40);
    expect(info.audioObjectType).toBe(2);
    expect(info.asc && [...info.asc]).toEqual([0x12, 0x10]);
  });

  it('skips ES flag-driven optional fields (streamDependence)', () => {
    const info = parseEsds(esds({ asc: [0x12, 0x10], esFlags: 0x80, extra: [0x00, 0x02] }));
    expect(info.codec).toBe('mp4a.40.2');
  });

  it('falls back to mp4a.<oti> for a non-AAC object type', () => {
    expect(parseEsds(esds({ oti: 0x69 }).slice()).codec).toBe('mp4a.69');
  });

  it('formats mp4a.<oti> when there is no DecoderSpecificInfo', () => {
    const info = parseEsds(esds({ oti: 0x40 }));
    expect(info.codec).toBe('mp4a.40');
    expect(info.audioObjectType).toBeUndefined();
  });

  it('returns a safe default when the ES_Descriptor tag is wrong', () => {
    const bytes = esds({ asc: [0x12, 0x10] });
    bytes[4] = 0x99; // corrupt the ES_Descriptor tag
    expect(parseEsds(bytes)).toEqual({ codec: 'mp4a', objectTypeIndication: 0 });
  });

  it('returns a safe default when the DecoderConfig tag is wrong', () => {
    const bytes = esds({ asc: [0x12, 0x10] });
    bytes[9] = 0x99; // corrupt the DecoderConfigDescriptor tag (after fullbox+ES header)
    expect(parseEsds(bytes)).toEqual({ codec: 'mp4a', objectTypeIndication: 0 });
  });
});
