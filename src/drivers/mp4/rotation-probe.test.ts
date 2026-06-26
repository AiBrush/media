/**
 * `rotation:decode` verification (baseline NA-flip bucket). Proves the engine GENUINELY surfaces a track's
 * display rotation on `probe`/decode — so the harness adapter may honestly declare the `rotation:decode`
 * feature. Pure-Node: `probe` reads the MP4 `tkhd` transform matrix WITHOUT the WebCodecs packet seam, so
 * no browser is needed (the matrix→degrees decode is in `src/drivers/mp4/parse.ts`).
 *
 * Fixture: `bear-rotate-90.mp4` — a real H.264 MP4 whose track matrix encodes a 90° display rotation
 * (ffprobe reports `rotation:-90`; the engine normalizes to the positive 90° clockwise convention). A
 * broken matrix decode (wrong angle, dropped field) fails the assertion.
 */

import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';

describe('rotation:decode — the engine surfaces tkhd display rotation on probe (baseline NA-flip)', () => {
  it('reports a 90° rotation for bear-rotate-90.mp4', async () => {
    const bytes = await loadFixture('bear-rotate-90.mp4');
    const info = await createMedia().probe(fromBytes(bytes, { mime: 'video/mp4' }));
    const video = info.tracks.find((t) => t.type === 'video');
    expect(video, 'has a video track').toBeDefined();
    // The matrix decodes to a quarter-turn; the engine normalizes to 90 (positive, clockwise).
    expect(video?.rotation, 'rotation degrees').toBe(90);
    // Sanity: the coded dims are the storage dims (rotation is display-only metadata, not applied here).
    expect(video?.width, 'coded width').toBe(1280);
    expect(video?.height, 'coded height').toBe(720);
  });

  it('reports no rotation (or 0) for an unrotated MP4', async () => {
    const bytes = await loadFixture('bear-1280x720.mp4');
    const info = await createMedia().probe(fromBytes(bytes, { mime: 'video/mp4' }));
    const video = info.tracks.find((t) => t.type === 'video');
    expect(video, 'has a video track').toBeDefined();
    // An identity matrix yields either an absent rotation or 0 — never a spurious non-zero angle.
    expect(video?.rotation ?? 0, 'no spurious rotation').toBe(0);
  });
});
