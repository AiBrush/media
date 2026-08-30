/**
 * Fragmented-MP4 (ISO/IEC 14496-12 §8.8, CMAF) per-sample table recovery.
 *
 * A fragmented movie's `moov` sample tables are empty — the real samples live in a sequence of
 * `moof`+`mdat` fragments, each `traf`/`trun` carrying its own per-sample size/duration/flags and a
 * `tfdt` decode-time base. {@link parse.ts} only recovers *aggregate* fragment timing (total duration +
 * sample count) for probe; this module rebuilds the exact **flat per-sample list** — absolute byte
 * offset, size, DTS, duration, composition offset (B-frames), and sync flag — that the demux packet
 * stream needs. Without it, `buildSampleData` sees a zero-length table and the demuxer emits no packets,
 * so decode/convert of a fragmented input yields nothing.
 *
 * Byte-offset resolution follows §8.8.7 exactly: a `tfhd` may pin an explicit `base_data_offset`, request
 * `default-base-is-moof` (base = the enclosing `moof` start), or leave it implicit (first `traf` ⇒ the
 * `moof` start; later `traf`s ⇒ the end of the previous fragment's data). Each `trun`'s `data_offset` is
 * relative to that base; samples within a run are contiguous. Per-sample values fall back
 * `trun` → `tfhd` defaults → `trex` defaults, exactly as the spec layers them. Pure TS, Node-validated
 * against `ffprobe -show_packets` on the real fragmented corpus.
 */

import { MediaError } from '../../contracts/errors.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';
import type { Sample, SampleData } from './samples.ts';

// tfhd (§8.8.7) flags.
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

// trun (§8.8.8) flags.
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

// sample_flags (§8.8.3.1): bit 16 marks a non-sync (non-keyframe) sample.
const SAMPLE_IS_NON_SYNC = 0x00010000;

/** `trex` per-track defaults (the last-resort fallback for each `trun` field). */
interface TrexDefaults {
  readonly sampleDuration: number;
  readonly sampleSize: number;
  readonly sampleFlags: number;
}

/** Iterate the direct children of `box` (its payload span) matching `type`. */
function* childrenOf(r: Reader, box: BoxHeader, type: string): Generator<BoxHeader> {
  r.seek(box.payloadStart);
  for (const child of boxes(r, box.end)) {
    if (child.type === type) yield child;
    r.seek(child.end);
  }
}

/** The first direct child of `box` matching `type`, or undefined. */
function firstChild(r: Reader, box: BoxHeader, type: string): BoxHeader | undefined {
  for (const child of childrenOf(r, box, type)) return child;
  return undefined;
}

/** Parse `mvex`/`trex` from the `moov` into per-track defaults keyed by track id. */
function parseTrexDefaults(r: Reader, moov: BoxHeader): Map<number, TrexDefaults> {
  const out = new Map<number, TrexDefaults>();
  const mvex = firstChild(r, moov, 'mvex');
  if (mvex === undefined) return out;
  for (const trex of childrenOf(r, mvex, 'trex')) {
    r.seek(trex.payloadStart);
    readFullBoxHeader(r);
    const trackId = r.u32();
    r.skip(4); // default_sample_description_index
    const sampleDuration = r.u32();
    const sampleSize = r.u32();
    const sampleFlags = r.u32();
    out.set(trackId, { sampleDuration, sampleSize, sampleFlags });
  }
  return out;
}

/** Parsed `tfhd`: the track id plus every default the run may inherit. */
interface TfhdInfo {
  readonly trackId: number;
  readonly baseDataOffset: number | undefined;
  readonly defaultBaseIsMoof: boolean;
  readonly defaultSampleDuration: number | undefined;
  readonly defaultSampleSize: number | undefined;
  readonly defaultSampleFlags: number | undefined;
}

