import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { parseAsc } from '../../codecs/wasm-aac/aac.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { WebmMuxer } from './ebml-write.ts';
import { WebmDriver, WebmModule, demuxWebm, parseWebm } from './webm-driver.ts';

// A real H.264-in-Matroska asset (ffprobe: h264 High 1280×720 + aac 48k/2ch) lives in the sibling
// acceptance corpus, not this project's manifest, so it is read by direct path — like the mpegts tests.
const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;
async function bytesFromMediaTest(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

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
  TrackNumber: [0xd7],
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
  BlockGroup: [0xa0],
  Block: [0xa1],
  BlockAdditions: [0x75, 0xa1],
  BlockMore: [0xa6],
  BlockAdditional: [0xa5],
  BlockAddID: [0xee],
  ReferenceBlock: [0xfb],
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

describe('CodecPrivate → decoder description + canonical codec ids (real fixtures)', () => {
  it('h264_in_mkv.mkv — H.264 carries its avcC as config.description (decode unblocker)', async () => {
    const mkv = await bytesFromMediaTest('h264_in_mkv.mkv');
    // parseWebm reports the per-file DocType ('matroska' → 'mkv'); the codec ids are the canonical
    // harness-golden vocabulary (h264/aac), not the raw Matroska CodecIDs.
    const parsed = parseWebm(mkv);
    expect(parsed.container).toBe('mkv');
    const video = parsed.tracks.find((t) => t.mediaType === 'video');
    const audio = parsed.tracks.find((t) => t.mediaType === 'audio');
    expect(video?.codec).toBe('h264');
    expect(video).toMatchObject({ width: 1280, height: 720 });
    expect(audio?.codec).toBe('aac');

    // The H.264 track's WebCodecs decoder description IS the CodecPrivate = the avcC box; the demuxer
    // surfaces it on TrackInfo.config. Proof: present, non-empty, configurationVersion 1 (avcC byte 0).
    const demuxed = await WebmDriver.demux(fromBytes(mkv, { mime: 'video/x-matroska' }));
    const videoTrack = demuxed.tracks.find((t) => t.mediaType === 'video');
    expect(videoTrack?.codec).toBe('h264');
    const videoConfig = videoTrack?.config;
    const videoDescription =
      videoConfig && 'description' in videoConfig ? videoConfig.description : undefined;
    expect(videoDescription).toBeInstanceOf(Uint8Array);
    const avcC = videoDescription as Uint8Array;
    expect(avcC.byteLength).toBeGreaterThan(0);
    expect(avcC[0]).toBe(0x01); // avcC configurationVersion — proves this is the codec-private record

    const audioTrack = demuxed.tracks.find((t) => t.mediaType === 'audio');
    expect(audioTrack?.codec).toBe('aac');
    const audioConfig = audioTrack?.config;
    const audioDescription =
      audioConfig && 'description' in audioConfig ? audioConfig.description : undefined;
    expect(audioDescription).toBeInstanceOf(Uint8Array);
    const asc = parseAsc(audioDescription as Uint8Array);
    expect(asc).toMatchObject({ objectType: 2, sampleRate: 48_000, channels: 2 });
    await demuxed.close();
  });

  it('bear-multitrack.webm — raw A_PCM/INT/LIT is canonicalized to pcm-s16 (no raw-CodecID leak)', async () => {
    const info = parseWebm(await loadFixture('bear-multitrack.webm'));
    const codecs = info.tracks.map((t) => t.codec);
    // The multitrack asset carries VP8 + Vorbis + (Theora) + raw PCM. The PCM track must be the canonical
    // `pcm-s16` token, never the lowercased raw id `a_pcm/int/lit` that the old fall-through emitted.
    expect(codecs).toContain('pcm-s16');
    expect(codecs.some((c) => c.startsWith('a_pcm'))).toBe(false);
    expect(codecs).toContain('vp8');
    expect(codecs).toContain('vorbis');
  });

  it('bear-multitrack.webm — Vorbis carries Xiph-laced CodecPrivate as config.description', async () => {
    const demuxed = await WebmDriver.demux(await fixtureSource('bear-multitrack.webm'));
    const vorbis = demuxed.tracks.find((t) => t.codec === 'vorbis');
    expect(vorbis?.mediaType).toBe('audio');
    const config = vorbis?.config;
    const description = config && 'description' in config ? config.description : undefined;
    expect(description).toBeInstanceOf(Uint8Array);
    const xiph = description as Uint8Array;
    expect(xiph[0]).toBe(2); // three Vorbis headers: id, comment, setup
    expect(new TextDecoder().decode(xiph)).toContain('vorbis');
    await demuxed.close();
  });

  it('movie_5.webm — self-describing VP9/Opus carry no decoder description', async () => {
    const demuxed = await WebmDriver.demux(await fixtureSource('movie_5.webm'));
    for (const t of demuxed.tracks) {
      const hasDescription = t.config !== undefined && 'description' in t.config;
      expect(hasDescription).toBe(false); // VP9/Opus are self-describing — no avcC/hvcC to surface
    }
    expect(demuxed.tracks.find((t) => t.mediaType === 'video')?.codec).toBe('vp9');
    expect(demuxed.tracks.find((t) => t.mediaType === 'audio')?.codec).toBe('opus');
    await demuxed.close();
  });
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
    // The blocks are parsed (demuxWebm runs in node); only the EncodedChunk WRAPPING needs WebCodecs,
    // so packets() is a typed capability gap in node and a bad track id is a typed demux error.
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(99)).toThrowError(MediaError);
    await demuxed.close();
  });

  it('createMuxer returns a working WebmMuxer (round-trip validated in ebml-write.test.ts)', () => {
    const muxer = WebmDriver.createMuxer();
    expect(muxer).toBeInstanceOf(WebmMuxer);
  });
});

