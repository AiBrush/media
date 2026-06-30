/**
 * AVI container driver — structural oracle on REAL `.avi` media (BUILD_INSTRUCTIONS §6.1/§6.2).
 *
 * Subject media: two committed real AVIs under `fixtures/media-derived/` — `mjpeg_pcm_160p.avi`
 * (MJPEG + PCM s16) and `mpeg4_mp3_160p.avi` (MPEG-4/XVID + MP3). They are genuine AVI bytes written by
 * ffmpeg from the public-domain WPT `movie_5.mp4` (the container is real AVI; the content is real
 * licensed media). The oracle is **can-fail**, gated on ffprobe ground truth: RIFF/AVI recognition,
 * per-stream codec (from BITMAPINFOHEADER `biCompression` / WAVEFORMATEX `wFormatTag`), coded dims, fps,
 * audio sampleRate/channels, duration (within a frame), and `movi` chunk→stream attribution. A non-RIFF
 * input and a truncated `movi` are handled cleanly; mutation flips the reported codec (anti-cheat).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { AviDriver, AviModule } from './avi-driver.ts';
import { type AviChunkStruct, AviMuxer, writeAviFromTracks } from './avi-mux.ts';
import { parseAvi } from './avi-parse.ts';

const DERIVED = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

async function bytesFromDerived(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${name}`));
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
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

class TestEncodedChunk {
  readonly byteLength: number;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly type: EncodedVideoChunkType;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, type: EncodedVideoChunkType = 'key', duration?: number) {
    this.#bytes = bytes.slice();
    this.byteLength = this.#bytes.byteLength;
    this.timestamp = 0;
    this.duration = duration ?? null;
    this.type = type;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const out = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    out.set(this.#bytes);
  }
}

function encodedChunk(
  bytes: Uint8Array,
  mediaType: TrackInfo['mediaType'],
  keyframe: boolean,
): EncodedAudioChunk | EncodedVideoChunk {
  const chunk = new TestEncodedChunk(bytes, keyframe ? 'key' : 'delta');
  return mediaType === 'audio'
    ? (chunk as unknown as EncodedAudioChunk)
    : (chunk as unknown as EncodedVideoChunk);
}

function packetStream(
  chunks: readonly { readonly data: Uint8Array; readonly keyframe: boolean }[],
  mediaType: TrackInfo['mediaType'],
): ReadableStream<Packet> {
  return new ReadableStream<Packet>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue({ chunk: encodedChunk(chunk.data, mediaType, chunk.keyframe) });
      }
      controller.close();
    },
  });
}

interface Idx1Entry {
  readonly chunkId: string;
  readonly flags: number;
  readonly offset: number;
  readonly size: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function indexOfAscii(haystack: Uint8Array, needle: string): number {
  const pat = Uint8Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + pat.length <= haystack.byteLength; i++) {
    for (let j = 0; j < pat.length; j++) if (haystack[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

function parseIdx1(bytes: Uint8Array): Idx1Entry[] {
  const idx = indexOfAscii(bytes, 'idx1');
  if (idx < 0) throw new Error('missing idx1');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint32(idx + 4, true);
  const entries: Idx1Entry[] = [];
  for (let offset = idx + 8; offset + 16 <= idx + 8 + size; offset += 16) {
    entries.push({
      chunkId: ascii(bytes, offset, 4),
      flags: dv.getUint32(offset + 4, true),
      offset: dv.getUint32(offset + 8, true),
      size: dv.getUint32(offset + 12, true),
    });
  }
  return entries;
}

function countAscii(bytes: Uint8Array, needle: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = indexOfAscii(bytes.subarray(offset), needle);
    if (found < 0) return count;
    count++;
    offset += found + needle.length;
  }
}

function writeFourCC(bytes: Uint8Array, offset: number, tag: string): void {
  if (tag.length !== 4) throw new Error(`test FourCC '${tag}' must be 4 bytes`);
  for (let i = 0; i < 4; i++) bytes[offset + i] = tag.charCodeAt(i) & 0xff;
}

function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function firstChunk(bytes: Uint8Array, id: string, from = 0): number {
  const offset = indexOfAscii(bytes.subarray(from), id);
  if (offset < 0) throw new Error(`missing ${id} chunk`);
  return offset + from;
}

function firstAudioStrf(bytes: Uint8Array): number {
  const auds = firstChunk(bytes, 'auds');
  return firstChunk(bytes, 'strf', auds);
}

function withVideoCompression(original: Uint8Array, compression: string): Uint8Array {
  const mutated = original.slice();
  const strf = firstChunk(mutated, 'strf');
  writeFourCC(mutated, strf + 8 + 16, compression);
  return mutated;
}

function withAudioFormatTag(original: Uint8Array, formatTag: number): Uint8Array {
  const mutated = original.slice();
  const strf = firstAudioStrf(mutated);
  writeU16LE(mutated, strf + 8, formatTag);
  return mutated;
}

function withChunkSize(original: Uint8Array, chunkId: string, size: number, from = 0): Uint8Array {
  const mutated = original.slice();
  const chunk = firstChunk(mutated, chunkId, from);
  writeU32LE(mutated, chunk + 4, size);
  return mutated;
}

function concatArrays(parts: readonly Uint8Array[]): Uint8Array {
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

function riffPayloadChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  writeFourCC(out, 0, id);
  writeU32LE(out, 4, body.byteLength);
  out.set(body, 8);
  return out;
}

function riffContainer(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  writeFourCC(out, 0, 'RIFF');
  writeU32LE(out, 4, 4 + body.byteLength);
  writeFourCC(out, 8, type);
  out.set(body, 12);
  return out;
}

async function demuxTrackInfos(bytes: Uint8Array): Promise<readonly TrackInfo[]> {
  const demuxed = await AviDriver.demux(fromBytes(bytes, { mime: 'video/x-msvideo' }));
  try {
    return demuxed.tracks;
  } finally {
    await demuxed.close();
  }
}

async function muxSelectedTracks(
  sourceName: string,
  selectedTrackIndexes: readonly number[],
): Promise<Uint8Array> {
  const input = await bytesFromDerived(sourceName);
  const parsed = parseAvi(input);
  const trackInfos = await demuxTrackInfos(input);
  const muxer = AviDriver.createMuxer();
  expect(muxer).toBeInstanceOf(AviMuxer);
  if (!(muxer instanceof AviMuxer)) throw new Error('expected AviMuxer');

  const outputTrackIds = new Map<number, number>();
  for (const index of selectedTrackIndexes) {
    const trackInfo = trackInfos[index];
    if (trackInfo === undefined) throw new Error(`missing track ${index}`);
    outputTrackIds.set(index, muxer.addTrack(trackInfo));
  }
  for (const index of selectedTrackIndexes) {
    const track = parsed.tracks[index];
    const outputTrackId = outputTrackIds.get(index);
    if (track === undefined || outputTrackId === undefined)
      throw new Error(`missing track ${index}`);
    for (const chunk of track.chunks) {
      muxer.addChunkStruct(outputTrackId, {
        data: chunk.data,
        keyframe: chunk.keyframe,
      });
    }
  }

  await muxer.finalize();
  const out = await drain(muxer.output);
  const reparsed = parseAvi(out);
  expect(reparsed.tracks).toHaveLength(selectedTrackIndexes.length);

  for (const [outputIndex, sourceIndex] of selectedTrackIndexes.entries()) {
    const sourceTrack = parsed.tracks[sourceIndex];
    const outputTrack = reparsed.tracks[outputIndex];
    if (sourceTrack === undefined || outputTrack === undefined) {
      throw new Error(`missing source/output track ${sourceIndex}`);
    }
    expect(outputTrack.stream.mediaType).toBe(sourceTrack.stream.mediaType);
    expect(outputTrack.stream.codec).toBe(sourceTrack.stream.codec);
    expect(outputTrack.chunks.map((chunk) => chunk.data.byteLength)).toEqual(
      sourceTrack.chunks.map((chunk) => chunk.data.byteLength),
    );
    for (const [chunkIndex, chunk] of sourceTrack.chunks.entries()) {
      expect(outputTrack.chunks[chunkIndex]?.data).toEqual(chunk.data);
    }
  }

  const entries = parseIdx1(out);
  expect(entries).toHaveLength(
    selectedTrackIndexes.reduce(
      (sum, index) => sum + (parsed.tracks[index]?.chunks.length ?? 0),
      0,
    ),
  );
  expect(entries[0]?.offset).toBe(4);
  expect(out.byteLength).toBeGreaterThan(input.byteLength / 10);
  return out;
}

/** Real committed AVIs + their ffprobe ground truth (the structural oracle). */
interface AviGolden {
  name: string;
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  audioCodec: string;
  sampleRate: number;
  channels: number;
  /** ffprobe `format=duration` (seconds); the probe duration must land within FRAME_TOLERANCE_SEC. */
  durationSec: number;
  videoFrames: number;
}
const GOLDENS: readonly AviGolden[] = [
  {
    name: 'mjpeg_pcm_160p.avi',
    videoCodec: 'mjpeg',
    width: 160,
    height: 120,
    fps: 24,
    audioCodec: 'pcm',
    sampleRate: 16000,
    channels: 1,
    durationSec: 1.0,
    videoFrames: 24,
  },
  {
    name: 'mpeg4_mp3_160p.avi',
    videoCodec: 'mpeg4',
    width: 160,
    height: 120,
    fps: 24,
    audioCodec: 'mp3',
    sampleRate: 16000,
    channels: 1,
    durationSec: 1.083333,
    videoFrames: 26,
  },
];

