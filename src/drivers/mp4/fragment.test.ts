/**
 * Validation for the fragmented-MP4 / CMAF writer ({@link fragmentMp4}) — a real round-trip oracle that
 * can fail. Plain sample structs (NOT WebCodecs chunks) are fragmented into an init segment + media
 * segments; the segments are re-scanned with an independent ISO-BMFF box reader that pulls each `moof`'s
 * `tfhd`/`tfdt`/`trun` + the paired `mdat`, reconstructing the full per-track sample list. We assert:
 *
 *  - the init segment is a valid `ftyp` + `moov` whose (empty) `trak`s re-parse via the demuxer's
 *    `readMovie`, and whose `moov` carries `mvex`/`trex` (one per track);
 *  - there are N `moof` + `mdat` media segments (no sample buffered into `moov`);
 *  - per-track `tfdt` baseMediaDecodeTime is monotonic non-decreasing across that track's fragments;
 *  - sample **count** and per-sample **size** are preserved exactly (no drop/dup/clamp);
 *  - a fragment-by-fragment read reconstructs the original sample list — sizes, durations, keyframe
 *    flags, composition offsets (incl. negative, B-frame), and the sample **bytes** themselves;
 *  - the `trun` `data_offset` actually addresses each sample's bytes inside the shared `mdat`.
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  type FragmentTrackInput,
  buildMediaSegment,
  fragmentMp4,
  planFragmentRuns,
} from './fragment.ts';
import { readMovie } from './mp4-driver.ts';
import type { Movie, ParsedTrack } from './parse.ts';
import { Reader, boxes } from './reader.ts';
import { type SampleData, buildSampleData } from './samples.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';

// ── shared helpers ─────────────────────────────────────────────────────────────────────────────

const AVCC = new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]);
const ASC = new Uint8Array([0x11, 0x90]);

/** A sample whose bytes are a deterministic, per-sample-unique pattern, so a byte-level read can fail. */
function sample(
  durationTicks: number,
  cttsTicks: number,
  keyframe: boolean,
  size: number,
  fill: number,
): MuxSampleInput {
  return { data: new Uint8Array(size).fill(fill & 0xff), durationTicks, cttsTicks, keyframe };
}

function videoTrack(samples: MuxSampleInput[]): FragmentTrackInput {
  return {
    mediaType: 'video',
    sampleEntryType: 'avc1',
    timescale: 30_000,
    description: AVCC,
    width: 64,
    height: 48,
    samples,
  };
}

function audioTrack(samples: MuxSampleInput[]): FragmentTrackInput {
  return {
    mediaType: 'audio',
    sampleEntryType: 'mp4a',
    timescale: 48_000,
    description: ASC,
    sampleRate: 48_000,
    channels: 2,
    samples,
  };
}

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ── an independent box scanner that reconstructs samples from moof/mdat ───────────────────────────

interface ParsedSample {
  size: number;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
  data: Uint8Array;
}
interface ParsedTraf {
  trackId: number;
  baseMediaDecodeTime: number;
  samples: ParsedSample[];
}
interface ParsedSegment {
  sequenceNumber: number;
  trafs: ParsedTraf[];
}

/** Top-level boxes of the whole fragmented stream, in order (e.g. ftyp, moov, moof, mdat, moof, …). */
function topLevelBoxes(file: Uint8Array): { type: string; start: number; end: number }[] {
  const r = new Reader(file);
  const out: { type: string; start: number; end: number }[] = [];
  for (const b of boxes(r, file.byteLength)) out.push({ type: b.type, start: b.start, end: b.end });
  return out;
}

/** A non-sync `trun` sample-flags word? (bit `sample_is_non_sync_sample` = 0x00010000). */
function isNonSync(flags: number): boolean {
  return (flags & 0x00010000) !== 0;
}

/**
 * Parse one `moof` (at `[moofStart, moofEnd)`) against its paired `mdat` (the box immediately after),
 * pulling each `traf`'s `tfhd`(trackId), `tfdt`(baseMediaDecodeTime), and `trun` (per-sample duration/
 * size/flags/cto + the data_offset), then slicing each sample's bytes out of the file by the data_offset
 * (which, with default-base-is-moof, is relative to the `moof` start).
 */
