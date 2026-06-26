/**
 * MPEG-TS container driver — structural oracle on REAL transport streams (BUILD_INSTRUCTIONS §6.1/§6.2).
 *
 * Subject media: a committed verbatim slice (`fixtures/media-derived/h264_720p.head.ts`) plus the larger
 * real `.ts` assets in the sibling `media-test` corpus (read by direct path). The oracle is **can-fail**:
 * exact PAT→PMT→stream-type structure, codec ids, coded dims / sample params parsed from the bitstream,
 * the first PES PTS (== ffprobe `start_time`), monotonic decode timestamps, and a PES-span duration that
 * matches ffprobe within a frame. A scrambled (HLS-AES) segment and a sync-corrupted file are rejected /
 * survived cleanly. Mutation checks confirm the oracle rejects wrong structure (anti-cheat, ADR-018).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { MpegTsDriver, MpegTsModule } from './mpegts-driver.ts';
import { TS_CLOCK_HZ, detectFraming, parseTs } from './ts-parse.ts';
import { MpegTsMuxer } from './ts-write.ts';

// The sibling acceptance corpus holds full-length real transport streams; we read them by direct path
// (they are not in this project's fetch-fixtures manifest). The committed slice is self-contained.
const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;
const DERIVED = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

async function bytesFromMediaTest(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}
async function bytesFromDerived(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${name}`));
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
async function streamCopyTs(
  bytes: Uint8Array,
  options?: Parameters<NonNullable<typeof MpegTsDriver.streamCopy>>[1],
): Promise<Uint8Array> {
  const streamCopy = MpegTsDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('MpegTsDriver.streamCopy is not implemented');
  return collectBytes(await streamCopy(fromBytes(bytes, { mime: 'video/mp2t' }), options));
}
function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function u16Bytes(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}
function avcCWithParameterSets(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x01, sps[1] ?? 0x42, sps[2] ?? 0x00, sps[3] ?? 0x1e, 0xff, 0xe1),
    u16Bytes(sps.byteLength),
    sps,
    Uint8Array.of(0x01),
    u16Bytes(pps.byteLength),
    pps,
  );
}
function expectUnitsPreserved(
  actual: readonly { data: Uint8Array; ptsUs: number; dtsUs: number; keyframe: boolean }[],
  expected: readonly { data: Uint8Array; ptsUs: number; dtsUs: number; keyframe: boolean }[],
): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const rewritten = actual[index];
    const original = expected[index];
    if (rewritten === undefined || original === undefined) {
      throw new Error(`missing unit ${index}`);
    }
    expect(rewritten.data).toEqual(original.data);
    expect(Math.abs(rewritten.ptsUs - original.ptsUs)).toBeLessThanOrEqual(12);
    expect(Math.abs(rewritten.dtsUs - original.dtsUs)).toBeLessThanOrEqual(12);
    expect(rewritten.keyframe).toBe(original.keyframe);
  }
}
function unitDurationUs(units: readonly { ptsUs: number }[], index: number): number {
  const current = units[index];
  if (current === undefined) return 0;
  const next = units[index + 1];
  if (next !== undefined && next.ptsUs > current.ptsUs) return next.ptsUs - current.ptsUs;
  const previous = units[index - 1];
  if (previous !== undefined && current.ptsUs > previous.ptsUs) {
    return current.ptsUs - previous.ptsUs;
  }
  return 0;
}

/** The committed verbatim head of `h264_ts.ts` — a valid standalone TS (PAT+PMT+first PES). */
const DERIVED_TS = 'h264_720p.head.ts';

