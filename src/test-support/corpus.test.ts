import { describe, expect, it } from 'vitest';
import { createMedia } from '../api/create-media.ts';
import type { MediaInfo, MediaInfoTrack } from '../api/types.ts';
import { AdtsModule } from '../drivers/adts/adts-driver.ts';
import { FlacModule } from '../drivers/flac/flac-driver.ts';
import { Mp3Module } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Module } from '../drivers/mp4/mp4-driver.ts';
import { OggModule } from '../drivers/ogg/ogg-driver.ts';
import { WavModule } from '../drivers/wav/wav-driver.ts';
import { WebmModule } from '../drivers/webm/webm-driver.ts';
import { sha256Hex } from '../util/digest.ts';
import {
  type FixtureEntry,
  fixtureEntry,
  fixtureSource,
  fixturesByContainer,
  fixturesByTrait,
  hasGoldenMetadata,
  loadFixture,
  loadGoldenMetadata,
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

// All container modules our TS demuxer ships, so the integrity probe is deterministic (not reliant on
// zero-config auto-registration). MOV routes through the MP4 driver; mpegts has no golden here.
const probeEngine = () =>
  createMedia()
    .use(Mp4Module)
    .use(WavModule)
    .use(Mp3Module)
    .use(OggModule)
    .use(WebmModule)
    .use(FlacModule)
    .use(AdtsModule);

/** A golden that holds no real information must not be accepted (anti-cheat, doc 11 §5). */
function assertNonDegenerate(id: string, g: MediaInfo): void {
  expect(g.container, `${id}: container`).toBeTruthy();
  expect(g.durationSec, `${id}: duration > 0`).toBeGreaterThan(0);
  expect(g.tracks.length, `${id}: has tracks`).toBeGreaterThan(0);
  for (const t of g.tracks) {
    expect(t.codec, `${id}: track ${t.id} codec`).toBeTruthy();
    if (t.type === 'video') {
      expect(t.width ?? 0, `${id}: track ${t.id} width`).toBeGreaterThan(0);
      expect(t.height ?? 0, `${id}: track ${t.id} height`).toBeGreaterThan(0);
    } else {
      expect(t.sampleRate ?? 0, `${id}: track ${t.id} sampleRate`).toBeGreaterThan(0);
      expect(t.channels ?? 0, `${id}: track ${t.id} channels`).toBeGreaterThan(0);
    }
  }
}

describe('corpus integrity — every manifest entry fetches, loads, and (where pinned) probes to truth', () => {
  let files: FixtureEntry[] = [];
  it('the corpus is diverse and present', async () => {
    files = (await loadManifest()).files;
    expect(files.length).toBeGreaterThanOrEqual(40);
    // §6.1 axes that must each be backed by ≥1 real file.
    for (const c of ['mp4', 'mov', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'adts', 'mpegts'])
      expect((await fixturesByContainer(c)).length, `container ${c}`).toBeGreaterThan(0);
    for (const t of ['rotation', '10-bit', 'alpha', 'fragmented', 'vfr', 'stereo', 'multichannel'])
      expect((await fixturesByTrait(t)).length, `trait ${t}`).toBeGreaterThan(0);
  });

  it('every entry is cached and byte-identical to its pinned sha256 (tests never hit the network)', async () => {
    for (const entry of files) {
      const bytes = await loadFixture(entry.id);
      expect(bytes.byteLength, `${entry.id}: bytes`).toBe(entry.bytes);
      expect(await sha256Hex(bytes), `${entry.id}: sha256`).toBe(entry.sha256);
      // every entry records provenance (source + license; new entries also carry attribution).
      expect(entry.source, `${entry.id}: source`).toBeTruthy();
      expect(entry.license, `${entry.id}: license`).toBeTruthy();
    }
  });

  it('every entry normalizes to a Source', async () => {
    for (const entry of files) expect((await fixtureSource(entry.id)).kind).toBe('bytes');
  });

  it('every committed golden is non-degenerate and reproduced exactly by probe', async () => {
    let asserted = 0;
    for (const entry of files) {
      if (!(await hasGoldenMetadata(entry.id))) continue;
      const golden = (await loadGoldenMetadata(entry.id)) as MediaInfo;
      assertNonDegenerate(entry.id, golden);
      const info = await probeEngine().probe(await fixtureSource(entry.id));
      expect(info, `${entry.id}: probe matches committed golden`).toEqual(golden);
      asserted++;
    }
    expect(asserted, 'goldens asserted').toBeGreaterThanOrEqual(40);
  });

  it('the golden oracle can fail — a tampered field is rejected (mutation self-check)', async () => {
    const golden = (await loadGoldenMetadata('bear-1280x720.mp4')) as MediaInfo;
    const tampered = structuredClone(golden);
    const t: MediaInfoTrack | undefined = tampered.tracks.find((x) => x.type === 'video');
    if (t) t.width = (t.width ?? 0) + 1;
    const info = await probeEngine().probe(await fixtureSource('bear-1280x720.mp4'));
    expect(info).not.toEqual(tampered); // a wrong golden would be rejected
    expect(info).toEqual(golden); // the true golden still matches
  });
});
