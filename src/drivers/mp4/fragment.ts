/**
 * Fragmented-MP4 / CMAF writer (ISO/IEC 14496-12 §8.8) — the streaming counterpart of {@link writeMp4}.
 *
 * A non-fragmented MP4 must buffer every sample so the `moov` sample tables can name absolute byte
 * offsets; that defeats a streaming target. A fragmented MP4 instead emits a small **init segment**
 * (`ftyp` + a `moov` whose `trak`s are empty and whose `mvex`/`trex` declare the tracks) once, then a
 * sequence of self-describing **media segments** (`moof` + `mdat`), each carrying its own timing in a
 * `tfdt`/`trun`. Nothing downstream of a segment depends on a later segment, so segments can be written
 * out and dropped as they are produced — peak memory stays bounded to one fragment (the whole point of
 * the streaming target, doc 09 streaming-output).
 *
 * Pure TS box-writing — the helper STYLE mirrors {@link writeMp4} but lives here (this module owns no
 * shared mutable state and never edits write.ts). {@link fragmentMp4} is a generator that yields the
 * init segment then one media segment at a time; round-trip validated by re-scanning `moof`/`mdat` back
 * into the sample list (fragment.test.ts), with the init `moov` re-parsed by the demuxer.
 */

import { MediaError } from '../../contracts/errors.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';

export type FragmentInitTrackInput = Omit<MuxTrackInput, 'samples'>;

// ── byte/box helpers (same encoding as write.ts; kept local so this file edits nothing shared) ──────

const u8 = (n: number): number[] => [n & 0xff];
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u24 = (n: number): number[] => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
/** 64-bit unsigned big-endian (split through 2^32; `tfdt` v1 baseMediaDecodeTime). */
const u64 = (n: number): number[] => {
  const hi = Math.floor(n / 2 ** 32);
  const lo = n >>> 0;
  return [...u32(hi), ...u32(lo)];
};
const fourcc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const cat = (...parts: number[][]): number[] => parts.flat();

function box(type: string, payload: number[]): number[] {
  return cat(u32(8 + payload.length), fourcc(type), payload);
}
function full(type: string, version: number, flags: number, payload: number[]): number[] {
  return box(type, cat(u8(version), u24(flags), payload));
}

const IDENTITY_MATRIX = cat(
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

// `trun` is the only box here whose per-sample arrays can run long (one segment = up to a GOP of
// samples). Build it by pushing bytes — never `cat(...vals.map(u32))`, whose spread overflows the call
// stack at large rungs (the same hazard write.ts documents for stsz). Bytes are identical either way.
function pushU32(out: number[], n: number): void {
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
function pushS32(out: number[], n: number): void {
  pushU32(out, n | 0);
}

// ── codec-config + sample-entry boxes (encode-path synthesis or verbatim raw box, like write.ts) ────

/** Build an `esds` box wrapping an AudioSpecificConfig (reverse of the demuxer's `parseEsds`). */
function esdsBox(asc: Uint8Array): number[] {
  const dsi = cat([0x05, asc.byteLength], [...asc]);
  const dcdPayload = cat([0x40, 0x15], u24(0), u32(0), u32(0), dsi);
  const dcd = cat([0x04, dcdPayload.length], dcdPayload);
  const esPayload = cat(u16(0), u8(0), dcd);
  const es = cat([0x03, esPayload.length], esPayload);
  return full('esds', 0, 0, es);
}

/** The codec-config box: the preserved raw box (lossless), a synthesized `avcC`/`esds`, or nothing. */
function codecConfigBox(track: FragmentInitTrackInput): number[] {
  if (track.codecPrivate) return box(track.codecPrivate.boxType, [...track.codecPrivate.data]);
  if (track.mediaType === 'video' && track.description) return box('avcC', [...track.description]);
  if (track.mediaType === 'audio' && track.description) return esdsBox(track.description);
  return [];
}

function videoSampleEntry(track: FragmentInitTrackInput): number[] {
  return box(
    track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(16), // pre_defined + reserved + pre_defined[3]
      u16(track.width ?? 0),
      u16(track.height ?? 0),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1), // resolutions + reserved + frame_count
      zeros(32),
      u16(0x0018),
      u16(0xffff), // compressorname + depth + pre_defined
      codecConfigBox(track),
    ),
  );
}

