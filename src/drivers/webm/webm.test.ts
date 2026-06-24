import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { WebmDriver, WebmModule, parseWebm } from './webm-driver.ts';

// ── EBML builders ────────────────────────────────────────────────────────────────────────────────
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function sizeVint(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
}
function uintN(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push((value / 256 ** i) & 0xff);
  return out;
}
function f64(value: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, false);
  return [...b];
}
const el = (id: number[], data: number[]): number[] => [...id, ...sizeVint(data.length), ...data];

const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  DocType: [0x42, 0x82],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
};

describe('WebmDriver.supports', () => {
  it('recognizes EBML magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('movie_5.webm')).subarray(0, 16);
    expect(WebmDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', mime: 'video/webm' })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', extension: 'mkv' })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(WebmDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe WebM across the real corpus', () => {
  it('movie_5.webm — vp9 video + opus audio, ~5 s', async () => {
    const info = await createMedia()
      .use(WebmModule)
      .probe(await fixtureSource('movie_5.webm'));
    expect(info.container).toBe('webm');
    expect(info.tracks.find((t) => t.type === 'video')?.codec).toBe('vp9');
    expect(info.tracks.find((t) => t.type === 'video')?.width).toBe(320);
    expect(info.tracks.find((t) => t.type === 'audio')?.codec).toBe('opus');
    expect(info.durationSec).toBeGreaterThan(4);
    expect(info.durationSec).toBeLessThan(6);
  });

  it('2x2-green.webm — tiny vp8 video', async () => {
    const info = await createMedia()
      .use(WebmModule)
      .probe(await fixtureSource('2x2-green.webm'));
    const video = info.tracks.find((t) => t.type === 'video');
    expect(video?.codec).toBe('vp8');
    expect(video?.width).toBe(2);
    expect(video?.height).toBe(2);
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it.each(['movie_5.webm', '2x2-green.webm', 'white.webm'])(
    '%s probe matches its committed golden',
    async (id) => {
      const info = await createMedia()
        .use(WebmModule)
        .probe(await fixtureSource(id));
      expect(info).toEqual(await loadGoldenMetadata(id));
    },
  );
});

describe('parseWebm — EBML parsing', () => {
  it('parses Duration when declared (video track)', () => {
    const info = el(E.Info, [
      ...el(E.TimecodeScale, uintN(1_000_000, 4)),
      ...el(E.Duration, f64(5000)),
    ]);
    const video = el(E.Video, [
      ...el(E.PixelWidth, uintN(640, 2)),
      ...el(E.PixelHeight, uintN(480, 2)),
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...video,
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [...info, ...el(E.Tracks, track)]),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('webm');
    expect(out.durationSec).toBeCloseTo(5, 5);
    expect(out.tracks[0]).toMatchObject({
      mediaType: 'video',
      codec: 'vp9',
      width: 640,
      height: 480,
    });
  });

  it('derives duration from clusters when Duration is absent (audio track)', () => {
    const info = el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4)));
    const audio = el(E.Audio, [...el(E.SamplingFrequency, f64(48000)), ...el(E.Channels, [2])]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_OPUS')),
      ...audio,
    ]);
    const block = el(E.SimpleBlock, [0x81, 0x01, 0xf4, 0x80]); // track 1, rel +500, flags
    const cluster = el(E.Cluster, [...el(E.Timecode, uintN(4000, 2)), ...block]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('matroska'))),
      ...el(E.Segment, [...info, ...el(E.Tracks, track), ...cluster]),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('mkv'); // DocType matroska
    expect(out.durationSec).toBeCloseTo(4.5, 5); // (4000 + 500) ticks × 1e6ns / 1e9
    expect(out.tracks[0]).toMatchObject({
      mediaType: 'audio',
      codec: 'opus',
      sampleRate: 48000,
      channels: 2,
    });
  });

  it('rejects a non-EBML / track-less file', () => {
    expect(() => parseWebm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrowError(MediaError);
    const empty = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, el(E.Info, [])),
    ]);
    expect(() => parseWebm(empty)).toThrowError(/no decodable tracks/);
  });

  it('maps codec ids (AVC→h264, HEVC→hevc, MPEG/L3→mp3, unknown→lowercase)', () => {
    const vid = el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]);
    const aud = el(E.Audio, el(E.Channels, [2]));
    const te = (type: number, codec: string, sub: number[]): number[] =>
      el(E.TrackEntry, [...el(E.TrackType, [type]), ...el(E.CodecID, str(codec)), ...sub]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, [
          ...te(1, 'V_MPEG4/ISO/AVC', vid),
          ...te(1, 'V_MPEGH/ISO/HEVC', vid),
          ...te(2, 'A_MPEG/L3', aud),
          ...te(2, 'A_WEIRD', aud),
          ...te(17, 'S_TEXT/UTF8', []), // subtitle → skipped
        ]),
      ]),
    ]);
    expect(parseWebm(bytes).tracks.map((t) => t.codec)).toEqual(['h264', 'hevc', 'mp3', 'a_weird']);
  });

  it('handles an unknown-size Segment and a header without DocType', () => {
    const info = el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4)));
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
      ...el(E.Video, [...el(E.PixelWidth, [4]), ...el(E.PixelHeight, [4])]),
    ]);
    // EBML header with no DocType child → defaults to 'webm'; Segment with unknown size (0xFF) → EOF.
    const bytes = new Uint8Array([
      ...el(E.EBML, []),
      ...E.Segment,
      0xff,
      ...info,
      ...el(E.Tracks, track),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('webm');
    expect(out.tracks[0]?.codec).toBe('vp8');
  });
});

describe('WebmDriver — demux seam + muxer', () => {
  it('demuxes a stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('white.webm');
    const half = bytes.byteLength >> 1;
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes.subarray(0, half)); // two chunks → exercises the head-concat path
            c.enqueue(bytes.subarray(half));
            c.close();
          },
        }),
    };
    const demuxed = await WebmDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('vp8');
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('createMuxer is a typed not-yet-implemented error', () => {
    expect(() => WebmDriver.createMuxer()).toThrowError(MediaError);
  });
});
