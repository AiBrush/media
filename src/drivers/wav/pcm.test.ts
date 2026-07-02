import { describe, expect, it } from 'vitest';
import { wavPcmPacketCopy } from '../../api/pcm-convert-plan.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { gain } from '../../dsp/index.ts';
import { channelAt, encodePcm } from '../../dsp/pcm.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { readWavPcm, rewriteWavPcmCopy, writeWav } from './pcm.ts';
import { parseWav } from './wav-driver.ts';

/** Independent `data`-chunk locator — the byte-exact oracle must not depend on the code under test. */
function dataChunk(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[pos] ?? 0,
      bytes[pos + 1] ?? 0,
      bytes[pos + 2] ?? 0,
      bytes[pos + 3] ?? 0,
    );
    const size = dv.getUint32(pos + 4, true);
    if (id === 'data')
      return bytes.subarray(pos + 8, pos + 8 + Math.min(size, bytes.byteLength - pos - 8));
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function peak(ch: Float64Array): number {
  let m = 0;
  for (const s of ch) m = Math.max(m, Math.abs(s));
  return m;
}

const REAL_WAVS = [
  { id: 'sin_440Hz_-6dBFS_1s.wav', sampleRate: 44100, channels: 1, format: 's16', tonePeak: 0.5 },
  { id: 'speech.wav', sampleRate: 16000, channels: 1, format: 's16', tonePeak: undefined },
] as const;

describe('readWavPcm / writeWav — bit-exact on real WAV PCM (decoded-audio-pcm oracle)', () => {
  for (const w of REAL_WAVS) {
    it(`${w.id}: decodes the documented layout`, async () => {
      const a = readWavPcm(await loadFixture(w.id));
      expect(a.format).toBe(w.format);
      expect(a.sampleRate).toBe(w.sampleRate);
      expect(a.channels).toBe(w.channels);
      expect(a.frames).toBeGreaterThan(0);
    });

    it(`${w.id}: encodePcm reproduces the source data chunk byte-for-byte`, async () => {
      const file = await loadFixture(w.id);
      const a = readWavPcm(file);
      expect(encodePcm(a, a.format)).toEqual(dataChunk(file));
    });

    it(`${w.id}: writeWav round-trips sample-exact and re-probes consistently`, async () => {
      const a = readWavPcm(await loadFixture(w.id));
      const re = readWavPcm(writeWav(a, a.format));
      expect(re.frames).toBe(a.frames);
      expect(re.format).toBe(a.format);
      for (let c = 0; c < a.channels; c++) {
        expect(channelAt(re.planar, c)).toEqual(channelAt(a.planar, c));
      }
      // The canonical file we wrote must satisfy the independent header parser too.
      const probe = parseWav(writeWav(a, a.format));
      expect(probe.sampleRate).toBe(w.sampleRate);
      expect(probe.channels).toBe(w.channels);
      expect(probe.durationSec).toBeCloseTo(a.frames / a.sampleRate, 6);
    });

    it(`${w.id}: s16 → f32 → s16 conversion is loss-free on real audio`, async () => {
      const file = await loadFixture(w.id);
      const a = readWavPcm(file);
      const asF32 = readWavPcm(writeWav(a, 'f32'));
      expect(encodePcm(asF32, 's16')).toEqual(dataChunk(file));
    });
  }

  it('sin_440Hz: the tone peaks at ~-6 dBFS and +6 dB gain drives it to ~full-scale', async () => {
    const a = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav'));
    expect(peak(channelAt(a.planar, 0))).toBeCloseTo(0.5, 2);
    const louder = gain(a, 6.020599913279624);
    expect(peak(channelAt(louder.planar, 0))).toBeCloseTo(1, 2);
  });
});