function audioSampleEntry(track: FragmentInitTrackInput): number[] {
  return box(
    track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(8), // reserved
      u16(track.channels ?? 2),
      u16(16),
      zeros(4), // samplesize + pre_defined + reserved
      u32((track.sampleRate ?? 48000) * 65536), // 16.16 fixed
      codecConfigBox(track),
    ),
  );
}

function sampleEntry(track: FragmentInitTrackInput): number[] {
  return track.mediaType === 'video' ? videoSampleEntry(track) : audioSampleEntry(track);
}

// ── init segment (ftyp + moov with empty trak + mvex/trex) ──────────────────────────────────────

function ftypBox(): number[] {
  // `iso5`/`cmfc` advertise CMAF; `isom`/`iso6` cover the generic fragmented-MP4 brand set.
  return box(
    'ftyp',
    cat(fourcc('iso5'), u32(0x200), fourcc('iso5'), fourcc('iso6'), fourcc('cmfc'), fourcc('isom')),
  );
}

/** An empty `stbl`: the sample entry (in `stsd`) plus zero-count `stts`/`stsc`/`stsz`/`stco`. */
function emptyStbl(track: FragmentInitTrackInput): number[] {
  return box(
    'stbl',
    cat(
      full('stsd', 0, 0, cat(u32(1), sampleEntry(track))),
      full('stts', 0, 0, u32(0)),
      full('stsc', 0, 0, u32(0)),
      full('stsz', 0, 0, cat(u32(0), u32(0))),
      full('stco', 0, 0, u32(0)),
    ),
  );
}

/** An empty (fragmented) `trak`: real codec/geometry in `stsd`, but zero samples in the tables. */
function emptyTrak(track: FragmentInitTrackInput, trackId: number): number[] {
  const isVideo = track.mediaType === 'video';
  const tkhd = full(
    'tkhd',
    0,
    0x000007,
    cat(
      zeros(8),
      u32(trackId),
      zeros(4),
      u32(0), // duration 0 — the movie is fragmented (real duration lives in the fragments)
      zeros(8),
      u16(0),
      u16(0),
      u16(isVideo ? 0 : 0x0100),
      u16(0), // layer + altgroup + volume + reserved
      IDENTITY_MATRIX,
      u32((track.width ?? 0) * 65536),
      u32((track.height ?? 0) * 65536),
    ),
  );
  const mdhd = full('mdhd', 0, 0, cat(zeros(8), u32(track.timescale), u32(0), u16(0x55c4), u16(0)));
  const hdlr = full(
    'hdlr',
    0,
    0,
    cat(zeros(4), fourcc(isVideo ? 'vide' : 'soun'), zeros(12), u8(0)),
  );
  const mediaHeader = isVideo
    ? full('vmhd', 0, 1, cat(u16(0), zeros(6)))
    : full('smhd', 0, 0, cat(u16(0), u16(0)));
  const dref = full('dref', 0, 0, cat(u32(1), full('url ', 0, 1, [])));
  const minf = box('minf', cat(mediaHeader, box('dinf', dref), emptyStbl(track)));
  const mdia = box('mdia', cat(mdhd, hdlr, minf));
  return box('trak', cat(tkhd, mdia));
}

/** `trex`: per-track defaults for fragments. All zero — each `trun` carries its own per-sample values. */
function trexBox(trackId: number): number[] {
  return full(
    'trex',
    0,
    0,
    cat(
      u32(trackId),
      u32(1), // default_sample_description_index (1-based, the single stsd entry)
      u32(0), // default_sample_duration
      u32(0), // default_sample_size
      u32(0), // default_sample_flags
    ),
  );
}