describe('demuxWebm — (Simple)Block → frames vs golden-packets (real .webm + .mkv)', () => {
  interface GoldenPacket {
    trackIndex: number;
    size: number;
    ptsUs: number;
    dtsUs: number;
    keyframe: boolean;
  }
  const GOLDEN_DIR = new URL(
    '../../../../media-test/media-browser-test/fixtures/golden/',
    import.meta.url,
  ).pathname;
  async function golden(name: string): Promise<GoldenPacket[]> {
    return JSON.parse(
      await readFile(`${GOLDEN_DIR}${name}.packets.json`, 'utf8'),
    ) as GoldenPacket[];
  }

  // A real H.264 .mkv, a real VP9/Opus .webm, and a real AV1/Opus .webm — Block parsing must reproduce
  // the harness golden packet list exactly: per-track count, byte-exact frame sizes, monotonic
  // origin-aligned timestamps (±1 ms), and keyframe flags (SimpleBlock 0x80 / BlockGroup ReferenceBlock).
  it.each(['h264_in_mkv.mkv', 'vp9_1080p_10s.webm', 'av1_720p_5s.webm'])(
    '%s — exact packet count + size + timestamp + keyframe per track',
    async (name) => {
      const want = await golden(name);
      const { info, framesByIndex } = demuxWebm(await bytesFromMediaTest(name));
      const total = framesByIndex.reduce((n, f) => n + f.length, 0);
      expect(total).toBe(want.length);

      info.tracks.forEach((_track, ti) => {
        const ours = framesByIndex[ti] ?? [];
        const gold = want.filter((g) => g.trackIndex === ti);
        expect(ours.length).toBe(gold.length);
        // Origin-align each track's timeline (the harness oracle does the same), then compare deltas.
        const oOrigin = ours[0]?.timestampUs ?? 0;
        const gOrigin = gold[0]?.ptsUs ?? 0;
        for (let i = 0; i < gold.length; i++) {
          const u = ours[i];
          const g = gold[i];
          if (!u || !g) throw new Error(`missing packet ${ti}:${i}`);
          expect(u.data.byteLength).toBe(g.size);
          expect(u.keyframe).toBe(g.keyframe);
          expect(Math.abs(u.timestampUs - oOrigin - (g.ptsUs - gOrigin))).toBeLessThanOrEqual(1000);
        }
        // Timestamps are non-decreasing in decode order (block/file order).
        for (let i = 1; i < ours.length; i++) {
          expect(ours[i]?.timestampUs).toBeGreaterThanOrEqual(ours[i - 1]?.timestampUs ?? 0);
        }
      });
    },
  );

  it('the H.264 .mkv frames + their avcC description form a valid VideoDecoderConfig', async () => {
    const mkv = await bytesFromMediaTest('h264_in_mkv.mkv');
    const frames = demuxWebm(mkv).framesByIndex;
    // The demuxer contract surfaces the decoder config (codec + dims + the avcC description) on
    // TrackInfo.config — exactly what `VideoDecoder.configure` needs for an H.264-in-Matroska decode.
    const demuxed = await WebmDriver.demux(fromBytes(mkv, { mime: 'video/x-matroska' }));
    const videoTrackInfo = demuxed.tracks.find((t) => t.mediaType === 'video');
    const config = videoTrackInfo?.config;
    if (!config || !('codedWidth' in config)) throw new Error('expected a video config');
    expect(config.codec).toBe('h264');
    expect(config.codedWidth).toBe(1280);
    expect(config.codedHeight).toBe(720);
    const description = 'description' in config ? config.description : undefined;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array)[0]).toBe(0x01); // avcC configurationVersion
    // The first decodable frame is a keyframe with real bytes — the decode loop's first input.
    const videoIndex = demuxed.tracks.findIndex((t) => t.mediaType === 'video');
    expect(frames[videoIndex]?.[0]?.keyframe).toBe(true);
    expect((frames[videoIndex]?.[0]?.data.byteLength ?? 0) > 0).toBe(true);
    await demuxed.close();
  });

  it('bear-vp9-alpha.webm exposes VPx alpha BlockAdditions as frame side data', async () => {
    const { info, framesByIndex } = demuxWebm(await loadFixture('bear-vp9-alpha.webm'));
    const videoIndex = info.tracks.findIndex((track) => track.mediaType === 'video');
    const frames = framesByIndex[videoIndex] ?? [];
    expect(frames.length).toBeGreaterThan(0);

    const alphaFrames = frames.filter((frame) => frame.alpha !== undefined);
    expect(alphaFrames.length).toBeGreaterThan(0);
    expect(alphaFrames[0]?.alpha?.byteLength).toBeGreaterThan(0);
    expect(alphaFrames[0]?.alpha?.byteLength).not.toBe(alphaFrames[0]?.data.byteLength);
  });
});

