import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { readWavPcm } from './pcm.ts';
import { WavDriver, WavModule, parseWav } from './wav-driver.ts';

const WAVS = [
  'speech.wav',
  'sin_440Hz_-6dBFS_1s.wav',
  'sfx-pcm-u8.wav',
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sfx-pcm-s32.wav',
  'sfx-pcm-f32.wav',
];
const riffWave = (extra: number[] = []): Uint8Array =>
  new Uint8Array([
    ...[...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ...[...'WAVE'].map((c) => c.charCodeAt(0)),
    ...extra,
  ]);

describe('WavDriver.supports', () => {
  it('recognizes RIFF/WAVE magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('speech.wav')).subarray(0, 16);
    expect(WavDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(WavDriver.supports({ direction: 'demux', mime: 'audio/wav' })).toBe(true);
    expect(WavDriver.supports({ direction: 'demux', extension: 'wav' })).toBe(true);
    expect(WavDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(WavDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe WAV across the real corpus', () => {
  it.each(WAVS)('%s — pcm audio with sane params (invariants)', async (id) => {
    const info = await createMedia()
      .use(WavModule)
      .probe(await fixtureSource(id));
    expect(info.container).toBe('wav');
    expect(info.tracks).toHaveLength(1);
    const a = info.tracks[0];
    expect(a?.type).toBe('audio');
    expect(a?.codec.startsWith('pcm-')).toBe(true);
    expect([8000, 16000, 22050, 24000, 32000, 44100, 48000]).toContain(a?.sampleRate);
    expect(a?.channels).toBeGreaterThanOrEqual(1);
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it.each(WAVS)('%s probe matches its committed golden exactly', async (id) => {
    const info = await createMedia()
      .use(WavModule)
      .probe(await fixtureSource(id));
    expect(info).toEqual(await loadGoldenMetadata(id));
  });

  it('the demux packet seam is a typed capability gap in node (PCM → audio-dsp)', async () => {
    const demuxed = await WavDriver.demux(await fixtureSource('speech.wav'));
    expect(demuxed.tracks).toHaveLength(1);
    expect(() => demuxed.packets(0)).toThrowError(/audio-dsp/);
    await demuxed.close();
  });

  it('demuxes a non-seekable stream source (reads the header from the first chunk)', async () => {
    const bytes = await loadFixture('speech.wav');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await WavDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('pcm-s16');
  });

  it('createMuxer is a typed not-yet-implemented error (P2)', () => {
    expect(() => WavDriver.createMuxer()).toThrowError(MediaError);
  });
});

describe('parseWav — robustness + format variants', () => {
  it('rejects non-RIFF input', () => {
    expect(() => parseWav(new Uint8Array(20))).toThrowError(/RIFF/);
  });

  it('throws when there is no fmt chunk', () => {
    expect(() => parseWav(riffWave())).toThrowError(/fmt/);
  });

  it('derives byteRate when the header omits it, and handles float + extensible formats', () => {
    // fmt chunk: format=3 (float), 1ch, 48000Hz, byteRate=0 (omitted), blockAlign=4, 32-bit
    const fmt = [
      ...'fmt '.split('').map((c) => c.charCodeAt(0)),
      16,
      0,
      0,
      0,
      3,
      0,
      1,
      0,
      0x80,
      0xbb,
      0,
      0,
      0,
      0,
      0,
      0,
      4,
      0,
      32,
      0,
    ];
    const data = ['d', 'a', 't', 'a'].map((c) => c.charCodeAt(0)).concat([0, 0x30, 0x02, 0]); // 0x23000 bytes
    const info = parseWav(new Uint8Array([...riffWave(), ...fmt, ...data]), 1 << 20);
    expect(info.codec).toBe('pcm-f32');
    expect(info.sampleRate).toBe(48000);
    expect(info.durationSec).toBeGreaterThan(0); // byteRate derived from blockAlign × sampleRate
  });
});

describe('WavDriver.transformPcm — PCM-native path (ADR-022)', () => {
  const SIN = 'sin_440Hz_-6dBFS_1s.wav';
  const transformPcm = WavDriver.transformPcm;
  if (!transformPcm) throw new Error('WavDriver must expose transformPcm');
  const streamOnly = (bytes: Uint8Array): ByteSource => ({
    // No range/size → forces the streaming readAll fallback (two chunks exercise the accumulation).
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
  const hasNaN = (ch: Float64Array): boolean => {
    for (const s of ch) if (Number.isNaN(s)) return true;
    return false;
  };
  const differs = (a: Float64Array, b: Float64Array): boolean => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return true;
    }
    return a.length !== b.length;
  };

  it('reads a non-seekable stream source (no range) and up-mixes mono → stereo', async () => {
    const bytes = await loadFixture(SIN);
    const out = await drain(await transformPcm(streamOnly(bytes), { channels: 2 }));
    const re = readWavPcm(out);
    expect(re.channels).toBe(2);
    expect(channelAt(re.planar, 1)).toEqual(channelAt(readWavPcm(bytes).planar, 0));
  });

  it('applies gain in the PCM domain (≈ ×0.5 at -6.02 dB)', async () => {
    const bytes = await loadFixture(SIN);
    const out = await drain(await transformPcm(streamOnly(bytes), { gainDb: -6.020599913279624 }));
    const orig = peak(channelAt(readWavPcm(bytes).planar, 0));
    expect(peak(channelAt(readWavPcm(out).planar, 0))).toBeCloseTo(orig * 0.5, 2);
  });

  it.each(WAVS)(
    '%s applies public PCM dynamics over real corpus audio (peak-normalize then hard-limit)',
    async (id) => {
      const bytes = await loadFixture(id);
      const out = await drain(
        await transformPcm(streamOnly(bytes), {
          sampleFormat: 'f32',
          dynamics: {
            normalize: { mode: 'peak', targetDbfs: -3 },
            limit: { ceilingDbfs: -1, mode: 'hard' },
          },
        }),
      );
      const re = readWavPcm(out);
      const ch = channelAt(re.planar, 0);
      expect(re.frames).toBe(readWavPcm(bytes).frames);
      expect(hasNaN(ch)).toBe(false);
      expect(peak(ch)).toBeCloseTo(10 ** (-3 / 20), 5);
    },
  );

  it.each(WAVS)('%s applies a PCM biquad section over real corpus audio', async (id) => {
    const bytes = await loadFixture(id);
    const source = readWavPcm(bytes);
    const out = await drain(
      await transformPcm(streamOnly(bytes), {
        sampleFormat: 'f32',
        biquad: {
          type: 'highpass',
          frequency: Math.min(1000, source.sampleRate / 4),
          q: Math.SQRT1_2,
        },
      }),
    );
    const re = readWavPcm(out);
    const ch = channelAt(re.planar, 0);
    expect(re.frames).toBe(source.frames);
    expect(re.sampleRate).toBe(source.sampleRate);
    expect(re.channels).toBe(source.channels);
    expect(hasNaN(ch)).toBe(false);
    expect(differs(ch, channelAt(source.planar, 0))).toBe(true);
  });

  it('honors an already-aborted signal', async () => {
    const bytes = await loadFixture(SIN);
    await expect(
      transformPcm(streamOnly(bytes), { signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/abort/i);
  });
});
