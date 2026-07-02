import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { readWavPcm, writeWav } from './pcm.ts';
import { WavDriver, WavModule, parseWav } from './wav-driver.ts';
import { WavMuxer } from './wav-mux.ts';

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

async function outputBytes(
  output: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (output === undefined) throw new Error('expected byte output');
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  return drain(output);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function withJunkChunk(bytes: Uint8Array): Uint8Array {
  const fmtSize = u32le(bytes, 16);
  const insertAt = 20 + fmtSize + (fmtSize & 1);
  const junkPayload = new Uint8Array([1, 2, 3, 4]);
  const junk = new Uint8Array(8 + junkPayload.byteLength);
  junk.set(
    [...'JUNK'].map((c) => c.charCodeAt(0)),
    0,
  );
  new DataView(junk.buffer).setUint32(4, junkPayload.byteLength, true);
  junk.set(junkPayload, 8);
  const out = new Uint8Array(bytes.byteLength + junk.byteLength);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(junk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + junk.byteLength);
  new DataView(out.buffer).setUint32(4, out.byteLength - 8, true);
  return out;
}

function chunkPayload(bytes: Uint8Array, target: string): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === target) return bytes.subarray(body, body + size);
    offset = body + size + (size & 1);
  }
  throw new Error(`missing WAV chunk '${target}'`);
}

class TestEncodedAudioChunk {
  readonly byteLength: number;
  readonly timestamp = 0;
  readonly duration: number | null = null;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
    this.byteLength = this.#bytes.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const out = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    out.set(this.#bytes);
  }
}

function encodedAudioChunk(bytes: Uint8Array): EncodedAudioChunk {
  return new TestEncodedAudioChunk(bytes) as unknown as EncodedAudioChunk;
}

