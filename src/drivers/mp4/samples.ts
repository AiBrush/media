/**
 * Expand a track's sample tables into a flat sample list. DTS accumulates `stts` deltas; the `ctts`
 * composition offset is preserved (so B-frame reordering survives); keyframes come from `stss` (absent
 * ⇒ every sample is sync). {@link buildSampleData} works in the container's native ticks (exact —
 * what the muxer round-trips); {@link buildSamples} maps to WebCodecs microseconds for the decode seam.
 * Pure TS — validated against the real corpus without a browser.
 */

import type { CompositionOffset, ParsedTrack, SampleToChunk, TimeToSample } from './parse.ts';

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

function toUs(ticks: number, timescale: number): number {
  return timescale > 0 ? Math.round((ticks * 1_000_000) / timescale) : 0;
}

/** Run-length-expand `stts`/`ctts` entries into a per-sample array of length `count`. */
function expand<E extends { count: number }>(
  entries: readonly E[],
  count: number,
  pick: (e: E) => number,
): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const value = pick(e);
    for (let i = 0; i < e.count && out.length < count; i++) out.push(value);
  }
  while (out.length < count) out.push(out.length > 0 ? (out[out.length - 1] ?? 0) : 0);
  return out;
}

/** Samples-per-chunk for a 1-based chunk number, from the `stsc` run-length table. */
function samplesPerChunk(stsc: readonly SampleToChunk[], chunkNumber: number): number {
  let result = 0;
  for (const e of stsc) {
    if (e.firstChunk <= chunkNumber) result = e.samplesPerChunk;
    else break;
  }
  return result;
}

/** Build the flat sample list (container-native ticks) for a track. */
export function buildSampleData(track: ParsedTrack): SampleData[] {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const count = sizes.length;
  const deltas = expand<TimeToSample>(st.timeToSample, count, (e) => e.delta);
  const hasCtts = st.compositionOffsets.length > 0;
  const cOffsets = hasCtts
    ? expand<CompositionOffset>(st.compositionOffsets, count, (e) => e.offset)
    : undefined;
  const sync = new Set(st.syncSamples);
  const allSync = sync.size === 0;

  const out: SampleData[] = [];
  let sampleIndex = 0;
  let dts = 0;
  for (let c = 0; c < st.chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = st.chunkOffsets[c];
    if (chunkOffset === undefined) break;
    let offset = chunkOffset;
    const spc = samplesPerChunk(st.sampleToChunk, c + 1);
    for (let s = 0; s < spc && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const delta = deltas[sampleIndex] ?? 0;
      out.push({
        index: sampleIndex,
        offset,
        size,
        dtsTicks: dts,
        durationTicks: delta,
        cttsTicks: cOffsets?.[sampleIndex] ?? 0,
        keyframe: allSync || sync.has(sampleIndex + 1),
      });
      offset += size;
      dts += delta;
      sampleIndex++;
    }
  }
  return out;
}

/** Build the flat sample list with WebCodecs microsecond timestamps. */
export function buildSamples(track: ParsedTrack): Sample[] {
  const ts = track.timescale;
  return buildSampleData(track).map((s) => ({
    index: s.index,
    offset: s.offset,
    size: s.size,
    dtsUs: toUs(s.dtsTicks, ts),
    ptsUs: toUs(s.dtsTicks + s.cttsTicks, ts),
    durationUs: toUs(s.durationTicks, ts),
    keyframe: s.keyframe,
  }));
}