describe('demuxWebm — lacing (none / Xiph / EBML / fixed) splits one block into N frames', () => {
  // Build a one-audio-track WebM whose single Cluster holds one laced SimpleBlock, then assert the
  // demuxer splits it into the expected per-frame byte lengths. Lacing is codec-agnostic framing, so a
  // hand-built block is the right unit subject (the real corpus is unlaced — see the golden tests above).
  function webmWithBlock(blockBody: number[]): Uint8Array {
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [2]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('A_OPUS')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48000)), ...el(E.Channels, [1])]),
    ]);
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el(E.SimpleBlock, blockBody),
    ]);
    return new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);
  }
  // Block body prefix: track-number vint (0x81) + int16 timecode (0,0) + flags byte.
  const DATA9 = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22];

  it('no lacing → a single frame of the whole payload', () => {
    const { framesByIndex } = demuxWebm(webmWithBlock([0x81, 0, 0, 0x80, 0xaa, 0xbb, 0xcc]));
    expect(framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([3]);
  });

  it('Xiph lacing → frame sizes from the consecutive-byte size table', () => {
    // flags 0x80|0x02 (keyframe + Xiph); [count-1=2][size0=2][size1=3]; last frame (4) is implicit.
    const body = [0x81, 0, 0, 0x82, 2, 2, 3, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      2, 3, 4,
    ]);
  });

  it('EBML lacing → first vint size then signed-vint deltas', () => {
    // flags 0x80|0x06; [count-1=2][vint size0=2 →0x82][signed delta +1 →0xC0]; last (4) implicit.
    const body = [0x81, 0, 0, 0x86, 2, 0x82, 0xc0, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      2, 3, 4,
    ]);
  });

  it('fixed lacing → equal-size frames (payload ÷ frame count)', () => {
    // flags 0x80|0x04; [count-1=2]; 9 payload bytes / 3 = 3 each, no size table.
    const body = [0x81, 0, 0, 0x84, 2, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      3, 3, 3,
    ]);
  });

  it('a BlockGroup with a ReferenceBlock is a delta frame; without one it is a keyframe', () => {
    // Two single-frame blocks in BlockGroups: the first has no ReferenceBlock (key), the second has one.
    const blk = (tc: number): number[] => [0x81, 0, tc, 0x00, 0xaa, 0xbb];
    const refBlock = el([0xfb], [0x01]); // ReferenceBlock = +1 (references a prior frame → delta)
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el([0xa0], el([0xa1], blk(0))), // BlockGroup → Block, no ReferenceBlock → keyframe
      ...el([0xa0], [...el([0xa1], blk(1)), ...refBlock]), // BlockGroup → Block + ReferenceBlock → delta
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(64, 1)), ...el(E.PixelHeight, uintN(64, 1))]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);
    const frames = demuxWebm(bytes).framesByIndex[0] ?? [];
    expect(frames.map((f) => f.keyframe)).toEqual([true, false]);
  });

  it('a BlockGroup with BlockAddID=1 attaches VPx alpha side data to its single frame', () => {
    const color = [0xaa, 0xbb, 0xcc];
    const alpha = [0x11, 0x22, 0x33, 0x44];
    const block = [0x81, 0, 0, 0x00, ...color];
    const additions = el(
      E.BlockAdditions,
      el(E.BlockMore, [...el(E.BlockAddID, [0x01]), ...el(E.BlockAdditional, alpha)]),
    );
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el(E.BlockGroup, [...el(E.Block, block), ...additions]),
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(64, 1)), ...el(E.PixelHeight, uintN(64, 1))]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);

    const frame = demuxWebm(bytes).framesByIndex[0]?.[0];
    expect(frame?.data).toEqual(new Uint8Array(color));
    expect(frame?.alpha).toEqual(new Uint8Array(alpha));
  });
});
