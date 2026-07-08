/**
 * MPEG-TS AAC ADTS de-framing — real-world oracle suite (ADR-184). The demuxer must emit exactly ONE
 * raw AAC access unit per packet (ADTS header + CRC stripped), stateful across PES boundaries, with the
 * AudioSpecificConfig derived from the ADTS header and per-frame PTS advancing 1024 samples from each
 * PES anchor. Ground truth is ffmpeg/ffprobe, captured offline as committed twins + recorded constants
 * (fixtures/media-derived/mpegts/README.md documents every provenance command):
 *
 *  - byte truth: `ffmpeg -i f.m2t -c:a copy -f adts f.aac` — the committed twin; our unit bytes must
 *    equal the twin's per-frame payloads 1:1 (headers stripped), for every frame.
 *  - count truth: ffprobe `nb_read_packets` (recorded) — also equals the twin's own ffprobe count.
 *  - duration truth: ffprobe `format=duration` of the lossless MP4 remux (`-c copy`), which is
 *    sample-table exact (frameCount × 1024 / rate) — the TS-level estimate is a tail heuristic.
 *  - timing truth: PES PTS anchors each frame group; 48 kHz has an exact 1920-tick cadence so the whole
 *    PTS list is asserted exactly; fractional-cadence rates assert first/last anchors + bounded cadence
 *    (ffprobe's own interpolated mid-PES values wobble ±2 ticks and even step backward on bear).
 *
 * Four structurally distinct real transport streams (anti-overfit):
 *  (i) multi ADTS frames per PES (44.1 kHz stereo, CBR mux rate), (ii) every frame CROSSING PES
 *  boundaries + PTS-less PES packets (48 kHz broadcast-style repacketization, ffmpeg-certified
 *  byte-identical), (iii) real H.264+AAC A/V TS (Chromium bear), (iv) ≥30 s audio-only (22.05 kHz mono)
 *  where any cadence/drop bug compounds visibly.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { readAdtsFrames } from '../../codecs/wasm-aac/aac.ts';
import { AdtsDeframer, TS_CLOCK_HZ, type TsParse, type TsTrack, parseTs } from './ts-parse.ts';

const MPEGTS_DERIVED = new URL('../../../fixtures/media-derived/mpegts/', import.meta.url).pathname;
const MEDIA = new URL('../../../fixtures/media/', import.meta.url).pathname;

function ticksToUs(ticks: number): number {
  return Math.round((ticks * 1_000_000) / TS_CLOCK_HZ);
}

/** A real TS file + its recorded ffmpeg/ffprobe ground truth (see the fixture README for commands). */
interface DeframeGolden {
  /** Absolute fixture path. */
  path: string;
  /** Committed `ffmpeg -c:a copy -f adts` twin (absolute path). */
  twinPath: string;
  /** ffprobe `nb_read_packets` for the AAC stream — equals the twin's own packet count. */
  audioPackets: number;
  sampleRate: number;
  channels: number;
  /** ffprobe `format=duration` of the lossless MP4 remux (`ffmpeg -i f -c copy f.mp4`). */
  mp4RemuxDurationSec: number;
  /** First AAC PES PTS in 90 kHz ticks (ffprobe first packet pts). */
  firstPtsTicks: number;
  /** ffprobe's last audio packet pts (90 kHz) and the µs tolerance for our last frame vs it. */
  lastPtsTicks: number;
  lastPtsToleranceUs: number;
  /** Inclusive bounds for successive PTS deltas (µs): exact-cadence ± PES-anchor stamping jitter. */
  deltaBoundsUs: readonly [number, number];
}

