import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readWavPcm } from '../../drivers/wav/pcm.ts';
import type { PcmAudio, SampleFormat } from '../../dsp/pcm.ts';
import { fixturesByContainer, loadFixture } from '../../test-support/corpus.ts';
import { decodeFlac, enumerateFlacFrameSpans, interleavedPcmBytes } from './decode.ts';
import {
  FlacFrameEncoder,
  type FlacPcm,
  encodeFlac,
  encodeFlacVerbatim,
  interleavedPcmBytes as encodedPcmBytes,
  finalizeMd5,
  flacPcmFromDecoded,
  flacPcmFromPcmAudio,
  newMd5State,
  streamInfoPrelude,
  updateMd5,
  updateMd5WithBlock,
} from './encode.ts';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function assertSampleExact(actual: readonly Int32Array[], expected: readonly Int32Array[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let ch = 0; ch < expected.length; ch++) {
    expect([...(actual[ch] ?? [])], `channel ${ch}`).toEqual([...(expected[ch] ?? [])]);
  }
}

function assertRoundTrip(pcm: FlacPcm): Uint8Array {
  const encoded = encodeFlac(pcm, { blockSize: 1024 });
  const decoded = decodeFlac(encoded);
  expect(decoded.sampleRate).toBe(pcm.sampleRate);
  expect(decoded.channels).toBe(pcm.channels);
  expect(decoded.bitsPerSample).toBe(pcm.bitsPerSample);
  expect(decoded.totalSamples).toBe(pcm.totalSamples);
  expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
  assertSampleExact(decoded.samples, pcm.samples);
  assertFrameCrcs(encoded);
  return encoded;
}