function mvexBox(trackCount: number): number[] {
  const trexs = Array.from({ length: trackCount }, (_, i) => trexBox(i + 1)).flat();
  return box('mvex', trexs);
}

function initMoov(tracks: readonly FragmentInitTrackInput[], movieTimescale: number): number[] {
  const mvhd = full(
    'mvhd',
    0,
    0,
    cat(
      zeros(8),
      u32(movieTimescale),
      u32(0), // duration 0 — fragmented movie
      u32(0x00010000),
      u16(0x0100),
      zeros(10), // rate + volume + reserved
      IDENTITY_MATRIX,
      zeros(24), // pre_defined
      u32(tracks.length + 1), // next_track_id
    ),
  );
  const traks = tracks.flatMap((t, i) => emptyTrak(t, i + 1));
  return box('moov', cat(mvhd, traks, mvexBox(tracks.length)));
}

/** Build the fragmented MP4 initialization segment (`ftyp` + empty `moov`) without sample payloads. */
export function fragmentMp4InitSegment(
  tracks: readonly FragmentInitTrackInput[],
  opts: Pick<FragmentOptions, 'movieTimescale'> = {},
): Uint8Array {
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot fragment a movie with no tracks');
  }
  const movieTimescale = opts.movieTimescale ?? 1000;
  return Uint8Array.from(cat(ftypBox(), initMoov(tracks, movieTimescale)));
}

// ── media segments (moof + mdat) ────────────────────────────────────────────────────────────────

/** `trun` sample flags: build a 32-bit flags word marking a non-sync (depended-on) sample. */
function sampleFlags(keyframe: boolean): number {
  // ISO/IEC 14496-12 §8.8.3.1: bit `sample_is_non_sync_sample` (0x00010000); for non-keyframes also set
  // `sample_depends_on = 1` (0x01000000) — "this sample depends on others" — so players treat deltas
  // correctly. Keyframes: sync (clear the non-sync bit) + `sample_depends_on = 2` ("depends on nothing").
  return keyframe ? 0x02000000 : 0x01010000;
}

const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

/** Whether any sample in this run carries a non-zero composition offset (⇒ emit + need v1 for negatives). */
function runUsesCto(samples: readonly MuxSampleInput[]): { used: boolean; signed: boolean } {
  let used = false;
  let signed = false;
  for (const s of samples) {
    if (s.cttsTicks !== 0) used = true;
    if (s.cttsTicks < 0) signed = true;
  }
  return { used, signed };
}

/**
 * A `traf` for one track's run of samples in this segment. `tfdt` carries the run's first-sample DTS
 * (`baseMediaDecodeTime`, monotonic per track across segments); `trun` carries each sample's duration,
 * size, flags, and (when any sample is reordered) composition-time offset. The data-offset is patched in
 * by the caller once the surrounding `moof` length is known (it must point at the `mdat` payload).
 */
interface TrafResult {
  bytes: number[];
  /** Byte index, within `bytes`, of the `trun` data_offset field (s32) to patch. */
  dataOffsetPos: number;
}

function buildTraf(
  trackId: number,
  samples: readonly MuxSampleInput[],
  baseDecodeTime: number,
): TrafResult {
  const tfhd = full(
    'tfhd',
    0,
    TFHD_DEFAULT_BASE_IS_MOOF,
    u32(trackId), // no optional fields — defaults come from trex, per-sample values from trun
  );
  const tfdt = full('tfdt', 1, 0, u64(baseDecodeTime));

  const { used: useCto, signed } = runUsesCto(samples);
  let flags = TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS;
  if (useCto) flags |= TRUN_SAMPLE_CTO;
  const version = signed ? 1 : 0;

  // Build the trun payload (after version/flags): sample_count, data_offset(placeholder), then per-sample
  // [duration, size, flags, (cto)]. The data_offset is fixed-width s32, so its position is known now.
  const payload: number[] = [];
  pushU32(payload, samples.length);
  const dataOffsetPayloadPos = payload.length;
  pushS32(payload, 0); // placeholder; patched once the moof size is known
  for (const s of samples) {
    pushU32(payload, s.durationTicks);
    pushU32(payload, s.data.byteLength);
    pushU32(payload, sampleFlags(s.keyframe));
    if (useCto) pushS32(payload, s.cttsTicks);
  }
  const trun = full('trun', version, flags, payload);

  const trafChildren = cat(tfhd, tfdt, trun);
  const traf = box('traf', trafChildren);

  // data_offset position inside `traf`: 8 (traf hdr) + tfhd.len + tfdt.len + [8 trun hdr + 4 ver/flags]
  // + 4 (sample_count) → then the placeholder. Compute from the actual emitted lengths.
  const trunStart = 8 + tfhd.length + tfdt.length;
  const dataOffsetPos = trunStart + 12 + dataOffsetPayloadPos;
  return { bytes: traf, dataOffsetPos };
}