const MULTI: DeframeGolden = {
  path: `${MPEGTS_DERIVED}aac_44k_multi.m2t`,
  twinPath: `${MPEGTS_DERIVED}aac_44k_multi.aac`,
  audioPackets: 119,
  sampleRate: 44100,
  channels: 2,
  mp4RemuxDurationSec: 2.763175,
  firstPtsTicks: 126000,
  lastPtsTicks: 372596,
  lastPtsToleranceUs: 60,
  deltaBoundsUs: [23205, 23235], // 1024/44100 = 23219.95 µs ± anchor jitter
};
const SPLIT: DeframeGolden = {
  path: `${MPEGTS_DERIVED}aac_48k_split.m2t`,
  twinPath: `${MPEGTS_DERIVED}aac_48k_split.aac`,
  audioPackets: 130,
  sampleRate: 48000,
  channels: 2,
  mp4RemuxDurationSec: 2.773333,
  firstPtsTicks: 126000,
  lastPtsTicks: 373680,
  lastPtsToleranceUs: 0, // 48 kHz cadence is exactly 1920 ticks — the whole list is exact
  deltaBoundsUs: [21333, 21334],
};
const LONG: DeframeGolden = {
  path: `${MPEGTS_DERIVED}aac_22k_long.m2t`,
  twinPath: `${MPEGTS_DERIVED}aac_22k_long.aac`,
  audioPackets: 691,
  sampleRate: 22050,
  channels: 1,
  mp4RemuxDurationSec: 32.089977,
  firstPtsTicks: 126000,
  lastPtsTicks: 3009919,
  lastPtsToleranceUs: 200,
  deltaBoundsUs: [46430, 46450], // 1024/22050 = 46439.9 µs ± anchor jitter
};
const BEAR: DeframeGolden = {
  path: `${MEDIA}bear-1280x720.ts`,
  twinPath: `${MPEGTS_DERIVED}bear-1280x720.aac`,
  audioPackets: 119,
  sampleRate: 44100,
  channels: 2,
  mp4RemuxDurationSec: 2.746067, // format duration of the A/V remux (video-dominated)
  firstPtsTicks: 126000,
  // Clean-cadence last frame, derived purely from ffmpeg-measured quantities: firstPts (126000, ffprobe
  // first packet pts) + (nb_read_packets − 1) × 1024 / sample_rate on the 90 kHz clock = 126000 +
  // 118 × 1024 × 90000 / 44100 = 372596. ffprobe's *raw* last audio packet pts is 370506 — exactly one
  // AAC frame (2090 ticks) less — because bear's first audio PES carries a priming frame that ffmpeg's
  // parser folds onto frame 0's PTS slot (its frame 1 steps back to 125999), compressing the tail by a
  // frame. The de-framer instead keeps a strictly monotonic 1024-sample cadence (ADR-184), so its last
  // frame lands one frame later; the materialized *duration* still matches ffprobe within one frame
  // (asserted separately). A tight tolerance pins the last frame to the exact model — a miscount or a
  // misplaced anchor moves it by a whole frame and fails.
  lastPtsTicks: 372596,
  lastPtsToleranceUs: 5,
  deltaBoundsUs: [23205, 23235],
};
const ALL: ReadonlyArray<[string, DeframeGolden]> = [
  ['aac_44k_multi.m2t (multi frames per PES, CBR)', MULTI],
  ['aac_48k_split.m2t (frames crossing PES boundaries)', SPLIT],
  ['aac_22k_long.m2t (≥30 s, cadence compounds)', LONG],
  ['bear-1280x720.ts (real A/V)', BEAR],
];

/** `ffmpeg -map 0:v -c copy -f h264` of bear-1280x720.ts — sha256 + byte length (recorded). */
const BEAR_VIDEO_ES_SHA256 = '927e1c212b248d295f494a2dce9f5c5f425c29d373dccf9de05784197f20c21b';
const BEAR_VIDEO_ES_BYTES = 688201;
const BEAR_VIDEO_PACKETS = 82;

const parsedByPath = new Map<string, TsParse>();
const twinByPath = new Map<string, ReturnType<typeof readAdtsFrames>>();
const bytesByPath = new Map<string, Uint8Array>();

beforeAll(async () => {
  for (const [, g] of ALL) {
    const bytes = new Uint8Array(await readFile(g.path));
    bytesByPath.set(g.path, bytes);
    parsedByPath.set(g.path, parseTs(bytes));
    twinByPath.set(g.twinPath, readAdtsFrames(new Uint8Array(await readFile(g.twinPath))));
  }
});

function audioTrack(g: DeframeGolden): TsTrack {
  const track = parsedByPath.get(g.path)?.tracks.find((t) => t.stream.mediaType === 'audio');
  if (!track) throw new Error(`no audio track in ${g.path}`);
  return track;
}

/**
 * The MP4 muxer's mix-detector (mux.ts `parseAdtsAccessUnit` semantics): a sample "is ADTS-framed" when
 * it starts with a full valid ADTS header whose frame length equals the sample length. The de-framed
 * demux invariant is that NO emitted unit ever trips this — that is exactly what kills the
 * "cannot mix ADTS-framed and raw samples" failure.
 */
