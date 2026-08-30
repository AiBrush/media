/**
 * Expand a track's sample tables into a flat sample list. DTS accumulates `stts` deltas; the `ctts`
 * composition offset is preserved (so B-frame reordering survives); keyframes come from `stss` (absent
 * ⇒ every sample is sync). {@link buildSampleData} works in the container's native ticks (exact —
 * what the muxer round-trips); {@link buildSamples} maps to WebCodecs microseconds for the decode seam.
 * Pure TS — validated against the real corpus without a browser.
 */

import { MediaError } from '../../contracts/errors.ts';
import type {
  CompositionOffsetTable,
  ParsedTrack,
  SampleToChunkTable,
  TimeToSampleTable,
} from './parse.ts';

/** A sample in container-native ticks (exact). */
export interface SampleData {
  index: number;
  /** Absolute byte offset of the sample in the file. */
  offset: number;
  size: number;
  dtsTicks: number;
  durationTicks: number;
  /** Composition offset (PTS − DTS) in ticks. */
  cttsTicks: number;
  keyframe: boolean;
}

/** A sample with WebCodecs microsecond timestamps (the codec seam). */
export interface Sample {
  index: number;
  offset: number;
  size: number;
  dtsUs: number;
  ptsUs: number;
  durationUs: number;
  keyframe: boolean;
}

export type SampleVisitor = (
  index: number,
  offset: number,
  size: number,
  dtsTicks: number,
  durationTicks: number,
  cttsTicks: number,
  keyframe: boolean,
) => void;

/** A zero-allocation visitor over normalized sample byte ranges. */
export type SampleRangeVisitor = (index: number, offset: number, size: number) => void;

/** A physical sample row plus its exact `stss` membership, without timing-table expansion. */
export type SampleClassificationRangeVisitor = (
  index: number,
  offset: number,
  size: number,
  declaredSync: boolean,
) => void;

import { ticksToUs } from '../../util/ticks.ts';

function toUs(ticks: number, timescale: number): number {
  if (timescale <= 0) return 0;
  if (!Number.isSafeInteger(timescale)) {
    throw new MediaError('demux-error', `toUs: timescale must be a safe positive integer, got ${timescale}`);
  }
  if (!Number.isSafeInteger(ticks)) {
    throw new MediaError('demux-error', `toUs: ticks must be a safe integer, got ${ticks}`);
  }
  return ticksToUs(ticks, timescale);
}

function checkedAdd(a: number, b: number): number {
  const r = a + b;
  if (!Number.isSafeInteger(r))
    throw new MediaError('demux-error', `tick addition overflow: ${a} + ${b}`);
  return r;
}

interface RunCursor {
  index: number;
  remaining: number;
  value: number;
}

function nextRunValue(
  counts: Uint32Array,
  values: Uint32Array | Int32Array,
  cursor: RunCursor,
): number {
  while (cursor.remaining <= 0) {
    if (cursor.index >= counts.length) return cursor.value;
    const count = counts[cursor.index] ?? 0;
    const value = values[cursor.index] ?? 0;
    cursor.index++;
    if (count <= 0) continue;
    cursor.remaining = count;
    cursor.value = value;
  }
  cursor.remaining--;
  return cursor.value;
}

function nextTimeDelta(entries: TimeToSampleTable, cursor: RunCursor): number {
  return nextRunValue(entries.counts, entries.deltas, cursor);
}

function nextCompositionOffset(entries: CompositionOffsetTable, cursor: RunCursor): number {
  return nextRunValue(entries.counts, entries.offsets, cursor);
}

/** A monotonic `stsc` walk position: the next unread entry plus the run currently in force. */
export interface SampleToChunkCursor {
  index: number;
  value: number;
}

/**
 * The `stsc` samples-per-chunk in force for a 1-based chunk number, advancing a monotonic cursor.
 * Every sample-table walk shares this so the run-length semantics exist once.
 */