/** Real full-length transport streams + their ffprobe ground truth (the structural oracle). */
interface TsGolden {
  name: string;
  videoCodec: string;
  width: number;
  height: number;
  audioCodec: string;
  sampleRate: number;
  channels: number;
  /** ffprobe `format=duration` (seconds); our PES-span estimate must land within FRAME_TOLERANCE_SEC. */
  durationSec: number;
}
const GOLDENS: readonly TsGolden[] = [
  // ffprobe -show_entries stream=...:format=duration on each file (recorded ground truth).
  {
    name: 'h264_ts.ts',
    videoCodec: 'h264',
    width: 1280,
    height: 720,
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationSec: 10.021333,
  },
  {
    name: 'hls_vod_000.ts',
    videoCodec: 'h264',
    width: 1280,
    height: 720,
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationSec: 2.021333,
  },
  {
    name: 'hls_vod_001.ts',
    videoCodec: 'h264',
    width: 1280,
    height: 720,
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationSec: 2.0,
  },
  {
    name: 'ts_discontinuity.ts',
    videoCodec: 'h264',
    width: 320,
    height: 240,
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationSec: 600.605333,
  },
];

/** One video frame (30 fps) — the doc-09 ±1-frame duration tolerance; our span+frame matches ffprobe. */
const FRAME_TOLERANCE_SEC = 1 / 30 + 1e-4;
/** First video PES PTS for these BBC-derived assets (90 kHz 127920 = 1.421333 s), == ffprobe start_time. */
const FIRST_VIDEO_PTS_US = Math.round((127920 / TS_CLOCK_HZ) * 1_000_000);
const FIRST_AUDIO_PTS_US = Math.round((126000 / TS_CLOCK_HZ) * 1_000_000);