function parseSegment(file: Uint8Array, moofStart: number, moofEnd: number): ParsedSegment {
  const r = new Reader(file);
  r.seek(moofStart);
  const moof = [...boxes(r, moofEnd)].find((b) => b.type === 'moof');
  if (!moof) throw new Error('no moof');

  // mfhd → sequence_number
  r.seek(moof.payloadStart);
  let sequenceNumber = 0;
  const trafs: ParsedTraf[] = [];
  for (const b of boxes(r, moof.end)) {
    if (b.type === 'mfhd') {
      r.seek(b.payloadStart);
      r.skip(4); // version+flags
      sequenceNumber = r.u32();
    } else if (b.type === 'traf') {
      trafs.push(parseTraf(file, b.payloadStart, b.end, moofStart));
    }
  }
  return { sequenceNumber, trafs };
}

function parseTraf(
  file: Uint8Array,
  trafStart: number,
  trafEnd: number,
  moofStart: number,
): ParsedTraf {
  const r = new Reader(file);
  r.seek(trafStart);
  let trackId = 0;
  let baseMediaDecodeTime = 0;
  let trunBox: { payloadStart: number; end: number } | undefined;
  for (const b of boxes(r, trafEnd)) {
    if (b.type === 'tfhd') {
      r.seek(b.payloadStart);
      r.skip(4); // version+flags (we always emit default-base-is-moof with no optional fields)
      trackId = r.u32();
    } else if (b.type === 'tfdt') {
      r.seek(b.payloadStart);
      const version = r.u8();
      r.skip(3); // flags
      baseMediaDecodeTime = version === 1 ? r.u64() : r.u32();
    } else if (b.type === 'trun') {
      trunBox = { payloadStart: b.payloadStart, end: b.end };
    }
  }
  if (!trunBox) throw new Error('traf has no trun');

  // Parse trun (the writer never sets first-sample-flags 0x000004, so there is no leading flags field).
  r.seek(trunBox.payloadStart);
  const version = r.u8();
  const flags = r.u24();
  const sampleCount = r.u32();
  const hasDataOffset = (flags & 0x000001) !== 0;
  const dataOffset = hasDataOffset ? r.i32() : 0;
  const hasDuration = (flags & 0x000100) !== 0;
  const hasSize = (flags & 0x000200) !== 0;
  const hasFlags = (flags & 0x000400) !== 0;
  const hasCto = (flags & 0x000800) !== 0;

  const samples: ParsedSample[] = [];
  // data_offset is relative to the moof start (default-base-is-moof); follow it into the file.
  let dataPos = moofStart + dataOffset;
  for (let i = 0; i < sampleCount; i++) {
    const durationTicks = hasDuration ? r.u32() : 0;
    const size = hasSize ? r.u32() : 0;
    const sFlags = hasFlags ? r.u32() : 0;
    const cttsTicks = hasCto ? (version === 1 ? r.i32() : r.u32()) : 0;
    const data = file.subarray(dataPos, dataPos + size).slice();
    dataPos += size;
    samples.push({ size, durationTicks, cttsTicks, keyframe: !isNonSync(sFlags), data });
  }
  return { trackId, baseMediaDecodeTime, samples };
}

/** Re-scan a full fragmented file into its ordered media segments (skipping the init ftyp/moov). */
function scanSegments(file: Uint8Array): ParsedSegment[] {
  const top = topLevelBoxes(file);
  const out: ParsedSegment[] = [];
  for (const b of top) {
    if (b.type === 'moof') out.push(parseSegment(file, b.start, b.end));
  }
  return out;
}

