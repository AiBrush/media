import { describe, expect, it } from 'vitest';
import {
  av1CodecString,
  avcCodecString,
  h273Matrix,
  h273Primaries,
  h273Transfer,
  hevcCodecString,
  parseEsds,
  qtPcmCodec,
  videoColorSpaceFromColr,
} from './codec-strings.ts';

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

function ascBits(bits: string): number[] {
  const compact = bits.replaceAll(' ', '');
  const padded = compact.padEnd(Math.ceil(compact.length / 8) * 8, '0');
  const bytes: number[] = [];
  for (let offset = 0; offset < padded.length; offset += 8) {
    bytes.push(Number.parseInt(padded.slice(offset, offset + 8), 2));
  }
  return bytes;
}

describe('parseEsds', () => {
  it('parses AAC-LC into mp4a.40.2 with the AudioSpecificConfig', () => {
    const info = parseEsds(esds({ asc: [0x12, 0x10] }));
    expect(info.codec).toBe('mp4a.40.2');
    expect(info.objectTypeIndication).toBe(0x40);
    expect(info.audioObjectType).toBe(2);
    expect(info.asc && [...info.asc]).toEqual([0x12, 0x10]);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
  });

  it('takes mono channel configuration from AAC ASC instead of a stale MP4 sample-entry default', () => {
    const info = parseEsds(esds({ asc: [0x11, 0x88] }));
    expect(info.audioObjectType).toBe(2);
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1);
  });

  it('uses the backward-compatible SBR extension output rate for implicit HE-AAC', () => {
    // Real HE-AAC ASC: AAC-LC core at 24 kHz/stereo, syncExtensionType=0x2b7, SBR output at 48 kHz.
    const info = parseEsds(esds({ asc: [0x13, 0x08, 0x56, 0xe5, 0x98] }));
    expect(info.audioObjectType).toBe(2);
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1); // AAC-LC core; the outer sample entry carries 2-channel output
    expect(info.sbrPresent).toBe(true);
  });

  it('parses escaped object types, explicit sample rates, and signaled SBR geometry', () => {
    const escaped = parseEsds(esds({ asc: ascBits('11111 000001 0100 0010') }));
    expect(escaped).toMatchObject({
      codec: 'mp4a.40.33',
      audioObjectType: 33,
      sampleRate: 44_100,
      channels: 2,
    });

    const explicitRate = parseEsds(
      esds({ asc: ascBits(`00010 1111 ${(48_000).toString(2).padStart(24, '0')} 0110`) }),
    );
    expect(explicitRate).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      channels: 6,
    });

    const sbr = parseEsds(esds({ asc: ascBits('00101 0110 0010 0011 00010') }));
    expect(sbr).toMatchObject({
      audioObjectType: 5,
      sampleRate: 48_000,
      channels: 2,
      sbrPresent: true,
    });

    const sbrCore22 = parseEsds(esds({ asc: ascBits('00101 0110 0010 0011 10110 0001') }));
    expect(sbrCore22).toMatchObject({
      audioObjectType: 5,
      sampleRate: 48_000,
      channels: 1,
      sbrPresent: true,
    });
  });

  it('keeps truncated AudioSpecificConfig geometry absent instead of guessing', () => {
    expect(parseEsds(esds({ asc: [] }))).toMatchObject({ codec: 'mp4a.40' });
    const truncated = parseEsds(esds({ asc: [0x12] }));
    expect(truncated.codec).toBe('mp4a.40');
    expect('sampleRate' in truncated).toBe(false);
    expect('channels' in truncated).toBe(false);
  });

  it('skips ES flag-driven optional fields (streamDependence)', () => {
    const info = parseEsds(esds({ asc: [0x12, 0x10], esFlags: 0x80, extra: [0x00, 0x02] }));
    expect(info.codec).toBe('mp4a.40.2');
  });

  it('skips URL and OCR optional ES descriptor fields without shifting DecoderConfig', () => {
    const info = parseEsds(
      esds({
        asc: [0x12, 0x10],
        esFlags: 0x60,
        extra: [0x02, 0x6f, 0x6b, 0x00, 0x03],
      }),
    );
    expect(info.codec).toBe('mp4a.40.2');
    expect(info.sampleRate).toBe(44_100);
  });

  it('walks GA-specific extension syntax for ER and scalable AAC object types', () => {
    for (const audioObjectType of [17, 19, 20, 23]) {
      const typeBits = audioObjectType.toString(2).padStart(5, '0');
      const info = parseEsds(esds({ asc: ascBits(`${typeBits} 0100 0010 0 0 1 000 0`) }));
      expect(info).toMatchObject({
        codec: `mp4a.40.${audioObjectType}`,
        audioObjectType,
        sampleRate: 44_100,
        channels: 2,
      });
    }

    const scalable = parseEsds(esds({ asc: ascBits('10110 0100 0010 0 0 1 0000000000000000') }));
    expect(scalable).toMatchObject({
      codec: 'mp4a.40.22',
      audioObjectType: 22,
      sampleRate: 44_100,
      channels: 2,
    });
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

// ============ H.273 colour code points → WebCodecs (task #11 / ADR-185) ============
//
// Oracles are the ISO/IEC 23091-2 (H.273) tables applied by hand — independent of the mapping code.
// Unmappable code points (unspecified=2, reserved, or no WebCodecs equivalent) must yield undefined:
// an honest omission the decoder resolves with its own default, never a guessed value.

describe('h273Primaries', () => {
  it('maps the WebCodecs-representable code points', () => {
    expect(h273Primaries(1)).toBe('bt709');
    expect(h273Primaries(5)).toBe('bt470bg');
    expect(h273Primaries(6)).toBe('smpte170m');
    expect(h273Primaries(9)).toBe('bt2020');
    expect(h273Primaries(12)).toBe('smpte432');
  });
  it('maps 7 (SMPTE-240M) to smpte170m — H.273 defines identical chromaticities for 6 and 7', () => {
    expect(h273Primaries(7)).toBe('smpte170m');
  });
  it('returns undefined for unspecified/unknown (2, 0, 13, 99)', () => {
    for (const code of [2, 0, 13, 99]) expect(h273Primaries(code)).toBeUndefined();
  });
});

describe('h273Transfer', () => {
  it('maps the WebCodecs-representable code points', () => {
    expect(h273Transfer(1)).toBe('bt709');
    expect(h273Transfer(6)).toBe('smpte170m');
    expect(h273Transfer(8)).toBe('linear');
    expect(h273Transfer(13)).toBe('iec61966-2-1');
    expect(h273Transfer(16)).toBe('pq');
    expect(h273Transfer(18)).toBe('hlg');
  });
  it('maps 14/15 (BT.2020 10/12-bit) to bt709 — H.273 defines the identical transfer function', () => {
    expect(h273Transfer(14)).toBe('bt709');
    expect(h273Transfer(15)).toBe('bt709');
  });
  it('returns undefined for unspecified and for curves WebCodecs cannot name (2, 7=SMPTE-240M, 99)', () => {
    for (const code of [2, 7, 99]) expect(h273Transfer(code)).toBeUndefined();
  });
});

describe('h273Matrix', () => {
  it('maps the WebCodecs-representable code points', () => {
    expect(h273Matrix(0)).toBe('rgb');
    expect(h273Matrix(1)).toBe('bt709');
    expect(h273Matrix(5)).toBe('bt470bg');
    expect(h273Matrix(6)).toBe('smpte170m');
    expect(h273Matrix(9)).toBe('bt2020-ncl');
  });
  it('returns undefined for unspecified and for matrices WebCodecs cannot name (2, 7=SMPTE-240M, 10=bt2020-cl)', () => {
    for (const code of [2, 7, 10, 99]) expect(h273Matrix(code)).toBeUndefined();
  });
});

describe('videoColorSpaceFromColr', () => {
  it('builds a full init from nclx with the range flag', () => {
    expect(
      videoColorSpaceFromColr({
        colourType: 'nclx',
        primaries: 1,
        transfer: 1,
        matrix: 1,
        fullRange: true,
      }),
    ).toEqual({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true });
  });
  it('builds a partial init from a partially-specified nclc (unspecified fields omitted)', () => {
    expect(
      videoColorSpaceFromColr({ colourType: 'nclc', primaries: 2, transfer: 2, matrix: 1 }),
    ).toEqual({ matrix: 'bt709' });
  });
  it('returns undefined when nothing maps (all unspecified) — no empty colorSpace object', () => {
    expect(
      videoColorSpaceFromColr({ colourType: 'nclc', primaries: 2, transfer: 2, matrix: 2 }),
    ).toBeUndefined();
  });
});

// ============ QuickTime PCM sample-entry fourccs → engine PCM tokens (QTFF sound descriptions) ====
//
// Oracle: the QTFF "Sound Sample Description" format table + CoreAudio format flags, cross-checked
// against ffmpeg's codec_name for the same entries (pcm_s16le ↔ pcm-s16 etc., see the ffprobe-truth
// golden). `littleEndian` is the `enda` atom value (undefined = absent ⇒ each format's default).

describe('qtPcmCodec', () => {
  it('maps the fixed-endianness 16-bit formats', () => {
    expect(qtPcmCodec('sowt', 16, undefined)).toBe('pcm-s16');
    expect(qtPcmCodec('twos', 16, undefined)).toBe('pcm-s16be');
    expect(qtPcmCodec('twos', 24, undefined)).toBeUndefined();
  });
  it('maps the 8-bit formats where endianness is moot', () => {
    expect(qtPcmCodec('raw ', 8, undefined)).toBe('pcm-u8');
    expect(qtPcmCodec('twos', 8, undefined)).toBe('pcm-s8');
  });
  it('maps float/integer wide formats: big-endian default, enda=1 flips to little-endian', () => {
    expect(qtPcmCodec('fl32', 32, undefined)).toBe('pcm-f32be');
    expect(qtPcmCodec('fl32', 32, true)).toBe('pcm-f32');
    expect(qtPcmCodec('fl64', 64, false)).toBe('pcm-f64be');
    expect(qtPcmCodec('fl64', 64, true)).toBe('pcm-f64');
    expect(qtPcmCodec('in24', 24, true)).toBe('pcm-s24');
    expect(qtPcmCodec('in24', 24, undefined)).toBe('pcm-s24be');
    expect(qtPcmCodec('in32', 32, true)).toBe('pcm-s32');
    expect(qtPcmCodec('in32', 32, false)).toBe('pcm-s32be');
  });
  it('maps lpcm (v2) from constBitsPerChannel + formatSpecificFlags', () => {
    // CoreAudio flags: 0x1 float, 0x2 big-endian, 0x4 signed integer, 0x8 packed.
    expect(qtPcmCodec('lpcm', 16, undefined, 0xc)).toBe('pcm-s16'); // signed+packed, LE
    expect(qtPcmCodec('lpcm', 16, undefined, 0xe)).toBe('pcm-s16be'); // + big-endian
    expect(qtPcmCodec('lpcm', 32, undefined, 0x9)).toBe('pcm-f32'); // float+packed, LE
    expect(qtPcmCodec('lpcm', 32, undefined, 0xb)).toBe('pcm-f32be');
    expect(qtPcmCodec('lpcm', 64, undefined, 0xb)).toBe('pcm-f64be'); // float+BE
    expect(qtPcmCodec('lpcm', 64, undefined, 0x9)).toBe('pcm-f64');
    expect(qtPcmCodec('lpcm', 8, undefined, 0xc)).toBe('pcm-s8');
    expect(qtPcmCodec('lpcm', 8, undefined, 0x8)).toBe('pcm-u8'); // unsigned 8-bit
    expect(qtPcmCodec('lpcm', 24, undefined, 0x6)).toBe('pcm-s24be');
    expect(qtPcmCodec('lpcm', 24, undefined, 0x4)).toBe('pcm-s24');
    expect(qtPcmCodec('lpcm', 32, undefined, 0x6)).toBe('pcm-s32be');
    expect(qtPcmCodec('lpcm', 32, undefined, 0x4)).toBe('pcm-s32');
  });
  it('returns undefined for non-PCM or unrepresentable combinations (honest fourcc fallback)', () => {
    expect(qtPcmCodec('mp4a', 16, undefined)).toBeUndefined();
    expect(qtPcmCodec('alaw', 8, undefined)).toBeUndefined();
    expect(qtPcmCodec('sowt', 8, undefined)).toBeUndefined(); // sowt is 16-bit by definition
    expect(qtPcmCodec('lpcm', 16, undefined, 0x8)).toBeUndefined(); // unsigned 16-bit: no token
    expect(qtPcmCodec('lpcm', 20, undefined, 0xc)).toBeUndefined(); // 20-bit: no token
    expect(qtPcmCodec('raw ', 16, undefined)).toBeUndefined(); // 16-bit unsigned: no token
  });
});
