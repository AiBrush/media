import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { MediaStreams } from '../../api/types.ts';
import { decodeFlac, interleavedPcmBytes } from '../../codecs/flac/decode.ts';
import { encodeFlac, flacPcmFromDecoded } from '../../codecs/flac/encode.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import {
  fixtureSource,
  fixturesByContainer,
  loadFixture,
  loadGoldenMetadata,
} from '../../test-support/corpus.ts';
import { readWavPcm } from '../wav/pcm.ts';
import {
  FlacDriver,
  FlacMuxer,
  enumerateFlacFrames,
  nativeFlacMetadata,
  parseFlac,
} from './flac-driver.ts';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

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

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
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

  it('the FLAC packet seam is browser-gated; pure frame enumeration is Node-validated', async () => {
    const demuxed = await FlacDriver.demux(await fixtureSource('sfx.flac'));
    if (typeof EncodedAudioChunk === 'undefined') {
      expect(() => demuxed.packets(0)).toThrowError(/EncodedAudioChunk/);
      await demuxed.close();
      return;
    }
    const reader = demuxed.packets(0).getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    expect(first.value?.chunk.byteLength).toBeGreaterThan(0);
    await demuxed.close();
  });

  it('createMuxer authors native FLAC from FLAC packets (decode round-trip + STREAMINFO MD5)', async () => {
    const encoded = encodeFlac(flacPcmFromDecoded(decodeFlac(await loadFixture('sfx.flac'))), {
      blockSize: 1024,
    });
    const metadata = nativeFlacMetadata(encoded);
    const frames = enumerateFlacFrames(encoded);

    const muxer = new FlacMuxer();
    const track = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'flac',
      config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1, description: metadata },
    });
    for (const frame of frames) {
      muxer.addChunkStruct(track, {
        timestampUs: frame.ptsUs,
        durationUs: frame.durationUs,
        key: true,
        data: frame.data,
      });
    }
    await muxer.finalize();
    const out = await collectBytes(muxer.output);
    const decoded = decodeFlac(out);
    expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
    expect(hex(decoded.md5)).toBe(hex(decodeFlac(encoded).md5));
  });
});

describe('FLAC packet seam — native frame enumeration for Ogg remux', () => {
  it('enumerates byte-exact native FLAC frames across the real corpus', async () => {
    const entries = (await fixturesByContainer('flac')).slice(0, 5);
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const entry of entries) {
      const bytes = await loadFixture(entry.id);
      const info = parseFlac(bytes);
      const frames = enumerateFlacFrames(bytes);
      expect(frames.length, `${entry.id}: frame count`).toBeGreaterThan(0);
      expect(
        frames.reduce((sum, f) => sum + f.samples, 0),
        `${entry.id}: samples`,
      ).toBe(info.totalSamples);
      expect(
        frames.reduce((sum, f) => sum + f.durationUs, 0) / 1_000_000,
        `${entry.id}: duration`,
      ).toBeCloseTo(info.durationSec, 3);

      for (const frame of frames) {
        expect(frame.data[0], `${entry.id}: frame sync byte`).toBe(0xff);
        expect((frame.data[1] ?? 0) & 0xfc, `${entry.id}: frame sync bits`).toBe(0xf8);
        expect(
          bytes.subarray(frame.offset, frame.offset + frame.size),
          `${entry.id}: byte span`,
        ).toEqual(frame.data);
      }
    }
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

type TestChunkInit = {
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly data: AllowSharedBufferSource;
};

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

class TestEncodedAudioChunk {
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: TestChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = copyBufferSource(init.data);
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

class TestAudioData {
  readonly format: AudioSampleFormat;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly #planes: Float32Array[];
  closeCount = 0;

  constructor(init: AudioDataInit) {
    if (init.format !== 'f32-planar') throw new Error('test shim supports f32-planar only');
    this.format = init.format;
    this.sampleRate = init.sampleRate;
    this.numberOfChannels = init.numberOfChannels;
    this.numberOfFrames = init.numberOfFrames;
    this.timestamp = init.timestamp;
    this.duration = Math.round((init.numberOfFrames / init.sampleRate) * 1_000_000);
    const all = ArrayBuffer.isView(init.data)
      ? new Float32Array(init.data.buffer, init.data.byteOffset, init.data.byteLength / 4)
      : new Float32Array(init.data);
    this.#planes = [];
    for (let ch = 0; ch < init.numberOfChannels; ch++) {
      const start = ch * init.numberOfFrames;
      this.#planes.push(all.slice(start, start + init.numberOfFrames));
    }
  }

  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
    const plane = this.#planes[options.planeIndex];
    if (plane === undefined) throw new Error(`missing plane ${options.planeIndex}`);
    const view = ArrayBuffer.isView(destination)
      ? new Float32Array(destination.buffer, destination.byteOffset, destination.byteLength / 4)
      : new Float32Array(destination);
    view.set(plane);
  }

  close(): void {
    this.closeCount++;
  }
}

function installAudioShims(): () => void {
  const originalAudioData = globalThis.AudioData;
  const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    writable: true,
    value: TestAudioData as unknown as typeof AudioData,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: TestEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
  });
  return () => {
    if (originalAudioData === undefined) {
      Reflect.deleteProperty(globalThis, 'AudioData');
    } else {
      Object.defineProperty(globalThis, 'AudioData', {
        configurable: true,
        writable: true,
        value: originalAudioData,
      });
    }
    if (originalEncodedAudioChunk === undefined) {
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    } else {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        writable: true,
        value: originalEncodedAudioChunk,
      });
    }
  };
}