/** Collect all samples for a given 1-based trackId across every segment, in segment order. */
function samplesForTrack(segments: readonly ParsedSegment[], trackId: number): ParsedSample[] {
  const out: ParsedSample[] = [];
  for (const seg of segments) {
    for (const traf of seg.trafs) {
      if (traf.trackId === trackId) out.push(...traf.samples);
    }
  }
  return out;
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────

describe('planFragmentRuns — keyframe + cap partitioning (pure)', () => {
  it('splits at each keyframe (the CMAF decodable-segment rule)', () => {
    const samples = [
      sample(10, 0, true, 5, 1),
      sample(10, 0, false, 5, 2),
      sample(10, 0, false, 5, 3),
      sample(10, 0, true, 5, 4),
      sample(10, 0, false, 5, 5),
    ];
    const runs = planFragmentRuns(samples, 90);
    expect(runs.map((r) => r.length)).toEqual([3, 2]);
    expect(runs[0]?.[0]?.keyframe).toBe(true);
    expect(runs[1]?.[0]?.keyframe).toBe(true);
  });

  it('forces a new run once the per-fragment cap is hit even without a keyframe', () => {
    const samples = Array.from({ length: 5 }, (_, i) => sample(10, 0, i === 0, 4, i + 1));
    const runs = planFragmentRuns(samples, 2);
    // [kf,delta] | [delta,delta] | [delta] — caps at 2, first run starts at the keyframe.
    expect(runs.map((r) => r.length)).toEqual([2, 2, 1]);
  });

  it('covers every sample exactly once (no drop/dup)', () => {
    const samples = Array.from({ length: 17 }, (_, i) => sample(10, 0, i % 4 === 0, 3, i + 1));
    const runs = planFragmentRuns(samples, 3);
    expect(runs.flat().length).toBe(17);
    expect(runs.flat().map((s) => s.data[0])).toEqual(samples.map((s) => s.data[0]));
  });

  it('empty input → no runs', () => {
    expect(planFragmentRuns([], 90)).toEqual([]);
  });
});

describe('fragmentMp4 — init segment structure', () => {
  it('emits ftyp + moov first; the empty-trak moov re-parses with mvex/trex per track', async () => {
    const segs = [...fragmentMp4([videoTrack([sample(1000, 0, true, 10, 1)])])];
    const init = segs[0];
    expect(init).toBeDefined();
    if (!init) return;

    const top = topLevelBoxes(init);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov']);

    // The init moov parses as a real movie (track codec/geometry recoverable from the empty-table trak).
    const movie = await readMovie(ra(init));
    expect(movie.tracks).toHaveLength(1);
    expect(movie.tracks[0]?.mediaType).toBe('video');
    expect(movie.tracks[0]?.codec).toBe('avc1.42C01E');
    expect(movie.tracks[0]?.width).toBe(64);
    expect(movie.tracks[0]?.height).toBe(48);
    // Fragmented ⇒ the moov sample tables are empty (no samples buffered in the init segment).
    expect(movie.tracks[0]?.samples.sampleSizes).toEqual([]);

    // mvex/trex are present (one trex per track).
    const moovBox = top.find((b) => b.type === 'moov');
    expect(moovBox).toBeDefined();
    if (!moovBox) return;
    const moovScan = new Reader(init);
    moovScan.seek(moovBox.start + 8);
    const mvexBox = [...boxes(moovScan, moovBox.end)].find((b) => b.type === 'mvex');
    expect(mvexBox).toBeDefined();
    if (!mvexBox) return;
    const mvexScan = new Reader(init);
    mvexScan.seek(mvexBox.payloadStart);
    const trexCount = [...boxes(mvexScan, mvexBox.end)].filter((b) => b.type === 'trex').length;
    expect(trexCount).toBe(1);
  });
});

describe('fragmentMp4 — audio segment planning', () => {
  it('groups audio sync packets by cap instead of splitting every packet', () => {
    const audio = audioTrack(
      Array.from({ length: 200 }, (_, i) => sample(1024, 0, true, 4, i + 1)),
    );
    const file = concat([...fragmentMp4([audio], { maxSamplesPerFragment: 90 })]);
    const segments = scanSegments(file);

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => samplesForTrack([segment], 1).length)).toEqual([90, 90, 20]);
  });
});