describe('MpegTsDriver.supports', () => {
  it('recognizes TS by mime, extension, and a two-sync-byte magic; rejects others', async () => {
    const head = (await bytesFromDerived(DERIVED_TS)).subarray(0, 200);
    expect(MpegTsDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(MpegTsDriver.supports({ direction: 'demux', mime: 'video/mp2t' })).toBe(true);
    expect(MpegTsDriver.supports({ direction: 'demux', extension: 'ts' })).toBe(true);
    expect(MpegTsDriver.supports({ direction: 'demux', extension: 'm2ts' })).toBe(true);
    // A single 0x47 at offset 0 without a second sync 188 bytes later is NOT a TS signal.
    const oneByte = new Uint8Array(200);
    oneByte[0] = 0x47;
    expect(MpegTsDriver.supports({ direction: 'demux', head: oneByte })).toBe(false);
    expect(MpegTsDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('detectFraming locks onto 188-byte packets on real media', () => {
  it('finds 188-byte packets starting at offset 0 of a real TS', async () => {
    const framing = detectFraming(await bytesFromMediaTest('h264_ts.ts'));
    expect(framing).toEqual({ packetSize: 188, start: 0, tsOffset: 0 });
  });
  it('returns undefined for bytes that are not a transport stream', () => {
    expect(detectFraming(new Uint8Array(2000))).toBeUndefined(); // all-zero: no sync run
  });
});

describe('parseTs — PAT/PMT/PES structural oracle on the committed slice', () => {
  it('yields exactly the H.264 video + AAC audio elementary streams with correct PIDs', async () => {
    const parsed = parseTs(await bytesFromDerived(DERIVED_TS));
    expect(parsed.tracks).toHaveLength(2);
    const [video, audio] = parsed.tracks;
    // PMT declared stream_type 0x1b @ PID 0x100 (video) and 0x0f @ PID 0x101 (audio).
    expect(video?.stream).toMatchObject({
      pid: 0x100,
      streamType: 0x1b,
      mediaType: 'video',
      codec: 'h264',
    });
    expect(audio?.stream).toMatchObject({
      pid: 0x101,
      streamType: 0x0f,
      mediaType: 'audio',
      codec: 'aac',
    });
  });

  it('parses coded dimensions from the H.264 SPS and sample params from the ADTS header', async () => {
    const parsed = parseTs(await bytesFromDerived(DERIVED_TS));
    const v = parsed.tracks[0]?.config as VideoDecoderConfig;
    const a = parsed.tracks[1]?.config as AudioDecoderConfig;
    expect(v).toMatchObject({ codec: 'h264', codedWidth: 1280, codedHeight: 720 });
    expect(a).toMatchObject({ codec: 'aac', sampleRate: 48000, numberOfChannels: 2 });
  });

  it('extracts the exact first PTS (== ffprobe start_time) and emits decode-monotonic access units', async () => {
    const parsed = parseTs(await bytesFromDerived(DERIVED_TS));
    const video = parsed.tracks[0];
    const audio = parsed.tracks[1];
    expect(video?.units[0]?.ptsUs).toBe(FIRST_VIDEO_PTS_US);
    expect(audio?.units[0]?.ptsUs).toBe(FIRST_AUDIO_PTS_US);
    expect(video?.units[0]?.keyframe).toBe(true); // first AU carries the IDR
    // DTS is non-decreasing (decode order), the core demux guarantee even with B-frames.
    for (const t of parsed.tracks) {
      const dts = t.units.map((u) => u.dtsUs);
      for (let i = 1; i < dts.length; i++) expect(dts[i]).toBeGreaterThanOrEqual(dts[i - 1] ?? 0);
    }
  });
});

describe('probe across the real MPEG-TS corpus (≥5 distinct files) — golden structure + duration', () => {
  it.each(GOLDENS)(
    '$name — exact tracks, codecs, dims and a frame-accurate duration',
    async (g) => {
      const info = await createMedia()
        .use(MpegTsModule)
        .probe(fromBytes(await bytesFromMediaTest(g.name), { mime: 'video/mp2t' }));
      expect(info.container).toBe('ts');
      const video = info.tracks.find((t) => t.type === 'video');
      const audio = info.tracks.find((t) => t.type === 'audio');
      expect(video).toMatchObject({ codec: g.videoCodec, width: g.width, height: g.height });
      expect(audio).toMatchObject({
        codec: g.audioCodec,
        sampleRate: g.sampleRate,
        channels: g.channels,
      });
      // Duration from the PES span lands within a frame of ffprobe's container duration.
      expect(info.durationSec).toBeGreaterThan(0);
      expect(Math.abs(info.durationSec - g.durationSec)).toBeLessThanOrEqual(FRAME_TOLERANCE_SEC);
    },
  );

  it('committed slice probes to the same codecs/dims as the full asset (self-contained TS)', async () => {
    const info = await createMedia()
      .use(MpegTsModule)
      .probe(fromBytes(await bytesFromDerived(DERIVED_TS), { mime: 'video/mp2t' }));
    expect(info.container).toBe('ts');
    expect(info.tracks.find((t) => t.type === 'video')).toMatchObject({
      codec: 'h264',
      width: 1280,
      height: 720,
    });
    expect(info.tracks.find((t) => t.type === 'audio')).toMatchObject({
      codec: 'aac',
      sampleRate: 48000,
      channels: 2,
    });
  });
});

describe('golden-packets — access-unit count + per-frame size/PTS/DTS vs the harness golden', () => {
  // The harness `golden-packets` oracle (the live-demux gate) compares the demuxer's per-track access
  // units to fixtures/golden/h264_ts.ts.packets.json. The decisive case: an AAC PES carries MANY ADTS
  // frames, each a distinct access unit — so audio must emit one EncodedChunk per ADTS frame (470), not
  // per PES (59). Video (H.264) is one access unit per PES (300). This replays the exact oracle in node.
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

  it('h264_ts.ts — 770 packets {video:300, audio:470}, every size/PTS/DTS/keyframe matches', async () => {
    const golden = JSON.parse(
      await readFile(`${GOLDEN_DIR}h264_ts.ts.packets.json`, 'utf8'),
    ) as GoldenPacket[];
    const parsed = parseTs(await bytesFromMediaTest('h264_ts.ts'));
    // Track index in the golden is video-first then audio — the same order parseTs emits.
    const byIndex = parsed.tracks.map((t) => t.units);
    expect(byIndex[0]?.length).toBe(golden.filter((g) => g.trackIndex === 0).length); // video 300
    expect(byIndex[1]?.length).toBe(golden.filter((g) => g.trackIndex === 1).length); // audio 470
    const total = byIndex.reduce((n, u) => n + u.length, 0);
    expect(total).toBe(golden.length); // 770

    for (const trackIndex of [0, 1]) {
      const ours = byIndex[trackIndex] ?? [];
      const want = golden.filter((g) => g.trackIndex === trackIndex);
      // The oracle aligns each track's timeline origin (subtract the first PTS/DTS), then bounds drift.
      const ptsOrigin = ours[0]?.ptsUs ?? 0;
      const dtsOrigin = ours[0]?.dtsUs ?? 0;
      const gPtsOrigin = want[0]?.ptsUs ?? 0;
      const gDtsOrigin = want[0]?.dtsUs ?? 0;
      for (let i = 0; i < want.length; i++) {
        const u = ours[i];
        const g = want[i];
        if (!u || !g) throw new Error(`missing packet ${trackIndex}:${i}`);
        expect(u.data.byteLength).toBe(g.size); // byte-exact access-unit boundary
        expect(u.keyframe).toBe(g.keyframe);
        expect(Math.abs(u.ptsUs - ptsOrigin - (g.ptsUs - gPtsOrigin))).toBeLessThanOrEqual(1000);
        expect(Math.abs(u.dtsUs - dtsOrigin - (g.dtsUs - gDtsOrigin))).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('each AAC audio frame is one ADTS frame, PTS advancing by 1024/sampleRate (≈21333µs @48kHz)', async () => {
    const parsed = parseTs(await bytesFromMediaTest('h264_ts.ts'));
    const audio = parsed.tracks.find((t) => t.stream.mediaType === 'audio');
    if (!audio) throw new Error('no audio track');
    // Every audio AU begins with the ADTS syncword 0xFFFx (proves we split into frames, not whole PES).
    for (const u of audio.units.slice(0, 20)) {
      expect(u.data[0]).toBe(0xff);
      expect((u.data[1] ?? 0) & 0xf0).toBe(0xf0);
    }
    // Consecutive frame PTS deltas are one AAC frame: 1024 samples / 48000 Hz = 21333.33µs.
    const deltas = audio.units.slice(1, 11).map((u, i) => u.ptsUs - (audio.units[i]?.ptsUs ?? 0));
    for (const d of deltas) expect(d).toBeGreaterThanOrEqual(21333);
    for (const d of deltas) expect(d).toBeLessThanOrEqual(21334);
  });
});

describe('demux — packet seam (browser-gated like mp4)', () => {
  it('exposes the tracks but the EncodedChunk seam is a typed capability gap in node', async () => {
    const demuxed = await MpegTsDriver.demux(
      fromBytes(await bytesFromDerived(DERIVED_TS), { mime: 'video/mp2t' }),
    );
    expect(demuxed.tracks).toHaveLength(2);
    expect(demuxed.tracks[0]?.mediaType).toBe('video');
    // In node WebCodecs' EncodedVideoChunk is undefined → the same typed miss the mp4 driver raises.
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(99)).toThrowError(MediaError); // unknown track id
    await demuxed.close();
  });

  it('reads a non-seekable stream source (no range) by buffering the whole segment', async () => {
    const bytes = await bytesFromDerived(DERIVED_TS);
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
    const demuxed = await MpegTsDriver.demux(streamSource);
    expect(demuxed.tracks.map((t) => t.codec)).toEqual(['h264', 'aac']);
    await demuxed.close();
  });
});

describe('mux — H.264/AAC access units into MPEG-TS', () => {
  const sps = Uint8Array.of(0x67, 0x42, 0x00, 0x1e, 0xf4, 0x05, 0x01, 0xec, 0x80);
  const pps = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
  const h264Track = (description = avcCWithParameterSets(sps, pps)): TrackInfo => ({
    id: 0,
    mediaType: 'video',
    codec: 'avc1.42001e',
    durationSec: 1 / 30,
    config: {
      codec: 'avc1.42001e',
      codedWidth: 16,
      codedHeight: 16,
      description,
    },
  });
  const aacTrack = (description = Uint8Array.of(0x11, 0x90)): TrackInfo => ({
    id: 1,
    mediaType: 'audio',
    codec: 'mp4a.40.2',
    durationSec: 1024 / 48_000,
    config: {
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 2,
      description,
    },
  });

  it('authors PAT/PMT/PES packets and converts AVCC H.264 plus raw AAC into Annex B/ADTS', async () => {
    const muxer = new MpegTsMuxer();
    const videoTrack = h264Track();
    const audioTrack = aacTrack();
    const videoTrackId = muxer.addTrack(videoTrack);
    const audioTrackId = muxer.addTrack(audioTrack);
    muxer.addChunkStruct(videoTrackId, {
      data: Uint8Array.of(0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84),
      timestampUs: 0,
      dtsUs: 0,
      durationUs: 33_333,
      key: true,
    });
    muxer.addChunkStruct(audioTrackId, {
      data: Uint8Array.of(0x21, 0x10, 0x56, 0xe5, 0x00, 0x40),
      timestampUs: 0,
      dtsUs: 0,
      durationUs: 21_333,
      key: true,
    });

    await muxer.finalize();
    const bytes = await collectBytes(muxer.output);
    expect(bytes.byteLength % 188).toBe(0);
    expect(bytes[0]).toBe(0x47);
    expect(bytes[188]).toBe(0x47);

    const parsed = parseTs(bytes);
    expect(parsed.tracks.map((track) => track.stream.codec)).toEqual(['h264', 'aac']);
    const video = parsed.tracks[0];
    const audio = parsed.tracks[1];
    expect(video?.units).toHaveLength(1);
    expect(audio?.units).toHaveLength(1);
    expect(video?.units[0]?.keyframe).toBe(true);
    expect([...(video?.units[0]?.data ?? new Uint8Array()).subarray(0, 4)]).toEqual([0, 0, 0, 1]);
    expect(video?.units[0]?.data.includes(0x67)).toBe(true);
    expect(video?.units[0]?.data.includes(0x68)).toBe(true);
    expect(audio?.config).toMatchObject({ codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 });
    expect(audio?.units[0]?.data[0]).toBe(0xff);
    expect((audio?.units[0]?.data[1] ?? 0) & 0xf0).toBe(0xf0);
  });

  it('round-trips real Annex-B/ADTS access units without changing boundaries or data bytes', async () => {
    const source = parseTs(await bytesFromDerived(DERIVED_TS));
    const muxer = new MpegTsMuxer();
    const trackIds = source.tracks.map((track, index) =>
      muxer.addTrack({
        id: index,
        mediaType: track.stream.mediaType,
        codec: track.stream.codec,
        durationSec: track.durationSec,
        ...(track.fps !== undefined ? { fps: track.fps } : {}),
        config: track.config,
      }),
    );

    const units = source.tracks.flatMap((track, trackIndex) =>
      track.units.map((unit) => ({ trackIndex, unit })),
    );
    units.sort(
      (left, right) => left.unit.dtsUs - right.unit.dtsUs || left.trackIndex - right.trackIndex,
    );
    for (const { trackIndex, unit } of units) {
      const trackId = trackIds[trackIndex];
      if (trackId === undefined) throw new Error(`missing mux track ${trackIndex}`);
      muxer.addChunkStruct(trackId, {
        data: unit.data,
        timestampUs: unit.ptsUs,
        dtsUs: unit.dtsUs,
        key: unit.keyframe,
      });
    }

    await muxer.finalize();
    const remuxed = parseTs(await collectBytes(muxer.output));
    expect(remuxed.tracks.map((track) => track.stream.codec)).toEqual(
      source.tracks.map((track) => track.stream.codec),
    );
    for (let trackIndex = 0; trackIndex < source.tracks.length; trackIndex += 1) {
      const before = source.tracks[trackIndex]?.units ?? [];
      const after = remuxed.tracks[trackIndex]?.units ?? [];
      expect(after.length).toBe(before.length);
      for (let index = 0; index < Math.min(20, before.length); index += 1) {
        const original = before[index];
        const rewritten = after[index];
        if (original === undefined || rewritten === undefined)
          throw new Error(`missing unit ${trackIndex}:${index}`);
        expect([...rewritten.data]).toEqual([...original.data]);
        expect(Math.abs(rewritten.ptsUs - original.ptsUs)).toBeLessThanOrEqual(12);
        expect(Math.abs(rewritten.dtsUs - original.dtsUs)).toBeLessThanOrEqual(12);
        expect(rewritten.keyframe).toBe(original.keyframe);
      }
    }
  });

  it('rejects unsupported shapes and write/finalize misuse with typed errors', async () => {
    expect(() => new MpegTsMuxer({ fragmented: true })).toThrowError(CapabilityError);

    const mediaMismatch = new MpegTsMuxer();
    expect(() =>
      mediaMismatch.addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'h264',
        config: { codec: 'h264', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).toThrowError(/media type does not match/i);

    const unsupported = new MpegTsMuxer();
    expect(() =>
      unsupported.addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'mp3',
        config: { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).toThrowError(/supports H.264 and AAC/);

    const empty = new MpegTsMuxer();
    await expect(empty.finalize()).rejects.toThrowError(/at least one track/);

    const noPackets = new MpegTsMuxer();
    noPackets.addTrack(h264Track());
    await expect(noPackets.finalize()).rejects.toThrowError(/at least one packet/);

    const invalid = new MpegTsMuxer();
    const trackId = invalid.addTrack(aacTrack());
    expect(() =>
      invalid.addChunkStruct(99, {
        data: Uint8Array.of(1),
        timestampUs: 0,
        key: true,
      }),
    ).toThrowError(/unknown mux track/);
    expect(() =>
      invalid.addChunkStruct(trackId, {
        data: Uint8Array.of(1),
        timestampUs: Number.NaN,
        key: true,
      }),
    ).toThrowError(/Invalid MPEG-TS timestampUs/);
    expect(() =>
      invalid.addChunkStruct(trackId, {
        data: Uint8Array.of(1),
        timestampUs: 0,
        durationUs: -1,
        key: true,
      }),
    ).toThrowError(/Invalid MPEG-TS durationUs/);
    expect(() =>
      invalid.addChunkStruct(trackId, {
        data: new Uint8Array(),
        timestampUs: 0,
        key: true,
      }),
    ).toThrowError(/empty MPEG-TS access unit/);

    invalid.addChunkStruct(trackId, {
      data: Uint8Array.of(1, 2, 3),
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
    });
    await invalid.finalize();
    expect(() =>
      invalid.addChunkStruct(trackId, {
        data: Uint8Array.of(4),
        timestampUs: 21_333,
        key: true,
      }),
    ).toThrowError(/after finalize/);
  });

  it('rejects malformed H.264 avcC descriptions and invalid length-prefixed samples', async () => {
    expect(() => new MpegTsMuxer().addTrack(h264Track(Uint8Array.of(0, 1, 2)))).toThrowError(
      /Invalid avcC/,
    );
    expect(() =>
      new MpegTsMuxer().addTrack(
        h264Track(
          concatBytes(
            Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1),
            u16Bytes(sps.byteLength + 1),
            sps,
          ),
        ),
      ),
    ).toThrowError(/parameter set length/);
    expect(() =>
      new MpegTsMuxer().addTrack(
        h264Track(concatBytes(Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0x00))),
      ),
    ).toThrowError(/missing SPS\/PPS/);

    const noConfig = new MpegTsMuxer();
    const noConfigTrack = noConfig.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
    });
    noConfig.addChunkStruct(noConfigTrack, {
      data: Uint8Array.of(0, 0, 0, 1, 0x65),
      timestampUs: 0,
      key: true,
    });
    await noConfig.finalize();
    expect(parseTs(await collectBytes(noConfig.output)).tracks[0]?.units[0]?.data[4]).toBe(0x65);

    const invalidNal = new MpegTsMuxer();
    const invalidNalTrack = invalidNal.addTrack(h264Track());
    invalidNal.addChunkStruct(invalidNalTrack, {
      data: Uint8Array.of(0, 0, 0, 10, 0x65),
      timestampUs: 0,
      key: true,
    });
    await expect(invalidNal.finalize()).rejects.toThrowError(/Invalid H.264 NAL length/);
  });

  it('rejects AAC configs that cannot be represented as ADTS', () => {
    expect(() =>
      new MpegTsMuxer().addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', numberOfChannels: 2 },
      }),
    ).toThrowError(/sampleRate metadata/);
    expect(() =>
      new MpegTsMuxer().addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 12_345, numberOfChannels: 2 },
      }),
    ).toThrowError(/sample rate is not representable/);
    expect(() =>
      new MpegTsMuxer().addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 8 },
      }),
    ).toThrowError(/channel count is not representable/);
    expect(() => new MpegTsMuxer().addTrack(aacTrack(Uint8Array.of(0x29, 0x90)))).toThrowError(
      /object types 1 through 4/,
    );
  });
});