function looksAdtsFramed(data: Uint8Array): boolean {
  if (data.byteLength < 7) return false;
  const b1 = data[1] as number;
  if (data[0] !== 0xff || (b1 & 0xf0) !== 0xf0 || (b1 & 0x06) !== 0) return false;
  const frameLength =
    (((data[3] as number) & 0x03) << 11) |
    ((data[4] as number) << 3) |
    (((data[5] as number) >> 5) & 0x07);
  return frameLength === data.byteLength;
}

describe('AAC de-framing — packet count + raw framing invariant (vs ffprobe nb_read_packets)', () => {
  it.each(ALL)('%s', (_name, g) => {
    const units = audioTrack(g).units;
    expect(units.length).toBe(g.audioPackets);
    for (const u of units) {
      expect(u.data.byteLength).toBeGreaterThan(0);
      expect(looksAdtsFramed(u.data)).toBe(false); // raw AU, never an ADTS-framed sample
      expect(u.keyframe).toBe(true);
      expect(u.dtsUs).toBe(u.ptsUs); // audio has no reorder
    }
  });
});

describe('AAC de-framing — frame-by-frame byte equality vs the ffmpeg ADTS extraction twin', () => {
  it.each(ALL)('%s', (_name, g) => {
    const units = audioTrack(g).units;
    const twin = twinByPath.get(g.twinPath);
    if (!twin) throw new Error(`missing twin ${g.twinPath}`);
    expect(twin.frames.length).toBe(g.audioPackets); // the twin corroborates the recorded ffprobe count
    expect(units.length).toBe(twin.frames.length);
    for (let i = 0; i < twin.frames.length; i++) {
      const ours = units[i]?.data;
      const truth = twin.frames[i];
      if (ours === undefined || truth === undefined) throw new Error(`missing frame ${i}`);
      // Uint8Array equality via Buffer.compare keeps the failure output readable on huge frames.
      expect(
        Buffer.compare(Buffer.from(ours), Buffer.from(truth)),
        `frame ${i} bytes differ from ffmpeg extraction`,
      ).toBe(0);
    }
  });
});

describe('AAC de-framing — track config carries the ADTS-derived AudioSpecificConfig', () => {
  it.each(ALL)('%s', (_name, g) => {
    const track = audioTrack(g);
    const twin = twinByPath.get(g.twinPath);
    if (!twin) throw new Error(`missing twin ${g.twinPath}`);
    const config = track.config as AudioDecoderConfig;
    expect(config.sampleRate).toBe(g.sampleRate);
    expect(config.numberOfChannels).toBe(g.channels);
    expect(config.sampleRate).toBe(twin.sampleRate); // twin-corroborated geometry
    expect(config.numberOfChannels).toBe(twin.channels);
    const description = config.description;
    if (description === undefined) throw new Error('config.description missing');
    const asc = ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);
    // AudioSpecificConfig: objectType(5) | samplingFrequencyIndex(4) | channelConfiguration(4) | pad(3).
    const freqIndex = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ].indexOf(g.sampleRate);
    expect([...asc]).toEqual([
      (twin.objectType << 3) | (freqIndex >> 1),
      ((freqIndex & 0x01) << 7) | (g.channels << 3),
    ]);
  });

  it('spot-check: 44.1 kHz stereo AAC-LC is exactly [0x12, 0x10]', () => {
    const config = audioTrack(MULTI).config as AudioDecoderConfig;
    const d = config.description;
    if (d === undefined) throw new Error('description missing');
    const asc = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d);
    expect([...asc]).toEqual([0x12, 0x10]);
  });
});

describe('AAC de-framing — PES-anchored timestamps, monotonic 1024-sample cadence', () => {
  it.each(ALL)('%s', (_name, g) => {
    const units = audioTrack(g).units;
    expect(units[0]?.ptsUs).toBe(ticksToUs(g.firstPtsTicks));
    const [minDelta, maxDelta] = g.deltaBoundsUs;
    for (let i = 1; i < units.length; i++) {
      const delta = (units[i]?.ptsUs ?? 0) - (units[i - 1]?.ptsUs ?? 0);
      expect(delta, `pts delta at frame ${i}`).toBeGreaterThanOrEqual(minDelta);
      expect(delta, `pts delta at frame ${i}`).toBeLessThanOrEqual(maxDelta);
    }
    const last = units[units.length - 1]?.ptsUs ?? 0;
    expect(Math.abs(last - ticksToUs(g.lastPtsTicks))).toBeLessThanOrEqual(
      Math.max(g.lastPtsToleranceUs, 0),
    );
  });

  it('48 kHz crossing fixture: the ENTIRE pts list equals the exact 1920-tick model (== ffprobe)', () => {
    const units = audioTrack(SPLIT).units;
    for (let i = 0; i < units.length; i++) {
      expect(units[i]?.ptsUs, `frame ${i}`).toBe(ticksToUs(126000 + i * 1920));
    }
  });
});