/** One video frame at 24 fps — the doc-09 ±1-frame duration tolerance. */
const FRAME_TOLERANCE_SEC = 1 / 24 + 1e-4;

interface AviMuxCase {
  readonly codec: string;
  readonly mediaType: 'video' | 'audio';
  readonly expectedCodec: string;
  readonly data: Uint8Array;
}

const AVI_MUX_CODEC_CASES: readonly AviMuxCase[] = [
  { mediaType: 'video', codec: 'jpeg', expectedCodec: 'mjpeg', data: new Uint8Array([0xff, 0xd8]) },
  { mediaType: 'video', codec: 'divx', expectedCodec: 'mpeg4', data: new Uint8Array([1, 2]) },
  {
    mediaType: 'video',
    codec: 'avc1.42E01E',
    expectedCodec: 'h264',
    data: new Uint8Array([0, 0, 1, 9]),
  },
  {
    mediaType: 'video',
    codec: 'avc3.42E01E',
    expectedCodec: 'h264',
    data: new Uint8Array([0, 0, 1, 9]),
  },
  {
    mediaType: 'video',
    codec: 'hvc1.1.6.L93.B0',
    expectedCodec: 'hevc',
    data: new Uint8Array([0, 0, 1, 0x26]),
  },
  {
    mediaType: 'video',
    codec: 'hev1.1.6.L93.B0',
    expectedCodec: 'hevc',
    data: new Uint8Array([0, 0, 1, 0x26]),
  },
  { mediaType: 'video', codec: 'vp8', expectedCodec: 'vp8', data: new Uint8Array([1, 2, 3]) },
  { mediaType: 'video', codec: 'vp80', expectedCodec: 'vp8', data: new Uint8Array([1, 2, 3]) },
  { mediaType: 'video', codec: 'vp9', expectedCodec: 'vp9', data: new Uint8Array([1, 2, 3]) },
  { mediaType: 'video', codec: 'vp90', expectedCodec: 'vp9', data: new Uint8Array([1, 2, 3]) },
  { mediaType: 'video', codec: 'av1', expectedCodec: 'av1', data: new Uint8Array([1, 2, 3]) },
  {
    mediaType: 'video',
    codec: 'av01.0.05M.08',
    expectedCodec: 'av1',
    data: new Uint8Array([1, 2, 3]),
  },
  { mediaType: 'video', codec: 'rawvideo', expectedCodec: 'rawvideo', data: new Uint8Array(3) },
  { mediaType: 'video', codec: 'dib ', expectedCodec: 'rawvideo', data: new Uint8Array(3) },
  { mediaType: 'video', codec: 'zzzz', expectedCodec: 'zzzz', data: new Uint8Array([1, 2]) },
  { mediaType: 'audio', codec: 'pcm', expectedCodec: 'pcm', data: new Uint8Array([0, 0]) },
  { mediaType: 'audio', codec: 'pcm-u8', expectedCodec: 'pcm', data: new Uint8Array([128]) },
  { mediaType: 'audio', codec: 'pcm-s24', expectedCodec: 'pcm', data: new Uint8Array([0, 0, 0]) },
  {
    mediaType: 'audio',
    codec: 'pcm-s32',
    expectedCodec: 'pcm',
    data: new Uint8Array([0, 0, 0, 0]),
  },
  {
    mediaType: 'audio',
    codec: 'pcm-f32',
    expectedCodec: 'pcm',
    data: new Uint8Array([0, 0, 0, 0]),
  },
  {
    mediaType: 'audio',
    codec: 'mp4a.6b',
    expectedCodec: 'mp3',
    data: new Uint8Array([0xff, 0xfb]),
  },
  {
    mediaType: 'audio',
    codec: 'mp4a.69',
    expectedCodec: 'mp3',
    data: new Uint8Array([0xff, 0xfb]),
  },
  { mediaType: 'audio', codec: 'aac', expectedCodec: 'aac', data: new Uint8Array([0x21, 0x10]) },
  {
    mediaType: 'audio',
    codec: 'mp4a.40.2',
    expectedCodec: 'aac',
    data: new Uint8Array([0x21, 0x10]),
  },
  { mediaType: 'audio', codec: 'ac-3', expectedCodec: 'ac-3', data: new Uint8Array([0x0b, 0x77]) },
  { mediaType: 'audio', codec: 'ac3', expectedCodec: 'ac-3', data: new Uint8Array([0x0b, 0x77]) },
];

