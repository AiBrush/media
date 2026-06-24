import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { readWavPcm } from '../wav/pcm.ts';
import { FlacDriver, parseFlac } from './flac-driver.ts';

/** Build a minimal native-FLAC header (fLaC + STREAMINFO), optionally with an ID3v2 prefix. */
function buildFlac(
  opts: {
    sampleRate?: number;
    channels?: number;
    bps?: number;
    totalSamples?: number;
    blockType?: number;
    prefixId3?: boolean;
  } = {},
): Uint8Array {
  const { sampleRate = 48000, channels = 1, bps = 16, totalSamples = 10240, blockType = 0 } = opts;
  const hi =
    ((sampleRate << 12) |
      ((channels - 1) << 9) |
      ((bps - 1) << 4) |
      Math.floor(totalSamples / 2 ** 32)) >>>
    0;
  const body = new Uint8Array(34);
  const bv = new DataView(body.buffer);
  bv.setUint32(10, hi); // packed sampleRate|channels|bps|samples[35:32]
  bv.setUint32(14, totalSamples >>> 0); // samples[31:0]
  const block = new Uint8Array([0x80 | (blockType & 0x7f), 0x00, 0x00, body.byteLength, ...body]);
  const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...block]); // 'fLaC' + block
  if (!opts.prefixId3) return flac;
  const id3 = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0, 0, 0, 0, 0,
  ]);
  return new Uint8Array([...id3, ...flac]);
}

describe('FlacDriver.supports', () => {
  it('recognizes fLaC magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sfx.flac')).subarray(0, 16);
    expect(FlacDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(FlacDriver.supports({ direction: 'demux', mime: 'audio/flac' })).toBe(true);
    expect(FlacDriver.supports({ direction: 'demux', extension: 'flac' })).toBe(true);
    expect(FlacDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(FlacDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe FLAC — real corpus + STREAMINFO parsing', () => {
  it('sfx.flac — native FLAC, 48 kHz mono 16-bit, ~0.213 s (invariants)', async () => {
    const info = await createMedia().probe(await fixtureSource('sfx.flac')); // zero-config
    expect(info.container).toBe('flac');
    expect(info.tracks).toHaveLength(1);
    const a = info.tracks[0];
    expect(a?.type).toBe('audio');
    expect(a?.codec).toBe('flac');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(10240 / 48000, 5);
  });

  it('sfx.flac probe matches its committed golden exactly', async () => {
    const info = await createMedia().probe(await fixtureSource('sfx.flac'));
    expect(info).toEqual(await loadGoldenMetadata('sfx.flac'));
  });

  it('parseFlac reads STREAMINFO fields from the real file', async () => {
    const info = parseFlac(await loadFixture('sfx.flac'));
    expect(info).toEqual({
      codec: 'flac',
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
      totalSamples: 10240,
      durationSec: 10240 / 48000,
    });
  });

  it('the WebCodecs chunk seam is a typed gap; FLAC decodes via the pure-TS decodePcm path', async () => {
    const demuxed = await FlacDriver.demux(await fixtureSource('sfx.flac'));
    expect(() => demuxed.packets(0)).toThrowError(/decodePcm/);
    await demuxed.close();
  });

  it('createMuxer is a typed not-yet-implemented error', () => {
    expect(() => FlacDriver.createMuxer()).toThrowError(MediaError);
  });
});

describe('FlacDriver.decodePcm — pure-TS decode to WAV (ADR-024)', () => {
  const decodePcm = FlacDriver.decodePcm;
  if (!decodePcm) throw new Error('FlacDriver must expose decodePcm');
  const streamOnly = (bytes: Uint8Array): ByteSource => ({
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          const mid = bytes.byteLength >> 1;
          c.enqueue(bytes.subarray(0, mid));
          c.enqueue(bytes.subarray(mid));
          c.close();
        },
      }),
  });
  async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = s.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
  const peak = (ch: Float64Array): number => {
    let m = 0;
    for (const s of ch) m = Math.max(m, Math.abs(s));
    return m;
  };

  it('decodes a non-seekable stream source (no range) to WAV', async () => {
    const out = await drain(await decodePcm(streamOnly(await loadFixture('sfx.flac'))));
    const wav = readWavPcm(out);
    expect(wav.channels).toBe(1);
    expect(wav.frames).toBe(10240);
  });

  it('applies gain in the PCM domain (≈ ×0.5 at -6.02 dB)', async () => {
    const bytes = await loadFixture('sfx.flac');
    const plain = readWavPcm(await drain(await decodePcm(streamOnly(bytes))));
    const quieter = readWavPcm(
      await drain(await decodePcm(streamOnly(bytes), { gainDb: -6.020599913279624 })),
    );
    expect(peak(channelAt(quieter.planar, 0))).toBeCloseTo(
      peak(channelAt(plain.planar, 0)) * 0.5,
      2,
    );
  });

  it('honors an already-aborted signal', async () => {
    await expect(
      decodePcm(streamOnly(await loadFixture('sfx.flac')), { signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/abort/i);
  });

  it('demuxes a non-seekable stream source (reads STREAMINFO from the first chunk)', async () => {
    const bytes = await loadFixture('sfx.flac');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await FlacDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('flac');
    expect(demuxed.tracks[0]?.durationSec).toBeCloseTo(10240 / 48000, 5);
  });
});

describe('parseFlac — robustness + variants', () => {
  it('parses a crafted stereo / 44.1 kHz / 24-bit STREAMINFO', () => {
    const info = parseFlac(
      buildFlac({ sampleRate: 44100, channels: 2, bps: 24, totalSamples: 88200 }),
    );
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.bitsPerSample).toBe(24);
    expect(info.durationSec).toBeCloseTo(2, 6);
  });

  it('skips an ID3v2 prefix before fLaC', () => {
    expect(parseFlac(buildFlac({ prefixId3: true })).sampleRate).toBe(48000);
  });

  it('rejects a non-FLAC stream', () => {
    expect(() => parseFlac(new Uint8Array(64))).toThrowError(InputError);
  });

  it('rejects when the first metadata block is not STREAMINFO', () => {
    expect(() => parseFlac(buildFlac({ blockType: 4 }))).toThrowError(/STREAMINFO/);
  });

  it('rejects a truncated STREAMINFO', () => {
    expect(() => parseFlac(buildFlac().subarray(0, 14))).toThrowError(/truncated/);
  });

  it('rejects a zero sample rate', () => {
    expect(() => parseFlac(buildFlac({ sampleRate: 0 }))).toThrowError(/sample rate/);
  });
});