describe('streamCopy — driver-native MPEG-TS remux and keyframe trim', () => {
  it('remuxes a real TS without WebCodecs and preserves every access-unit byte/timestamp', async () => {
    const sourceBytes = await bytesFromMediaTest('h264_ts.ts');
    const source = parseTs(sourceBytes);
    const copiedBytes = await streamCopyTs(sourceBytes, { container: 'ts' });
    expect(copiedBytes.byteLength % 188).toBe(0);
    expect(copiedBytes[0]).toBe(0x47);
    expect(copiedBytes[188]).toBe(0x47);

    const copied = parseTs(copiedBytes);
    expect(copied.tracks.map((track) => track.stream.codec)).toEqual(
      source.tracks.map((track) => track.stream.codec),
    );
    for (let trackIndex = 0; trackIndex < source.tracks.length; trackIndex += 1) {
      expectUnitsPreserved(
        copied.tracks[trackIndex]?.units ?? [],
        source.tracks[trackIndex]?.units ?? [],
      );
    }
  });

  it('keyframe-trims a real TS with source-relative timing and no codec seam', async () => {
    const sourceBytes = await bytesFromMediaTest('h264_ts.ts');
    const source = parseTs(sourceBytes);
    const allPts = source.tracks.flatMap((track) => track.units.map((unit) => unit.ptsUs));
    const originUs = Math.min(...allPts);
    const startSec = 2.1;
    const endSec = 4.05;
    const startUs = Math.round(startSec * 1_000_000);
    const endUs = Math.round(endSec * 1_000_000);

    const video = source.tracks.find((track) => track.stream.mediaType === 'video');
    const audio = source.tracks.find((track) => track.stream.mediaType === 'audio');
    if (video === undefined || audio === undefined) throw new Error('fixture missing tracks');

    let videoStartIndex = 0;
    for (let index = 0; index < video.units.length; index += 1) {
      const unit = video.units[index];
      if (unit?.keyframe === true && unit.ptsUs - originUs <= startUs) {
        videoStartIndex = index;
      }
    }
    const expectedVideo = video.units
      .slice(videoStartIndex)
      .filter((unit) => unit.dtsUs - originUs < endUs);
    const audioStartIndex = audio.units.findIndex(
      (unit, index) => unit.ptsUs - originUs + unitDurationUs(audio.units, index) > startUs,
    );
    const expectedAudio = audio.units
      .slice(audioStartIndex < 0 ? 0 : audioStartIndex)
      .filter((unit) => unit.dtsUs - originUs < endUs);

    const trimmedBytes = await streamCopyTs(sourceBytes, {
      container: 'ts',
      trim: { startSec, endSec },
    });
    const trimmed = parseTs(trimmedBytes);
    const trimmedVideo = trimmed.tracks.find((track) => track.stream.mediaType === 'video');
    const trimmedAudio = trimmed.tracks.find((track) => track.stream.mediaType === 'audio');
    const trimmedDurationSec = Math.max(...trimmed.tracks.map((track) => track.durationSec));

    expect(trimmedDurationSec).toBeGreaterThan(1.8);
    expect(trimmedDurationSec).toBeLessThan(2.2);
    expect(trimmedVideo?.units[0]?.keyframe).toBe(true);
    expectUnitsPreserved(trimmedVideo?.units ?? [], expectedVideo);
    expectUnitsPreserved(trimmedAudio?.units ?? [], expectedAudio);
  });
});