function syntheticTrack(c: AviMuxCase): TrackInfo {
  if (c.mediaType === 'video') {
    return {
      id: 0,
      mediaType: 'video',
      codec: c.codec,
      durationSec: 1 / 24,
      fps: 24,
      config: { codec: c.codec, codedWidth: 16, codedHeight: 16 },
    };
  }
  return {
    id: 0,
    mediaType: 'audio',
    codec: c.codec,
    durationSec: 1 / 48_000,
    config: { codec: c.codec, sampleRate: 48_000, numberOfChannels: 1 },
  };
}

async function muxOneSyntheticTrack(
  track: TrackInfo,
  packets: readonly AviChunkStruct[],
): Promise<ReturnType<typeof parseAvi>> {
  const muxer = new AviMuxer();
  const trackId = muxer.addTrack(track);
  for (const packet of packets) muxer.addChunkStruct(trackId, packet);
  await muxer.finalize();
  return parseAvi(await drain(muxer.output));
}

type InternalAviTracks = Parameters<typeof writeAviFromTracks>[0];
type InternalAviSamples = Parameters<typeof writeAviFromTracks>[1];

describe('AviDriver.supports', () => {
  it('recognizes AVI by RIFF…AVI magic, mime, and extension; rejects RIFF/WAVE and others', async () => {
    const head = (await bytesFromDerived('mjpeg_pcm_160p.avi')).subarray(0, 16);
    expect(AviDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(AviDriver.supports({ direction: 'demux', mime: 'video/x-msvideo' })).toBe(true);
    expect(AviDriver.supports({ direction: 'demux', extension: 'avi' })).toBe(true);
    // RIFF…WAVE is NOT an AVI (the form type at offset 8 disambiguates).
    const wave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(AviDriver.supports({ direction: 'demux', head: wave })).toBe(false);
    expect(AviDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(AviDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('parseAvi — RIFF/hdrl/strl structural oracle', () => {
  it('yields the video + audio streams with correct stream indices and codecs', async () => {
    const parsed = parseAvi(await bytesFromDerived('mjpeg_pcm_160p.avi'));
    expect(parsed.tracks).toHaveLength(2);
    const [video, audio] = parsed.tracks;
    expect(video?.stream).toMatchObject({ index: 0, mediaType: 'video', codec: 'mjpeg' });
    expect(audio?.stream).toMatchObject({ index: 1, mediaType: 'audio', codec: 'pcm' });
    // Video dims from BITMAPINFOHEADER, audio params from WAVEFORMATEX.
    expect(video?.stream.width).toBe(160);
    expect(video?.stream.height).toBe(120);
    expect(audio?.stream.sampleRate).toBe(16000);
    expect(audio?.stream.channels).toBe(1);
  });

  it('attributes movi data chunks to streams and derives monotonic PTS', async () => {
    const parsed = parseAvi(await bytesFromDerived('mjpeg_pcm_160p.avi'));
    const video = parsed.tracks[0];
    const audio = parsed.tracks[1];
    expect(video?.chunks.length).toBe(24); // 24 MJPEG frames (== ffprobe nb_frames)
    expect((video?.chunks.length ?? 0) > 0).toBe(true);
    expect(audio && audio.chunks.length > 0).toBe(true);
    expect(video?.chunks[0]?.ptsUs).toBe(0);
    expect(video?.chunks[0]?.keyframe).toBe(true); // MJPEG: every frame is intra
    for (const t of parsed.tracks) {
      const pts = t.chunks.map((c) => c.ptsUs);
      for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1] ?? 0);
    }
  });

  it('maps AVI-only video and audio codec tags from authoritative strf fields', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');

    expect(parseAvi(withVideoCompression(original, 'MPG2')).tracks[0]?.stream.codec).toBe(
      'mpeg2video',
    );

    expect(
      parseAvi(withAudioFormatTag(original, 0x0050)).tracks.find(
        (track) => track.stream.mediaType === 'audio',
      )?.stream.codec,
    ).toBe('mp2');
    expect(
      parseAvi(withAudioFormatTag(original, 0x2001)).tracks.find(
        (track) => track.stream.mediaType === 'audio',
      )?.stream.codec,
    ).toBe('dts');
    expect(
      parseAvi(withAudioFormatTag(original, 0x0006)).tracks.find(
        (track) => track.stream.mediaType === 'audio',
      )?.stream.codec,
    ).toBe('alaw');
    expect(
      parseAvi(withAudioFormatTag(original, 0x0007)).tracks.find(
        (track) => track.stream.mediaType === 'audio',
      )?.stream.codec,
    ).toBe('mulaw');
    expect(
      parseAvi(withAudioFormatTag(original, 0x1234)).tracks.find(
        (track) => track.stream.mediaType === 'audio',
      )?.stream.codec,
    ).toBe('0x1234');
  });

  it('falls back to the AVI main-header cadence when a video stream time base is degenerate', async () => {
    const mutated = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const strh = firstChunk(mutated, 'strh');
    writeU32LE(mutated, strh + 8 + 20, 0);
    writeU32LE(mutated, strh + 8 + 24, 0);

    const parsed = parseAvi(mutated);
    expect(parsed.tracks[0]?.stream.mediaType).toBe('video');
    expect(parsed.tracks[0]?.fps).toBeCloseTo(24, 3);
    expect(parsed.tracks[0]?.chunks[1]?.ptsUs).toBe(0);
  });

  it('ignores non-media movi chunk ids instead of attributing them to a stream', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const baselineVideoChunks = parseAvi(original).tracks[0]?.chunks.length;
    expect(baselineVideoChunks).toBe(24);

    const nonDigitPrefix = original.slice();
    const movi = firstChunk(nonDigitPrefix, 'movi');
    writeFourCC(nonDigitPrefix, firstChunk(nonDigitPrefix, '00dc', movi), 'xxdc');
    expect(parseAvi(nonDigitPrefix).tracks[0]?.chunks.length).toBe((baselineVideoChunks ?? 0) - 1);

    const nonPayloadSuffix = original.slice();
    writeFourCC(nonPayloadSuffix, firstChunk(nonPayloadSuffix, '00dc', movi), '00ix');
    expect(parseAvi(nonPayloadSuffix).tracks[0]?.chunks.length).toBe(
      (baselineVideoChunks ?? 0) - 1,
    );
  });

  it('skips non-audio/video stream declarations and rejects files with none left', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');

    const videoSkipped = original.slice();
    writeFourCC(videoSkipped, firstChunk(videoSkipped, 'vids'), 'txts');
    const oneTrack = parseAvi(videoSkipped);
    expect(oneTrack.tracks).toHaveLength(1);
    expect(oneTrack.tracks[0]?.stream).toMatchObject({
      index: 1,
      mediaType: 'audio',
      codec: 'pcm',
    });

    const noneLeft = videoSkipped.slice();
    writeFourCC(noneLeft, firstChunk(noneLeft, 'auds'), 'txts');
    expect(() => parseAvi(noneLeft)).toThrowError(MediaError);
  });

  it('keeps declared streams in a header-only AVI and falls back to header duration', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const moviList = firstChunk(original, 'LIST', firstChunk(original, 'movi') - 8);
    const headerOnly = original.slice(0, moviList);
    writeU32LE(headerOnly, 4, headerOnly.byteLength - 8);

    const parsed = parseAvi(headerOnly);
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0]?.chunks).toHaveLength(0);
    expect(parsed.tracks[0]?.durationSec).toBeGreaterThan(0);
    expect(parsed.tracks[1]?.chunks).toHaveLength(0);
    expect(parsed.tracks[1]?.durationSec).toBe(0);
  });

  it('ignores malformed or non-movi OpenDML AVIX tails without corrupting primary chunks', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const baseline = parseAvi(original);

    const danglingAvix = concatArrays([original, riffContainer('AVIX', new Uint8Array([0]))]);
    expect(parseAvi(danglingAvix).tracks[0]?.chunks.length).toBe(baseline.tracks[0]?.chunks.length);

    const junkAvix = concatArrays([
      original,
      riffContainer('AVIX', riffPayloadChunk('JUNK', new Uint8Array([1, 2, 3]))),
    ]);
    expect(parseAvi(junkAvix).tracks[1]?.chunks.length).toBe(baseline.tracks[1]?.chunks.length);
  });

  it('rejects truncated required AVI headers with typed demux errors', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    expect(() => parseAvi(withChunkSize(original, 'avih', 20))).toThrowError(MediaError);
    expect(() => parseAvi(withChunkSize(original, 'strh', 20))).toThrowError(MediaError);
    expect(() => parseAvi(withChunkSize(original, 'strf', 12))).toThrowError(MediaError);
    const auds = firstChunk(original, 'auds');
    expect(() => parseAvi(withChunkSize(original, 'strf', 10, auds))).toThrowError(MediaError);
  });
});