describe('readWavPcm / writeWav — formats, edges & rejects', () => {
  it('packet-copy authors a canonical WAV from real raw PCM bytes without sample decode', async () => {
    const file = await loadFixture('speech.wav');
    const source = readWavPcm(file);
    const out = wavPcmPacketCopy(
      {
        pcmSampleFormat: (codec) => (codec === 'pcm-s16' ? 's16' : undefined),
        pcmEndian: (codec) => (codec === 'pcm-s16' ? 'le' : undefined),
      },
      {
        payload: dataChunk(file),
        sourceBytes: file,
        codec: 'pcm-s16',
        sampleRate: source.sampleRate,
        channels: source.channels,
      },
    );
    const probe = parseWav(out, out.byteLength);
    expect(probe.sampleRate).toBe(source.sampleRate);
    expect(probe.channels).toBe(source.channels);
    expect(probe.codec).toBe('pcm-s16');
    expect(dataChunk(out)).toEqual(dataChunk(file));
  });

  it('declines WAV byte-copy when explicit identity constraints do not match', () => {
    const wav = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 2,
        planar: [Float64Array.of(0.25, -0.25)],
      },
      's16',
    );
    expect(rewriteWavPcmCopy(wav, 's24')).toBeUndefined();
    expect(rewriteWavPcmCopy(wav, 's16', 'be')).toBeUndefined();
    expect(rewriteWavPcmCopy(wav, 's16', 'le', 2)).toBeUndefined();
    expect(rewriteWavPcmCopy(wav, 's16', 'le', 1, 44_100)).toBeUndefined();
  });

  it('rejects signed 8-bit WAV authoring instead of writing mislabeled bytes', () => {
    expect(() =>
      writeWav(
        {
          sampleRate: 8_000,
          channels: 1,
          frames: 1,
          planar: [Float64Array.of(0)],
        },
        's8',
      ),
    ).toThrow(CapabilityError);
  });

  it('round-trips a float WAV (tag 3) it wrote', () => {
    const audio = {
      sampleRate: 8000,
      channels: 1,
      frames: 4,
      planar: [Float64Array.of(0, 0.5, -0.5, 0.25)],
    };
    const re = readWavPcm(writeWav(audio, 'f32'));
    expect(re.format).toBe('f32');
    expect(channelAt(re.planar, 0)).toEqual(Float64Array.of(0, 0.5, -0.5, 0.25));
  });

  it('parses WAVE_FORMAT_EXTENSIBLE via the SubFormat GUID', () => {
    // 40-byte fmt: tag 0xFFFE, 1ch, 8000 Hz, 16-bit, SubFormat tag = 1 (PCM) at +24.
    const fmt = new Uint8Array(40);
    const fd = new DataView(fmt.buffer);
    fd.setUint16(0, 0xfffe, true);
    fd.setUint16(2, 1, true);
    fd.setUint32(4, 8000, true);
    fd.setUint32(8, 16000, true);
    fd.setUint16(12, 2, true);
    fd.setUint16(14, 16, true);
    fd.setUint16(16, 22, true); // cbSize
    fd.setUint16(24, 1, true); // SubFormat GUID first word = PCM
    const data = new Uint8Array(new Int16Array([1000, -1000]).buffer);
    const re = readWavPcm(craftWav(fmt, data));
    expect(re.format).toBe('s16');
    expect(re.frames).toBe(2);
  });

  it('rejects a non-RIFF file', () => {
    expect(() => readWavPcm(new Uint8Array(32))).toThrow(InputError);
  });

  it('rejects an unsupported bit depth', () => {
    const fmt = new Uint8Array(16);
    const fd = new DataView(fmt.buffer);
    fd.setUint16(0, 1, true);
    fd.setUint16(2, 1, true);
    fd.setUint32(4, 8000, true);
    fd.setUint16(14, 12, true); // 12-bit: unsupported
    expect(() => readWavPcm(craftWav(fmt, new Uint8Array(4)))).toThrow(InputError);
  });

  it('throws when the fmt chunk is missing', () => {
    const junk = new Uint8Array(8);
    junk.set([0x4a, 0x55, 0x4e, 0x4b], 0); // 'JUNK'
    expect(() => readWavPcm(craftWav(junk, new Uint8Array(0), 'JUNK'))).toThrow(MediaError);
  });

  it('throws a typed demux error when the fmt chunk is truncated', () => {
    const wav = new Uint8Array(24);
    const dv = new DataView(wav.buffer);
    for (let i = 0; i < 4; i++) dv.setUint8(i, 'RIFF'.charCodeAt(i));
    dv.setUint32(4, 16, true);
    for (let i = 0; i < 4; i++) dv.setUint8(8 + i, 'WAVE'.charCodeAt(i));
    for (let i = 0; i < 4; i++) dv.setUint8(12 + i, 'fmt '.charCodeAt(i));
    dv.setUint32(16, 16, true);
    expect(() => readWavPcm(wav)).toThrow(MediaError);
  });

  it('treats a fmt-only file (no data chunk) as empty audio', () => {
    const fmt = new Uint8Array(16);
    const fd = new DataView(fmt.buffer);
    fd.setUint16(0, 1, true);
    fd.setUint16(2, 1, true);
    fd.setUint32(4, 8000, true);
    fd.setUint16(14, 16, true);
    const wav = riff([chunk('fmt ', fmt)]);
    const a = readWavPcm(wav);
    expect(a.frames).toBe(0);
  });
});

// ---- crafted-WAV helpers (test-only) ----
function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, id.charCodeAt(i));
  dv.setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}
function riff(chunks: Uint8Array[]): Uint8Array {
  const bodies = chunks.reduce((n, c) => n + c.byteLength, 4);
  const out = new Uint8Array(8 + bodies);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, 'RIFF'.charCodeAt(i));
  dv.setUint32(4, bodies, true);
  for (let i = 0; i < 4; i++) dv.setUint8(8 + i, 'WAVE'.charCodeAt(i));
  let pos = 12;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
function craftWav(fmt: Uint8Array, data: Uint8Array, fmtId = 'fmt '): Uint8Array {
  return riff([chunk(fmtId, fmt), chunk('data', data)]);
}
