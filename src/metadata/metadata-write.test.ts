import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../api/create-media.ts';
import type { TrackInfo } from '../contracts/driver.ts';
import { parseAiff, readAiffPcm } from '../drivers/aiff/aiff.ts';
import { parseCaf, readCafPcm } from '../drivers/caf/caf.ts';
import { parseFlac } from '../drivers/flac/flac-driver.ts';
import { enumerateMp3Packets, parseMp3 } from '../drivers/mp3/mp3-driver.ts';
import { readMovie } from '../drivers/mp4/mp4-driver.ts';
import { parseOgg } from '../drivers/ogg/ogg-driver.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { parseWav } from '../drivers/wav/wav-driver.ts';
import { WebmMuxer } from '../drivers/webm/ebml-write.ts';
import { type WebmTrack, demuxWebm, parseWebm } from '../drivers/webm/webm-driver.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { readMp3Id3Tags, writeMp3Id3Tags } from './id3.ts';
import { readMkvTags, writeMkvTags } from './matroska-tags.ts';
import { readMp4Tags, writeMp4Tags } from './mp4-tags.ts';
import { readOggVorbisComment, writeOggVorbisComment } from './ogg-vorbis-comment.ts';
import {
  readAiffTags,
  readCafTags,
  readWavTags,
  writeAiffTags,
  writeCafTags,
  writeWavTags,
} from './pcm-tags.ts';
import { readFlacVorbisComment, writeFlacVorbisComment } from './vorbis-comment.ts';

const DERIVED = new URL('../../fixtures/media-derived/', import.meta.url).pathname;
const LONG_COMMENT = 'metadata:write roundtrip - '.repeat(12);
const TAGS = {
  title: 'Conformance Clip',
  artist: 'aibrush-media-test',
  album: 'Suite Vol. 1',
  comment: LONG_COMMENT,
  date: '2026-06-18',
  genre: 'Test',
  trackNumber: '7',
};

interface RandomAccess {
  read(offset: number, length: number): Promise<Uint8Array>;
  size?: number;
}

function ra(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function blobBytes(output: unknown): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

function expectTags(actual: Record<string, string>): void {
  for (const [key, value] of Object.entries(TAGS)) expect(actual[key]).toBe(value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (c) => c.charCodeAt(0));
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function i64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function riffChunkBytes(id: string, declaredSize: number, body: Uint8Array): Uint8Array {
  return concat([asciiBytes(id), u32le(declaredSize), body]);
}

function iffChunkBytes(id: string, declaredSize: number, body: Uint8Array): Uint8Array {
  return concat([asciiBytes(id), u32be(declaredSize), body]);
}

function cafChunkBytes(id: string, declaredSize: bigint, body: Uint8Array): Uint8Array {
  return concat([asciiBytes(id), i64be(declaredSize), body]);
}

function chunkPayload(bytes: Uint8Array, id: string, endian: 'le' | 'be'): Uint8Array {
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const size = endian === 'le' ? readU32le(bytes, pos + 4) : readU32be(bytes, pos + 4);
    const body = pos + 8;
    if (ascii(bytes, pos, 4) === id) return bytes.slice(body, body + size);
    pos = body + size + (size & 1);
  }
  throw new Error(`missing ${id} chunk`);
}

function cafDataPayload(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 12 <= bytes.byteLength) {
    const type = ascii(bytes, pos, 4);
    const size = Number(dv.getBigInt64(pos + 4));
    const body = pos + 12;
    const end = size < 0 ? bytes.byteLength : body + size;
    if (type === 'data') return bytes.slice(body, end);
    if (size < 0) break;
    pos = end;
  }
  throw new Error('missing CAF data chunk');
}

