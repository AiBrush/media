import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../contracts/driver.ts';
import { parseFlac } from '../drivers/flac/flac-driver.ts';
import { enumerateMp3Packets, parseMp3 } from '../drivers/mp3/mp3-driver.ts';
import { readMovie } from '../drivers/mp4/mp4-driver.ts';
import { parseOgg } from '../drivers/ogg/ogg-driver.ts';
import { WebmMuxer } from '../drivers/webm/ebml-write.ts';
import { type WebmTrack, demuxWebm, parseWebm } from '../drivers/webm/webm-driver.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { readMp3Id3Tags, writeMp3Id3Tags } from './id3.ts';
import { readMkvTags, writeMkvTags } from './matroska-tags.ts';
import { readMp4Tags, writeMp4Tags } from './mp4-tags.ts';
import { readOggVorbisComment, writeOggVorbisComment } from './ogg-vorbis-comment.ts';
import { readFlacVorbisComment, writeFlacVorbisComment } from './vorbis-comment.ts';

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

function expectTags(actual: Record<string, string>): void {
  for (const [key, value] of Object.entries(TAGS)) expect(actual[key]).toBe(value);
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
});