/** Per-track run within one media segment. */
export interface SegmentTrackRun {
  trackId: number;
  samples: readonly MuxSampleInput[];
  baseDecodeTime: number;
}

/** Patch a fixed-width s32 in-place inside a byte array (big-endian). */
function patchS32(bytes: number[], pos: number, value: number): void {
  const v = value | 0;
  bytes[pos] = (v >>> 24) & 0xff;
  bytes[pos + 1] = (v >>> 16) & 0xff;
  bytes[pos + 2] = (v >>> 8) & 0xff;
  bytes[pos + 3] = v & 0xff;
}

/**
 * Build one media segment (`moof` + `mdat`) for the given per-track runs, as a single contiguous
 * `Uint8Array`. The `moof`'s per-`traf` `trun` data-offsets are patched to point at each track's bytes
 * inside the shared `mdat` payload (default-base-is-moof ⇒ offsets are relative to the `moof` start).
 */
export function buildMediaSegment(
  sequenceNumber: number,
  runs: readonly SegmentTrackRun[],
): Uint8Array {
  const mfhd = full('mfhd', 0, 0, u32(sequenceNumber));

  // Build each traf; its `data_offset` placeholder is patched once the moof + mdat layout is known.
  const trafs = runs.map((run) => buildTraf(run.trackId, run.samples, run.baseDecodeTime));

  const moofPayloadLen = mfhd.length + trafs.reduce((a, t) => a + t.bytes.length, 0);
  const moofLen = 8 + moofPayloadLen; // + box header

  // mdat payload = each run's samples in run order; the box header is 8 bytes. A sample's absolute byte
  // position (from the moof start) is moofLen + 8 (mdat hdr) + its offset within the concatenated payload.
  let mdatPayloadLen = 0;
  const runDataStart: number[] = [];
  for (const run of runs) {
    runDataStart.push(mdatPayloadLen);
    for (const s of run.samples) mdatPayloadLen += s.data.byteLength;
  }
  const mdatPayloadBase = moofLen + 8; // first mdat payload byte, relative to the moof start

  // Patch each traf's data_offset (within its own bytes) to the absolute offset of its first sample.
  trafs.forEach((t, i) => {
    patchS32(t.bytes, t.dataOffsetPos, mdatPayloadBase + (runDataStart[i] ?? 0));
  });

  const moof = box('moof', cat(mfhd, ...trafs.map((t) => t.bytes)));
  const mdatHeader = cat(u32(8 + mdatPayloadLen), fourcc('mdat'));

  const out = new Uint8Array(moof.length + mdatHeader.length + mdatPayloadLen);
  out.set(moof, 0);
  let p = moof.length;
  out.set(mdatHeader, p);
  p += mdatHeader.length;
  for (const run of runs) {
    for (const s of run.samples) {
      out.set(s.data, p);
      p += s.data.byteLength;
    }
  }
  return out;
}

// ── segmentation + the streaming generator ────────────────────────────────────────────────────────

export interface FragmentOptions {
  movieTimescale?: number;
  /**
   * Maximum samples per fragment (per track) before a new segment is forced. A video track also splits
   * at every keyframe (so each segment is independently decodable, the CMAF rule). Default 90.
   */
  maxSamplesPerFragment?: number;
}