function parseTfhd(r: Reader, tfhd: BoxHeader): TfhdInfo {
  r.seek(tfhd.payloadStart);
  const { flags } = readFullBoxHeader(r);
  const trackId = r.u32();
  const baseDataOffset = (flags & TFHD_BASE_DATA_OFFSET) !== 0 ? r.u64() : undefined;
  if ((flags & TFHD_SAMPLE_DESCRIPTION_INDEX) !== 0) r.skip(4);
  const defaultSampleDuration = (flags & TFHD_DEFAULT_SAMPLE_DURATION) !== 0 ? r.u32() : undefined;
  const defaultSampleSize = (flags & TFHD_DEFAULT_SAMPLE_SIZE) !== 0 ? r.u32() : undefined;
  const defaultSampleFlags = (flags & TFHD_DEFAULT_SAMPLE_FLAGS) !== 0 ? r.u32() : undefined;
  return {
    trackId,
    baseDataOffset,
    defaultBaseIsMoof: (flags & TFHD_DEFAULT_BASE_IS_MOOF) !== 0,
    defaultSampleDuration,
    defaultSampleSize,
    defaultSampleFlags,
  };
}

/** `tfdt` baseMediaDecodeTime (v1 64-bit / v0 32-bit), or undefined when the box is absent. */
function parseTfdt(r: Reader, traf: BoxHeader): number | undefined {
  const tfdt = firstChild(r, traf, 'tfdt');
  if (tfdt === undefined) return undefined;
  r.seek(tfdt.payloadStart);
  const { version } = readFullBoxHeader(r);
  return version === 1 ? r.u64() : r.u32();
}

/** Running per-track decode-time cursors, so a `traf` without `tfdt` continues the prior fragment. */
type DtsCursors = Map<number, number>;

/**
 * Append one `traf`'s samples to `out`. Returns the byte offset just past this fragment's data (used as
 * the implicit base for a following `traf` that pins neither `base_data_offset` nor default-base-is-moof).
 */
function appendTrafSamples(
  r: Reader,
  traf: BoxHeader,
  moofStart: number,
  firstTrafImplicitBase: number,
  trex: Map<number, TrexDefaults>,
  dtsCursors: DtsCursors,
  out: Map<number, SampleData[]>,
): number {
  const tfhd = firstChild(r, traf, 'tfhd');
  if (tfhd === undefined) return firstTrafImplicitBase;
  const info = parseTfhd(r, tfhd);
  const defaults = trex.get(info.trackId);

  const base = info.baseDataOffset ?? (info.defaultBaseIsMoof ? moofStart : firstTrafImplicitBase);

  const tfdt = parseTfdt(r, traf);
  let dts = tfdt ?? dtsCursors.get(info.trackId) ?? 0;

  let samples = out.get(info.trackId);
  if (samples === undefined) {
    samples = [];
    out.set(info.trackId, samples);
  }

  let runCursor = base; // where the next run's bytes begin when it omits its own data_offset
  let fragmentEnd = base;
  for (const trun of childrenOf(r, traf, 'trun')) {
    r.seek(trun.payloadStart);
    const { version, flags } = readFullBoxHeader(r);
    const count = r.u32();
    const runStart = (flags & TRUN_DATA_OFFSET) !== 0 ? base + r.i32() : runCursor;
    const firstSampleFlags = (flags & TRUN_FIRST_SAMPLE_FLAGS) !== 0 ? r.u32() : undefined;

    let offset = runStart;
    for (let i = 0; i < count; i++) {
      const duration =
        (flags & TRUN_SAMPLE_DURATION) !== 0
          ? r.u32()
          : (info.defaultSampleDuration ?? defaults?.sampleDuration ?? 0);
      const size =
        (flags & TRUN_SAMPLE_SIZE) !== 0
          ? r.u32()
          : (info.defaultSampleSize ?? defaults?.sampleSize ?? 0);
      const sampleFlags =
        (flags & TRUN_SAMPLE_FLAGS) !== 0
          ? r.u32()
          : i === 0 && firstSampleFlags !== undefined
            ? firstSampleFlags
            : (info.defaultSampleFlags ?? defaults?.sampleFlags ?? 0);
      // Composition offset is unsigned in v0, signed in v1 (negative offsets, e.g. edit-shifted B-frames).
      const cto = (flags & TRUN_SAMPLE_CTO) !== 0 ? (version === 0 ? r.u32() : r.i32()) : 0;

      samples.push({
        index: samples.length,
        offset,
        size,
        dtsTicks: dts,
        durationTicks: duration,
        cttsTicks: cto,
        keyframe: (sampleFlags & SAMPLE_IS_NON_SYNC) === 0,
      });
      offset += size;
      dts += duration;
    }
    runCursor = offset;
    fragmentEnd = Math.max(fragmentEnd, offset);
  }

  dtsCursors.set(info.trackId, dts);
  return fragmentEnd;
}