describe('AAC de-framing — materialized duration equals the lossless MP4 remux (ffprobe)', () => {
  it.each([
    ['aac_44k_multi.m2t', MULTI],
    ['aac_48k_split.m2t', SPLIT],
    ['aac_22k_long.m2t', LONG],
  ] as const)('%s — within one AAC frame', (_name, g) => {
    const track = audioTrack(g);
    const frameSec = 1024 / g.sampleRate;
    expect(Math.abs(track.durationSec - g.mp4RemuxDurationSec)).toBeLessThanOrEqual(
      frameSec + 1e-3,
    );
  });

  it('bear-1280x720.ts — container duration within one video frame', () => {
    const track = audioTrack(BEAR);
    expect(Math.abs(track.durationSec - BEAR.mp4RemuxDurationSec)).toBeLessThanOrEqual(
      1 / 30 + 1e-3,
    );
  });
});

describe('video stays untouched — bear H.264 elementary stream is byte-identical to ffmpeg', () => {
  it('82 Annex-B access units; concatenation sha256-equal to `ffmpeg -map 0:v -c copy -f h264`', () => {
    const video = parsedByPath.get(BEAR.path)?.tracks.find((t) => t.stream.mediaType === 'video');
    if (!video) throw new Error('no video track');
    expect(video.stream.codec).toBe('h264');
    expect(video.units.length).toBe(BEAR_VIDEO_PACKETS);
    expect(video.units[0]?.keyframe).toBe(true);
    const hash = createHash('sha256');
    let total = 0;
    for (const u of video.units) {
      const annexB =
        u.data[0] === 0 &&
        u.data[1] === 0 &&
        (u.data[2] === 1 || (u.data[2] === 0 && u.data[3] === 1));
      expect(annexB).toBe(true);
      hash.update(u.data);
      total += u.data.byteLength;
    }
    expect(total).toBe(BEAR_VIDEO_ES_BYTES);
    expect(hash.digest('hex')).toBe(BEAR_VIDEO_ES_SHA256);
  });
});

describe('fixture shape (anti-fake): the crossing fixture really does split frames across PES packets', () => {
  it('aac_48k_split.m2t has >100 PES starting mid-frame and >50 PTS-less PES on the AAC PID', () => {
    const bytes = bytesByPath.get(SPLIT.path);
    if (!bytes) throw new Error('missing fixture bytes');
    let midStart = 0;
    let noPts = 0;
    let pusiCount = 0;
    for (let off = 0; off + 188 <= bytes.byteLength; off += 188) {
      expect(bytes[off]).toBe(0x47);
      const b1 = bytes[off + 1] as number;
      if ((b1 & 0x40) === 0) continue; // not a payload-unit start
      const pid = ((b1 & 0x1f) << 8) | (bytes[off + 2] as number);
      const afc = ((bytes[off + 3] as number) >> 4) & 0x3;
      let cur = off + 4;
      if ((afc & 0x2) !== 0) cur += 1 + (bytes[cur] as number);
      if ((afc & 0x1) === 0 || cur >= off + 188) continue;
      if (bytes[cur] !== 0 || bytes[cur + 1] !== 0 || bytes[cur + 2] !== 1) continue;
      const streamId = bytes[cur + 3] as number;
      if (streamId < 0xc0 || streamId > 0xdf || pid === 0) continue; // audio PES only
      pusiCount++;
      const hasPts = (((bytes[cur + 7] as number) >> 6) & 0x2) !== 0;
      if (!hasPts) noPts++;
      const payloadStart = cur + 9 + (bytes[cur + 8] as number);
      const p0 = bytes[payloadStart] as number;
      const p1 = bytes[payloadStart + 1] as number;
      if (!(p0 === 0xff && (p1 & 0xf0) === 0xf0)) midStart++;
    }
    expect(pusiCount).toBe(161);
    expect(midStart).toBeGreaterThan(100);
    expect(noPts).toBeGreaterThan(50);
  });
});

// ── synthetic ADTS: deterministic branch coverage the real corpus cannot all exercise ────────────────