describe('probe across the real AVI corpus — golden structure + frame-accurate duration', () => {
  it.each(GOLDENS)('$name — exact tracks, codecs, dims, fps and duration', async (g) => {
    const info = await createMedia()
      .use(AviModule)
      .probe(fromBytes(await bytesFromDerived(g.name), { mime: 'video/x-msvideo' }));
    expect(info.container).toBe('avi');
    const video = info.tracks.find((t) => t.type === 'video');
    const audio = info.tracks.find((t) => t.type === 'audio');
    expect(video).toMatchObject({ codec: g.videoCodec, width: g.width, height: g.height });
    expect(video?.fps).toBeCloseTo(g.fps, 3);
    expect(audio).toMatchObject({
      codec: g.audioCodec,
      sampleRate: g.sampleRate,
      channels: g.channels,
    });
    expect(info.durationSec).toBeGreaterThan(0);
    expect(Math.abs(info.durationSec - g.durationSec)).toBeLessThanOrEqual(FRAME_TOLERANCE_SEC);
  });
});

describe('demux — packet seam (browser-gated like mp4/mpegts)', () => {
  it('exposes the tracks but the EncodedChunk seam is a typed capability gap in node', async () => {
    const demuxed = await AviDriver.demux(
      fromBytes(await bytesFromDerived('mjpeg_pcm_160p.avi'), { mime: 'video/x-msvideo' }),
    );
    expect(demuxed.tracks).toHaveLength(2);
    expect(demuxed.tracks[0]?.mediaType).toBe('video');
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(99)).toThrowError(MediaError); // unknown track id
    await demuxed.close();
  });

  it('reads a non-seekable stream source (no range) by buffering the whole file', async () => {
    const bytes = await bytesFromDerived('mpeg4_mp3_160p.avi');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            const mid = bytes.byteLength >> 1;
            c.enqueue(bytes.subarray(0, mid)); // two chunks exercise the accumulation path
            c.enqueue(bytes.subarray(mid));
            c.close();
          },
        }),
    };
    const demuxed = await AviDriver.demux(streamSource);
    expect(demuxed.tracks.map((t) => t.codec)).toEqual(['mpeg4', 'mp3']);
    await demuxed.close();
  });
});