/**
 * Rebuild each track's flat sample list from every `moof`/`traf`/`trun` in the file, in file order.
 * `trex` defaults come from the `moov` (already located by the caller); the returned map is keyed by the
 * ISO track id (`ParsedTrack.id`), sample indexes are reassigned 0..n−1 per track.
 */
export function parseFragmentSamples(file: Uint8Array): Map<number, SampleData[]> {
  const r = new Reader(file);
  const out = new Map<number, SampleData[]>();
  const dtsCursors: DtsCursors = new Map();

  // trex defaults live in the (single) moov; find it first without consuming the moof scan.
  let trex = new Map<number, TrexDefaults>();
  {
    const scan = new Reader(file);
    for (const top of boxes(scan, file.byteLength)) {
      if (top.type === 'moov') {
        trex = parseTrexDefaults(scan, top);
        break;
      }
      scan.seek(top.end);
    }
  }

  for (const top of boxes(r, file.byteLength)) {
    if (top.type === 'moof') {
      const moofStart = top.start;
      // §8.8.7: the first traf lacking an explicit/default base uses the moof start; later trafs use the
      // end of the previous fragment's data.
      let implicitBase = moofStart;
      for (const traf of childrenOf(r, top, 'traf')) {
        implicitBase = appendTrafSamples(r, traf, moofStart, implicitBase, trex, dtsCursors, out);
      }
    }
    r.seek(top.end);
  }

  return out;
}

function sameIndexedSample(a: SampleData, b: SampleData): boolean {
  return (
    a.offset === b.offset &&
    a.size === b.size &&
    a.dtsTicks === b.dtsTicks &&
    a.durationTicks === b.durationTicks &&
    a.cttsTicks === b.cttsTicks &&
    a.keyframe === b.keyframe
  );
}

/**
 * Merge samples indexed by the initial `moov/stbl` with samples appended by later `moof/trun` runs.
 *
 * ISO-BMFF permits a movie to carry a real progressive prefix and then continue in movie fragments
 * (FFmpeg's default `+frag_keyframe`, without `+empty_moov`, writes exactly this shape). Neither index is
 * complete by itself. The native DTS is the canonical decode-order key; an exact duplicate physical
 * range is collapsed, while contradictory timing for the same bytes is rejected instead of exposing the
 * sample twice. Returned indexes are dense because the downstream read-window planner keys by index.
 */
export function mergeMoovAndFragmentSamples(
  moovSamples: readonly SampleData[],
  fragmentSamples: readonly SampleData[],
): SampleData[] {
  if (moovSamples.length === 0) {
    return fragmentSamples.map((sample, index) =>
      sample.index === index ? sample : { ...sample, index },
    );
  }
  if (fragmentSamples.length === 0) {
    return moovSamples.map((sample, index) =>
      sample.index === index ? sample : { ...sample, index },
    );
  }

  const ordered = [...moovSamples, ...fragmentSamples].sort(
    (a, b) => a.dtsTicks - b.dtsTicks || a.offset - b.offset,
  );
  const byOffset = new Map<number, Map<number, SampleData>>();
  const out: SampleData[] = [];
  for (const sample of ordered) {
    let bySize = byOffset.get(sample.offset);
    if (bySize === undefined) {
      bySize = new Map<number, SampleData>();
      byOffset.set(sample.offset, bySize);
    }
    const previous = bySize.get(sample.size);
    if (previous !== undefined) {
      if (sameIndexedSample(previous, sample)) continue;
      throw new MediaError(
        'demux-error',
        `MP4 sample range [${sample.offset}, ${sample.offset + sample.size}) has contradictory moov/moof timing`,
      );
    }
    bySize.set(sample.size, sample);
    out.push(sample.index === out.length ? sample : { ...sample, index: out.length });
  }
  return out;
}