function crc8Bitwise(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc16Bitwise(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function frameNumberBytes(first: number): number {
  if ((first & 0x80) === 0) return 1;
  let ones = 0;
  for (let mask = 0x80; (first & mask) !== 0; mask >>= 1) ones++;
  return ones;
}

/** Trailing block-size bytes a frame's block-size code (header byte 2, high nibble) carries: 6→1, 7→2, else 0. */
function blockSizeTrailingBytes(byte2: number): number {
  const code = (byte2 >> 4) & 0xf;
  if (code === 6) return 1; // explicit 8-bit block size
  if (code === 7) return 2; // explicit 16-bit block size
  return 0; // standard table code — no trailing size byte(s)
}

function assertFrameCrcs(encoded: Uint8Array): void {
  const frames = enumerateFlacFrameSpans(encoded);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    const bytes = frame.data;
    const utf8Len = frameNumberBytes(bytes[4] ?? 0);
    // fixed 4-byte header + frame number + (block-size byte(s) only when explicitly coded).
    const crc8Offset = 4 + utf8Len + blockSizeTrailingBytes(bytes[2] ?? 0);
    expect(bytes[crc8Offset], 'frame header CRC-8').toBe(
      crc8Bitwise(bytes.subarray(0, crc8Offset)),
    );
    const stored16 = ((bytes[bytes.length - 2] ?? 0) << 8) | (bytes[bytes.length - 1] ?? 0);
    expect(stored16, 'frame footer CRC-16').toBe(crc16Bitwise(bytes.subarray(0, -2)));
  }
}

describe('FLAC encode — verbatim pure-TS authoring with STREAMINFO MD5 oracle', () => {
  it('encodes decoded PCM from ≥5 real FLAC fixtures and decodes bit-exactly', async () => {
    const entries = await fixturesByContainer('flac');
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const entry of entries.slice(0, 5)) {
      const source = decodeFlac(await loadFixture(entry.id));
      const encoded = assertRoundTrip(flacPcmFromDecoded(source));
      const roundTrip = decodeFlac(encoded);
      expect(hex(roundTrip.md5), entry.id).toBe(hex(source.md5));
    }
  }, 30_000);

  it('encodes existing real WAV PCM fixtures as native FLAC and decodes sample-exactly', async () => {
    const ids = ['sfx-pcm-u8.wav', 'sfx-pcm-s16.wav', 'sfx-pcm-s24.wav'] as const;

    for (const id of ids) {
      const wav = readWavPcm(await loadFixture(id));
      const pcm = flacPcmFromPcmAudio(wav, wav.format);
      const encoded = assertRoundTrip(pcm);
      expect(encoded[0], id).toBe(0x66);
      expect(encoded[1], id).toBe(0x4c);
      expect(encoded[2], id).toBe(0x61);
      expect(encoded[3], id).toBe(0x43);
    }
  });

  it('rejects unsupported PCM geometry with typed errors rather than malformed output', () => {
    const ch = Int32Array.from([0, 1, -1]);
    expect(() =>
      encodeFlac({
        sampleRate: 0,
        channels: 1,
        bitsPerSample: 16,
        totalSamples: ch.length,
        samples: [ch],
      }),
    ).toThrow(/sample rate/);
    expect(() =>
      encodeFlac({
        sampleRate: 48_000,
        channels: 9,
        bitsPerSample: 16,
        totalSamples: ch.length,
        samples: Array.from({ length: 9 }, () => ch),
      }),
    ).toThrow(/channel/);
  });

  it('rejects invalid frame-encoder lifecycle and malformed PCM planes', () => {
    const enc = new FlacFrameEncoder({ sampleRate: 48_000, channels: 1, bitsPerSample: 16 });

    expect(() => enc.encodeBlock([new Int32Array([0])], 0)).toThrow(/frame needs/);
    expect(() => enc.encodeBlock([], 1)).toThrow(/expected 1 planes/);
    expect(() => enc.finalizeStreamInfo(new Uint8Array(16))).toThrow(/produced no frames/);

    expect(() =>
      encodeFlac({
        sampleRate: 48_000,
        channels: 2,
        bitsPerSample: 16,
        totalSamples: 2,
        samples: [Int32Array.from([0, 1])],
      }),
    ).toThrow(/expected 2 channel planes/);
    expect(() =>
      encodeFlac({
        sampleRate: 48_000,
        channels: 1,
        bitsPerSample: 8,
        totalSamples: 2,
        samples: [Int32Array.from([0])],
      }),
    ).toThrow(/length must equal/);
    expect(() =>
      encodeFlac({
        sampleRate: 48_000,
        channels: 1,
        bitsPerSample: 8,
        totalSamples: 1,
        samples: [Int32Array.from([128])],
      }),
    ).toThrow(/outside signed 8-bit/);
    expect(() =>
      encodeFlac(
        {
          sampleRate: 48_000,
          channels: 1,
          bitsPerSample: 16,
          totalSamples: 1,
          samples: [Int32Array.from([0])],
        },
        { blockSize: 0 },
      ),
    ).toThrow(/blockSize/);

    const frame = enc.encodeBlock([Int32Array.from([0, 1, 2])], 3);
    expect(frame.samples).toBe(3);
    expect(() => enc.finalizeStreamInfo(new Uint8Array(15))).toThrow(/MD5/);
  });

  it('quantizes every supported PCM input format, clamps extremes, and fills missing channels with zero', () => {
    const formats: readonly [SampleFormat | number, number][] = [
      ['u8', 8],
      ['s8', 8],
      ['s16', 16],
      ['s24', 24],
      ['s32', 32],
      ['f32', 24],
      ['f64', 24],
      [20, 20],
    ];
    const audio: PcmAudio = {
      sampleRate: 48_000,
      channels: 2,
      frames: 3,
      planar: [Float64Array.from([-2, 0, 2])],
    };

    for (const [format, bits] of formats) {
      const pcm = flacPcmFromPcmAudio(audio, format);
      const scale = 2 ** (bits - 1);
      expect(pcm.bitsPerSample, String(format)).toBe(bits);
      expect([...(pcm.samples[0] ?? [])], String(format)).toEqual([-scale, 0, scale - 1]);
      expect([...(pcm.samples[1] ?? [])], String(format)).toEqual([0, 0, 0]);
    }

    expect(() =>
      flacPcmFromPcmAudio(
        {
          sampleRate: 48_000,
          channels: 1,
          frames: 1,
          planar: [Float64Array.from([Number.NaN])],
        },
        's16',
      ),
    ).toThrow(/non-finite/);
  });

  it('emits compressed, verbatim, stereo-decorrelated, and multi-frame FLAC that decodes bit-exactly', () => {
    const monoRamp: FlacPcm = {
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      totalSamples: 130,
      samples: [Int32Array.from({ length: 130 }, (_v, i) => i * 3 - 128)],
    };
    const rampEncoded = encodeFlac(monoRamp, { blockSize: 1 });
    const decodedRamp = decodeFlac(rampEncoded);
    assertSampleExact(decodedRamp.samples, monoRamp.samples);
    assertFrameCrcs(rampEncoded);
    expect(enumerateFlacFrameSpans(rampEncoded)).toHaveLength(130);

    const constant: FlacPcm = {
      sampleRate: 44_100,
      channels: 1,
      bitsPerSample: 16,
      totalSamples: 64,
      samples: [new Int32Array(64).fill(23)],
    };
    const compressedConstant = assertRoundTrip(constant);
    const verbatimConstant = encodeFlacVerbatim(constant, { blockSize: 64 });
    expect(compressedConstant.byteLength).toBeLessThan(verbatimConstant.byteLength);
    assertSampleExact(decodeFlac(verbatimConstant).samples, constant.samples);

    const stereo: FlacPcm = {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      totalSamples: 32,
      samples: [
        Int32Array.from({ length: 32 }, (_v, i) => i * 4),
        Int32Array.from({ length: 32 }, (_v, i) => i * 4 - 2),
      ],
    };
    assertRoundTrip(stereo);
  });

  it('publishes valid STREAMINFO preludes and streaming MD5 digests across buffered tails', () => {
    expect([
      ...streamInfoPrelude({ sampleRate: 48_000, channels: 2, bitsPerSample: 24 }).subarray(0, 4),
    ]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(() => streamInfoPrelude({ sampleRate: 48_000, channels: 0, bitsPerSample: 24 })).toThrow(
      /channel count/,
    );

    const direct = createHash('md5').update('abc').digest('hex');
    const oneShot = newMd5State();
    updateMd5(oneShot, new TextEncoder().encode('abc'));
    expect(hex(finalizeMd5(oneShot))).toBe(direct);

    const chunked = newMd5State();
    updateMd5(chunked, new Uint8Array(60).fill(0xa5));
    updateMd5(chunked, new Uint8Array(70).fill(0x5a));
    const expectedChunked = createHash('md5')
      .update(new Uint8Array(60).fill(0xa5))
      .update(new Uint8Array(70).fill(0x5a))
      .digest('hex');
    expect(hex(finalizeMd5(chunked))).toBe(expectedChunked);

    const blockState = newMd5State();
    updateMd5WithBlock(blockState, [Int32Array.from([1, -2])], 2, 16, 2);
    expect(hex(finalizeMd5(blockState))).toBe(hex(md5BlockBytes(Int32Array.from([1, -2]))));
  });

  it('serializes FLAC PCM bytes in sample-width little-endian order', () => {
    const pcm: FlacPcm = {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 20,
      totalSamples: 2,
      samples: [Int32Array.from([0x12_34_5, -1]), Int32Array.from([0, -0x12_34_5])],
    };

    expect([...encodedPcmBytes(pcm)]).toEqual([
      0x45, 0x23, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xbb, 0xdc, 0xfe,
    ]);
  });
});

function md5BlockBytes(left: Int32Array): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, left[0] ?? 0, true);
  view.setInt16(2, 0, true);
  view.setInt16(4, left[1] ?? 0, true);
  view.setInt16(6, 0, true);
  return new Uint8Array(createHash('md5').update(bytes).digest());
}
