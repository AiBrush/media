import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { gain } from '../../dsp/gain.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { sha256Hex } from '../../util/digest.ts';
import { readAiffPcm, writeAiff } from '../aiff/aiff.ts';
import { tryRewriteWavPcmToAiffBe, wavPcmToAiffFromBytes } from './aiff-rewrite.ts';
import { tryGainWavF32ToF32Wav } from './f32-gain.ts';
import { tryConvertWavPcmFormatToWav, wavPcmFormatToWavFromBytes } from './format-convert.ts';
import { readWavPcm, rewriteWavPcmCopy, writeWav } from './pcm.ts';
import { tryResampleWavS16ToS16Wav, wavS16ResampleToWavFromBytes } from './s16-resample.ts';
import { wavTrimFromUrl } from './url-trim.ts';
import { streamWavPcmCopy } from './wav-copy-stream.ts';
import {
  WavDriver,
  WavModule,
  parseWav,
  wavPacketInfoFromBytes,
  wavPacketInfoFromUrl,
} from './wav-driver.ts';
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

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

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

function seededWavUint32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function testRiffChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  out.set(
    Uint8Array.from(id, (character) => character.charCodeAt(0)),
    0,
  );
  new DataView(out.buffer).setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

function testRiffWave(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = 12 + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(byteLength);
  out.set(
    Uint8Array.from('RIFF', (character) => character.charCodeAt(0)),
    0,
  );
  new DataView(out.buffer).setUint32(4, byteLength - 8, true);
  out.set(
    Uint8Array.from('WAVE', (character) => character.charCodeAt(0)),
    8,
  );
  let offset = 12;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function rangeServer(bytes: Uint8Array): {
  readonly fetch: typeof fetch;
  readonly calls: Array<{
    readonly method: string;
    readonly range: string | null;
    readonly bytes: number;
  }>;
} {
  const calls: Array<{ method: string; range: string | null; bytes: number }> = [];
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers as { Range?: string } | undefined;
    const range = headers?.Range ?? null;
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) return new Response('bad range', { status: 416 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, total);
      const slice = bytes.subarray(start, Math.max(start, end));
      calls.push({ method, range, bytes: slice.byteLength });
      return new Response(slice.slice(), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${start + slice.byteLength - 1}/${total}` },
      });
    }
    calls.push({ method, range, bytes: total });
    return new Response(bytes.slice(), {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
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

    expect(reads).toEqual([[0, 128]]);
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
      [0, 128],
      [5044, bytes.byteLength],
    ]);
    expect(tracks[0]?.durationSec).toBeGreaterThan(0);

    reads.length = 0;
    const decode = WavDriver.decodePcmAudioStream;
    if (decode === undefined) throw new Error('WavDriver must expose lazy PCM audio decode');
    const chunks = await decode(source);
    const reader = chunks.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.frames).toBe(4);
    expect(reads).toEqual([[0, bytes.byteLength]]);
    await reader.cancel('large-header fallback coverage');
  });

  it('sparse-skips the real exhaustive s24 PAD body and preserves exact probe truth', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = new Uint8Array(
      await readFile(
        new URL(
          '../../../../media-test/fixtures/media/scenarios/probe/wav_s24/03.wav',
          import.meta.url,
        ),
      ),
    );
    const reads: Array<readonly [number, number]> = [];
    const tracks = await probe({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('sparse WAV metadata probe must not stream the payload');
      },
    });

    const truth = parseWav(bytes, bytes.byteLength);
    expect(tracks).toEqual([
      {
        id: 0,
        mediaType: 'audio',
        codec: 'pcm-s24',
        durationSec: truth.durationSec,
        config: {
          codec: 'pcm-s24',
          sampleRate: truth.sampleRate,
          numberOfChannels: truth.channels,
        },
      },
    ]);
    expect(reads).toEqual([
      [0, 128],
      [12_280, 12_408],
    ]);
  });

  it('amortizes a remote WAV metadata prelude into one bounded range', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = new Uint8Array(
      await readFile(
        new URL(
          '../../../../media-test/fixtures/media/scenarios/probe/wav_s24/03.wav',
          import.meta.url,
        ),
      ),
    );
    const reads: Array<readonly [number, number]> = [];
    const tracks = await probe({
      size: bytes.byteLength,
      kind: 'url',
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('remote WAV metadata probe must remain range-backed');
      },
    } as ByteSource & { readonly kind: 'url' });

    const truth = parseWav(bytes, bytes.byteLength);
    expect(tracks[0]).toMatchObject({
      codec: 'pcm-s24',
      durationSec: truth.durationSec,
      config: { sampleRate: truth.sampleRate, numberOfChannels: truth.channels },
    });
    expect(reads).toEqual([[0, 16 * 1024]]);
  });

  it('preserves typed probe cancellation before and after initial and sparse range reads', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = new Uint8Array(
      await readFile(
        new URL(
          '../../../../media-test/fixtures/media/scenarios/probe/wav_s24/03.wav',
          import.meta.url,
        ),
      ),
    );

    const before = new AbortController();
    before.abort('before WAV probe');
    let beforeReads = 0;
    await expect(
      probe(
        {
          size: bytes.byteLength,
          range: () => {
            beforeReads++;
            return Promise.resolve(bytes);
          },
          stream: () => streamBytes(bytes),
        },
        { signal: before.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(beforeReads).toBe(0);

    for (const abortAfterRead of [1, 2]) {
      const controller = new AbortController();
      let reads = 0;
      await expect(
        probe(
          {
            size: bytes.byteLength,
            range(start, end): Promise<Uint8Array> {
              reads++;
              if (reads === abortAfterRead) controller.abort(`after range ${reads}`);
              return Promise.resolve(bytes.subarray(start, end));
            },
            stream: () => streamBytes(bytes),
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'aborted' });
      expect(reads).toBe(abortAfterRead);
    }
  });

  it('keeps malformed and truncated sparse WAV probes on typed error paths', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const valid = await loadFixture('speech.wav');
    const wrongRiff = valid.slice(0, 128);
    wrongRiff.set([0x42, 0x41, 0x44, 0x21], 0);
    const wrongWave = valid.slice(0, 128);
    wrongWave.set([0x42, 0x41, 0x44, 0x21], 8);
    const dataOnly = riffWave([...[...'data'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    const truncatedFmt = riffWave([
      ...[...'fmt '].map((c) => c.charCodeAt(0)),
      16,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
    ]);
    const cases: readonly (readonly [Uint8Array, string])[] = [
      [valid.subarray(0, 7), 'unsupported-input'],
      [wrongRiff, 'unsupported-input'],
      [wrongWave, 'unsupported-input'],
      [dataOnly, 'demux-error'],
      [truncatedFmt, 'demux-error'],
    ];

    for (const [bytes, code] of cases) {
      await expect(
        probe({
          size: bytes.byteLength,
          range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
          stream: () => streamBytes(bytes),
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('bounds adversarial sparse chunk walks before using the established full-head fallback', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const junkChunks: number[] = [];
    for (let index = 0; index < 8; index++) {
      junkChunks.push(
        ...[...'JUNK'].map((c) => c.charCodeAt(0)),
        0,
        2,
        0,
        0,
        ...new Array<number>(512).fill(index),
      );
    }
    const fmtAndData = [
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
      ...[...'data'].map((c) => c.charCodeAt(0)),
      2,
      0,
      0,
      0,
      0,
      0,
    ];
    const bytes = riffWave([...junkChunks, ...fmtAndData]);
    const reads: Array<readonly [number, number]> = [];
    const tracks = await probe({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream: () => streamBytes(bytes),
    });

    expect(tracks[0]).toMatchObject({ codec: 'pcm-s16', config: { sampleRate: 44_100 } });
    expect(reads).toHaveLength(9);
    expect(reads.at(-1)).toEqual([0, 64 * 1024]);
  });

  it('returns proved format metadata when a later sparse range is short', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = withJunkChunk(await loadFixture('speech.wav'));
    const fmtEnd = 36;
    const padded = new Uint8Array(bytes.byteLength + 4096);
    padded.set(bytes.subarray(0, fmtEnd), 0);
    padded.set([0x4a, 0x55, 0x4e, 0x4b, 0, 0x10, 0, 0], fmtEnd);
    const reads: Array<readonly [number, number]> = [];
    const tracks = await probe({
      size: padded.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(
          reads.length === 1 ? padded.subarray(start, end) : new Uint8Array(0),
        );
      },
      stream: () => streamBytes(padded),
    });

    expect(reads).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ codec: 'pcm-s16', durationSec: 0 });
  });

  it('probes a non-seekable stream through the same bounded RIFF parser', async () => {
    const probe = WavDriver.probe;
    if (probe === undefined) throw new Error('WavDriver must expose probe');
    const bytes = await loadFixture('speech.wav');

    const tracks = await probe({ stream: () => streamBytes(bytes) });

    expect(tracks).toEqual([wavTrack(bytes)]);
  });

  it('the demux packet seam is a typed capability gap in node (PCM → audio-dsp)', async () => {
    const demuxed = await WavDriver.demux(await fixtureSource('speech.wav'));
    expect(demuxed.tracks).toHaveLength(1);
    expect(() => demuxed.packets(0)).toThrowError(/audio-dsp/);
    await demuxed.close();
  });

  it('packetInfo enumerates WAV PCM chunks from the bounded header without payload fetch', async () => {
    const packetInfo = WavDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WavDriver must expose packetInfo');
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error(
          'packetInfo should not fetch the WAV payload when the data header is visible',
        );
      },
    };

    const table = await packetInfo(source);
    const track = table.tracks[0];
    const config = track?.config;
    const channels =
      config !== undefined && 'numberOfChannels' in config ? config.numberOfChannels : undefined;
    const payload = chunkPayload(bytes, 'data');
    const bytesPerFrame = 3 * (channels ?? 0);

    expect(reads).toEqual([[0, 128]]);
    expect(track?.codec).toBe('pcm-s24');
    expect(channels).toBeGreaterThan(0);
    expect(table.packets).toHaveLength(Math.ceil(payload.byteLength / (4096 * bytesPerFrame)));
    expect(table.packets.reduce((total, packet) => total + packet.size, 0)).toBe(
      payload.byteLength,
    );
    expect(table.packets[0]).toMatchObject({
      trackIndex: 0,
      offset: bytes.byteLength - payload.byteLength,
      size: 4096 * bytesPerFrame,
      ptsUs: 0,
      dtsUs: 0,
      keyframe: true,
    });
  });

  it('decodes range-capable WAV PCM lazily in bounded canonical chunks', async () => {
    const sourcePcm = {
      sampleRate: 48_000,
      channels: 2,
      frames: 40_000,
      planar: [new Float64Array(40_000).fill(0.25), new Float64Array(40_000).fill(-0.25)],
    } as const;
    const bytes = writeWav(sourcePcm, 's24');
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-capable lazy decode must not fall back to stream()');
      },
    };
    const decode = WavDriver.decodePcmAudioStream;
    if (decode === undefined) throw new Error('WavDriver must expose lazy PCM audio decode');

    const chunks = await decode(source);
    const reader = chunks.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.sampleRate).toBe(48_000);
    expect(first.value?.channels).toBe(2);
    expect(first.value?.frames).toBe(4096);
    expect(first.value?.planar[0]?.slice(0, 3)).toEqual(sourcePcm.planar[0].slice(0, 3));
    expect(first.value?.planar[1]?.slice(0, 3)).toEqual(sourcePcm.planar[1].slice(0, 3));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]).toEqual([0, 65536]);
    expect(reads.some(([start, end]) => start === 0 && end < bytes.byteLength)).toBe(true);
    await reader.cancel('first chunk is sufficient for the lazy contract');
  });

  it('fuses the real signed-24 WAV fixture to bit-exact interleaved Float32 chunks', async () => {
    interface InterleavedChunk {
      readonly sampleRate: number;
      readonly channels: number;
      readonly frames: number;
      readonly data: Float32Array<ArrayBuffer>;
    }
    type InterleavedDecoder = (src: ByteSource) => Promise<ReadableStream<InterleavedChunk>>;
    const decode = (
      WavDriver as typeof WavDriver & {
        readonly decodePcmInterleavedStream?: InterleavedDecoder;
      }
    ).decodePcmInterleavedStream;
    expect(decode).toBeTypeOf('function');
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');

    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const canonical = readWavPcm(bytes);
    const expected = new Float32Array(canonical.frames * canonical.channels);
    for (let frame = 0; frame < canonical.frames; frame++) {
      for (let channel = 0; channel < canonical.channels; channel++) {
        expected[frame * canonical.channels + channel] = canonical.planar[channel]?.[frame] ?? 0;
      }
    }
    const stream = await decode({
      size: bytes.byteLength,
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
      stream(): ReadableStream<Uint8Array> {
        throw new Error('real range-backed WAV must not fall back to full streaming');
      },
    });
    const reader = stream.getReader();
    const actual = new Uint32Array(expected.length);
    let sample = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.data.length).toBe(next.value.frames * next.value.channels);
      const bits = new Uint32Array(
        next.value.data.buffer,
        next.value.data.byteOffset,
        next.value.data.length,
      );
      actual.set(bits, sample);
      sample += bits.length;
    }
    expect(sample).toBe(expected.length);
    expect(actual).toEqual(new Uint32Array(expected.buffer));
  });

  it('streams range-less signed-24 PCM sequentially with exact range-path samples and cadence', async () => {
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const expectedReader = (
      await decode({
        size: bytes.byteLength,
        range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
        stream: () => {
          throw new Error('range control must not stream');
        },
      })
    ).getReader();
    const expectedBits: number[] = [];
    const expectedCadence: number[] = [];
    for (;;) {
      const next = await expectedReader.read();
      if (next.done) break;
      expectedCadence.push(next.value.frames);
      expectedBits.push(...new Uint32Array(next.value.data.buffer));
    }
    expectedReader.releaseLock();

    let streamCalls = 0;
    const rangeCalls = 0;
    let offset = 0;
    let activePulls = 0;
    let maximumActivePulls = 0;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      size: bytes.byteLength,
      mimeHint: 'audio/wav',
      stream: () => {
        streamCalls++;
        offset = 0;
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller): Promise<void> {
              activePulls++;
              maximumActivePulls = Math.max(maximumActivePulls, activePulls);
              await Promise.resolve();
              const length = Math.min(97 + (offset % 131), bytes.byteLength - offset);
              if (length > 0) {
                controller.enqueue(bytes.slice(offset, offset + length));
                offset += length;
              }
              if (offset >= bytes.byteLength) controller.close();
              activePulls--;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };

    const actualReader = (await decode(source)).getReader();
    const actualBits: number[] = [];
    const actualCadence: number[] = [];
    for (;;) {
      const next = await actualReader.read();
      if (next.done) break;
      actualCadence.push(next.value.frames);
      actualBits.push(...new Uint32Array(next.value.data.buffer));
    }
    actualReader.releaseLock();

    expect(streamCalls).toBe(1);
    expect(rangeCalls).toBe(0);
    expect(maximumActivePulls).toBe(1);
    expect(actualCadence).toEqual(expectedCadence);
    expect(actualBits).toEqual(expectedBits);
  });

  it('cancels and unlocks a sequential signed-24 source during a pending payload read', async () => {
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const firstPayloadEnd = 68 + 4096 * 2 * 3;
    let pendingPull = false;
    let cancelled = 0;
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(bytes.slice(0, firstPayloadEnd));
        },
        pull(): Promise<void> {
          pendingPull = true;
          return new Promise(() => {});
        },
        cancel(): void {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const output = await decode({ stream: () => sourceStream });
    const reader = output.getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    const pending = reader.read();
    while (!pendingPull) await Promise.resolve();

    await reader.cancel('consumer stopped');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(cancelled).toBe(1);
    expect(sourceStream.locked).toBe(false);
  });

  it('preserves a sequential source error as a typed demux failure and unlocks the reader', async () => {
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const firstPayloadEnd = 68 + 4096 * 2 * 3;
    const sourceFailure = new Error('producer failed after first PCM chunk');
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(bytes.slice(0, firstPayloadEnd));
        },
        pull(controller): void {
          controller.error(sourceFailure);
        },
      },
      { highWaterMark: 0 },
    );
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const reader = (await decode({ stream: () => sourceStream })).getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    await expect(reader.read()).rejects.toMatchObject({
      code: 'demux-error',
      detail: sourceFailure,
      message: expect.stringContaining('producer failed after first PCM chunk'),
    });
    reader.releaseLock();
    expect(sourceStream.locked).toBe(false);
  });

  it('rejects a sequential signed-24 payload that ends before its declared final frame', async () => {
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const truncated = bytes.slice(0, -3);
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(truncated.subarray(0, 83));
          controller.enqueue(truncated.subarray(83));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const reader = (await decode({ stream: () => sourceStream })).getReader();
    await expect(
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('ended before the declared data payload'),
    });
    reader.releaseLock();
    expect(sourceStream.locked).toBe(false);
  });

  it('amortizes a full fused drain through bounded sequential range windows', async () => {
    const frames = 100_000;
    const sourcePcm = {
      sampleRate: 48_000,
      channels: 2,
      frames,
      planar: [new Float64Array(frames).fill(0.25), new Float64Array(frames).fill(-0.25)],
    } as const;
    const bytes = writeWav(sourcePcm, 's24');
    const reads: Array<readonly [number, number]> = [];
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const chunks = await decode({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-backed fused decode must remain bounded');
      },
    });
    const reader = chunks.getReader();
    let decodedFrames = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.frames).toBeLessThanOrEqual(4096);
      expect(next.value.data[0]).toBe(0.25);
      expect(next.value.data[1]).toBe(-0.25);
      decodedFrames += next.value.frames;
    }
    expect(decodedFrames).toBe(frames);
    expect(reads[0]).toEqual([0, 65_536]);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(Math.max(...reads.map(([start, end]) => end - start))).toBeLessThanOrEqual(1024 * 1024);
  });

  it('drops a pending fused range window when the consumer cancels', async () => {
    const frames = 20_000;
    const bytes = writeWav(
      {
        sampleRate: 48_000,
        channels: 2,
        frames,
        planar: [new Float64Array(frames).fill(0.25), new Float64Array(frames).fill(-0.25)],
      },
      's24',
    );
    let resolveRange: (() => void) | undefined;
    let rangeCalls = 0;
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        expect(this).toBe(source);
        rangeCalls++;
        if (rangeCalls === 1) return Promise.resolve(bytes.subarray(start, end));
        return new Promise((resolve) => {
          resolveRange = () => resolve(bytes.subarray(start, end));
        });
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-backed fused decode must remain bounded');
      },
    };
    const chunks = await decode(source);
    const reader = chunks.getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    expect((await reader.read()).value?.frames).toBe(4096);
    const pending = reader.read();
    while (resolveRange === undefined) await Promise.resolve();

    const cancelled = reader.cancel('consumer stopped during range read');
    resolveRange();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(cancelled).resolves.toBeUndefined();
    expect(rangeCalls).toBe(2);
    reader.releaseLock();
    expect(chunks.locked).toBe(false);
  });

  it('keeps every fused range request bounded for high-channel PCM', async () => {
    const frames = 4096;
    const channels = 96;
    const bytes = writeWav(
      {
        sampleRate: 48_000,
        channels,
        frames,
        planar: Array.from({ length: channels }, () => new Float64Array(frames).fill(0.125)),
      },
      's24',
    );
    const reads: Array<readonly [number, number]> = [];
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const chunks = await decode({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-backed fused decode must remain bounded');
      },
    });

    const reader = chunks.getReader();
    let decodedFrames = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      decodedFrames += next.value.frames;
    }

    expect(decodedFrames).toBe(frames);
    expect(reads.every(([start, end]) => end - start <= 1024 * 1024)).toBe(true);
  });

  it('keeps a stream-backed source locked only until the fused PCM payload is consumed', async () => {
    const bytes = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [new Float64Array([0.25, -0.25, 0.5, -0.5])],
      },
      's24',
    );
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');

    const chunks = await decode({ stream: () => sourceStream });

    expect(sourceStream.locked).toBe(true);
    const reader = chunks.getReader();
    const first = await reader.read();
    expect(first.value?.frames).toBe(4);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(sourceStream.locked).toBe(false);
  });

  it('cancels and unlocks a pending stream-backed fused fallback on abort', async () => {
    const bytes = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [new Float64Array([0.25, -0.25, 0.5, -0.5])],
      },
      's24',
    );
    let releasePull: (() => void) | undefined;
    let cancelled = false;
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes.subarray(0, 12));
      },
      pull(controller): Promise<void> {
        return new Promise((resolve) => {
          releasePull = () => {
            controller.enqueue(bytes.subarray(12));
            controller.close();
            resolve();
          };
        });
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const decode = WavDriver.decodePcmInterleavedStream;
    if (decode === undefined) throw new Error('WavDriver must expose fused interleaved PCM decode');
    const abort = new AbortController();
    const pending = decode({ stream: () => sourceStream }, { signal: abort.signal });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (releasePull === undefined) await Promise.resolve();

    abort.abort('stop');
    await Promise.resolve();
    await Promise.resolve();
    const wasCancelledPromptly = cancelled;
    if (!cancelled) releasePull?.();

    expect(wasCancelledPromptly).toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: 'aborted' });
    expect(sourceStream.locked).toBe(false);
  });

  it('wavPacketInfoFromUrl uses one small range for header-visible data chunks', async () => {
    const bytes = await loadFixture('sfx-pcm-s24.wav');
    const server = rangeServer(bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const table = await wavPacketInfoFromUrl('https://fixtures.invalid/sfx-pcm-s24.wav', {
        mime: 'audio/wav',
        size: bytes.byteLength,
      });
      expect(table).toEqual(wavPacketInfoFromBytes(bytes));
      await expect(
        wavPacketInfoFromUrl('https://fixtures.invalid/sfx-pcm-s24.wav', {
          mime: 'audio/wav',
          size: bytes.byteLength,
        }),
      ).resolves.toEqual(table);
      expect(table.packets.reduce((total, packet) => total + packet.size, 0)).toBe(
        chunkPayload(bytes, 'data').byteLength,
      );
      expect(server.calls).toEqual([{ method: 'GET', range: 'bytes=0-127', bytes: 128 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('wavTrimFromUrl caches bounded raw source bytes and authors a fresh exact slice', async () => {
    const bytes = writeWav(
      {
        sampleRate: 10,
        channels: 1,
        frames: 10,
        planar: [Float64Array.of(-0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9)],
      },
      's16',
    );
    const server = rangeServer(bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const trim = { startSec: 0.21, endSec: 0.74 };
      const first = await wavTrimFromUrl('https://fixtures.invalid/sfx-pcm-s16.wav', {
        ...trim,
        mime: 'audio/wav',
        size: bytes.byteLength,
      });
      const second = await wavTrimFromUrl('https://fixtures.invalid/sfx-pcm-s16.wav', {
        ...trim,
        mime: 'audio/wav',
        size: bytes.byteLength,
      });

      expect(first).toEqual(second);
      expect(second).not.toBe(first);
      expect(first).not.toEqual(bytes);
      expect(first.byteLength).toBe(44 + 5 * 2);
      expect(chunkPayload(first, 'data')).toEqual(
        chunkPayload(bytes, 'data').subarray(2 * 2, 7 * 2),
      );
      expect(readWavPcm(first).frames).toBe(5);
      expect(server.calls).toEqual([
        {
          method: 'GET',
          range: `bytes=0-${bytes.byteLength - 1}`,
          bytes: bytes.byteLength,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('parses seeded valid PCM headers with arbitrary aligned metadata preludes', () => {
    const next = seededWavUint32(0xa11ce55e);
    const sampleRates = [8_000, 11_025, 22_050, 44_100, 48_000, 96_000] as const;
    const bitDepths = [8, 16, 24, 32] as const;
    const unknownIds = ['JUNK', 'LIST', 'PAD '] as const;

    for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
      const channels = 1 + (next() % 8);
      const sampleRate = sampleRates[next() % sampleRates.length] ?? 48_000;
      const bits = bitDepths[next() % bitDepths.length] ?? 16;
      const bytesPerFrame = channels * (bits >> 3);
      const frames = next() % 129;
      const data = new Uint8Array(frames * bytesPerFrame);
      for (let index = 0; index < data.byteLength; index++) data[index] = next() & 0xff;

      const fmt = new Uint8Array(16);
      const formatView = new DataView(fmt.buffer);
      formatView.setUint16(0, 1, true);
      formatView.setUint16(2, channels, true);
      formatView.setUint32(4, sampleRate, true);
      formatView.setUint32(8, sampleRate * bytesPerFrame, true);
      formatView.setUint16(12, bytesPerFrame, true);
      formatView.setUint16(14, bits, true);

      const metadata: Uint8Array[] = [];
      const metadataCount = next() % 4;
      for (let chunkIndex = 0; chunkIndex < metadataCount; chunkIndex++) {
        const body = new Uint8Array(next() % 34);
        for (let index = 0; index < body.byteLength; index++) body[index] = next() & 0xff;
        metadata.push(testRiffChunk(unknownIds[next() % unknownIds.length] ?? 'JUNK', body));
      }
      const split = next() % (metadata.length + 1);
      const bytes = testRiffWave([
        ...metadata.slice(0, split),
        testRiffChunk('fmt ', fmt),
        ...metadata.slice(split),
        testRiffChunk('data', data),
      ]);
      const info = parseWav(bytes, bytes.byteLength);

      expect(info).toEqual({
        codec: bits === 8 ? 'pcm-u8' : `pcm-s${bits}`,
        sampleRate,
        channels,
        durationSec: frames / sampleRate,
      });
    }
  });

  it('keeps seeded truncations and header mutations on typed bounded outcomes', () => {
    const next = seededWavUint32(0xbadf00d);
    const fmt = new Uint8Array(16);
    const formatView = new DataView(fmt.buffer);
    formatView.setUint16(0, 1, true);
    formatView.setUint16(2, 2, true);
    formatView.setUint32(4, 48_000, true);
    formatView.setUint32(8, 192_000, true);
    formatView.setUint16(12, 4, true);
    formatView.setUint16(14, 16, true);
    const valid = testRiffWave([
      testRiffChunk('JUNK', Uint8Array.of(1, 2, 3, 4, 5)),
      testRiffChunk('fmt ', fmt),
      testRiffChunk('data', new Uint8Array(257)),
    ]);

    const malformed: Uint8Array[] = [];
    for (let caseIndex = 0; caseIndex < 192; caseIndex++) {
      const candidate = valid.slice(0, next() % (valid.byteLength + 1));
      if (candidate.byteLength > 12 && (next() & 1) === 1) {
        const mutationOffset = 12 + (next() % Math.min(48, candidate.byteLength - 12));
        candidate[mutationOffset] = (candidate[mutationOffset] ?? 0) ^ (1 << (next() % 8));
      }
      malformed.push(candidate);
    }

    const extensibleTruncation = testRiffWave([testRiffChunk('fmt ', fmt)]).subarray(0, 40);
    new DataView(
      extensibleTruncation.buffer,
      extensibleTruncation.byteOffset,
      extensibleTruncation.byteLength,
    ).setUint32(16, 40, true);
    malformed.push(extensibleTruncation);

    for (const candidate of malformed) {
      try {
        const info = parseWav(candidate, candidate.byteLength);
        expect(Number.isFinite(info.durationSec)).toBe(true);
        expect(Number.isSafeInteger(info.channels)).toBe(true);
        expect(Number.isSafeInteger(info.sampleRate)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(MediaError);
      }
    }
    expect(() => readWavPcm(extensibleTruncation)).toThrowError(MediaError);
  });
});

describe('WavDriver.transformPcm — PCM-native path (ADR-022)', () => {
  const SIN = 'sin_440Hz_-6dBFS_1s.wav';
  const transformPcm = WavDriver.transformPcm;
  if (!transformPcm) throw new Error('WavDriver must expose transformPcm');
  const sineWav = (freq: number, sampleRate: number, frames: number, amp = 0.5): Uint8Array =>
    writeWav(
      {
        sampleRate,
        channels: 1,
        frames,
        planar: [
          Float64Array.from(
            { length: frames },
            (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sampleRate),
          ),
        ],
      },
      's16',
    );
  const stereoSineWav = (sampleRate: number, frames: number): Uint8Array =>
    writeWav(
      {
        sampleRate,
        channels: 2,
        frames,
        planar: [
          Float64Array.from(
            { length: frames },
            (_, i) => 0.55 * Math.sin((2 * Math.PI * 997 * i) / sampleRate),
          ),
          Float64Array.from(
            { length: frames },
            (_, i) => 0.35 * Math.sin((2 * Math.PI * 1499 * i) / sampleRate),
          ),
        ],
      },
      's16',
    );
  const rms = (ch: Float64Array): number => {
    let sum = 0;
    for (const sample of ch) sum += sample * sample;
    return Math.sqrt(sum / Math.max(1, ch.length));
  };
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

  it('streams a fresh canonical header before the immutable PCM payload under pull backpressure', async () => {
    const canonical = writeWav(
      {
        sampleRate: 48_000,
        channels: 2,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5), Float64Array.of(0.5, -0.5, 0.75, -0.75)],
      },
      's16',
    );
    const withJunk = withJunkChunk(canonical);
    const stream = await transformPcm(streamOnly(withJunk), {
      container: 'wav',
      sampleFormat: 's16',
      endian: 'le',
      channels: 2,
      sampleRate: 48_000,
    });
    const reader = stream.getReader();
    const header = await reader.read();
    expect(header.done).toBe(false);
    expect(header.value).toEqual(canonical.subarray(0, 44));
    const payload = await reader.read();
    expect(payload.done).toBe(false);
    expect(payload.value).toEqual(chunkPayload(canonical, 'data'));
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  it('releases a copy payload when cancelled between its canonical header and PCM bytes', async () => {
    const bytes = await loadFixture('stereo-48000.wav');
    const stream = await transformPcm(streamOnly(bytes), {
      container: 'wav',
      sampleFormat: 's16',
      endian: 'le',
      channels: 2,
      sampleRate: 48_000,
    });
    const reader = stream.getReader();
    const header = await reader.read();
    expect(header.value?.byteLength).toBe(44);
    await reader.cancel('stop before payload');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  it('rejects a WAV copy stream before its first pull when already aborted', async () => {
    const abort = new AbortController();
    abort.abort('stop before stream construction');
    const reader = streamWavPcmCopy(
      { header: new Uint8Array(44), payload: Uint8Array.of(1, 2, 3, 4) },
      abort.signal,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
    reader.releaseLock();
  });

  it('errors a WAV copy stream and releases its pending payload on live abort', async () => {
    const abort = new AbortController();
    const header = Uint8Array.from({ length: 44 }, (_value, index) => index);
    const reader = streamWavPcmCopy(
      { header, payload: Uint8Array.of(7, 8, 9, 10) },
      abort.signal,
    ).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: header });
    abort.abort('stop before payload');
    await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
    reader.releaseLock();
  });

  it('snapshots multipart Blob output before the caller mutates its original input bytes', async () => {
    const canonical = await loadFixture('stereo-48000.wav');
    const input = withJunkChunk(canonical);
    const expected = rewriteWavPcmCopy(input, 's16', 'le', 2, 48_000);
    if (expected === undefined) throw new Error('expected same-layout canonical WAV rewrite');
    const output = await createMedia().convert(fromBytes(input, { mime: 'audio/wav' }), {
      to: 'wav',
      audio: { codec: 'pcm-s16', channels: 2, sampleRate: 48_000 },
    });
    if (!(output instanceof Blob)) throw new Error('expected Blob output');
    input.fill(0);
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(expected);
  });

  it('routes an unhinted WAV before its single full copy-plan read', async () => {
    const input = await loadFixture('stereo-48000.wav');
    const reads: Array<readonly [number, number]> = [];
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: input.byteLength,
      stream: () => {
        throw new Error('unhinted range source must not open a stream');
      },
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(input.subarray(start, end));
      },
    };
    const output = await createMedia().convert(source, {
      to: 'wav',
      audio: { codec: 'pcm-s16', channels: 2, sampleRate: 48_000 },
    });
    expect(await outputBytes(output)).toEqual(input);
    expect(reads).toHaveLength(3);
    expect(reads.slice(0, -1).every(([start, end]) => start === 0 && end < input.byteLength)).toBe(
      true,
    );
    expect(reads.at(-1)).toEqual([0, input.byteLength]);
  });

  it('forwards cancellation into the direct WAV copy-plan range read', async () => {
    const input = await loadFixture('stereo-48000.wav');
    const abort = new AbortController();
    let entered!: () => void;
    const rangeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let rangeSignal: AbortSignal | undefined;
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: input.byteLength,
      mimeHint: 'audio/wav',
      stream: () => {
        throw new Error('direct range copy must not open a stream');
      },
      range: (_start, _end, signal) => {
        rangeSignal = signal;
        entered();
        if (signal === undefined) {
          return Promise.reject(new Error('direct copy range read requires the operation signal'));
        }
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new MediaError('aborted', 'operation aborted', signal.reason)),
            { once: true },
          );
        });
      },
    };

    const pending = createMedia().convert(
      source,
      {
        to: 'wav',
        audio: { codec: 'pcm-s16', channels: 2, sampleRate: 48_000 },
      },
      { signal: abort.signal },
    );
    await rangeEntered;
    abort.abort('cancel direct copy read');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(rangeSignal?.aborted).toBe(true);
    expect(rangeSignal?.reason).toBe('cancel direct copy read');
  });

  it('direct-resamples s16 WAV to canonical s16 WAV for sample-rate-only transforms', () => {
    const input = sineWav(997, 44_100, 44_100, 0.65);
    const out = tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 16_000 });
    if (out === undefined) throw new Error('s16 WAV resample fast path must be eligible');

    const re = readWavPcm(out);
    expect(re.sampleRate).toBe(16_000);
    expect(re.channels).toBe(1);
    expect(re.frames).toBe(16_000);
    expect(peak(channelAt(re.planar, 0))).toBeGreaterThan(0.5);
  });

  it.each([
    {
      sourceRate: 44_100,
      targetRate: 48_000,
      sourceFrames: 100,
      outputFrames: 109,
      sha256: '20e3eeddc6bc8e71be81fff96c8f1990a359db0d5653e5b70a80aa5da78f40ca',
      first: [-20423, -13667, -5414, 906, 9839, 12837, 31120, 3059, -32768, -17713, -14017, -5814],
      last: [23994, -29863, -21719, -12978, -6883, 645, 9143, 12339, 29872, 6434, -32768, -15404],
    },
    {
      sourceRate: 48_000,
      targetRate: 44_100,
      sourceFrames: 101,
      outputFrames: 93,
      sha256: '23c21db3ce2f186cc7ea22a284127c01eecb17d40c8b6a015a1056d81e90c2a0',
      first: [-19422, -12065, -3337, 6399, 11233, 30179, -3593, -32768, -14287, -9434, 882, 7645],
      last: [26980, 14835, -32678, -14808, -9569, 119, 8807, 16392, 27947, -26436, -24350, -11989],
    },
    {
      sourceRate: 48_000,
      targetRate: 16_000,
      sourceFrames: 100,
      outputFrames: 33,
      sha256: '90318225348e52a246aa38b276b4f0e34bda16dd14e76b8e27a8297026419c9d',
      first: [
        -13083, 6002, 6524, -21229, 15296, -10869, -15154, 21247, -6083, -6908, 18857, -19558,
      ],
      last: [18040, -20375, 5390, 4565, -22765, 13636, 9346, -16793, 19651, -7900, -7901, 15336],
    },
  ] as const)(
    'keeps paired mono FIR byte-exact with scalar boundaries at $sourceRate→$targetRate Hz',
    async ({ sourceRate, targetRate, sourceFrames, outputFrames, sha256, first, last }) => {
      const input = writeWav(
        {
          sampleRate: sourceRate,
          channels: 1,
          frames: sourceFrames,
          planar: [
            Float64Array.from(
              { length: sourceFrames },
              (_, frame) => (((frame * 7_919 + 12_345) & 0xffff) - 32_768) / 32_768,
            ),
          ],
        },
        's16',
      );
      const out = tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleRate: targetRate,
      });
      if (out === undefined) throw new Error('mono s16 FIR fast path must be eligible');

      const decoded = readWavPcm(out);
      const samples = new Int16Array(out.buffer, out.byteOffset + 44, decoded.frames);
      expect(decoded.frames).toBe(outputFrames);
      expect(decoded.frames & 1).toBe(1);
      expect(await sha256Hex(out)).toBe(sha256);
      expect(Array.from(samples.subarray(0, first.length))).toEqual(first);
      expect(Array.from(samples.subarray(samples.length - last.length))).toEqual(last);
    },
  );

  it('keeps a real low-pass filter in the s16 WAV direct resampler', () => {
    const input = sineWav(12_000, 44_100, 44_100, 0.8);
    const out = tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 16_000 });
    if (out === undefined) throw new Error('s16 WAV resample fast path must be eligible');

    const source = rms(channelAt(readWavPcm(input).planar, 0));
    const re = rms(channelAt(readWavPcm(out).planar, 0));
    expect(re).toBeLessThan(source * 0.04);
  });

  it('direct-resamples interleaved stereo s16 WAV without collapsing channels', () => {
    const input = stereoSineWav(48_000, 48_000);
    const first = tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 16_000 });
    const cached = tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 16_000 });
    if (first === undefined || cached === undefined) {
      throw new Error('stereo s16 WAV resample fast path must be eligible');
    }

    const re = readWavPcm(first);
    expect(re.sampleRate).toBe(16_000);
    expect(re.channels).toBe(2);
    expect(re.frames).toBe(16_000);
    expect(peak(channelAt(re.planar, 0))).toBeGreaterThan(0.45);
    expect(peak(channelAt(re.planar, 1))).toBeGreaterThan(0.25);
    expect(differs(channelAt(re.planar, 0), channelAt(re.planar, 1))).toBe(true);
    expect(cached).toEqual(first);
  });

  it.each([
    [44_100, 48_000],
    [48_000, 44_100],
    [48_000, 16_000],
  ] as const)(
    'keeps the fused stereo FIR byte-exact with two independent mono FIRs at %i→%i Hz',
    (sourceRate, targetRate) => {
      const input = readWavPcm(stereoSineWav(sourceRate, sourceRate));
      const stereoBytes = writeWav(input, 's16');
      const mono = (channel: number): Uint8Array =>
        writeWav(
          {
            sampleRate: sourceRate,
            channels: 1,
            frames: input.frames,
            planar: [channelAt(input.planar, channel)],
          },
          's16',
        );
      const stereoOut = tryResampleWavS16ToS16Wav(stereoBytes, {
        container: 'wav',
        sampleRate: targetRate,
      });
      const leftOut = tryResampleWavS16ToS16Wav(mono(0), {
        container: 'wav',
        sampleRate: targetRate,
      });
      const rightOut = tryResampleWavS16ToS16Wav(mono(1), {
        container: 'wav',
        sampleRate: targetRate,
      });
      if (stereoOut === undefined || leftOut === undefined || rightOut === undefined) {
        throw new Error('stereo and mono s16 FIR paths must be eligible');
      }

      const stereo = readWavPcm(stereoOut);
      expect(channelAt(stereo.planar, 0)).toEqual(channelAt(readWavPcm(leftOut).planar, 0));
      expect(channelAt(stereo.planar, 1)).toEqual(channelAt(readWavPcm(rightOut).planar, 0));
    },
  );

  it('exposes the same direct s16 resampler through the core byte helper', () => {
    const input = stereoSineWav(48_000, 48_000);
    const direct = tryResampleWavS16ToS16Wav(input, {
      container: 'wav',
      sampleFormat: 's16',
      endian: 'le',
      sampleRate: 16_000,
    });
    const helper = wavS16ResampleToWavFromBytes(input, { sampleRate: 16_000 });
    if (direct === undefined || helper === undefined) {
      throw new Error('s16 WAV resample byte helper must be eligible');
    }
    expect(helper).toEqual(direct);
  });

  it('declines unsupported direct-resample shapes before the canonical PCM fallback', () => {
    const input = sineWav(997, 44_100, 256, 0.65);
    const sourceF32 = writeWav(readWavPcm(input), 'f32');
    const zeroChannels = input.slice();
    const zeroRate = input.slice();
    const misalignedBacking = new Uint8Array(input.byteLength + 1);
    misalignedBacking.set(input, 1);
    const misaligned = misalignedBacking.subarray(1);
    new DataView(zeroChannels.buffer, zeroChannels.byteOffset, zeroChannels.byteLength).setUint16(
      22,
      0,
      true,
    );
    new DataView(zeroRate.buffer, zeroRate.byteOffset, zeroRate.byteLength).setUint32(24, 0, true);

    expect(
      tryResampleWavS16ToS16Wav(input, { container: 'aiff', sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(tryResampleWavS16ToS16Wav(input, { container: 'wav' })).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(input, { container: 'wav', endian: 'be', sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(input, { container: 'wav', channels: 2, sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 44_100 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(input, { container: 'wav', sampleRate: 16_000.5 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(sourceF32, { container: 'wav', sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(zeroChannels, { container: 'wav', sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(zeroRate, { container: 'wav', sampleRate: 16_000 }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(misaligned, { container: 'wav', sampleRate: 16_000 }),
    ).toBeUndefined();
  });

  it('honors abort signals before direct s16 WAV resample work starts', () => {
    const input = sineWav(997, 44_100, 44_100, 0.65);
    expect(() =>
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleRate: 16_000,
        signal: AbortSignal.abort(),
      }),
    ).toThrowError(MediaError);
  });

  it('polls abort signals at the scalar cadence inside the paired mono FIR loop', () => {
    const input = sineWav(997, 44_100, 5_000, 0.65);
    let polls = 0;
    const signal = {
      get aborted(): boolean {
        polls++;
        return polls === 4;
      },
    } as unknown as AbortSignal;

    expect(() =>
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleRate: 48_000,
        signal,
      }),
    ).toThrowError(MediaError);
    expect(polls).toBe(4);
  });

  it('routes sample-rate-only s16 WAV transforms through the direct resample writer', async () => {
    const canonical = sineWav(997, 44_100, 44_100, 0.65);
    const withJunk = withJunkChunk(canonical);
    const expected = tryResampleWavS16ToS16Wav(withJunk, {
      container: 'wav',
      sampleFormat: 's16',
      endian: 'le',
      sampleRate: 16_000,
    });
    if (expected === undefined) throw new Error('s16 WAV resample fast path must be eligible');

    const out = await drain(
      await transformPcm(streamOnly(withJunk), {
        container: 'wav',
        sampleFormat: 's16',
        endian: 'le',
        sampleRate: 16_000,
      }),
    );
    expect(out).toEqual(expected);
    expect(out).not.toEqual(withJunk);
  });

  it('leaves non-s16 or multi-stage WAV transforms on the canonical PCM path', () => {
    const input = sineWav(997, 44_100, 44_100, 0.65);
    expect(
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleFormat: 'f32',
        sampleRate: 16_000,
      }),
    ).toBeUndefined();
    expect(
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleRate: 16_000,
        gainDb: 0,
      }),
    ).toBeUndefined();
  });

  it('trims same-layout WAV PCM by copying the selected data bytes into a fresh envelope', async () => {
    const canonical = writeWav(
      {
        sampleRate: 10,
        channels: 1,
        frames: 10,
        planar: [Float64Array.of(-0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9)],
      },
      's16',
    );
    const withJunk = withJunkChunk(canonical);
    const out = await drain(
      await transformPcm(streamOnly(withJunk), {
        container: 'wav',
        timeBounds: { startSec: 0.21, endSec: 0.74 },
      }),
    );

    expect(out.byteLength).toBe(44 + 5 * 2);
    expect(out).not.toEqual(withJunk);
    expect(chunkPayload(out, 'data')).toEqual(
      chunkPayload(canonical, 'data').subarray(2 * 2, 7 * 2),
    );
    const re = readWavPcm(out);
    expect(re.frames).toBe(5);
    expect(channelAt(re.planar, 0)).toEqual(
      channelAt(readWavPcm(canonical).planar, 0).subarray(2, 7),
    );
  });

  it('range-trims WAV PCM from a prefix plus the selected sample window', async () => {
    const samples = Float64Array.from({ length: 600_000 }, (_, i) => ((i % 101) - 50) / 50);
    const canonical = writeWav(
      {
        sampleRate: 1000,
        channels: 1,
        frames: samples.length,
        planar: [samples],
      },
      's16',
    );
    const calls: Array<{ readonly start: number; readonly end: number; readonly bytes: number }> =
      [];
    const source: ByteSource = {
      size: canonical.byteLength,
      stream: () => {
        throw new Error('range fast path must not stream the full WAV');
      },
      range: (start, end) => {
        const slice = canonical.subarray(start, end).slice();
        calls.push({ start, end, bytes: slice.byteLength });
        return Promise.resolve(slice);
      },
    };
    const out = await drain(
      await transformPcm(source, {
        container: 'wav',
        timeBounds: { startSec: 300, endSec: 301 },
      }),
    );

    expect(out.byteLength).toBe(44 + 1000 * 2);
    expect(chunkPayload(out, 'data')).toEqual(
      chunkPayload(canonical, 'data').subarray(300_000 * 2, 301_000 * 2),
    );
    expect(calls).toEqual([
      { start: 0, end: 4096, bytes: 4096 },
      { start: 44 + 300_000 * 2, end: 44 + 301_000 * 2, bytes: 1000 * 2 },
    ]);
    expect(calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(canonical.byteLength);
  });

  it('range-trims WAV PCM directly from the prefix when the selected window is already buffered', async () => {
    const samples = Float64Array.from({ length: 525_000 }, (_, i) => (i % 2 === 0 ? -0.25 : 0.25));
    const canonical = writeWav(
      {
        sampleRate: 1000,
        channels: 1,
        frames: samples.length,
        planar: [samples],
      },
      's16',
    );
    const calls: Array<{ readonly start: number; readonly end: number; readonly bytes: number }> =
      [];
    const source: ByteSource = {
      size: canonical.byteLength,
      stream: () => {
        throw new Error('prefix-contained range trim must not stream the full WAV');
      },
      range: (start, end) => {
        const slice = canonical.subarray(start, end).slice();
        calls.push({ start, end, bytes: slice.byteLength });
        return Promise.resolve(slice);
      },
    };

    const out = await drain(
      await transformPcm(source, {
        container: 'wav',
        timeBounds: { startSec: 0.001, endSec: 0.002 },
      }),
    );

    expect(out.byteLength).toBe(44 + 2);
    expect(chunkPayload(out, 'data')).toEqual(chunkPayload(canonical, 'data').subarray(2, 4));
    expect(calls).toEqual([{ start: 0, end: 4096, bytes: 4096 }]);
  });

  it('applies gain in the PCM domain (≈ ×0.5 at -6.02 dB)', async () => {
    const bytes = await loadFixture(SIN);
    const out = await drain(await transformPcm(streamOnly(bytes), { gainDb: -6.020599913279624 }));
    const orig = peak(channelAt(readWavPcm(bytes).planar, 0));
    expect(peak(channelAt(readWavPcm(out).planar, 0))).toBeCloseTo(orig * 0.5, 2);
  });

  it('direct-applies f32 WAV gain into the same canonical output as the PCM reference', () => {
    const canonical = writeWav(
      {
        sampleRate: 48_000,
        channels: 2,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5), Float64Array.of(-0, -0.75, 0.75, -1)],
      },
      'f32',
    );
    const withJunk = withJunkChunk(canonical);
    const direct = tryGainWavF32ToF32Wav(withJunk, {
      container: 'wav',
      sampleFormat: 'f32',
      endian: 'le',
      gainDb: -6.020599913279624,
    });
    const reference = writeWav(gain(readWavPcm(withJunk), -6.020599913279624), 'f32');

    expect(direct).toEqual(reference);
    expect(direct).not.toEqual(withJunk);
  });

  it('routes clean f32 WAV gain transforms through the direct writer', async () => {
    const bytes = await loadFixture('sfx-pcm-f32.wav');
    const expected = tryGainWavF32ToF32Wav(bytes, {
      container: 'wav',
      sampleFormat: 'f32',
      endian: 'le',
      gainDb: -6.020599913279624,
    });
    if (expected === undefined) throw new Error('f32 WAV gain fast path must be eligible');

    const out = await drain(
      await transformPcm(streamOnly(bytes), {
        container: 'wav',
        sampleFormat: 'f32',
        endian: 'le',
        gainDb: -6.020599913279624,
      }),
    );
    expect(out).toEqual(expected);
  });

  it('declines unsupported f32 WAV gain fast-path shapes before the canonical PCM fallback', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      'f32',
    );
    const sourceS16 = writeWav(readWavPcm(input), 's16');

    expect(tryGainWavF32ToF32Wav(input, { container: 'aiff', gainDb: -6 })).toBeUndefined();
    expect(tryGainWavF32ToF32Wav(input, { container: 'wav' })).toBeUndefined();
    expect(tryGainWavF32ToF32Wav(input, { container: 'wav', gainDb: 0 })).toBeUndefined();
    expect(tryGainWavF32ToF32Wav(input, { container: 'wav', gainDb: Number.NaN })).toBeUndefined();
    expect(
      tryGainWavF32ToF32Wav(input, { container: 'wav', endian: 'be', gainDb: -6 }),
    ).toBeUndefined();
    expect(
      tryGainWavF32ToF32Wav(input, { container: 'wav', sampleFormat: 's16', gainDb: -6 }),
    ).toBeUndefined();
    expect(
      tryGainWavF32ToF32Wav(input, { container: 'wav', channels: 2, gainDb: -6 }),
    ).toBeUndefined();
    expect(
      tryGainWavF32ToF32Wav(input, { container: 'wav', sampleRate: 44_100, gainDb: -6 }),
    ).toBeUndefined();
    expect(
      tryGainWavF32ToF32Wav(input, {
        container: 'wav',
        gainDb: -6,
        fade: { inSec: 0.1 },
      }),
    ).toBeUndefined();
    expect(tryGainWavF32ToF32Wav(sourceS16, { container: 'wav', gainDb: -6 })).toBeUndefined();
  });

  it.each([
    ['f32', 's16'],
    ['f32', 's24'],
    ['s24', 's16'],
    ['s24', 'f32'],
    ['s16', 's24'],
    ['s16', 'f32'],
  ] as const)(
    'direct-converts %s WAV to %s bytes equal to the canonical PCM reference',
    (sourceFormat, targetFormat) => {
      const canonical = writeWav(
        {
          sampleRate: 48_000,
          channels: 2,
          frames: 6,
          planar: [
            Float64Array.of(-1.25, -1, -0.5001, 0, 0.4999, 1.25),
            Float64Array.of(1, 0.75, 0.5, -0.5, -0.75, -1),
          ],
        },
        sourceFormat,
      );
      const withJunk = withJunkChunk(canonical);
      const direct = tryConvertWavPcmFormatToWav(withJunk, {
        container: 'wav',
        sampleFormat: targetFormat,
        endian: 'le',
      });
      const forcedDataView = tryConvertWavPcmFormatToWav(
        withJunk,
        {
          container: 'wav',
          sampleFormat: targetFormat,
          endian: 'le',
        },
        false,
      );
      const reference = writeWav(readWavPcm(withJunk), targetFormat);

      expect(direct).toEqual(reference);
      expect(forcedDataView).toEqual(reference);
      expect(direct).not.toEqual(withJunk);
    },
  );

  it.each([
    ['f32', 's16', 32_768],
    ['f32', 's24', 8_388_608],
    ['s24', 's16', 32_768],
  ] as const)(
    'keeps direct %s→%s exact-half quantization byte-equal to canonical nearest-even output',
    (sourceFormat, targetFormat, targetScale) => {
      const targetCodes = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
      const input = writeWav(
        {
          sampleRate: 48_000,
          channels: 1,
          frames: targetCodes.length,
          planar: [Float64Array.from(targetCodes, (code) => code / targetScale)],
        },
        sourceFormat,
      );
      const direct = tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: targetFormat,
      });
      const reference = writeWav(readWavPcm(input), targetFormat);

      expect(direct).toEqual(reference);
      if (direct === undefined) throw new Error('expected direct PCM conversion');
      const quantized = readWavPcm(direct);
      expect(Array.from(channelAt(quantized.planar, 0), (sample) => sample * targetScale)).toEqual([
        -2, -2, 0, 0, 2, 2,
      ]);
    },
  );

  it('applies exact floor truncation for public s24-to-s16 byte conversion', () => {
    const sourceCodes = [
      -8_388_608, -32_769, -32_768, -257, -256, -255, -1, 0, 1, 255, 256, 257, 32_767, 32_768,
      8_388_607,
    ];
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: sourceCodes.length,
        planar: [Float64Array.from(sourceCodes, (code) => code / 8_388_608)],
      },
      's24',
    );
    const output = wavPcmFormatToWavFromBytes(input, {
      sampleFormat: 's16',
      quantization: {
        dither: 'none',
        rounding: 'truncate-toward-negative-infinity',
        clipping: 'saturate',
      },
    });
    if (output === undefined) throw new Error('expected direct floor-truncating PCM conversion');
    const decoded = readWavPcm(output);
    expect(Array.from(channelAt(decoded.planar, 0), (sample) => sample * 32_768)).toEqual(
      sourceCodes.map((code) => Math.floor(code / 256)),
    );
  });

  it('accepts only quantization policies implemented by the direct sample-format pair', () => {
    const s24 = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 2,
        planar: [Float64Array.of(-0.25, 0.25)],
      },
      's24',
    );
    const s16 = writeWav(readWavPcm(s24), 's16');
    const f32 = writeWav(readWavPcm(s24), 'f32');
    const base = {
      sampleFormat: 's16' as const,
      quantization: {
        dither: 'none' as const,
        rounding: 'nearest-even' as const,
        clipping: 'saturate' as const,
      },
    };
    expect(wavPcmFormatToWavFromBytes(s24, base)).toBeDefined();
    expect(
      wavPcmFormatToWavFromBytes(s24, {
        ...base,
        quantization: { ...base.quantization, rounding: 'identity' },
      }),
    ).toBeUndefined();
    expect(
      wavPcmFormatToWavFromBytes(s24, {
        ...base,
        quantization: { ...base.quantization, dither: 'triangular' as never },
      }),
    ).toBeUndefined();
    expect(
      wavPcmFormatToWavFromBytes(s24, {
        ...base,
        quantization: { ...base.quantization, clipping: 'wrap' as never },
      }),
    ).toBeUndefined();
    expect(
      wavPcmFormatToWavFromBytes(s16, {
        sampleFormat: 's24',
        quantization: { ...base.quantization, rounding: 'identity' },
      }),
    ).toBeDefined();
    expect(
      wavPcmFormatToWavFromBytes(s16, {
        sampleFormat: 's24',
        quantization: { ...base.quantization, rounding: 'nearest-even' },
      }),
    ).toBeDefined();
    expect(
      wavPcmFormatToWavFromBytes(s16, {
        sampleFormat: 's24',
        quantization: {
          ...base.quantization,
          rounding: 'truncate-toward-negative-infinity',
        },
      }),
    ).toBeUndefined();
    expect(
      wavPcmFormatToWavFromBytes(s24, {
        sampleFormat: 'f32',
        quantization: { ...base.quantization, rounding: 'identity' },
      }),
    ).toBeDefined();
    expect(
      wavPcmFormatToWavFromBytes(s24, {
        sampleFormat: 'f32',
        quantization: { ...base.quantization, rounding: 'nearest-even' },
      }),
    ).toBeUndefined();
    expect(wavPcmFormatToWavFromBytes(f32, base)).toBeDefined();
    expect(
      wavPcmFormatToWavFromBytes(f32, {
        ...base,
        quantization: { ...base.quantization, rounding: 'identity' },
      }),
    ).toBeUndefined();
  });

  it.each([
    ['sfx-pcm-s24.wav', 's16'],
    ['sfx-pcm-f32.wav', 's24'],
  ] as const)(
    'routes clean %s sample-format-only transforms to %s through the direct converter',
    async (fixture, sampleFormat) => {
      const bytes = withJunkChunk(await loadFixture(fixture));
      const expected = tryConvertWavPcmFormatToWav(bytes, {
        container: 'wav',
        sampleFormat,
        endian: 'le',
      });
      if (expected === undefined) {
        throw new Error(`${fixture}→${sampleFormat} WAV format fast path must be eligible`);
      }

      const out = await drain(
        await transformPcm(streamOnly(bytes), {
          container: 'wav',
          sampleFormat,
          endian: 'le',
        }),
      );
      expect(out).toEqual(expected);
    },
  );

  it('declines unsupported WAV sample-format fast-path shapes before the canonical PCM fallback', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      'f32',
    );
    const sourceU8 = writeWav(readWavPcm(input), 'u8');

    expect(
      tryConvertWavPcmFormatToWav(input, { container: 'aiff', sampleFormat: 's16' }),
    ).toBeUndefined();
    expect(tryConvertWavPcmFormatToWav(input, { container: 'wav' })).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, { container: 'wav', sampleFormat: 's32' }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, { container: 'wav', sampleFormat: 'f32' }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        endian: 'be',
      }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        channels: 2,
      }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        sampleRate: 44_100,
      }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        gainDb: 0,
      }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        timeBounds: { startSec: 0, endSec: 0.001 },
      }),
    ).toBeUndefined();
    expect(
      tryConvertWavPcmFormatToWav(sourceU8, { container: 'wav', sampleFormat: 's16' }),
    ).toBeUndefined();
  });

  it('honors abort signals before direct WAV sample-format conversion starts', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      'f32',
    );
    expect(() =>
      tryConvertWavPcmFormatToWav(input, {
        container: 'wav',
        sampleFormat: 's16',
        signal: AbortSignal.abort(),
      }),
    ).toThrowError(MediaError);
  });

  it.each(['s16', 's24'] as const)(
    'direct-rewrites %s WAV to big-endian AIFF bytes equal to the canonical PCM reference',
    (format) => {
      const canonical = writeWav(
        {
          sampleRate: 48_000,
          channels: 2,
          frames: 6,
          planar: [
            Float64Array.of(-1, -0.75, -0.5, 0, 0.5, 1),
            Float64Array.of(1, 0.75, 0.25, -0.25, -0.75, -1),
          ],
        },
        format,
      );
      const withJunk = withJunkChunk(canonical);
      const direct = tryRewriteWavPcmToAiffBe(withJunk, {
        container: 'aiff',
        sampleFormat: format,
        endian: 'be',
      });
      const reference = writeAiff(readWavPcm(withJunk), format, { endian: 'be' });

      expect(direct).toEqual(reference);
      expect(direct).not.toEqual(withJunk);
      const source = readWavPcm(withJunk);
      const aiff = readAiffPcm(direct ?? new Uint8Array());
      expect(aiff.sampleRate).toBe(source.sampleRate);
      expect(aiff.channels).toBe(source.channels);
      expect(aiff.frames).toBe(source.frames);
      for (let c = 0; c < source.channels; c++) {
        expect(channelAt(aiff.planar, c)).toEqual(channelAt(source.planar, c));
      }
    },
  );

  it('exposes the canonical WAV-to-AIFF byte-swap through the public driver-author helper', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 2,
        frames: 3,
        planar: [Float64Array.of(-1, 0, 1), Float64Array.of(0.5, -0.5, 0.25)],
      },
      's16',
    );
    const output = wavPcmToAiffFromBytes(input, {
      sampleFormat: 's16',
      channels: 2,
      sampleRate: 48_000,
    });
    expect(wavPcmToAiffFromBytes(input)).toEqual(output);
    expect(output).toEqual(
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        channels: 2,
        sampleRate: 48_000,
      }),
    );
    const decoded = readAiffPcm(output ?? new Uint8Array());
    expect(decoded.endian).toBe('be');
    expect(decoded.frames).toBe(3);
    expect(decoded.channels).toBe(2);
    expect(() =>
      wavPcmToAiffFromBytes(input, {
        endian: 'be',
        signal: AbortSignal.abort(),
      }),
    ).toThrowError(MediaError);
  });

  it('routes clean WAV to big-endian AIFF transforms through the direct byte-swap writer', async () => {
    const bytes = withJunkChunk(await loadFixture('sfx-pcm-s16.wav'));
    const expected = tryRewriteWavPcmToAiffBe(bytes, {
      container: 'aiff',
      sampleFormat: 's16',
      endian: 'be',
    });
    if (expected === undefined) throw new Error('WAV s16→AIFF s16be fast path must be eligible');

    const out = await drain(
      await transformPcm(streamOnly(bytes), {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
      }),
    );
    expect(out).toEqual(expected);
  });

  it('declines unsupported WAV to AIFF byte-swap shapes before the canonical PCM fallback', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      's16',
    );
    const sourceF32 = writeWav(readWavPcm(input), 'f32');

    expect(
      tryRewriteWavPcmToAiffBe(input, { container: 'wav', sampleFormat: 's16', endian: 'be' }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, { container: 'aiff', sampleFormat: 's16' }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, { container: 'aiff', sampleFormat: 's24', endian: 'be' }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        channels: 2,
      }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        sampleRate: 44_100,
      }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        gainDb: 0,
      }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        timeBounds: { startSec: 0, endSec: 0.001 },
      }),
    ).toBeUndefined();
    expect(
      tryRewriteWavPcmToAiffBe(sourceF32, {
        container: 'aiff',
        sampleFormat: 'f32',
        endian: 'be',
      }),
    ).toBeUndefined();
  });

  it('honors abort signals before direct WAV to AIFF byte-swap work starts', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 4,
        planar: [Float64Array.of(0, 0.25, -0.25, 0.5)],
      },
      's16',
    );
    expect(() =>
      tryRewriteWavPcmToAiffBe(input, {
        container: 'aiff',
        sampleFormat: 's16',
        endian: 'be',
        signal: AbortSignal.abort(),
      }),
    ).toThrowError(MediaError);
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