describe('fragmentMp4 — single video track round-trip', () => {
  it('reconstructs sizes/durations/keyframes/ctts/bytes from moof+mdat fragments', () => {
    // I,P,B,B then a second GOP I,P — splits into two fragments at the second keyframe.
    const samples = [
      sample(1000, 0, true, 120, 0x10),
      sample(1000, 2000, false, 40, 0x11),
      sample(1000, -1000, false, 55, 0x12),
      sample(1000, -1000, false, 33, 0x13),
      sample(1000, 0, true, 80, 0x14),
      sample(1000, 0, false, 22, 0x15),
    ];
    const file = concat([...fragmentMp4([videoTrack(samples)])]);

    const segments = scanSegments(file);
    expect(segments.length).toBe(2); // one moof+mdat per GOP
    expect(segments.map((s) => s.sequenceNumber)).toEqual([1, 2]);

    const got = samplesForTrack(segments, 1);
    expect(got.length).toBe(samples.length);
    expect(got.map((s) => s.size)).toEqual([120, 40, 55, 33, 80, 22]);
    expect(got.map((s) => s.durationTicks)).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    expect(got.map((s) => s.cttsTicks)).toEqual([0, 2000, -1000, -1000, 0, 0]);
    expect(got.map((s) => s.keyframe)).toEqual([true, false, false, false, true, false]);
    // The bytes themselves round-trip (proves the trun data_offset addresses the right mdat region).
    got.forEach((s, i) => {
      expect([...s.data]).toEqual([...(samples[i]?.data ?? new Uint8Array())]);
    });
  });

  it('tfdt baseMediaDecodeTime is monotonic across the track fragments (= cumulative DTS)', () => {
    const samples = [
      sample(1000, 0, true, 10, 1),
      sample(1500, 0, false, 10, 2),
      sample(1000, 0, true, 10, 3), // new GOP → new fragment; base should be 1000+1500 = 2500
      sample(2000, 0, false, 10, 4),
    ];
    const file = concat([...fragmentMp4([videoTrack(samples)])]);
    const segments = scanSegments(file);
    const bases = segments.flatMap((s) => s.trafs.map((t) => t.baseMediaDecodeTime));
    expect(bases).toEqual([0, 2500]);
    // Monotonic non-decreasing.
    for (let i = 1; i < bases.length; i++) {
      expect(bases[i] ?? 0).toBeGreaterThanOrEqual(bases[i - 1] ?? 0);
    }
  });

  it('respects maxSamplesPerFragment when there are no extra keyframes', () => {
    const samples = Array.from({ length: 7 }, (_, i) => sample(1000, 0, i === 0, 8, i + 1));
    const file = concat([...fragmentMp4([videoTrack(samples)], { maxSamplesPerFragment: 3 })]);
    const segments = scanSegments(file);
    expect(segments.map((s) => s.trafs[0]?.samples.length)).toEqual([3, 3, 1]);
    expect(samplesForTrack(segments, 1).length).toBe(7);
  });
});

describe('fragmentMp4 — multitrack (video + audio) interleave', () => {
  it('packs both tracks per moof and reconstructs each track independently', () => {
    const video = videoTrack([
      sample(1000, 0, true, 100, 0x20),
      sample(1000, 0, false, 30, 0x21),
      sample(1000, 0, true, 90, 0x22),
      sample(1000, 0, false, 20, 0x23),
    ]);
    const audio = audioTrack([
      sample(1024, 0, true, 17, 0x30),
      sample(1024, 0, true, 18, 0x31),
      sample(1024, 0, true, 16, 0x32),
    ]);
    const file = concat([...fragmentMp4([video, audio])]);

    const segments = scanSegments(file);
    // Each media segment's moof may carry up to one traf per track.
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const seg of segments) {
      const ids = seg.trafs.map((t) => t.trackId);
      expect(new Set(ids).size).toBe(ids.length); // at most one traf per track per moof
    }

    const v = samplesForTrack(segments, 1);
    const a = samplesForTrack(segments, 2);
    expect(v.map((s) => s.size)).toEqual([100, 30, 90, 20]);
    expect(a.map((s) => s.size)).toEqual([17, 18, 16]);
    // Bytes round-trip for both tracks (shared mdat, separate data_offsets). Bind the expected source
    // samples explicitly (no non-null assertions) so the byte comparison stays a strict, can-fail oracle.
    const vSrc0 = video.samples[0];
    const aSrc2 = audio.samples[2];
    expect(vSrc0).toBeDefined();
    expect(aSrc2).toBeDefined();
    expect([...(v[0]?.data ?? [])]).toEqual([...(vSrc0?.data ?? [])]);
    expect([...(a[2]?.data ?? [])]).toEqual([...(aSrc2?.data ?? [])]);
    // Audio tfdt advances by 1024 ticks each fragment it appears in.
    const audioBases = segments
      .flatMap((s) => s.trafs.filter((t) => t.trackId === 2))
      .map((t) => t.baseMediaDecodeTime);
    for (let i = 1; i < audioBases.length; i++) {
      expect(audioBases[i] ?? 0).toBeGreaterThan(audioBases[i - 1] ?? 0);
    }
  });
});