describe('mux — RIFF hdrl/strl/movi/idx1 authoring', () => {
  it.each([
    {
      label: 'MJPEG + PCM',
      source: 'mjpeg_pcm_160p.avi',
      tracks: [0, 1],
    },
    {
      label: 'MPEG-4 + MP3',
      source: 'mpeg4_mp3_160p.avi',
      tracks: [0, 1],
    },
    {
      label: 'video-only MJPEG',
      source: 'mjpeg_pcm_160p.avi',
      tracks: [0],
    },
    {
      label: 'audio-only PCM',
      source: 'mjpeg_pcm_160p.avi',
      tracks: [1],
    },
    {
      label: 'audio-only MP3',
      source: 'mpeg4_mp3_160p.avi',
      tracks: [1],
    },
  ] as const)('$label: demux(mux(real packets)) preserves per-track packet bytes', async (c) => {
    const out = await muxSelectedTracks(c.source, c.tracks);
    expect(ascii(out, 0, 4)).toBe('RIFF');
    expect(ascii(out, 8, 4)).toBe('AVI ');
    expect(indexOfAscii(out, 'hdrl')).toBeGreaterThan(0);
    expect(indexOfAscii(out, 'movi')).toBeGreaterThan(0);
    expect(indexOfAscii(out, 'idx1')).toBeGreaterThan(0);
  });

  it('public mux() routes explicit AVI packet streams through AviMuxer', async () => {
    const input = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const parsed = parseAvi(input);
    const trackInfos = await demuxTrackInfos(input);
    const audioTrack = trackInfos[1];
    const audioPackets = parsed.tracks[1]?.chunks;
    if (audioTrack === undefined || audioPackets === undefined)
      throw new Error('missing audio track');

    const out = await outputBytes(
      await createMedia()
        .use(AviModule)
        .mux(
          { audio: { track: audioTrack, packets: packetStream(audioPackets, 'audio') } },
          { container: 'avi' },
        ),
    );
    const reparsed = parseAvi(out);
    expect(reparsed.tracks).toHaveLength(1);
    expect(reparsed.tracks[0]?.stream).toMatchObject({
      mediaType: 'audio',
      codec: 'pcm',
      sampleRate: 16000,
      channels: 1,
    });
    expect(reparsed.tracks[0]?.chunks.map((chunk) => chunk.data.byteLength)).toEqual(
      audioPackets.map((chunk) => chunk.data.byteLength),
    );
    for (const [index, packet] of audioPackets.entries()) {
      expect(reparsed.tracks[0]?.chunks[index]?.data).toEqual(packet.data);
    }
  });

  it.each(AVI_MUX_CODEC_CASES)(
    'muxes supported $mediaType codec $codec into a parseable AVI stream',
    async (c) => {
      const muxer = new AviMuxer();
      const trackId = muxer.addTrack(syntheticTrack(c));
      muxer.addChunkStruct(trackId, { data: c.data, keyframe: true, durationUs: 41_667 });
      await muxer.finalize();

      const out = await drain(muxer.output);
      const parsed = parseAvi(out);
      expect(parsed.tracks).toHaveLength(1);
      expect(parsed.tracks[0]?.stream.mediaType).toBe(c.mediaType);
      expect(parsed.tracks[0]?.stream.codec).toBe(c.expectedCodec);
      expect(parsed.tracks[0]?.chunks[0]?.data).toEqual(c.data);
    },
  );

  it('derives video timing from config framerate, duration, defaults, and fractional FPS', async () => {
    const configWithFps: VideoDecoderConfig & { readonly framerate: number } = {
      codec: 'mjpeg',
      codedWidth: 16,
      codedHeight: 16,
      framerate: 12,
    };
    const twoVideoPackets: readonly AviChunkStruct[] = [
      { data: new Uint8Array([0xff, 0xd8, 0x00]), keyframe: true },
      { data: new Uint8Array([0xff, 0xd8, 0x01]), keyframe: true },
    ];

    const configTimed = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'video',
        codec: 'mjpeg',
        config: configWithFps,
      },
      twoVideoPackets,
    );
    expect(configTimed.tracks[0]?.fps).toBe(12);

    const durationTimed = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'video',
        codec: 'mjpeg',
        durationSec: 2,
        config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
      },
      [
        ...twoVideoPackets,
        { data: new Uint8Array([0xff, 0xd8, 0x02]), keyframe: true },
        { data: new Uint8Array([0xff, 0xd8, 0x03]), keyframe: true },
      ],
    );
    expect(durationTimed.tracks[0]?.fps).toBe(2);

    const defaultTimed = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'video',
        codec: 'mjpeg',
        config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
      },
      twoVideoPackets,
    );
    expect(defaultTimed.tracks[0]?.fps).toBe(30);

    const fractionalTimed = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'video',
        codec: 'mjpeg',
        fps: 29.97,
        config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
      },
      twoVideoPackets,
    );
    expect(fractionalTimed.tracks[0]?.fps).toBeCloseTo(29.97, 3);
  });

  it('derives compressed-audio timing from packet durations, source duration, and codec defaults', async () => {
    const durationFromPackets = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 1 },
      },
      [
        { data: new Uint8Array([0x21, 0x10]), durationUs: 100_000 },
        { data: new Uint8Array([0x21, 0x10]), durationUs: 100_000 },
      ],
    );
    expect(durationFromPackets.tracks[0]?.durationSec).toBeCloseTo(0.2, 4);

    const sourceDuration = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'audio',
        codec: 'aac',
        durationSec: 2,
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 1 },
      },
      [{ data: new Uint8Array([0x21, 0x10]) }, { data: new Uint8Array([0x21, 0x10]) }],
    );
    expect(sourceDuration.tracks[0]?.durationSec).toBeCloseTo(2, 4);

    const mp3Default = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'audio',
        codec: 'mp3',
        config: { codec: 'mp3', sampleRate: 16_000, numberOfChannels: 1 },
      },
      [{ data: new Uint8Array([0xff, 0xfb]) }, { data: new Uint8Array([0xff, 0xfb]) }],
    );
    expect(mp3Default.tracks[0]?.durationSec).toBeCloseTo((2 * 576) / 16_000, 4);

    const mp3HighRateDefault = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'audio',
        codec: 'mp3',
        config: { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 1 },
      },
      [{ data: new Uint8Array([0xff, 0xfb]) }, { data: new Uint8Array([0xff, 0xfb]) }],
    );
    expect(mp3HighRateDefault.tracks[0]?.durationSec).toBeCloseTo((2 * 1152) / 48_000, 4);

    const sampleRateDefault = await muxOneSyntheticTrack(
      {
        id: 0,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 1 },
      },
      [
        { data: new Uint8Array([0x21, 0x10]) },
        { data: new Uint8Array([0x21, 0x10]) },
        { data: new Uint8Array([0x21, 0x10]) },
      ],
    );
    expect(sampleRateDefault.tracks[0]?.durationSec).toBeGreaterThan(0);
  });

  it('write() preserves packet side metadata for AVI packet streams', async () => {
    const muxer = new AviMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'mjpeg',
      config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
    });
    await muxer.write(trackId, {
      chunk: new TestEncodedChunk(new Uint8Array([1, 2, 3]), 'delta', 41_667) as unknown as
        | EncodedVideoChunk
        | EncodedAudioChunk,
    });
    await muxer.finalize();
    const parsed = parseAvi(await drain(muxer.output));
    expect(parsed.tracks[0]?.chunks[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('splits oversized movi payloads into OpenDML AVIX RIFF segments', async () => {
    const input = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const parsed = parseAvi(input);
    const trackInfos = await demuxTrackInfos(input);
    const videoTrack = trackInfos[0];
    const videoPackets = parsed.tracks[0]?.chunks.slice(0, 4);
    if (videoTrack === undefined || videoPackets === undefined)
      throw new Error('missing video track');

    const muxer = new AviMuxer({ openDmlSegmentBytes: 400 });
    const trackId = muxer.addTrack(videoTrack);
    for (const packet of videoPackets) {
      muxer.addChunkStruct(trackId, { data: packet.data, keyframe: packet.keyframe });
    }
    await muxer.finalize();
    const out = await drain(muxer.output);

    expect(countAscii(out, 'AVIX')).toBeGreaterThan(0);
    const reparsed = parseAvi(out);
    expect(reparsed.tracks[0]?.chunks.map((chunk) => chunk.data.byteLength)).toEqual(
      videoPackets.map((chunk) => chunk.data.byteLength),
    );
    for (const [index, packet] of videoPackets.entries()) {
      expect(reparsed.tracks[0]?.chunks[index]?.data).toEqual(packet.data);
    }
  });

  it('rejects unsupported AVI mux shapes with typed errors', async () => {
    expect(() => AviDriver.createMuxer({ fragmented: true })).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'video',
        codec: 'theora',
        config: { codec: 'theora', codedWidth: 16, codedHeight: 16 },
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'video',
        codec: 'mjpeg',
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'opus',
        config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'pcm-s16',
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'pcm-f64',
        config: { codec: 'pcm-f64', sampleRate: 48_000, numberOfChannels: 1 },
      }),
    ).toThrowError(CapabilityError);

    expect(() =>
      AviDriver.createMuxer().addTrack({
        id: 0,
        mediaType: 'subtitle' as never,
        codec: 'text',
      }),
    ).toThrowError(CapabilityError);

    const tooMany = AviDriver.createMuxer();
    for (let i = 0; i < 100; i++) {
      tooMany.addTrack({
        id: i,
        mediaType: 'audio',
        codec: 'pcm-u8',
        config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
      });
    }
    expect(() =>
      tooMany.addTrack({
        id: 100,
        mediaType: 'audio',
        codec: 'pcm-u8',
        config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
      }),
    ).toThrowError(CapabilityError);

    expect(() => {
      const raw = AviDriver.createMuxer();
      if (!(raw instanceof AviMuxer)) throw new Error('expected AviMuxer');
      raw.addChunkStruct(0, { data: new Uint8Array([0]) });
    }).toThrowError(MediaError);

    const pcm = AviDriver.createMuxer();
    const trackId = pcm.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-s16',
      config: { codec: 'pcm-s16', sampleRate: 48_000, numberOfChannels: 2 },
    });
    expect(() => {
      if (!(pcm instanceof AviMuxer)) throw new Error('expected AviMuxer');
      pcm.addChunkStruct(trackId, { data: new Uint8Array([0, 1]) });
    }).toThrowError(MediaError);

    await expect(AviDriver.createMuxer().finalize()).rejects.toThrowError(MediaError);

    const empty = AviDriver.createMuxer();
    empty.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'mjpeg',
      config: { codec: 'mjpeg', codedWidth: 160, codedHeight: 120 },
    });
    await expect(empty.finalize()).rejects.toThrowError(MediaError);

    const invalidSegmentLimit = new AviMuxer({ openDmlSegmentBytes: 15 });
    const invalidTrackId = invalidSegmentLimit.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
    });
    invalidSegmentLimit.addChunkStruct(invalidTrackId, { data: new Uint8Array([128]) });
    await expect(invalidSegmentLimit.finalize()).rejects.toThrowError(MediaError);

    const oversized = new AviMuxer({ openDmlSegmentBytes: 16 });
    const oversizedTrackId = oversized.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'mjpeg',
      config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
    });
    oversized.addChunkStruct(oversizedTrackId, { data: new Uint8Array(32), keyframe: true });
    await expect(oversized.finalize()).rejects.toThrowError(CapabilityError);

    const done = new AviMuxer();
    const doneTrackId = done.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
    });
    done.addChunkStruct(doneTrackId, { data: new Uint8Array([128]) });
    await done.finalize();
    expect(() => done.addChunkStruct(doneTrackId, { data: new Uint8Array([128]) })).toThrowError(
      MediaError,
    );
  });

  it('writeAviFromTracks rejects malformed internal mux plans with typed errors', () => {
    const sourceVideo: TrackInfo = {
      id: 0,
      mediaType: 'video',
      codec: 'mjpeg',
      fps: 24,
      config: { codec: 'mjpeg', codedWidth: 16, codedHeight: 16 },
    };
    const sourceAudio: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
    };
    const sample = { trackId: 0, data: new Uint8Array([1, 2]), keyframe: true };
    const samples = [sample] as unknown as InternalAviSamples;

    expect(() =>
      writeAviFromTracks(
        [
          {
            id: 0,
            mediaType: 'video',
            codec: 'mjpeg',
            source: sourceVideo,
            chunks: [sample],
            totalBytes: 2,
            maxChunkBytes: 2,
          },
        ] as unknown as InternalAviTracks,
        samples,
      ),
    ).toThrowError(MediaError);

    expect(() =>
      writeAviFromTracks(
        [
          {
            id: 0,
            mediaType: 'video',
            codec: 'mjpeg',
            source: sourceVideo,
            video: { fourcc: 'BAD', width: 16, height: 16, suffix: 'dc' },
            chunks: [sample],
            totalBytes: 2,
            maxChunkBytes: 2,
          },
        ] as unknown as InternalAviTracks,
        samples,
      ),
    ).toThrowError(MediaError);

    expect(() =>
      writeAviFromTracks(
        [
          {
            id: 0,
            mediaType: 'audio',
            codec: 'pcm-u8',
            source: sourceAudio,
            chunks: [sample],
            totalBytes: 2,
            maxChunkBytes: 2,
          },
        ] as unknown as InternalAviTracks,
        samples,
      ),
    ).toThrowError(MediaError);

    expect(() =>
      writeAviFromTracks(
        [
          {
            id: 0,
            mediaType: 'audio',
            codec: 'pcm-s16',
            source: sourceAudio,
            audio: {
              formatTag: 1,
              channels: 1,
              sampleRate: 8000,
              bitsPerSample: 16,
              blockAlign: 4,
              avgBytesPerSec: 32_000,
              sampleSize: 4,
            },
            chunks: [sample],
            totalBytes: 2,
            maxChunkBytes: 2,
          },
        ] as unknown as InternalAviTracks,
        samples,
      ),
    ).toThrowError(MediaError);

    expect(() =>
      writeAviFromTracks(
        [
          {
            id: 0,
            mediaType: 'audio',
            codec: 'pcm-u8',
            source: sourceAudio,
            audio: {
              formatTag: 1,
              channels: 1,
              sampleRate: 8000,
              bitsPerSample: 8,
              blockAlign: 1,
              avgBytesPerSec: 8000,
              sampleSize: 1,
            },
            chunks: [sample],
            totalBytes: 2,
            maxChunkBytes: 2,
          },
        ] as unknown as InternalAviTracks,
        [{ ...sample, trackId: 99 }] as unknown as InternalAviSamples,
      ),
    ).toThrowError(MediaError);

    const missingSampleRate = writeAviFromTracks(
      [
        {
          id: 0,
          mediaType: 'audio',
          codec: 'aac',
          source: { ...sourceAudio, codec: 'aac' },
          audio: {
            formatTag: 0x00ff,
            channels: 1,
            bitsPerSample: 0,
            blockAlign: 1,
            avgBytesPerSec: 0,
            sampleSize: 0,
          },
          chunks: [sample],
          totalBytes: 2,
          maxChunkBytes: 2,
        },
      ] as unknown as InternalAviTracks,
      samples,
    );
    expect(parseAvi(missingSampleRate).tracks[0]?.stream.sampleRate).toBe(0);
  });
});