/**
 * Partition a track's samples into fragment runs. A new run starts at a keyframe (so a video segment
 * begins decodable) or once the running run reaches `maxSamples`; the first run always starts at index
 * 0. The returned runs are contiguous and cover every sample exactly once (no drop/dup).
 */
export function planFragmentRuns(
  samples: readonly MuxSampleInput[],
  maxSamples: number,
): MuxSampleInput[][] {
  if (samples.length === 0) return [];
  const runs: MuxSampleInput[][] = [];
  let current: MuxSampleInput[] = [];
  for (const s of samples) {
    // Start a fresh run at a keyframe boundary (except the very first sample) or when the cap is hit.
    if (current.length > 0 && (s.keyframe || current.length >= maxSamples)) {
      runs.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** A fragmentation-ready track: the same metadata {@link writeMp4} consumes, plus its ordered samples. */
export type FragmentTrackInput = MuxTrackInput;

function assertTracks(tracks: readonly FragmentTrackInput[]): void {
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot fragment a movie with no tracks');
  }
  for (const [i, t] of tracks.entries()) {
    if (t.samples.length === 0) {
      throw new MediaError('mux-error', `track ${i + 1} has no samples to fragment`);
    }
  }
}

/**
 * Stream a fragmented MP4 as a sequence of segments: first the **init segment** (`ftyp` + `moov`), then
 * one **media segment** (`moof` + `mdat`) per fragment. Yielding incrementally keeps peak memory bounded
 * to a single fragment (the streaming-target guarantee).
 *
 * Multi-track movies interleave one `moof` per fragment-step: each step takes the next run from every
 * track (so audio + video advance together) and packs all their `traf`s into one `moof` + shared `mdat`.
 * Per-track `tfdt` baseMediaDecodeTime is the running DTS sum (monotonic), and `trun` carries each
 * sample's duration/size/flags/composition-offset, so a re-scan of the fragments reconstructs the exact
 * sample list.
 */
export function* fragmentMp4(
  tracks: readonly FragmentTrackInput[],
  opts: FragmentOptions = {},
): Generator<Uint8Array, void, undefined> {
  assertTracks(tracks);
  const movieTimescale = opts.movieTimescale ?? 1000;
  const maxSamples = Math.max(1, opts.maxSamplesPerFragment ?? 90);

  // 1) Init segment: ftyp + moov (empty traks + mvex/trex). `ftyp` then `moov` are emitted as one chunk
  //    so a consumer that splits on top-level boxes still sees a complete initialization segment first.
  yield fragmentMp4InitSegment(tracks, { movieTimescale });

  // 2) Plan each track's fragment runs, then walk them in lockstep so audio + video advance together and
  //    every fragment-step produces ONE moof (one traf per track that still has a run) + a shared mdat.
  //    Per-track DTS accumulates across segments → `tfdt` baseMediaDecodeTime is monotonic per track.
  const plans = tracks.map((t) => planFragmentRuns(t.samples, maxSamples));
  const cursors = new Array<number>(tracks.length).fill(0);
  const baseDts = new Array<number>(tracks.length).fill(0);
  const maxRuns = plans.reduce((m, p) => Math.max(m, p.length), 0);

  let sequenceNumber = 1;
  for (let step = 0; step < maxRuns; step++) {
    const runs: SegmentTrackRun[] = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const run = plans[ti]?.[cursors[ti] ?? 0];
      if (run === undefined || run.length === 0) continue;
      cursors[ti] = (cursors[ti] ?? 0) + 1;
      const base = baseDts[ti] ?? 0;
      runs.push({ trackId: ti + 1, samples: run, baseDecodeTime: base });
      // Advance this track's DTS by the run's total duration (decode-order, contiguous).
      let dur = 0;
      for (const s of run) dur += s.durationTicks;
      baseDts[ti] = base + dur;
    }
    if (runs.length === 0) continue;
    yield buildMediaSegment(sequenceNumber, runs);
    sequenceNumber++;
  }
}