describe('buildMediaSegment — data_offset addresses the shared mdat correctly', () => {
  it('a single moof with two trafs slices each track from the right mdat region', () => {
    const seg = buildMediaSegment(7, [
      { trackId: 1, samples: [sample(10, 0, true, 4, 0xa1)], baseDecodeTime: 0 },
      { trackId: 2, samples: [sample(10, 0, true, 6, 0xb2)], baseDecodeTime: 0 },
    ]);
    const parsed = parseSegment(seg, 0, seg.byteLength);
    expect(parsed.sequenceNumber).toBe(7);
    expect(parsed.trafs.map((t) => t.trackId)).toEqual([1, 2]);
    expect([...(parsed.trafs[0]?.samples[0]?.data ?? [])]).toEqual([0xa1, 0xa1, 0xa1, 0xa1]);
    expect([...(parsed.trafs[1]?.samples[0]?.data ?? [])]).toEqual([
      0xb2, 0xb2, 0xb2, 0xb2, 0xb2, 0xb2,
    ]);
  });
});

describe('fragmentMp4 — typed misuse', () => {
  it('no tracks → mux-error', () => {
    expect(() => [...fragmentMp4([])]).toThrowError(/no tracks/);
  });

  it('a track with no samples → mux-error', () => {
    expect(() => [...fragmentMp4([videoTrack([])])]).toThrowError(/no samples/);
  });
});

// ── real-media hardening: re-fragment actual corpus MP4s to CMAF, re-parse, assert faithful ───────

/**
 * Project a parsed real track + its sample table into a {@link FragmentTrackInput}: carry the verbatim
 * codec-config box (`avcC`/`esds`, etc.) so the init `stsd` is byte-correct, and copy each sample's real
 * bytes (sliced from the source file by the index's offset/size) into the fragment input — exactly the
 * lossless stream-copy shape `mp4-driver.ts` builds for `remux`, but driven here for the CMAF writer.
 */
function trackToFragmentInput(file: Uint8Array, track: ParsedTrack): FragmentTrackInput {
  const sd = buildSampleData(track);
  const samples: MuxSampleInput[] = sd.map((s) => ({
    data: file.subarray(s.offset, s.offset + s.size).slice(),
    durationTicks: s.durationTicks,
    cttsTicks: s.cttsTicks,
    keyframe: s.keyframe,
  }));
  const meta: MuxTrackInput = {
    mediaType: track.mediaType,
    sampleEntryType: track.sampleEntryType,
    timescale: track.timescale,
    samples,
    ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}),
    ...(track.width !== undefined ? { width: track.width } : {}),
    ...(track.height !== undefined ? { height: track.height } : {}),
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.channels !== undefined ? { channels: track.channels } : {}),
  };
  return meta;
}

/** Read a corpus MP4 from the verified cache and parse its movie (random access over the in-memory buffer). */
async function readCorpusMovie(id: string): Promise<{ file: Uint8Array; movie: Movie }> {
  const file = await loadFixture(id);
  const movie = await readMovie(ra(file));
  return { file, movie };
}

// Diverse real, non-fragmented MP4s: tiny→720p, single+multitrack, AAC/MP3 audio, rotation, B-frames.
const REAL_MP4S = [
  'movie_5.mp4', // h264 + aac, multitrack, faststart, short
  'test.mp4', // h264 + aac, larger
  'bear-1280x720.mp4', // 720p h264 + aac
  'bear-rotate-90.mp4', // rotation metadata
  'h264.mp4', // small h264
] as const;