describe('robustness — corrupt / non-AVI inputs reject or survive cleanly (§6.2)', () => {
  it('rejects a non-RIFF / non-AVI input', () => {
    expect(() => parseAvi(new Uint8Array(0))).toThrowError(InputError);
    expect(() => parseAvi(new Uint8Array(64))).toThrowError(InputError); // zeroed: no RIFF magic
    // RIFF but WAVE (not AVI) → rejected as not-AVI.
    const wave = new Uint8Array(64);
    wave.set([0x52, 0x49, 0x46, 0x46], 0);
    wave.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(() => parseAvi(wave)).toThrowError(InputError);
  });

  it('survives a tail-truncated AVI (movi cut mid-chunk) — still recovers the stream table', async () => {
    const full = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const truncated = full.subarray(0, Math.floor(full.byteLength * 0.6)); // cut into movi
    const parsed = parseAvi(truncated);
    expect(parsed.tracks.map((t) => t.stream.codec).sort()).toEqual(['mjpeg', 'pcm']);
    // It must not crash and must still expose the (partial) chunk list, not fabricate data.
    expect(parsed.tracks[0]?.chunks.length).toBeGreaterThan(0);
  });
});

describe('anti-cheat — the oracle rejects mutated structure (it can fail)', () => {
  it('flipping the BITMAPINFOHEADER compression 4CC changes the reported codec', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    expect(parseAvi(original).tracks[0]?.stream.codec).toBe('mjpeg');

    // The codec comes from the strf BITMAPINFOHEADER `biCompression` (body offset 16) — NOT the
    // redundant strh `fccHandler` — so we mutate that authoritative field: 'MJPG' → 'H264'.
    const mutated = original.slice();
    const strfIdx = indexOfAscii(mutated, 'strf');
    expect(strfIdx).toBeGreaterThan(0);
    const compressionOff = strfIdx + 8 + 16; // 'strf'(4) + size(4) → biCompression at body+16
    expect(String.fromCharCode(...mutated.subarray(compressionOff, compressionOff + 4))).toBe(
      'MJPG',
    );
    mutated.set([0x48, 0x32, 0x36, 0x34], compressionOff); // 'H264'
    const codec = parseAvi(mutated).tracks.find((t) => t.stream.mediaType === 'video')?.stream
      .codec;
    expect(codec).toBe('h264');
    expect(codec).not.toBe('mjpeg');
  });

  it('flipping the WAVEFORMATEX format tag changes the reported audio codec', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    expect(parseAvi(original).tracks[1]?.stream.codec).toBe('pcm');
    // The audio strf is a WAVEFORMATEX with wFormatTag=0x0001 (PCM); the strh fccType 'auds' precedes
    // its strf. Locate 'auds', then the next 'strf' chunk, and flip its first u16 to 0x0055 (MP3).
    const mutated = original.slice();
    const audsIdx = indexOfAscii(mutated, 'auds');
    expect(audsIdx).toBeGreaterThan(0);
    const strfIdx = indexOfAscii(mutated.subarray(audsIdx), 'strf') + audsIdx;
    const fmtTagOff = strfIdx + 8; // 'strf'(4) + size(4) → WAVEFORMATEX body
    mutated[fmtTagOff] = 0x55;
    mutated[fmtTagOff + 1] = 0x00;
    expect(parseAvi(mutated).tracks.find((t) => t.stream.mediaType === 'audio')?.stream.codec).toBe(
      'mp3',
    );
  });
});
