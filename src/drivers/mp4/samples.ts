/**
 * Expand a track's sample tables into a flat sample list. DTS accumulates `stts` deltas; the `ctts`
 * composition offset is preserved (so B-frame reordering survives); keyframes come from `stss` (absent
 * ⇒ every sample is sync). {@link buildSampleData} works in the container's native ticks (exact —
 * what the muxer round-trips); {@link buildSamples} maps to WebCodecs microseconds for the decode seam.
 * Pure TS — validated against the real corpus without a browser.
 */

import type { CompositionOffset, ParsedTrack, TimeToSample } from './parse.ts';

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

function toUs(ticks: number, timescale: number): number {
  return timescale > 0 ? Math.round((ticks * 1_000_000) / timescale) : 0;
}

interface RunCursor {
  index: number;
  remaining: number;
  value: number;
}

function nextTimeDelta(entries: readonly TimeToSample[], cursor: RunCursor): number {
  while (cursor.remaining <= 0) {
    const entry = entries[cursor.index];
    if (entry === undefined) return cursor.value;
    cursor.index++;
    if (entry.count <= 0) continue;
    cursor.remaining = entry.count;
    cursor.value = entry.delta;
  }
  cursor.remaining--;
  return cursor.value;
}

function nextCompositionOffset(entries: readonly CompositionOffset[], cursor: RunCursor): number {
  while (cursor.remaining <= 0) {
    const entry = entries[cursor.index];
    if (entry === undefined) return cursor.value;
    cursor.index++;
    if (entry.count <= 0) continue;
    cursor.remaining = entry.count;
    cursor.value = entry.offset;
  }
  cursor.remaining--;
  return cursor.value;
}

function isAscending(values: readonly number[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < previous) return false;
    previous = value;
  }
  return true;
}

/** Build the flat sample list (container-native ticks) for a track. */
export function buildSampleData(track: ParsedTrack): SampleData[] {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const count = sizes.length;
  const hasCtts = st.compositionOffsets.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const out = new Array<SampleData>(count);
  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  let stscIndex = 0;
  let samplesPerChunk = 0;
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const chunkNumber = c + 1;
    while (true) {
      const entry = st.sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
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
      dts += delta;
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
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  const hasCtts = st.compositionOffsets.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const out = new Array<Sample>(count);
  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  let stscIndex = 0;
  let samplesPerChunk = 0;
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const chunkNumber = c + 1;
    while (true) {
      const entry = st.sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
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
      out[sampleIndex] = {
        index: sampleIndex,
        offset,
        size,
        dtsUs: toUs(dts - editOffsetTicks, ts),
        ptsUs: toUs(dts + ctts - editOffsetTicks, ts),
        durationUs: toUs(delta, ts),
        keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
      };
      offset += size;
      dts += delta;
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
  const hasCtts = st.compositionOffsets.length > 0;
  const allSync = st.syncSamples.length === 0;
  const sortedSync = allSync || isAscending(st.syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(st.syncSamples);

  const deltaCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: RunCursor = { index: 0, remaining: 0, value: 0 };
  let stscIndex = 0;
  let samplesPerChunk = 0;
  let syncIndex = 0;
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const chunkNumber = c + 1;
    while (true) {
      const entry = st.sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
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
      dts += delta;
      sampleIndex++;
    }
  }
}
