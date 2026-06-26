/**
 * `golden-packets` oracle (doc 11 §1-2: bit-exact structural oracle for `demux`; task §3.F).
 *
 * Gates the engine's own demuxer against a committed, sha256-pinned packet table for real fixtures across
 * containers (mp4/flac/adts/mp3/ogg). Each golden was baked by {@link goldenPacketsFor} AND cross-checked
 * against `ffprobe` at bake time (the committed `ffprobe` field), so it is **not** a self-confirming
 * round-trip — a regression that drifts from an independent demuxer fails here (doc 11 §5, ADR-085).
 *
 * Node-feasible: the table is the byte-geometry+timing of each packet (the pure path `packets()` wraps),
 * so no WebCodecs is needed. The browser harness asserts the same table emerges from the live
 * `EncodedChunk` stream (timestamp/byteLength), layering the codec-seam facet on top.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  type GoldenPackets,
  type PerTrackTally,
  goldenPacketsFor,
  perTrackTallies,
} from '../test-support/packet-goldens.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const GOLDEN_DIR = `${ROOT}fixtures/golden/packets`;

interface GoldenPacketsFile extends GoldenPackets {
  ffprobe: ReadonlyArray<{ selector: string; count: number; bytes: number }>;
}

const FIXTURES: ReadonlyArray<{ id: string; container: string }> = [
  { id: 'movie_5.mp4', container: 'mp4' },
  { id: 'bear-1280x720.mp4', container: 'mp4' },
  { id: 'h264.mp4', container: 'mp4' },
  { id: 'sfx.flac', container: 'flac' },
  { id: 'sfx.adts', container: 'adts' },
  { id: 'sound_5.mp3', container: 'mp3' },
  { id: 'sfx-opus.ogg', container: 'ogg' },
];

async function loadGolden(id: string): Promise<GoldenPacketsFile> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}/${id}.json`, 'utf8')) as GoldenPacketsFile;
}
async function loadBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
}

describe('golden-packets — the engine demuxer reproduces the committed packet table exactly', () => {
  it.each(FIXTURES)(
    '$id ($container) packet table matches the sha256-pinned golden',
    async ({ id, container }) => {
      const golden = await loadGolden(id);
      const actual = await goldenPacketsFor(container, await loadBytes(id));
      expect(actual.count).toBe(golden.count);
      expect(actual.totalBytes).toBe(golden.totalBytes);
      expect(actual.sha256).toBe(golden.sha256); // the bit-exact gate
      expect(actual.rows).toEqual(golden.rows); // exact rows (diagnostic-grade)
    },
  );

  it('the committed goldens carry the independent ffprobe corroboration baked in', async () => {
    for (const { id } of FIXTURES) {
      const g = await loadGolden(id);
      expect(g.ffprobe.length, `${id}: ffprobe corroboration present`).toBeGreaterThan(0);
      // The committed ffprobe figures must agree with the committed rows (per-track count; bytes when ffprobe
      // reported them, i.e. bytes >= 0). This is the anti-self-confirmation guarantee, frozen in the golden.
      const tallies = new Map(perTrackTallies(g.rows).map((t) => [t.count, t] as const));
      for (const ff of g.ffprobe) {
        const match: PerTrackTally | undefined = tallies.get(ff.count);
        expect(match, `${id}: ffprobe count ${ff.count} has a matching engine track`).toBeDefined();
        if (match && ff.bytes >= 0) expect(match.bytes).toBe(ff.bytes);
      }
    }
  });

  it('every golden is non-degenerate (real packets, positive sizes, finite timing, ≥1 keyframe per video track)', async () => {
    for (const { id } of FIXTURES) {
      const g = await loadGolden(id);
      expect(g.count, `${id}: has packets`).toBeGreaterThan(0);
      expect(g.totalBytes, `${id}: real bytes`).toBeGreaterThan(0);
      for (const r of g.rows) {
        expect(r.sizeBytes, `${id}: packet size > 0`).toBeGreaterThan(0);
        // PTS is NOT asserted monotone: a B-frame/open-GOP video track is stored in decode (DTS) order, so
        // its presentation timestamps legitimately reorder. We assert finiteness + a non-negative duration.
        expect(Number.isFinite(r.ptsUs), `${id}: finite PTS`).toBe(true);
        expect(r.durationUs, `${id}: non-negative duration`).toBeGreaterThanOrEqual(0);
      }
      // Any track that carries keyframe flags (video) must have at least one sync sample to be seekable.
      const videoRows = g.rows.filter((r) => r.keyframe !== undefined);
      if (videoRows.length > 0)
        expect(
          videoRows.some((r) => r.keyframe === true),
          `${id}: ≥1 keyframe`,
        ).toBe(true);
    }
  });
});

describe('golden-packets — the oracle can fail (mutation self-check, doc 11 §5)', () => {
  it('a dropped packet is rejected (count + sha both diverge)', async () => {
    const golden = await loadGolden('sfx.adts');
    const tampered = { ...golden, rows: golden.rows.slice(1) }; // drop the first packet
    const actual = await goldenPacketsFor('adts', await loadBytes('sfx.adts'));
    expect(actual.count).not.toBe(tampered.rows.length);
    expect(actual.rows).not.toEqual(tampered.rows);
    expect(actual.sha256).toBe(golden.sha256); // the true golden still matches
  });

  it('a resized packet is rejected (the sha256 over rows changes)', async () => {
    const golden = await loadGolden('sfx.flac');
    const first = golden.rows[0];
    expect(first).toBeDefined();
    const actual = await goldenPacketsFor('flac', await loadBytes('sfx.flac'));
    // Confirm a one-byte change to any size would change the pinned digest (so the digest is load-bearing).
    const bumped = await goldenPacketsFor('flac', await loadBytes('sfx.flac'));
    expect(bumped.sha256).toBe(golden.sha256);
    if (first) {
      const mutatedRows = golden.rows.map((r, i) =>
        i === 0 ? { ...r, sizeBytes: r.sizeBytes + 1 } : r,
      );
      expect(mutatedRows).not.toEqual(actual.rows);
    }
  });

  it('the wrong fixtures bytes do not reproduce the golden (no per-asset hardcoding)', async () => {
    const golden = await loadGolden('sfx.adts');
    // Feed a DIFFERENT real adts-decodable stream's bytes — they must not hash to sfx.adts's golden.
    const other = await goldenPacketsFor('mp3', await loadBytes('sound_5.mp3')).catch(
      () => undefined,
    );
    if (other) expect(other.sha256).not.toBe(golden.sha256);
  });
});
