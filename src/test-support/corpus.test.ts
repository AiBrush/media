import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../util/digest.ts';
import {
  fixtureEntry,
  fixtureSource,
  fixturesByContainer,
  fixturesByTrait,
  loadFixture,
  loadManifest,
} from './corpus.ts';

describe('corpus loader', () => {
  it('loads the manifest', async () => {
    const m = await loadManifest();
    expect(m.files.length).toBeGreaterThanOrEqual(5);
    expect(m.files.map((f) => f.id)).toContain('movie_5.mp4');
  });

  it('reads a real fixture and it matches its pinned size + sha256', async () => {
    const entry = await fixtureEntry('movie_5.mp4');
    const bytes = await loadFixture('movie_5.mp4');
    expect(bytes.byteLength).toBe(entry.bytes);
    expect(await sha256Hex(bytes)).toBe(entry.sha256);
    // MP4 magic: an 'ftyp' box type at offset 4.
    expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('ftyp');
  });

  it('builds a normalized source with the right mime hint', async () => {
    const src = await fixtureSource('movie_5.mp4');
    expect(src.kind).toBe('bytes');
    expect(src.mimeHint).toBe('video/mp4');
  });

  it('filters by container and trait', async () => {
    expect((await fixturesByContainer('mp4')).map((f) => f.id)).toContain('movie_5.mp4');
    expect((await fixturesByTrait('tiny-dims')).map((f) => f.id)).toContain('2x2-green.mp4');
  });

  it('fails loudly for a missing fixture', async () => {
    await expect(loadFixture('does-not-exist.mp4')).rejects.toThrow(/not cached/);
  });
});