/**
 * Build one spec-valid ADTS frame (ISO/IEC 13818-7 §6.2) around `payload`. `crc` selects the 9-byte
 * (protection_absent = 0) header; otherwise the 7-byte header. AAC-LC (profile 1 → objectType 2). Lets
 * the tests below drive {@link AdtsDeframer} directly over CRC / resync / boundary / rebase paths.
 */
function buildAdts(opts: {
  sfi: number;
  channels: number;
  payload: Uint8Array;
  profile?: number;
  crc?: boolean;
}): Uint8Array {
  const profile = opts.profile ?? 1;
  const protectionAbsent = opts.crc === true ? 0 : 1;
  const headerLen = protectionAbsent === 1 ? 7 : 9;
  const frameLen = headerLen + opts.payload.byteLength;
  const f = new Uint8Array(frameLen);
  f[0] = 0xff;
  f[1] = 0xf0 | protectionAbsent; // syncword + MPEG-4 + layer '00' + protection_absent
  f[2] = ((profile & 0x03) << 6) | ((opts.sfi & 0x0f) << 2) | ((opts.channels >> 2) & 0x01);
  f[3] = ((opts.channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  f[4] = (frameLen >> 3) & 0xff;
  f[5] = ((frameLen & 0x07) << 5) | 0x1f;
  f[6] = 0xfc; // buffer_fullness low bits + number_of_raw_data_blocks_in_frame = 0 → one 1024-sample block
  // CRC bytes (when present) stay 0 — the de-framer strips, never validates, them.
  f.set(opts.payload, headerLen);
  return f;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** A recognizable, sync-free payload of `len` bytes for frame `k` (so byte equality is meaningful). */
function payloadFor(k: number, len = 24): Uint8Array {
  return Uint8Array.from({ length: len }, (_, i) => (0x40 + k * 7 + i) & 0x7f); // top bit clear → never 0xFF
}

const SR48 = 48000;
const SFI48 = 3; // sampling_frequency_index for 48 kHz
const CADENCE_48 = (1024 * TS_CLOCK_HZ) / SR48; // 1920 ticks/frame, exact

describe('AAC de-framing — synthetic ADTS conformance (CRC / resync / boundary / rebase, ADR-184)', () => {
  it('strips a CRC-protected 9-byte header, emits raw AUs, and derives the geometry', () => {
    const frames = [payloadFor(0), payloadFor(1), payloadFor(2)];
    const bytes = concatAll(
      frames.map((p) => buildAdts({ sfi: SFI48, channels: 2, payload: p, crc: true })),
    );
    const d = new AdtsDeframer();
    d.push(bytes, 126000);
    d.finish();
    expect(d.units.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect([...(d.units[i]?.data ?? [])]).toEqual([...(frames[i] ?? [])]); // header + CRC stripped
      expect(looksAdtsFramed(d.units[i]?.data ?? new Uint8Array())).toBe(false);
    }
    expect(d.params).toEqual({
      objectType: 2,
      samplingFrequencyIndex: SFI48,
      sampleRate: SR48,
      channelConfiguration: 2,
    });
    expect(d.ptsTicksList).toEqual([126000, 126000 + CADENCE_48, 126000 + 2 * CADENCE_48]);
  });

  it('resyncs past leading garbage and rejects a false 0xFFF syncword inside the stream', () => {
    const garbage = Uint8Array.from({ length: 19 }, (_, i) => i & 0x3f); // no 0xFF
    // A byte pair that opens like a header (0xFF 0xF1) but carries a reserved sampling index (15) → the
    // validator must decline it and keep hunting, not split a phantom frame.
    const falseSync = Uint8Array.of(0xff, 0xf1, (15 << 2) & 0xff, 0x00, 0x00, 0x00, 0x00);
    const real = [
      buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(0) }),
      buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(1) }),
    ];
    const d = new AdtsDeframer();
    d.push(concatAll([garbage, falseSync, ...real]), 126000);
    d.finish();
    expect(d.units.length).toBe(2);
    expect([...(d.units[0]?.data ?? [])]).toEqual([...payloadFor(0)]);
    expect([...(d.units[1]?.data ?? [])]).toEqual([...payloadFor(1)]);
    expect(d.ptsTicksList).toEqual([126000, 126000 + CADENCE_48]);
  });

  it('carries a frame across a push boundary — body split (pending buffer) — and emits it once', () => {
    const frame = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(5) });
    const cut = 9; // header (7) intact, body split
    const d = new AdtsDeframer();
    d.push(frame.subarray(0, cut), 126000);
    expect(d.units.length).toBe(0); // frameLength not yet satisfied → held pending
    d.push(frame.subarray(cut), undefined);
    d.finish();
    expect(d.units.length).toBe(1);
    expect([...(d.units[0]?.data ?? [])]).toEqual([...payloadFor(5)]);
    expect(d.ptsTicksList).toEqual([126000]);
  });

  it('carries a frame across a push boundary — header split (partial-header pending) — and emits once', () => {
    const frame = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(6) });
    const d = new AdtsDeframer();
    d.push(frame.subarray(0, 3), 126000); // fewer than 7 header bytes → cannot parse yet
    expect(d.units.length).toBe(0);
    d.push(frame.subarray(3), undefined);
    d.finish();
    expect(d.units.length).toBe(1);
    expect([...(d.units[0]?.data ?? [])]).toEqual([...payloadFor(6)]);
  });

  it('continues the monotonic cadence chain across a PTS-less PES', () => {
    const first = concatAll(
      [0, 1].map((k) => buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(k) })),
    );
    const cont = concatAll(
      [2, 3].map((k) => buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(k) })),
    );
    const d = new AdtsDeframer();
    d.push(first, 126000);
    d.push(cont, undefined); // no anchor → the chain simply advances
    d.finish();
    expect(d.ptsTicksList).toEqual([
      126000,
      126000 + CADENCE_48,
      126000 + 2 * CADENCE_48,
      126000 + 3 * CADENCE_48,
    ]);
  });

  it('rebases the chain on a genuine PTS discontinuity (jump ≫ half a second)', () => {
    const first = concatAll(
      [0, 1].map((k) => buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(k) })),
    );
    const jumped = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(2) });
    const predictedThird = 126000 + 2 * CADENCE_48; // 129840
    const anchor = predictedThird + 50000; // 50000 ticks ≫ 45000 threshold → real discontinuity
    const d = new AdtsDeframer();
    d.push(first, 126000);
    d.push(jumped, anchor);
    d.finish();
    expect(d.ptsTicksList).toEqual([126000, 126000 + CADENCE_48, anchor]); // third frame rebased
  });

  it('keeps the cadence when a later anchor is within tolerance (bear frame-12 in miniature)', () => {
    const first = concatAll(
      [0, 1].map((k) => buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(k) })),
    );
    const next = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(2) });
    const predictedThird = 126000 + 2 * CADENCE_48; // 129840
    const laggingAnchor = predictedThird - CADENCE_48; // one frame behind, |Δ| ≪ threshold → NOT a reset
    const d = new AdtsDeframer();
    d.push(first, 126000);
    d.push(next, laggingAnchor);
    d.finish();
    // The clean cadence is kept (129840), NOT reset to the lagging anchor — this is exactly why bear's
    // frame 12 stays monotonic instead of collapsing to a ~0 delta.
    expect(d.ptsTicksList).toEqual([126000, 126000 + CADENCE_48, predictedThird]);
    for (let i = 1; i < d.units.length; i++) {
      expect((d.units[i]?.ptsUs ?? 0) - (d.units[i - 1]?.ptsUs ?? 0)).toBeGreaterThan(0);
    }
  });

  it('drops frames that precede the first PTS anchor, then anchors the first timed frame', () => {
    const d = new AdtsDeframer();
    d.push(buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(0) }), undefined); // no anchor yet
    expect(d.units.length).toBe(0); // cannot be placed on the timeline → dropped
    d.push(buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(1) }), 200000);
    d.finish();
    expect(d.units.length).toBe(1);
    expect(d.ptsTicksList).toEqual([200000]);
    expect([...(d.units[0]?.data ?? [])]).toEqual([...payloadFor(1)]);
  });

  it('drops a trailing partial frame at finish()', () => {
    const whole = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(0) });
    const partialNext = buildAdts({ sfi: SFI48, channels: 2, payload: payloadFor(1) }).subarray(
      0,
      10,
    );
    const d = new AdtsDeframer();
    d.push(concatAll([whole, partialNext]), 126000);
    expect(d.units.length).toBe(1); // only the complete frame emitted; the partial is held pending
    d.finish(); // EOF: the unplayable trailing partial is discarded (matches ffmpeg → packet counts hold)
    expect(d.units.length).toBe(1);
    expect([...(d.units[0]?.data ?? [])]).toEqual([...payloadFor(0)]);
  });
});