function wavTrack(bytes: Uint8Array): TrackInfo {
  const info = parseWav(bytes, bytes.byteLength);
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

function packetStream(bytes: Uint8Array): ReadableStream<Packet> {
  const packet: Packet = { chunk: encodedAudioChunk(bytes) };
  return new ReadableStream<Packet>({
    start(controller): void {
      controller.enqueue(packet);
      controller.close();
    },
  });
}

const WAV_MUX_PCM_CASES: readonly {
  readonly codec: string;
  readonly data: Uint8Array;
  readonly expectedCodec: string;
}[] = [
  { codec: 'pcm-u8', data: new Uint8Array([0x80]), expectedCodec: 'pcm-u8' },
  { codec: 'pcm-u8be', data: new Uint8Array([0x80]), expectedCodec: 'pcm-u8' },
  { codec: 'pcm-s8', data: new Uint8Array([0]), expectedCodec: 'pcm-u8' },
  { codec: 'pcm-s16be', data: new Uint8Array([0, 1]), expectedCodec: 'pcm-s16' },
  { codec: 'pcm-s24be', data: new Uint8Array([0, 0, 1]), expectedCodec: 'pcm-s24' },
  { codec: 'pcm-s32be', data: new Uint8Array([0, 0, 0, 1]), expectedCodec: 'pcm-s32' },
  { codec: 'pcm-f32be', data: new Uint8Array([0, 0, 0, 0]), expectedCodec: 'pcm-f32' },
  { codec: 'pcm-f64', data: new Uint8Array(8), expectedCodec: 'pcm-f64' },
  { codec: 'pcm-f64be', data: new Uint8Array(8), expectedCodec: 'pcm-f64' },
];

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

  it('metadata-only probe reads a small WAV header when fmt and data are both visible', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = await loadFixture('speech.wav');
    expect(bytes.byteLength).toBeGreaterThan(4096);
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('metadata-only probe should use range reads');
      },
    };

    const tracks = await probe(source);

    expect(reads).toEqual([[0, 4096]]);
    expect(tracks[0]?.codec).toBe('pcm-s16');
    expect(tracks[0]?.durationSec).toBeGreaterThan(0);
  });

  it('metadata-only probe falls back to the bounded demux window when data is after a large chunk', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const fmt = [
      ...[...'fmt '].map((c) => c.charCodeAt(0)),
      16,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0x44,
      0xac,
      0,
      0,
      0x88,
      0x58,
      1,
      0,
      2,
      0,
      16,
      0,
    ];
    const junkSize = 5000;
    const junk = [
      ...[...'JUNK'].map((c) => c.charCodeAt(0)),
      junkSize & 0xff,
      (junkSize >> 8) & 0xff,
      0,
      0,
      ...new Array<number>(junkSize).fill(0),
    ];
    const data = [
      ...[...'data'].map((c) => c.charCodeAt(0)),
      8,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const bytes = new Uint8Array([...riffWave(), ...fmt, ...junk, ...data]);
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('metadata-only probe should use range reads');
      },
    };

    const tracks = await probe(source);

    expect(reads).toEqual([
      [0, 4096],
      [0, 65536],
    ]);
    expect(tracks[0]?.durationSec).toBeGreaterThan(0);
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

  it.each(WAVS)('%s muxes raw PCM packets into WAV with bit-exact data bytes', async (id) => {
    const input = await loadFixture(id);
    const source = readWavPcm(input);
    const inputData = chunkPayload(input, 'data');
    const muxer = WavDriver.createMuxer();
    expect(muxer).toBeInstanceOf(WavMuxer);
    if (!(muxer instanceof WavMuxer)) throw new Error('expected WavMuxer');

    const trackId = muxer.addTrack(wavTrack(input));
    muxer.addChunkStruct(trackId, { data: inputData });
    await muxer.finalize();

    const out = await drain(muxer.output);
    const reparsed = readWavPcm(out);
    expect(parseWav(out, out.byteLength)).toEqual(parseWav(input, input.byteLength));
    expect(reparsed.format).toBe(source.format);
    expect(reparsed.sampleRate).toBe(source.sampleRate);
    expect(reparsed.channels).toBe(source.channels);
    expect(reparsed.frames).toBe(source.frames);
    expect(chunkPayload(out, 'data')).toEqual(inputData);
  });

  it('public mux() routes explicit WAV raw-PCM packet streams through WavMuxer', async () => {
    const input = await loadFixture('speech.wav');
    const track = wavTrack(input);
    const inputData = chunkPayload(input, 'data');
    const out = await outputBytes(
      await createMedia()
        .use(WavModule)
        .mux({ audio: { track, packets: packetStream(inputData) } }, { container: 'wav' }),
    );

    expect(parseWav(out, out.byteLength)).toEqual(parseWav(input, input.byteLength));
    expect(chunkPayload(out, 'data')).toEqual(inputData);
  });

  it.each(WAV_MUX_PCM_CASES)(
    'muxes one legal $codec PCM packet into a parseable WAV',
    async ({ codec, data, expectedCodec }) => {
      const muxer = new WavMuxer();
      const trackId = muxer.addTrack({
        id: 0,
        mediaType: 'audio',
        codec,
        config: { codec, sampleRate: 48_000, numberOfChannels: 1 },
      });
      muxer.addChunkStruct(trackId, { data });
      await muxer.finalize();

      const out = await drain(muxer.output);
      const info = parseWav(out, out.byteLength);
      expect(info.codec).toBe(expectedCodec);
      expect(info.sampleRate).toBe(48_000);
      expect(info.channels).toBe(1);
      expect(readWavPcm(out).frames).toBe(1);
    },
  );

  it('rejects unsupported WAV mux shapes with typed errors', async () => {
    expect(() => WavDriver.createMuxer({ fragmented: true })).toThrowError(CapabilityError);

    expect(() =>
      WavDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'video',
        codec: 'h264',
        config: { codec: 'avc1.42E01E', codedWidth: 16, codedHeight: 16 },
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      WavDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      WavDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'pcm-s16',
      }),
    ).toThrowError(MediaError);

    expect(() =>
      WavDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'pcm-s16',
        config: { codec: 'pcm-s16', sampleRate: 0, numberOfChannels: 1 },
      }),
    ).toThrowError(MediaError);

    expect(() => {
      const raw = WavDriver.createMuxer();
      if (!(raw instanceof WavMuxer)) throw new Error('expected WavMuxer');
      raw.addChunkStruct(0, { data: new Uint8Array([0]) });
    }).toThrowError(MediaError);

    const muxer = WavDriver.createMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-s16',
      config: { codec: 'pcm-s16', sampleRate: 48_000, numberOfChannels: 2 },
    });
    const duplicateTrack = wavTrack(await loadFixture('speech.wav'));
    expect(() => muxer.addTrack(duplicateTrack)).toThrowError(CapabilityError);
    expect(() => {
      if (!(muxer instanceof WavMuxer)) throw new Error('expected WavMuxer');
      muxer.addChunkStruct(trackId, { data: new Uint8Array([0, 1]) });
    }).toThrowError(MediaError);

    await expect(WavDriver.createMuxer().finalize()).rejects.toThrowError(MediaError);

    const empty = WavDriver.createMuxer();
    empty.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 44_100, numberOfChannels: 1 },
    });
    await expect(empty.finalize()).rejects.toThrowError(MediaError);

    const done = new WavMuxer();
    const doneTrackId = done.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 44_100, numberOfChannels: 1 },
    });
    done.addChunkStruct(doneTrackId, { data: new Uint8Array([128]) });
    await done.finalize();
    expect(() => done.addChunkStruct(doneTrackId, { data: new Uint8Array([128]) })).toThrowError(
      MediaError,
    );
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

  it('re-authors a no-op WAV transform with a fresh canonical header instead of passing input through', async () => {
    const canonical = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      's16',
    );
    const withJunk = withJunkChunk(canonical);
    const out = await drain(await transformPcm(streamOnly(withJunk), { container: 'wav' }));
    expect(out.byteLength).toBe(canonical.byteLength);
    expect(out).toEqual(canonical);
    expect(out).not.toEqual(withJunk);
    expect(readWavPcm(out).planar).toEqual(readWavPcm(canonical).planar);
  });

  it('re-authors explicit same-rate/same-channel/same-format WAV requests without PCM decode', async () => {
    const canonical = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      's16',
    );
    const withJunk = withJunkChunk(canonical);
    const out = await drain(
      await transformPcm(streamOnly(withJunk), {
        container: 'wav',
        sampleFormat: 's16',
        endian: 'le',
        channels: 1,
        sampleRate: 48_000,
      }),
    );
    expect(out).toEqual(canonical);
    expect(out).not.toEqual(withJunk);
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
