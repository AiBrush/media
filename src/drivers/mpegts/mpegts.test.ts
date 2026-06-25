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
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { MpegTsDriver, MpegTsModule } from './mpegts-driver.ts';
import { TS_CLOCK_HZ, detectFraming, parseTs } from './ts-parse.ts';

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
