/**
 * Fragmented-MP4 per-sample recovery (ADR-186). A fragmented movie's `moov` sample tables are empty, so
 * before this the demuxer emitted zero packets and decode/convert of any fragmented input produced empty
 * output. {@link parseFragmentSamples} rebuilds the exact sample list from `moof`/`traf`/`trun`.
 *
 * The oracle is INDEPENDENT: `fixtures/golden/mp4/fragment-samples.json`, baked by
 * `scripts/bake-fragment-samples-golden.ts` from `ffprobe -show_packets` (real byte offset, size, DTS,
 * PTS in container ticks, keyframe). We assert byte-exact equality on the real Chromium CMAF corpus —
 * one open-GOP B-frame fragment file and one A/V CMAF file — plus the truncation-drop invariant and the
 * empty-`moov`-table premise that makes this path necessary. A one-file pass would be overfitting, so
 * both rotated fixtures must hold.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { fragmentSamplesToDemuxSamples, parseFragmentSamples } from './fragment-samples.ts';
import { readMovie } from './mp4-driver.ts';
import type { Movie } from './parse.ts';
import { buildSampleData } from './samples.ts';

interface GoldenSample {
  readonly offset: number;
  readonly size: number;
  readonly dts: number;
  readonly pts: number;
  readonly keyframe: boolean;
}
type Golden = Record<string, { videoTrackSamples: GoldenSample[] }>;

async function loadGolden(): Promise<Golden> {
  const path = fileURLToPath(
    new URL('../../../fixtures/golden/mp4/fragment-samples.json', import.meta.url),
  );
  return JSON.parse(await readFile(path, 'utf8')) as Golden;
}

/** Random access over an in-memory fixture (mirrors the demuxer's ByteSource for `readMovie`). */
function randomAccessOf(bytes: Uint8Array): {
  size: number;
  read(o: number, n: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (o, n) => Promise.resolve(bytes.subarray(o, Math.min(bytes.byteLength, o + n))),
  };
}

/** The single video track of a parsed movie (all fragmented fixtures here carry one). */
function videoTrack(movie: Movie): Movie['tracks'][number] {
  const track = movie.tracks.find((t) => t.mediaType === 'video');
  if (track === undefined) throw new Error('fixture has no video track');
  return track;
}

describe('parseFragmentSamples — real CMAF corpus vs ffprobe packet golden', () => {
  it('rebuilds an open-GOP B-frame fragment track byte-exactly (offset/size/DTS/PTS/keyframe)', async () => {
    const golden = (await loadGolden())['bear-open-gop-frag.mp4'];
    expect(golden).toBeDefined();
    const bytes = await loadFixture('bear-open-gop-frag.mp4');
    const movie = await readMovie(randomAccessOf(bytes));
    const track = videoTrack(movie);
    // Premise: the moov sample table is empty, so the progressive builder yields nothing here.
    expect(buildSampleData(track).length).toBe(0);

    const data = parseFragmentSamples(bytes).get(track.id);
    expect(data).toBeDefined();
    const rows = (data ?? []).map((s) => ({
      offset: s.offset,
      size: s.size,
      dts: s.dtsTicks,
      pts: s.dtsTicks + s.cttsTicks,
      keyframe: s.keyframe,
    }));
    expect(rows).toEqual(golden?.videoTrackSamples);
    // Open GOP ⇒ at least one non-first sample presents before its decode order (ctts reordering).
    expect((data ?? []).some((s) => s.cttsTicks !== 0)).toBe(true);
  });

  it('rebuilds an A/V CMAF video track byte-exactly and drops a truncated fragment tail', async () => {
    const golden = (await loadGolden())['bear-av-frag.mp4'];
    expect(golden).toBeDefined();
    const bytes = await loadFixture('bear-av-frag.mp4');
    const movie = await readMovie(randomAccessOf(bytes));
    const track = videoTrack(movie);

    const byTrack = parseFragmentSamples(bytes);
    const video = byTrack.get(track.id);
    expect(video).toBeDefined();
    const rows = (video ?? []).map((s) => ({
      offset: s.offset,
      size: s.size,
      dts: s.dtsTicks,
      pts: s.dtsTicks + s.cttsTicks,
      keyframe: s.keyframe,
    }));
    expect(rows).toEqual(golden?.videoTrackSamples);

    // Truncation-drop invariant: this real fixture's audio tail references bytes past EOF (its final
    // fragments' mdat never arrived). Mapping to demux samples with the file size must drop exactly the
    // out-of-range samples, so every surviving sample is fully readable.
    for (const [, data] of byTrack) {
      const mapped = fragmentSamplesToDemuxSamples(data, 1, 0, bytes.byteLength);
      for (const s of mapped) {
        expect(s.offset).toBeGreaterThanOrEqual(0);
        expect(s.offset + s.size).toBeLessThanOrEqual(bytes.byteLength);
      }
      // Re-indexed contiguously so the read-window planner keyed on Sample.index stays valid.
      mapped.forEach((s, i) => expect(s.index).toBe(i));
    }
  });

  it('maps native ticks to microseconds and honours the edit-list media-time offset', () => {
    const data = [
      {
        index: 0,
        offset: 0,
        size: 10,
        dtsTicks: 0,
        durationTicks: 1000,
        cttsTicks: 500,
        keyframe: true,
      },
      {
        index: 1,
        offset: 10,
        size: 12,
        dtsTicks: 1000,
        durationTicks: 1000,
        cttsTicks: 0,
        keyframe: false,
      },
    ];
    const mapped = fragmentSamplesToDemuxSamples(data, 1000, 0, undefined);
    expect(mapped[0]).toMatchObject({
      dtsUs: 0,
      ptsUs: 500_000,
      durationUs: 1_000_000,
      keyframe: true,
    });
    expect(mapped[1]).toMatchObject({ dtsUs: 1_000_000, ptsUs: 1_000_000, keyframe: false });
    // An edit-list offset shifts DTS/PTS back by the media-time (ticks), exactly as buildSamples does.
    const shifted = fragmentSamplesToDemuxSamples(data, 1000, 1000, undefined);
    expect(shifted[0]).toMatchObject({ dtsUs: -1_000_000, ptsUs: -500_000 });
  });
});