export function samplesPerChunkFor(
  table: SampleToChunkTable,
  chunkNumber: number,
  cursor: SampleToChunkCursor,
): number {
  while (
    cursor.index < table.firstChunk.length &&
    (table.firstChunk[cursor.index] ?? 0) <= chunkNumber
  ) {
    cursor.value = table.samplesPerChunk[cursor.index] ?? 0;
    cursor.index++;
  }
  return cursor.value;
}

function isAscending(values: Uint32Array): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < previous) return false;
    previous = value;
  }
  return true;
}

/**
 * Walk only the byte-placement tables (`stsz` + `stsc` + `stco`/`co64`). This deliberately avoids
 * timing, composition, and sync-table work when a caller only needs physical sample ownership.
 */
export function walkSampleRanges(track: ParsedTrack, visitor: SampleRangeVisitor): number {
  const table = track.samples;
  const sizes = table.sampleSizes;
  const count = sizes.length;
  const stscCursor = { index: 0, value: 0 };
  let sampleIndex = 0;
  for (
    let chunkIndex = 0;
    chunkIndex < table.chunkOffsets.length && sampleIndex < count;
    chunkIndex++
  ) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(table.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (let inChunk = 0; inChunk < samplesPerChunk && sampleIndex < count; inChunk++) {
      const size = sizes[sampleIndex] ?? 0;
      visitor(sampleIndex, offset, size);
      offset += size;
      sampleIndex++;
    }
  }
  return sampleIndex;
}

/**
 * Walk byte-placement tables and exact sync membership without materializing sample objects or touching
 * timing tables. Sorted `stss` uses a monotonic cursor; malformed unsorted tables retain set semantics.
 */
export function walkSampleClassificationRanges(
  track: ParsedTrack,
  visitor: SampleClassificationRangeVisitor,
): number {
  const table = track.samples;
  const sizes = table.sampleSizes;
  const count = sizes.length;
  const syncSamples = table.syncSamples;
  const allSync = syncSamples.length === 0;
  const sortedSync = allSync || isAscending(syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(syncSamples);
  const stscCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  for (
    let chunkIndex = 0;
    chunkIndex < table.chunkOffsets.length && sampleIndex < count;
    chunkIndex++
  ) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(table.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (let inChunk = 0; inChunk < samplesPerChunk && sampleIndex < count; inChunk++) {
      const size = sizes[sampleIndex] ?? 0;
      const sampleNumber = sampleIndex + 1;
      let syncSample = syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = syncSamples[syncIndex];
      }
      const declaredSync =
        allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber;
      visitor(sampleIndex, offset, size, declaredSync);
      offset += size;
      sampleIndex++;
    }
  }
  return sampleIndex;
}

/** Build the flat sample list (container-native ticks) for a track. */
export function buildSampleData(track: ParsedTrack): SampleData[] {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const count = sizes.length;
  const hasCtts = st.compositionOffsets.counts.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const out = new Array<SampleData>(count);
  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const stscCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(st.sampleToChunk, c + 1, stscCursor);
    let offset = chunkOffset;
    for (let s = 0; s < samplesPerChunk && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const delta = nextTimeDelta(st.timeToSample, deltaCursor);
      const ctts = hasCtts ? nextCompositionOffset(st.compositionOffsets, cttsCursor) : 0;
      const sampleNumber = sampleIndex + 1;
      let syncSample = st.syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = st.syncSamples[syncIndex];
      }
      if (
        !Number.isSafeInteger(delta) ||
        !Number.isSafeInteger(ctts) ||
        !Number.isSafeInteger(dts)
      ) {
        throw new MediaError(
          'demux-error',
          `buildSampleData: tick values must be safe integers dts=${dts} delta=${delta} ctts=${ctts}`,
        );
      }
      out[sampleIndex] = {
        index: sampleIndex,
        offset,
        size,
        dtsTicks: dts,
        durationTicks: delta,
        cttsTicks: ctts,
        keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
      };
      offset += size;
      dts = checkedAdd(dts, delta);
      sampleIndex++;
    }
  }
  out.length = sampleIndex;
  return out;
}

