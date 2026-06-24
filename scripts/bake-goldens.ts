#!/usr/bin/env bun
/**
 * scripts/bake-goldens.ts — bake committed golden references from the verified corpus
 * (BUILD_INSTRUCTIONS §6.1, docs/architecture/11 §3). Goldens are checksum-pinned and committed;
 * the large media is not.
 *
 * Phase 0 bakes the **corpus index** (`fixtures/golden/corpus-index.json`) after re-verifying every
 * cached file's sha256, so the committed golden set has a single source of truth for what the corpus
 * contains. The strong per-op goldens — `golden-metadata`, `golden-packets`,
 * `decoded-frames-bitexact` (baked in `force-software`), cleartext twins for decrypt — are baked here
 * as their ops/drivers land (Phase 1+).
 *
 *   bun run bake-goldens
 */

import { createMedia } from '../src/api/create-media.ts';
import { AdtsModule } from '../src/drivers/adts/adts-driver.ts';
import { FlacModule } from '../src/drivers/flac/flac-driver.ts';
import { Mp3Module } from '../src/drivers/mp3/mp3-driver.ts';
import { Mp4Module } from '../src/drivers/mp4/mp4-driver.ts';
import { OggModule } from '../src/drivers/ogg/ogg-driver.ts';
import { WavModule } from '../src/drivers/wav/wav-driver.ts';
import { WebmModule } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';
import { dspGoldenDigests } from '../src/test-support/dsp-goldens.ts';
import { sha256Hex } from '../src/util/digest.ts';

interface FixtureEntry {
  id: string;
  sha256: string;
  bytes: number;
  container: string;
  video?: string;
  audio?: string;
  traits: string[];
}
interface Manifest {
  files: FixtureEntry[];
}

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = `${ROOT}fixtures/manifest.json`;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const GOLDEN_INDEX = `${ROOT}fixtures/golden/corpus-index.json`;
const METADATA_DIR = `${ROOT}fixtures/golden/metadata`;
const DSP_DIR = `${ROOT}fixtures/golden/dsp`;

/** Probe-backed golden-metadata for the containers our TS demuxer already parses (doc 11 §2). */
const PROBE_CONTAINERS = new Set(['mp4', 'wav', 'mp3', 'ogg', 'webm', 'flac', 'adts']);
const PROBE_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  flac: 'audio/flac',
  adts: 'audio/aac',
};

async function main(): Promise<void> {
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;
  const index: Record<string, Omit<FixtureEntry, 'id'>> = {};
  let failures = 0;

  for (const entry of [...manifest.files].sort((a, b) => a.id.localeCompare(b.id))) {
    const file = Bun.file(`${MEDIA_DIR}/${entry.id}`);
    if (!(await file.exists())) {
      console.error(`  ✗ ${entry.id}: missing from cache — run \`bun run fetch-fixtures\` first`);
      failures++;
      continue;
    }
    const actual = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
    if (actual !== entry.sha256) {
      console.error(`  ✗ ${entry.id}: sha256 mismatch (cache differs from manifest)`);
      failures++;
      continue;
    }
    const { id, ...rest } = entry;
    index[id] = rest;
    console.info(`  ✓ ${id}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} fixture(s) failed verification; goldens not baked.`);
    process.exit(1);
  }

  await Bun.write(GOLDEN_INDEX, `${JSON.stringify(index, null, 2)}\n`);
  console.info(`\nbaked ${Object.keys(index).length} entries → fixtures/golden/corpus-index.json`);

  // golden-metadata: probe each parseable container so probe is gated on an exact, frozen reference.
  const media = createMedia()
    .use(Mp4Module)
    .use(WavModule)
    .use(Mp3Module)
    .use(OggModule)
    .use(WebmModule)
    .use(FlacModule)
    .use(AdtsModule);
  let metaCount = 0;
  for (const entry of manifest.files) {
    if (!PROBE_CONTAINERS.has(entry.container)) continue;
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${entry.id}`).arrayBuffer());
    const mime = PROBE_MIME[entry.container];
    const info = await media.probe(fromBytes(bytes, mime ? { mime } : {}));
    await Bun.write(`${METADATA_DIR}/${entry.id}.json`, `${JSON.stringify(info, null, 2)}\n`);
    metaCount++;
  }
  console.info(`baked ${metaCount} golden-metadata files → fixtures/golden/metadata/`);

  // decoded-audio-pcm: pin the byte-stable (pow-free) PCM transforms for every WAV fixture (doc 11).
  let dspCount = 0;
  for (const entry of manifest.files) {
    if (entry.container !== 'wav') continue;
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${entry.id}`).arrayBuffer());
    const golden = await dspGoldenDigests(bytes);
    await Bun.write(`${DSP_DIR}/${entry.id}.json`, `${JSON.stringify(golden, null, 2)}\n`);
    dspCount++;
  }
  console.info(`baked ${dspCount} audio-dsp golden files → fixtures/golden/dsp/`);
}

await main();