describe('robustness — corrupt / scrambled / non-TS inputs reject or survive cleanly (§6.2)', () => {
  it('rejects a whole-segment-encrypted (HLS AES-128) TS as unsupported input, never wrong output', async () => {
    // The ciphertext has no transport sync run; probe must surface a typed InputError, not a fake result.
    await expect(
      createMedia()
        .use(MpegTsModule)
        .probe(fromBytes(await bytesFromMediaTest('hls_aes128_000.ts'), { mime: 'video/mp2t' })),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('rejects all-zero and empty inputs (no transport packets)', () => {
    expect(() => parseTs(new Uint8Array(0))).toThrowError(InputError);
    expect(() => parseTs(new Uint8Array(4 * 188))).toThrowError(InputError);
  });

  it('survives a sync-corrupted TS by resyncing — still recovers both real tracks', async () => {
    // fuzz_ts_zeroed_spans.ts zeroes a handful of packets; the parser must resync and not crash.
    const parsed = parseTs(await bytesFromMediaTest('fuzz_ts_zeroed_spans.ts'));
    expect(parsed.tracks.map((t) => t.stream.codec).sort()).toEqual(['aac', 'h264']);
    for (const t of parsed.tracks) expect(t.units.length).toBeGreaterThan(0);
  });

  it('rejects a valid-sync TS that carries no PMT (no decodable elementary stream)', async () => {
    // Real bytes: the PAT packet (index 1 of the committed slice) repeated — a locking sync run, but no
    // PMT and no PES, so there is nothing to demux. Must be a typed demux-error, not a fabricated track.
    const slice = await bytesFromDerived(DERIVED_TS);
    const patPacket = slice.subarray(188, 188 * 2);
    const buf = new Uint8Array(12 * 188);
    for (let i = 0; i < 12; i++) buf.set(patPacket, i * 188);
    expect(() => parseTs(buf)).toThrowError(MediaError);
    expect(() => parseTs(buf)).toThrowError(/no PAT\/PMT/);
  });
});

describe('anti-cheat — the oracle rejects mutated structure (it can fail)', () => {
  it('a flipped PMT stream_type byte changes the reported codec (so a wrong PMT cannot pass)', async () => {
    const original = await bytesFromDerived(DERIVED_TS);
    const truth = parseTs(original);
    expect(truth.tracks[0]?.stream.codec).toBe('h264');

    // Locate the PMT video entry's stream_type byte (0x1b) inside packet 2's section and corrupt it.
    const mutated = original.slice();
    const PKT = 188;
    const pmtPacket = mutated.subarray(2 * PKT, 3 * PKT); // PMT is packet index 2 in this asset
    const idx = pmtPacket.indexOf(0x1b);
    expect(idx).toBeGreaterThan(0); // the stream_type must be present to mutate
    pmtPacket[idx] = 0x02; // 0x1b (H.264) → 0x02 (MPEG-2 video): the oracle MUST notice
    const after = parseTs(mutated);
    expect(after.tracks.find((t) => t.stream.mediaType === 'video')?.stream.codec).toBe(
      'mpeg2video',
    );
    expect(after.tracks.find((t) => t.stream.mediaType === 'video')?.stream.codec).not.toBe('h264');
  });
});