/** Build the flat sample list with WebCodecs microsecond timestamps. */
export function buildSamples(track: ParsedTrack): Sample[] {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const count = sizes.length;
  const ts = track.timescale;
  if (ts <= 0) {
    // legacy zero-timescale path (malformed): return zero timestamps as before
    // but still validate editOffset is safe if present
  } else if (!Number.isSafeInteger(ts)) {
    throw new MediaError('demux-error', `buildSamples: timescale must be safe positive integer, got ${ts}`);
  }
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  if (editOffsetTicks !== 0 && !Number.isSafeInteger(editOffsetTicks)) {
    throw new MediaError(
      'demux-error',
      `buildSamples: editOffsetTicks must be safe integer, got ${editOffsetTicks}`,
    );
  }
  const hasCtts = st.compositionOffsets.counts.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const out = new Array<Sample>(count);
  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const stscCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(st.sampleToChunk, c + 1, stscCursor);
    let offset = chunkOffset;
    for (let s = 0; s < samplesPerChunk && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const delta = nextTimeDelta(st.timeToSample, deltaCursor);
      const ctts = hasCtts ? nextCompositionOffset(st.compositionOffsets, cttsCursor) : 0;
      const sampleNumber = sampleIndex + 1;
      let syncSample = st.syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = st.syncSamples[syncIndex];
      }
      if (
        !Number.isSafeInteger(delta) ||
        !Number.isSafeInteger(ctts) ||
        !Number.isSafeInteger(dts)
      ) {
        throw new MediaError(
          'demux-error',
          `buildSamples: tick values must be safe integers dts=${dts} delta=${delta} ctts=${ctts}`,
        );
      }
      const dtsMinusEdit = checkedAdd(dts, -editOffsetTicks);
      const ptsTicks = checkedAdd(dtsMinusEdit, ctts);
      out[sampleIndex] = {
        index: sampleIndex,
        offset,
        size,
        dtsUs: toUs(dtsMinusEdit, ts),
        ptsUs: toUs(ptsTicks, ts),
        durationUs: toUs(delta, ts),
        keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
      };
      offset += size;
      dts = checkedAdd(dts, delta);
      sampleIndex++;
    }
  }
  out.length = sampleIndex;
  return out;
}

/** Walk sample tables without materializing an intermediate sample array. */
export function walkSamples(track: ParsedTrack, visitor: SampleVisitor): void {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const count = sizes.length;
  if (track.timescale !== 0 && !Number.isSafeInteger(track.timescale)) {
    throw new MediaError(
      'demux-error',
      `walkSamples: timescale must be safe positive integer, got ${track.timescale}`,
    );
  }
  const hasCtts = st.compositionOffsets.counts.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const stscCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(st.sampleToChunk, c + 1, stscCursor);
    let offset = chunkOffset;
    for (let s = 0; s < samplesPerChunk && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const delta = nextTimeDelta(st.timeToSample, deltaCursor);
      const ctts = hasCtts ? nextCompositionOffset(st.compositionOffsets, cttsCursor) : 0;
      const sampleNumber = sampleIndex + 1;
      let syncSample = st.syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = st.syncSamples[syncIndex];
      }
      if (
        !Number.isSafeInteger(delta) ||
        !Number.isSafeInteger(ctts) ||
        !Number.isSafeInteger(dts)
      ) {
        throw new MediaError(
          'demux-error',
          `walkSamples: tick values must be safe integers dts=${dts} delta=${delta} ctts=${ctts}`,
        );
      }
      visitor(
        sampleIndex,
        offset,
        size,
        dts,
        delta,
        ctts,
        allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
      );
      offset += size;
      dts = checkedAdd(dts, delta);
      sampleIndex++;
    }
  }
}