describe('fragmentMp4 — real corpus MP4 → CMAF → re-parse (sample-faithful)', () => {
  for (const id of REAL_MP4S) {
    it(`${id}: fragments to a valid CMAF stream whose samples match the source exactly`, async () => {
      const { file, movie } = await readCorpusMovie(id);
      expect(movie.tracks.length).toBeGreaterThan(0);

      // Source-of-truth sample tables (container-native ticks), per track, straight from the real index.
      const sourceByTrack = new Map<number, SampleData[]>();
      const inputs: FragmentTrackInput[] = movie.tracks.map((t, i) => {
        sourceByTrack.set(i + 1, buildSampleData(t)); // fragmenter assigns trackId = position + 1
        return trackToFragmentInput(file, t);
      });

      const out = concat([...fragmentMp4(inputs)]);

      // (a) Structurally valid: ftyp + moov init, then ≥1 moof+mdat; the init moov re-parses as a movie
      //     with the same track count/codecs/geometry but EMPTY sample tables (samples live in fragments).
      const top = topLevelBoxes(out);
      expect(top[0]?.type).toBe('ftyp');
      expect(top[1]?.type).toBe('moov');
      const moofCount = top.filter((b) => b.type === 'moof').length;
      const mdatCount = top.filter((b) => b.type === 'mdat').length;
      expect(moofCount).toBeGreaterThan(0);
      expect(mdatCount).toBe(moofCount); // one mdat per moof

      const initEnd = top[1]?.end ?? out.byteLength;
      const initMovie = await readMovie(ra(out.subarray(0, initEnd)));
      expect(initMovie.tracks.length).toBe(movie.tracks.length);
      initMovie.tracks.forEach((it, i) => {
        expect(it.codec).toBe(movie.tracks[i]?.codec);
        expect(it.samples.sampleSizes).toEqual([]); // fragmented ⇒ no samples in the init moov
      });

      // (b) Sample-faithful: every track's fragmented samples reconstruct the source table exactly —
      //     count, sizes, durations, composition offsets, keyframe flags, AND the raw sample bytes.
      const segments = scanSegments(out);
      for (const [trackId, sourceSamples] of sourceByTrack) {
        const got = samplesForTrack(segments, trackId);
        expect(got.length).toBe(sourceSamples.length);
        expect(got.map((s) => s.size)).toEqual(sourceSamples.map((s) => s.size));
        expect(got.map((s) => s.durationTicks)).toEqual(sourceSamples.map((s) => s.durationTicks));
        expect(got.map((s) => s.cttsTicks)).toEqual(sourceSamples.map((s) => s.cttsTicks));
        expect(got.map((s) => s.keyframe)).toEqual(sourceSamples.map((s) => s.keyframe));

        // Byte-identity on the first, a middle, and the last sample (proves the trun data_offset
        // addresses the right mdat region; the full table above already proved sizes line up).
        const probeIdx = [0, sourceSamples.length >> 1, sourceSamples.length - 1].filter(
          (n, k, a) => n >= 0 && a.indexOf(n) === k,
        );
        for (const idx of probeIdx) {
          const src = sourceSamples[idx];
          const dst = got[idx];
          expect(src).toBeDefined();
          expect(dst).toBeDefined();
          if (!src || !dst) continue;
          const expected = file.subarray(src.offset, src.offset + src.size);
          expect([...(dst.data ?? new Uint8Array())]).toEqual([...expected]);
        }
      }

      // (c) Per-track tfdt baseMediaDecodeTime is monotonic non-decreasing across that track's fragments
      //     and starts at 0 (the running DTS sum).
      for (const trackId of sourceByTrack.keys()) {
        const bases = segments
          .flatMap((s) => s.trafs.filter((t) => t.trackId === trackId))
          .map((t) => t.baseMediaDecodeTime);
        expect(bases[0]).toBe(0);
        for (let i = 1; i < bases.length; i++) {
          expect(bases[i] ?? 0).toBeGreaterThanOrEqual(bases[i - 1] ?? 0);
        }
      }
    });
  }

  it('every real video fragment begins at a keyframe (CMAF decodable-segment rule)', async () => {
    const { file, movie } = await readCorpusMovie('test.mp4');
    const inputs = movie.tracks.map((t) => trackToFragmentInput(file, t));
    const out = concat([...fragmentMp4(inputs)]);
    const segments = scanSegments(out);

    // For each video track, the first sample of every fragment that the track appears in must be sync.
    const videoTrackIds = movie.tracks.flatMap((t, i) => (t.mediaType === 'video' ? [i + 1] : []));
    expect(videoTrackIds.length).toBeGreaterThan(0);
    for (const trackId of videoTrackIds) {
      for (const seg of segments) {
        for (const traf of seg.trafs) {
          if (traf.trackId !== trackId) continue;
          expect(traf.samples[0]?.keyframe).toBe(true);
        }
      }
    }
  });
});