function audioFrame(samples: readonly number[], sampleRate: number): AudioData {
  const data = new Float32Array(samples);
  return new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfChannels: 1,
    numberOfFrames: samples.length,
    timestamp: 0,
    data: data.buffer,
  });
}

async function outputBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

/** A multi-channel `f32-planar` AudioData: planes are concatenated (the shim's layout), one timestamp. */
function planarAudioFrame(planes: readonly Float32Array[], sampleRate: number): AudioData {
  const frames = planes[0]?.length ?? 0;
  const buf = new Float32Array(frames * planes.length);
  for (let c = 0; c < planes.length; c++)
    buf.set(planes[c] ?? new Float32Array(frames), c * frames);
  return new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfChannels: planes.length,
    numberOfFrames: frames,
    timestamp: 0,
    data: buf.buffer,
  });
}

/** Which independent FLAC decoder is installed (the third-party oracle), if any. */
function externalFlacDecoder(): 'flac' | 'ffmpeg' | undefined {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  for (const tool of ['flac', 'ffmpeg'] as const) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' });
      return tool;
    } catch {
      /* not installed */
    }
  }
  return undefined;
}

/** Decode `flacBytes` with `flac`/`ffmpeg` to interleaved s16le and assert it equals `expected` bytes. */
function assertExternalS16Equals(
  tool: 'flac' | 'ffmpeg',
  flacBytes: Uint8Array,
  expected: Uint8Array,
): void {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = tmpdir();
  const tag = `enc-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const inPath = `${dir}/aibrush-flac-${tag}.flac`;
  const outPath = `${dir}/aibrush-flac-${tag}.raw`;
  fs.writeFileSync(inPath, flacBytes);
  try {
    if (tool === 'flac') {
      execFileSync(
        'flac',
        [
          '-s',
          '-d',
          '-f',
          '--force-raw-format',
          '--endian=little',
          '--sign=signed',
          '-o',
          outPath,
          inPath,
        ],
        { stdio: 'ignore' },
      );
    } else {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inPath, '-f', 's16le', outPath], {
        stdio: 'ignore',
      });
    }
    const got = new Uint8Array(fs.readFileSync(outPath));
    expect(got.byteLength, `${tool} PCM byte length`).toBe(expected.byteLength);
    expect(md5(got), `${tool} decode equals source PCM`).toBe(md5(expected));
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
}

describe('media.encode — native FLAC output via pure-TS FLAC encoder + muxer', () => {
  it('encodes AudioData to a native FLAC Blob through default routing', async () => {
    const restore = installAudioShims();
    try {
      const frame = audioFrame([0, 0.25, -0.25, 0.5, -0.5, 0.125, -0.125, 0], 48_000);
      const streams: MediaStreams = {
        audio: new ReadableStream<AudioData>({
          start(controller): void {
            controller.enqueue(frame);
            controller.close();
          },
        }),
      };
      const out = await outputBytes(
        await createMedia().encode(streams, {
          to: 'flac',
          audio: { codec: 'flac', sampleRate: 48_000, channels: 1 },
        }),
      );
      const decoded = decodeFlac(out);
      expect(decoded.sampleRate).toBe(48_000);
      expect(decoded.channels).toBe(1);
      expect(decoded.totalSamples).toBe(8);
      expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
      expect((frame as unknown as TestAudioData).closeCount).toBe(1);
    } finally {
      restore();
    }
  });

  it('streams a multi-block stereo sine through the codec→mux seam: sample-exact + independently decodable', async () => {
    const restore = installAudioShims();
    try {
      // ~10 000 frames spans two full 4096 blocks + a 1808-sample partial final frame, across two pushes
      // of unequal length (so the block accumulator's re-chunking + partial tail are both exercised).
      const sampleRate = 44_100;
      const total = 10_000;
      const makeSine = (
        start: number,
        n: number,
        freq: number,
        phaseChan: number,
      ): Float32Array => {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = 0.6 * Math.sin((2 * Math.PI * freq * (start + i)) / sampleRate + phaseChan);
        }
        return out;
      };
      const splits = [4097, total - 4097]; // deliberately not block-aligned
      const frames: AudioData[] = [];
      let at = 0;
      for (const n of splits) {
        const left = makeSine(at, n, 440, 0);
        const right = makeSine(at, n, 660, Math.PI / 4);
        frames.push(planarAudioFrame([left, right], sampleRate));
        at += n;
      }
      const streams: MediaStreams = {
        audio: new ReadableStream<AudioData>({
          start(controller): void {
            for (const f of frames) controller.enqueue(f);
            controller.close();
          },
        }),
      };
      const out = await outputBytes(
        await createMedia().encode(streams, {
          to: 'flac',
          audio: { codec: 'flac', sampleRate, channels: 2 },
        }),
      );

      // (a) our decoder: correct geometry, self-consistent MD5, and sample-exact vs the 16-bit-quantized
      // source (the codec seam quantizes float AudioData to 16-bit; that is what FLAC losslessly stores).
      const decoded = decodeFlac(out);
      expect(decoded.sampleRate).toBe(sampleRate);
      expect(decoded.channels).toBe(2);
      expect(decoded.totalSamples).toBe(total);
      expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));

      const expectedS16 = new Uint8Array(total * 2 * 2);
      const dv = new DataView(expectedS16.buffer);
      const planes = [makeSine(0, total, 440, 0), makeSine(0, total, 660, Math.PI / 4)];
      let o = 0;
      for (let i = 0; i < total; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const q = Math.max(-32768, Math.min(32767, Math.round((planes[ch]?.[i] ?? 0) * 32768)));
          dv.setInt16(o, q, true);
          o += 2;
          expect(decoded.samples[ch]?.[i], `ch${ch} sample ${i}`).toBe(q);
        }
      }

      // (b) every input AudioData was closed exactly once (lifetime contract).
      for (const f of frames) expect((f as unknown as TestAudioData).closeCount).toBe(1);

      // (c) INDEPENDENT decoder agrees bit-for-bit (the output is a real, standards-valid FLAC).
      const tool = externalFlacDecoder();
      if (tool) assertExternalS16Equals(tool, out, expectedS16);
      else console.warn('[flac.encode] no flac/ffmpeg CLI — skipping the independent-decoder leg');
    } finally {
      restore();
    }
  }, 30_000);
});