import { ticksToUs } from '../../util/ticks.ts';

function toUs(ticks: number, timescale: number): number {
  if (timescale <= 0) return 0;
  if (!Number.isSafeInteger(timescale)) {
    throw new MediaError('demux-error', `toUs: timescale must be safe positive integer, got ${timescale}`);
  }
  if (!Number.isSafeInteger(ticks)) {
    throw new MediaError('demux-error', `toUs: ticks must be safe integer, got ${ticks}`);
  }
  return ticksToUs(ticks, timescale);
}

function checkedAdd(a: number, b: number): number {
  const r = a + b;
  if (!Number.isSafeInteger(r))
    throw new MediaError('demux-error', `tick addition overflow: ${a} + ${b}`);
  return r;
}

/**
 * Map a fragmented track's native-tick {@link SampleData} to the WebCodecs-microsecond {@link Sample}
 * the demux packet stream consumes, applying the track's edit-list media-time offset exactly as
 * {@link buildSamples} does for progressive tracks. Samples whose byte range escapes the file
 * (`fileSize` known) are **dropped** — a truncated/malformed fragment tail (some real captures store a
 * final `moof` whose `mdat` never arrived) yields no readable bytes, so emitting it would only crash the
 * reader; ffmpeg's demuxer stops at the same boundary. Surviving samples are re-indexed 0..n−1 so the
 * read-window planner keyed on `Sample.index` stays contiguous.
 */
export function fragmentSamplesToDemuxSamples(
  data: readonly SampleData[],
  timescale: number,
  editOffsetTicks: number,
  fileSize: number | undefined,
): Sample[] {
  if (timescale <= 0) return [];
  if (!Number.isSafeInteger(timescale)) {
    throw new MediaError(
      'demux-error',
      `fragmentSamplesToDemuxSamples: timescale must be safe positive integer, got ${timescale}`,
    );
  }
  if (!Number.isSafeInteger(editOffsetTicks)) {
    throw new MediaError(
      'demux-error',
      `fragmentSamplesToDemuxSamples: editOffsetTicks must be safe integer, got ${editOffsetTicks}`,
    );
  }
  const out: Sample[] = [];
  for (const s of data) {
    if (fileSize !== undefined && (s.offset < 0 || s.offset + s.size > fileSize)) continue;
    if (
      !Number.isSafeInteger(s.dtsTicks) ||
      !Number.isSafeInteger(s.cttsTicks) ||
      !Number.isSafeInteger(s.durationTicks)
    ) {
      throw new MediaError(
        'demux-error',
        `fragmentSamplesToDemuxSamples: tick values must be safe integers dts=${s.dtsTicks} ctts=${s.cttsTicks} dur=${s.durationTicks}`,
      );
    }
    const dtsMinusEdit = checkedAdd(s.dtsTicks, -editOffsetTicks);
    const ptsTicks = checkedAdd(dtsMinusEdit, s.cttsTicks);
    out.push({
      index: out.length,
      offset: s.offset,
      size: s.size,
      dtsUs: toUs(dtsMinusEdit, timescale),
      ptsUs: toUs(ptsTicks, timescale),
      durationUs: toUs(s.durationTicks, timescale),
      keyframe: s.keyframe,
    });
  }
  return out;
}
