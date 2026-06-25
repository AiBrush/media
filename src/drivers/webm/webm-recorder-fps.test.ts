/**
 * MediaRecorder-WebM fps derivation (BUILD_INSTRUCTIONS §6.2). A MediaRecorder/Chrome-captured WebM
 * omits the TrackEntry DefaultDuration, so a header-only fps is unavailable; the driver must instead
 * derive the video frame rate from the (Simple)Block cadence within the clusters. These tests gate
 * that derivation on the **real** recorder asset the acceptance harness uses (no DefaultDuration) and
 * keep the DefaultDuration path regression-safe on a normal WebM — both on genuine downloaded bytes.
 *
 * The harness `golden-metadata` oracle compares the probed video fps to a golden 30 within ±0.25 fps
 * (`fpsTolerance`), and treats a null fps against a non-null golden as a FAIL; so every assertion here
 * pins the derived **number** (it can disagree with a wrong value), never merely "not null".
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { WebmModule, parseWebm } from './webm-driver.ts';

// The real MediaRecorder asset (Chrome-captured VP8+Opus, no DefaultDuration). It is not a manifest
// fixture (manifest-edits are owned elsewhere), so it is loaded by direct path from the git-ignored
// media cache. sha256 4423ec5c7a9f50c6615190e642cdd8c0f501284b304a5a7824e226cd4e39c82d — copied from
// the acceptance harness corpus (`media-test/media-browser-test/fixtures/media/recorder_headerless.webm`).
const RECORDER_WEBM_URL = new URL(
  '../../../fixtures/media/recorder_headerless.webm',
  import.meta.url,
);

async function loadRecorderWebm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(RECORDER_WEBM_URL));
}

// The harness oracle's fps band for recorder WebM. The golden frame rate is 30.
const GOLDEN_FPS = 30;
const FPS_TOLERANCE = 0.25;

describe('WebM fps from MediaRecorder block cadence (no DefaultDuration)', () => {
  it('recorder_headerless.webm — derives ~30 fps from block timing (parseWebm)', async () => {
    const info = parseWebm(await loadRecorderWebm());

    const video = info.tracks.find((t) => t.mediaType === 'video');
    expect(video?.codec).toBe('vp8');
    // The asset carries NO DefaultDuration; fps therefore comes purely from the 93 video blocks across
    // 3.084 s (raw ≈ 29.83, snapped to the nominal integer cadence). Pin the number, within tolerance.
    expect(video?.fps).toBeDefined();
    expect(video?.fps).toBeCloseTo(GOLDEN_FPS, 1); // |derived − 30| < 0.05 once snapped
    expect(Math.abs((video?.fps ?? 0) - GOLDEN_FPS)).toBeLessThanOrEqual(FPS_TOLERANCE);
  });

  it('recorder_headerless.webm — fps surfaces through the public probe/TrackInfo path', async () => {
    const info = await createMedia()
      .use(WebmModule)
      .probe(fromBytes(await loadRecorderWebm(), { mime: 'video/webm' }));

    const video = info.tracks.find((t) => t.type === 'video');
    expect(video?.codec).toBe('vp8');
    expect(video?.fps).toBeDefined();
    expect(Math.abs((video?.fps ?? 0) - GOLDEN_FPS)).toBeLessThanOrEqual(FPS_TOLERANCE);
    // The audio track must not gain a video-style fps from the same cadence scan.
    expect(info.tracks.find((t) => t.type === 'audio')?.fps).toBeUndefined();
  });
});

describe('WebM fps regression — DefaultDuration stays the primary source', () => {
  it('movie_5.webm — fps still comes from DefaultDuration (1e9 / DefaultDuration)', async () => {
    const info = parseWebm(await loadFixture('movie_5.webm'));

    const video = info.tracks.find((t) => t.mediaType === 'video');
    expect(video?.codec).toBe('vp9');
    // DefaultDuration = 41_666_666 ns ⇒ 1e9 / 41_666_666 = 24.000000384…; the block-cadence fallback
    // must NOT overwrite this precise header value (it is left untouched, fraction and all).
    expect(video?.fps).toBeDefined();
    expect(video?.fps).toBeCloseTo(24, 4);
    expect(video?.fps).not.toBe(24); // proves it is the exact DefaultDuration value, not a snapped int
  });
});

// ── Anti-cheat: the derivation is a real estimate, so a DIFFERENT cadence yields a DIFFERENT fps. ────
// Hand-built EBML (no DefaultDuration) lets us drive the block timing directly: if the snapper merely
// returned 30, these would fail. Builders mirror src/drivers/webm/webm.test.ts.
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function sizeVint(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
}
function uintN(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push((value / 256 ** i) & 0xff);
  return out;
}
const el = (id: number[], data: number[]): number[] => [...id, ...sizeVint(data.length), ...data];
const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  DocType: [0x42, 0x82],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
};

/** A SimpleBlock for track 1 with a 16-bit relative timecode (TimecodeScale = 1 ms here). */
function simpleBlock(relMs: number): number[] {
  return el(E.SimpleBlock, [0x81, (relMs >> 8) & 0xff, relMs & 0xff, 0x80]); // track 1, int16 rel, flags
}

/** Build a one-cluster VP8 WebM (no DefaultDuration) whose video blocks land at the given ms times. */
function recorderLikeWebm(blockTimesMs: readonly number[]): Uint8Array {
  const track = el(E.TrackEntry, [
    ...el(E.TrackNumber, [1]),
    ...el(E.TrackType, [1]), // video
    ...el(E.CodecID, str('V_VP8')),
    ...el(E.Video, [...el(E.PixelWidth, uintN(320, 2)), ...el(E.PixelHeight, uintN(240, 2))]),
  ]);
  const cluster = el(E.Cluster, [
    ...el(E.Timecode, [0]),
    ...blockTimesMs.flatMap((t) => simpleBlock(t)),
  ]);
  return new Uint8Array([
    ...el(E.EBML, el(E.DocType, str('webm'))),
    ...el(E.Segment, [
      ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))), // 1 ms ticks
      ...el(E.Tracks, track),
      ...cluster,
    ]),
  ]);
}

describe('WebM fps derivation is a genuine estimate (anti-cheat)', () => {
  it('snaps a near-integer cadence to that integer (10 blocks @ 100 ms ⇒ 10 fps, not 30)', () => {
    // 10 blocks at 0,100,…,900 ms ⇒ span 0.9 s ⇒ (10−1)/0.9 = 10.0 fps exactly.
    const times = Array.from({ length: 10 }, (_, i) => i * 100);
    const video = parseWebm(recorderLikeWebm(times)).tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBe(10);
  });

  it('derives ~30 only when the blocks are actually ~30 fps (60 blocks @ 33 ms)', () => {
    // 60 blocks at 33 ms steps ⇒ span 1.947 s ⇒ 59/1.947 ≈ 30.3 → snapped to 30.
    const times = Array.from({ length: 60 }, (_, i) => i * 33);
    const video = parseWebm(recorderLikeWebm(times)).tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBe(30);
  });

  it('leaves a genuinely fractional cadence unsnapped (outside the ±2 % band)', () => {
    // 5 blocks at 80 ms steps ⇒ span 0.32 s ⇒ 4/0.32 = 12.5 fps; 12.5 is 4 % off 12/13 → reported raw.
    const times = [0, 80, 160, 240, 320];
    const video = parseWebm(recorderLikeWebm(times)).tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBeCloseTo(12.5, 6);
  });

  it('omits fps (does not fabricate) when a single block gives no interval', () => {
    const video = parseWebm(recorderLikeWebm([0])).tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBeUndefined();
  });
});