async function derivedBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${name}`));
}

function trackInfoFromWebm(track: WebmTrack, id: number, durationSec: number): TrackInfo {
  if (track.mediaType === 'video') {
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.width ?? 0,
      codedHeight: track.height ?? 0,
      ...(track.description !== undefined ? { description: track.description } : {}),
    };
    return {
      id,
      mediaType: 'video',
      codec: track.codec,
      durationSec,
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      config,
    };
  }
  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: track.sampleRate ?? 48_000,
    numberOfChannels: track.channels ?? 2,
    ...(track.description !== undefined ? { description: track.description } : {}),
  };
  return { id, mediaType: 'audio', codec: track.codec, durationSec, config };
}

async function mkvFromRealWebm(fixture: string): Promise<Uint8Array> {
  const source = demuxWebm(await loadFixture(fixture));
  const muxer = new WebmMuxer({ container: 'mkv' }, 'matroska');
  const track = source.info.tracks[0];
  const frames = source.framesByIndex[0];
  if (track === undefined || frames === undefined || frames.length === 0) {
    throw new Error(`${fixture} has no muxable first track`);
  }
  const id = muxer.addTrack(trackInfoFromWebm(track, 0, source.info.durationSec));
  for (const frame of frames.slice(0, 12)) {
    muxer.addChunkStruct(id, {
      timestampUs: frame.timestampUs,
      durationUs: undefined,
      key: frame.keyframe,
      data: frame.data.slice(),
    });
  }
  await muxer.finalize();
  return collectBytes(muxer.output);
}

describe('metadata:write tag writers — strict structural readback', () => {
  it.each(['h264.mp4', 'movie_5.mp4', 'test.mp4', '2x2-green.mp4', 'av1.mp4'])(
    'writes MP4 ilst tags without corrupting sample tables: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const before = await readMovie(ra(input));
      const output = writeMp4Tags(input, TAGS);
      const after = await readMovie(ra(output));

      expectTags(readMp4Tags(output));
      expect(after.tracks.map((track) => track.codec)).toEqual(
        before.tracks.map((track) => track.codec),
      );
      expect(after.durationSec).toBeCloseTo(before.durationSec, 6);
      expect(output).not.toEqual(input);
    },
  );

  it.each(['sound_5.mp3', 'bear-vbr-toc.mp3'])(
    'writes MP3 ID3v2 frames while preserving MPEG audio packetization: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const before = parseMp3(input, input.byteLength);
      const beforePackets = enumerateMp3Packets(input);
      const output = writeMp3Id3Tags(input, TAGS);
      const after = parseMp3(output, output.byteLength);

      expectTags(readMp3Id3Tags(output));
      expect(enumerateMp3Packets(output).length).toBe(beforePackets.length);
      expect(after.durationSec).toBeCloseTo(before.durationSec, 6);
      expect(output).not.toEqual(input);
    },
  );

  it.each([
    'sfx.flac',
    'flac-08bit.flac',
    'flac-12bit.flac',
    'flac-24bit-hires.flac',
    'flac-wasted-bits.flac',
  ])(
    'writes native FLAC VORBIS_COMMENT while preserving STREAMINFO duration: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const before = parseFlac(input);
      const output = writeFlacVorbisComment(input, TAGS);
      const after = parseFlac(output);

      expectTags(readFlacVorbisComment(output));
      expect(after.sampleRate).toBe(before.sampleRate);
      expect(after.channels).toBe(before.channels);
      expect(after.totalSamples).toBe(before.totalSamples);
      expect(output).not.toEqual(input);
    },
  );

  it.each(['sfx-opus.ogg', 'sound_5.oga'])(
    'writes Ogg Opus/Vorbis comment headers without changing duration: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const before = parseOgg(input);
      const output = writeOggVorbisComment(input, TAGS);
      const after = parseOgg(output);

      expectTags(readOggVorbisComment(output));
      expect(after.codec).toBe(before.codec);
      expect(after.durationSec).toBeCloseTo(before.durationSec, 6);
      expect(output).not.toEqual(input);
    },
  );

  it('writes Matroska Tags into an MKV authored from real WebM fixture packets', async () => {
    const mkv = await mkvFromRealWebm('movie_5.webm');
    expect(parseWebm(mkv).container).toBe('mkv');
    const tagged = writeMkvTags(mkv, TAGS);
    const reparsed = parseWebm(tagged);

    expectTags(readMkvTags(tagged));
    expect(reparsed.container).toBe('mkv');
    expect(reparsed.tracks[0]?.codec).toBe(parseWebm(mkv).tracks[0]?.codec);
    expect(tagged).not.toEqual(mkv);
  });

  it.each([
    'speech.wav',
    'sin_440Hz_-6dBFS_1s.wav',
    'sfx-pcm-u8.wav',
    'sfx-pcm-s16.wav',
    'sfx-pcm-s24.wav',
    'sfx-pcm-s32.wav',
    'sfx-pcm-f32.wav',
  ])('writes WAV LIST/INFO + bext tags while preserving data bytes: %s', async (fixture) => {
    const input = await loadFixture(fixture);
    const before = parseWav(input, input.byteLength);
    const output = writeWavTags(input, TAGS);
    const after = parseWav(output, output.byteLength);

    expectTags(readWavTags(output));
    expect(after).toEqual(before);
    expect(chunkPayload(output, 'data', 'le')).toEqual(chunkPayload(input, 'data', 'le'));
    expect(readWavPcm(output).frames).toBe(readWavPcm(input).frames);
    expect(output).not.toEqual(input);
  });

  it.each([
    'aiff-caf/sfx.aiff',
    'aiff-caf/sfx-s24.aiff',
    'aiff-caf/sfx-fl32.aifc',
    'aiff-caf/sfx-twos.aifc',
    'aiff-caf/stereo.aiff',
  ])('writes AIFF text + ID3 tags while preserving SSND bytes: %s', async (fixture) => {
    const input = await derivedBytes(fixture);
    const before = parseAiff(input);
    const output = writeAiffTags(input, TAGS);
    const after = parseAiff(output);

    expectTags(readAiffTags(output));
    expect(after).toEqual(before);
    expect(chunkPayload(output, 'SSND', 'be')).toEqual(chunkPayload(input, 'SSND', 'be'));
    expect(readAiffPcm(output).frames).toBe(readAiffPcm(input).frames);
    expect(output).not.toEqual(input);
  });

  it.each([
    'aiff-caf/sfx.caf',
    'aiff-caf/sfx-be.caf',
    'aiff-caf/sfx-f32.caf',
    'aiff-caf/sfx-u8.caf',
    'aiff-caf/stereo.caf',
  ])('writes CAF info tags while preserving data bytes: %s', async (fixture) => {
    const input = await derivedBytes(fixture);
    const before = parseCaf(input);
    const output = writeCafTags(input, TAGS);
    const after = parseCaf(output);

    expectTags(readCafTags(output));
    expect(after).toEqual(before);
    expect(cafDataPayload(output)).toEqual(cafDataPayload(input));
    expect(readCafPcm(output).frames).toBe(readCafPcm(input).frames);
    expect(output).not.toEqual(input);
  });

  it('routes WAV/AIFF/CAF tag rewrites through the public remux dispatch', async () => {
    const media = createMedia();
    const wav = await media.remux(await loadFixture('speech.wav'), { to: 'wav', tags: TAGS });
    const aiff = await media.remux(fromBytes(await derivedBytes('aiff-caf/sfx.aiff')), {
      to: 'aiff',
      tags: TAGS,
    });
    const caf = await media.remux(fromBytes(await derivedBytes('aiff-caf/sfx.caf')), {
      to: 'caf',
      tags: TAGS,
    });
    expectTags(readWavTags(new Uint8Array(await (wav as Blob).arrayBuffer())));
    expectTags(readAiffTags(new Uint8Array(await (aiff as Blob).arrayBuffer())));
    expectTags(readCafTags(new Uint8Array(await (caf as Blob).arrayBuffer())));
  });

  it('routes established tag writers through the public remux dispatch', async () => {
    const media = createMedia();
    const mp4 = await blobBytes(
      await media.remux(await loadFixture('movie_5.mp4'), { to: 'mp4', tags: TAGS }),
    );
    const mov = await blobBytes(
      await media.remux(await loadFixture('movie_5.mp4'), { to: 'mov', tags: TAGS }),
    );
    const webm = await blobBytes(
      await media.remux(await loadFixture('movie_5.webm'), { to: 'webm', tags: TAGS }),
    );
    const mkv = await blobBytes(
      await media.remux(fromBytes(await mkvFromRealWebm('movie_5.webm')), {
        to: 'mkv',
        tags: TAGS,
      }),
    );
    const mp3 = await blobBytes(
      await media.remux(await loadFixture('sound_5.mp3'), { to: 'mp3', tags: TAGS }),
    );
    const flac = await blobBytes(
      await media.remux(await loadFixture('sfx.flac'), { to: 'flac', tags: TAGS }),
    );
    const ogg = await blobBytes(
      await media.remux(await loadFixture('sfx-opus.ogg'), { to: 'ogg', tags: TAGS }),
    );

    expectTags(readMp4Tags(mp4));
    expectTags(readMp4Tags(mov));
    expectTags(readMkvTags(webm));
    expectTags(readMkvTags(mkv));
    expectTags(readMp3Id3Tags(mp3));
    expectTags(readFlacVorbisComment(flac));
    expectTags(readOggVorbisComment(ogg));
  });

  it('rejects public metadata rewrites for unsupported targets and track-selection mixes', async () => {
    const media = createMedia();
    await expect(
      media.remux(await loadFixture('speech.wav'), { to: 'ts', tags: TAGS }),
    ).rejects.toThrow(/metadata tag rewrite is not available/);
    await expect(
      media.remux(await loadFixture('speech.wav'), {
        to: 'wav',
        tags: TAGS,
        trackSelect: ['audio:0'],
      }),
    ).rejects.toThrow(/does not combine with track selection/);
  });

  it('rejects malformed raw-PCM metadata wrappers and truncated chunks', () => {
    expect(() => writeWavTags(new Uint8Array([1, 2, 3]), TAGS)).toThrowError(/RIFF\/WAVE/);
    expect(() => readWavTags(new Uint8Array([1, 2, 3]))).toThrowError(/RIFF\/WAVE/);
    expect(() => writeAiffTags(new Uint8Array([1, 2, 3]), TAGS)).toThrowError(/AIFF/);
    expect(() => readAiffTags(new Uint8Array([1, 2, 3]))).toThrowError(/AIFF/);
    expect(() => writeCafTags(new Uint8Array([1, 2, 3]), TAGS)).toThrowError(/CAF/);
    expect(() => readCafTags(new Uint8Array([1, 2, 3]))).toThrowError(/CAF/);

    const truncatedRiff = concat([
      asciiBytes('RIFF'),
      u32le(13),
      asciiBytes('WAVE'),
      riffChunkBytes('data', 4, new Uint8Array([1])),
    ]);
    expect(() => writeWavTags(truncatedRiff, TAGS)).toThrowError(/truncated chunk/);

    const truncatedAiff = concat([
      asciiBytes('FORM'),
      u32be(13),
      asciiBytes('AIFF'),
      iffChunkBytes('SSND', 8, new Uint8Array([0])),
    ]);
    expect(() => writeAiffTags(truncatedAiff, TAGS)).toThrowError(/truncated chunk/);

    const truncatedCaf = concat([
      asciiBytes('caff'),
      new Uint8Array([0, 1, 0, 0]),
      cafChunkBytes('data', 10n, new Uint8Array([1])),
    ]);
    expect(() => writeCafTags(truncatedCaf, TAGS)).toThrowError(/truncated chunk/);
  });

  it('round-trips custom WAV tags and catches malformed CAF info bodies', () => {
    const wav = concat([
      asciiBytes('RIFF'),
      u32le(14),
      asciiBytes('WAVE'),
      riffChunkBytes('data', 2, new Uint8Array([128, 128])),
    ]);
    const tagged = writeWavTags(wav, { composer: 'Ada' });
    const { composer } = readWavTags(tagged);
    expect(composer).toBe('Ada');

    const caffHead = concat([asciiBytes('caff'), new Uint8Array([0, 1, 0, 0])]);
    const badInfoKey = concat([
      caffHead,
      cafChunkBytes('info', 5n, concat([u32be(1), asciiBytes('k')])),
    ]);
    expect(() => readCafTags(badInfoKey)).toThrowError(/key is truncated/);

    const badInfoCount = concat([caffHead, cafChunkBytes('info', 2n, new Uint8Array([0, 1]))]);
    expect(() => readCafTags(badInfoCount)).toThrowError(/info chunk is truncated/);

    const badInfoValue = concat([
      caffHead,
      cafChunkBytes(
        'info',
        7n,
        concat([u32be(1), asciiBytes('k'), new Uint8Array([0]), asciiBytes('v')]),
      ),
    ]);
    expect(() => readCafTags(badInfoValue)).toThrowError(/value is truncated/);

    const indefiniteData = concat([
      caffHead,
      cafChunkBytes('data', -1n, new Uint8Array([0xde, 0xad])),
    ]);
    const out = writeCafTags(indefiniteData, { title: 'before data' });
    expect(ascii(out, 8, 4)).toBe('info');
    const { title } = readCafTags(out);
    expect(title).toBe('before data');
  });
});
