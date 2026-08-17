import { describe, expect, it } from 'vitest';
import { h264AvcCColors, rewriteH264AvcCColor } from '../codecs/h264-avcc-crop.ts';
import type { TrackInfo } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { readMovie } from '../drivers/mp4/mp4-driver.ts';
import { Mp4Muxer } from '../drivers/mp4/mux.ts';
import {
  assertVideoEncoderOutputBitDepth,
  videoTrackInfoFromDecoderConfig,
} from './mux-trackinfo.ts';
import { videoColorMuxIntent } from './video-stream-plan.ts';

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(
    Array.from({ length: hex.length / 2 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

/** Real libx264 High-profile avcC whose SPS has VUI timing but no colour description. */
const AVCC = fromHex(
  '0164001fffe1001a6764001facd940d83de5f0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
);

function descriptionBytes(value: AllowSharedBufferSource | undefined): Uint8Array {
  if (value === undefined) throw new Error('missing decoder description');
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

function hvcC(profileIdc: number, bitDepth: number): Uint8Array {
  const parameterSetTypes = [32, 33, 34] as const;
  const description = new Uint8Array(23 + parameterSetTypes.length * 7);
  description[0] = 1;
  description[1] = profileIdc;
  description[13] = 0xf0;
  description[15] = 0xfc;
  description[16] = 0xfc;
  description[17] = 0xf8 | (bitDepth - 8);
  description[18] = 0xf8 | (bitDepth - 8);
  description[22] = parameterSetTypes.length;
  let offset = 23;
  for (const nalType of parameterSetTypes) {
    description.set([0x80 | nalType, 0, 1, 0, 2, nalType << 1, 1], offset);
    offset += 7;
  }
  return description;
}

describe('assertVideoEncoderOutputBitDepth', () => {
  it('accepts genuine Main/Main10 records and rejects echoed Main10 labels over 8-bit hvcC', () => {
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.2.4.L120.B0', description: hvcC(2, 10) }, 10),
    ).not.toThrow();
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.1.6.L93.B0', description: hvcC(1, 8) }, 8),
    ).not.toThrow();
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.2.4.L120.B0', description: hvcC(1, 8) }, 10),
    ).toThrow(/published 8-bit hvcC/);
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.2.4.L120.B0', description: hvcC(2, 8) }, 10),
    ).toThrow(CapabilityError);
  });

  it('ignores inapplicable requests and rejects missing, malformed, or inconsistent HEVC facts', () => {
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: hvcC(1, 8) },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'avc1.42E01E', description: Uint8Array.of(1, 2) },
        10,
      ),
    ).not.toThrow();
    expect(() => assertVideoEncoderOutputBitDepth({ codec: 'hev1.2.4.L120.B0' }, 10)).toThrow(
      /missing hvcC/,
    );
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: Uint8Array.of(0) },
        10,
      ),
    ).toThrow(/malformed hvcC/);
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: Uint8Array.of(2, 2) },
        10,
      ),
    ).toThrow(/malformed hvcC/);

    const shortMain10 = hvcC(2, 10).subarray(0, 13);
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: shortMain10.buffer.slice(0, 13) },
        10,
      ),
    ).toThrow(/malformed hvcC/);
    const truncatedArray = hvcC(2, 10);
    truncatedArray[22] = 1;
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: truncatedArray },
        10,
      ),
    ).toThrow(/malformed hvcC/);
    const missingPps = hvcC(2, 10).subarray(0, 37);
    missingPps[22] = 2;
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.2.4.L120.B0', description: missingPps }, 10),
    ).toThrow(/malformed hvcC/);
    const reservedArrayBit = hvcC(2, 10);
    reservedArrayBit[23] = (reservedArrayBit[23] as number) | 0x40;
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: reservedArrayBit },
        10,
      ),
    ).toThrow(/malformed hvcC/);
    const inconsistent = hvcC(2, 10);
    inconsistent[18] = 0xf8;
    expect(() =>
      assertVideoEncoderOutputBitDepth(
        { codec: 'hev1.2.4.L120.B0', description: inconsistent },
        10,
      ),
    ).toThrow(/inconsistent-bit hvcC/);
    expect(() =>
      assertVideoEncoderOutputBitDepth({ codec: 'hev1.3.4.L120.B0', description: hvcC(3, 10) }, 10),
    ).toThrow(CapabilityError);
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function randomAccess(bytes: Uint8Array): {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

function fourccOffset(bytes: Uint8Array, fourcc: string): number {
  const code = [...fourcc].map((character) => character.charCodeAt(0));
  for (let offset = 4; offset + code.length <= bytes.byteLength; offset++) {
    if (code.every((value, index) => bytes[offset + index] === value)) return offset;
  }
  return -1;
}

const destinationCases = [
  {
    name: 'BT.709 to BT.2020 conversion',
    colorSpace: {
      primaries: 'bt2020',
      transfer: 'bt709',
      matrix: 'bt2020-ncl',
      fullRange: false,
    } as unknown as VideoColorSpaceInit,
    target: { colorspace: { to: 'bt2020' } },
    color: { primaries: 9, transferCharacteristics: 14, matrixCoefficients: 9, range: 1 },
  },
  {
    name: 'HDR to BT.709 SDR tone-map',
    colorSpace: {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    } satisfies VideoColorSpaceInit,
    target: { tonemap: { to: 'sdr' as const } },
    color: { primaries: 1, transferCharacteristics: 1, matrixCoefficients: 1, range: 1 },
  },
] as const;

describe('encoder colour metadata -> mux TrackInfo -> MP4 colr', () => {
  it.each(destinationCases)(
    'authors the encoder-published $name declaration as nclx',
    async (row) => {
      const config: VideoDecoderConfig = {
        codec: 'avc1.64001F',
        codedWidth: 856,
        codedHeight: 480,
        description: AVCC,
        colorSpace: row.colorSpace,
      };
      const info = videoTrackInfoFromDecoderConfig(
        config,
        30,
        1,
        undefined,
        videoColorMuxIntent(row.target),
      );
      expect(info.color).toEqual<TrackInfo['color']>(row.color);
      expect(h264AvcCColors(descriptionBytes(info.config?.description))).toEqual([
        {
          primaries: row.color.primaries,
          transferCharacteristics: row.color.transferCharacteristics,
          matrixCoefficients: row.color.matrixCoefficients,
          fullRange: false,
        },
      ]);

      const muxer = new Mp4Muxer();
      const trackId = muxer.addTrack(info);
      muxer.addChunkStruct(trackId, {
        timestampUs: 0,
        durationUs: 33_333,
        key: true,
        data: new Uint8Array([0x65, 0x88, 0x84]),
      });
      await muxer.finalize();
      const bytes = await collect(muxer.output);

      // Assert the authored bytes, independently of the parser: colr payload is
      // nclx + u16 primaries + u16 transfer + u16 matrix + the high-bit full-range flag.
      const typeOffset = fourccOffset(bytes, 'colr');
      expect(typeOffset).toBeGreaterThan(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(String.fromCharCode(...bytes.subarray(typeOffset + 4, typeOffset + 8))).toBe('nclx');
      expect(view.getUint16(typeOffset + 8)).toBe(row.color.primaries);
      expect(view.getUint16(typeOffset + 10)).toBe(row.color.transferCharacteristics);
      expect(view.getUint16(typeOffset + 12)).toBe(row.color.matrixCoefficients);
      expect(view.getUint8(typeOffset + 14)).toBe(0);

      expect((await readMovie(randomAccess(bytes))).tracks[0]?.colr).toEqual({
        colourType: 'nclx',
        primaries: row.color.primaries,
        transfer: row.color.transferCharacteristics,
        matrix: row.color.matrixCoefficients,
        fullRange: false,
      });
    },
  );

  it('retains the standard identity that the filter plan cannot spell in WebCodecs', () => {
    expect(videoColorMuxIntent({ colorspace: { to: 'rec.2020' } })).toEqual({
      kind: 'bt2020-sdr',
      transform: 'colorspace',
    });
    expect(() =>
      videoColorMuxIntent({
        colorspace: { to: 'bt2020' },
        tonemap: { to: 'sdr' },
      }),
    ).toThrow(CapabilityError);
    expect(videoColorMuxIntent({ colorspace: { to: 'bt709' } })).toBeUndefined();
  });

  it('keeps ordinary H.264 encoder nclx and SPS VUI declarations identical', () => {
    const publishedColor = {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    } as const;
    const info = videoTrackInfoFromDecoderConfig(
      {
        codec: 'avc1.64001F',
        description: AVCC,
        colorSpace: publishedColor,
      },
      30,
    );
    expect(info.color).toEqual({
      primaries: 1,
      transferCharacteristics: 1,
      matrixCoefficients: 1,
      range: 1,
    });
    expect(h264AvcCColors(descriptionBytes(info.config?.description))).toEqual([
      {
        primaries: 1,
        transferCharacteristics: 1,
        matrixCoefficients: 1,
        fullRange: false,
      },
    ]);
  });

  it('rejects incomplete or conflicting coded-output facts instead of stamping transform intent', () => {
    const bt2020Intent = videoColorMuxIntent({ colorspace: { to: 'bt2020' } });
    const build = (colorSpace: VideoColorSpaceInit): TrackInfo =>
      videoTrackInfoFromDecoderConfig(
        { codec: 'avc1.42C01E', colorSpace },
        30,
        undefined,
        undefined,
        bt2020Intent,
      );

    expect(() =>
      build({
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      } as unknown as VideoColorSpaceInit),
    ).toThrow(CapabilityError);
    expect(() =>
      build({
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'bt2020-ncl',
      } as unknown as VideoColorSpaceInit),
    ).toThrow(/encoder published/);
  });

  it('rewrites a conflicting SPS declaration and declines in-band or malformed SPS risk', () => {
    const intent = videoColorMuxIntent({ colorspace: { to: 'bt2020' } });
    const publishedColor = {
      primaries: 'bt2020',
      transfer: 'bt709',
      matrix: 'bt2020-ncl',
      fullRange: false,
    } as unknown as VideoColorSpaceInit;
    const conflicting = rewriteH264AvcCColor(AVCC, {
      primaries: 1,
      transferCharacteristics: 1,
      matrixCoefficients: 1,
      fullRange: false,
    });
    const info = videoTrackInfoFromDecoderConfig(
      { codec: 'avc1.64001F', description: conflicting, colorSpace: publishedColor },
      30,
      undefined,
      undefined,
      intent,
    );
    expect(h264AvcCColors(descriptionBytes(info.config?.description))).toEqual([
      { primaries: 9, transferCharacteristics: 14, matrixCoefficients: 9, fullRange: false },
    ]);

    expect(() =>
      videoTrackInfoFromDecoderConfig(
        { codec: 'avc3.64001F', description: AVCC, colorSpace: publishedColor },
        30,
        undefined,
        undefined,
        intent,
      ),
    ).toThrow(/in-band SPS replacement/);
    expect(() =>
      videoTrackInfoFromDecoderConfig(
        {
          codec: 'avc1.64001F',
          description: Uint8Array.of(1, 0x64),
          colorSpace: publishedColor,
        },
        30,
        undefined,
        undefined,
        intent,
      ),
    ).toThrow(CapabilityError);
  });

  it('omits unknown named fields and never guesses an absent range', () => {
    const info = videoTrackInfoFromDecoderConfig(
      {
        codec: 'vp09.00.10.08',
        colorSpace: {
          primaries: 'future-gamut',
          transfer: 'pq',
          matrix: 'future-matrix',
        } as unknown as VideoColorSpaceInit,
      },
      undefined,
    );
    expect(info.color).toEqual({ transferCharacteristics: 16 });

    const unknown = videoTrackInfoFromDecoderConfig(
      {
        codec: 'vp09.00.10.08',
        colorSpace: {
          primaries: 'future-gamut',
          transfer: 'future-transfer',
          matrix: 'future-matrix',
        } as unknown as VideoColorSpaceInit,
      },
      undefined,
    );
    expect('color' in unknown).toBe(false);
  });
});

describe('encoder full-range claim over RGB input — the codec default wins', () => {
  const config = (fullRange: boolean | null): VideoDecoderConfig => ({
    codec: 'avc1.64001F',
    codedWidth: 856,
    codedHeight: 480,
    description: AVCC,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange },
  });

  // A packed-RGB encoder input means the ENCODER performed RGB->YUV, and every codec here defaults that
  // conversion to studio swing. A runtime that publishes `fullRange: true` for it is contradicting the
  // samples it emitted, and with no in-band VUI the authored `colr` is the only signal a decoder gets.
  it('authors limited range for a full-range claim over RGB input', () => {
    expect(
      videoTrackInfoFromDecoderConfig(config(true), 30, 1, undefined, undefined, true).color?.range,
    ).toBe(1);
  });

  it('keeps the full-range claim when the encoder consumed planar frames', () => {
    expect(
      videoTrackInfoFromDecoderConfig(config(true), 30, 1, undefined, undefined, false).color
        ?.range,
    ).toBe(2);
    expect(videoTrackInfoFromDecoderConfig(config(true), 30, 1).color?.range).toBe(2);
  });

  it('never promotes a limited or absent declaration, whatever the input format was', () => {
    for (const rgb of [false, true]) {
      expect(
        videoTrackInfoFromDecoderConfig(config(false), 30, 1, undefined, undefined, rgb).color
          ?.range,
        `limited/${rgb}`,
      ).toBe(1);
      expect(
        videoTrackInfoFromDecoderConfig(config(null), 30, 1, undefined, undefined, rgb).color
          ?.range,
        `absent/${rgb}`,
      ).toBeUndefined();
    }
  });

  it('leaves every other colour field exactly as the encoder published it', () => {
    const withRgb = videoTrackInfoFromDecoderConfig(
      config(true),
      30,
      1,
      undefined,
      undefined,
      true,
    );
    const withPlanar = videoTrackInfoFromDecoderConfig(
      config(true),
      30,
      1,
      undefined,
      undefined,
      false,
    );
    expect({ ...withRgb.color, range: undefined }).toEqual({
      ...withPlanar.color,
      range: undefined,
    });
  });
});
