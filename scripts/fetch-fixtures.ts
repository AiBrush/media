#!/usr/bin/env bun
/**
 * scripts/fetch-fixtures.ts — download the pinned real-media corpus and verify it (docs/architecture
 * BUILD_INSTRUCTIONS §6.1). Reads `fixtures/manifest.json`, downloads each pinned URL into
 * `fixtures/media/` (git-ignored), and verifies the `sha256`. Tests never touch the network — they
 * read this verified local cache; a missing/mismatched file fails setup loudly.
 *
 *   bun run fetch-fixtures            # download missing files and verify all against pinned sha256
 *   bun run fetch-fixtures --update   # (re)compute and write sha256/bytes back into the manifest
 *   bun run fetch-fixtures --force    # re-download even if cached
 *
 * Exit code is non-zero on any verification failure.
 */

import { sha256Hex } from '../src/util/digest.ts';

interface FixtureEntry {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  source: string;
  /** Provenance line: copyright holder + license (+ link). Recorded for every real-media entry. */
  attribution?: string;
  container: string;
  video?: string;
  audio?: string;
  traits: string[];
}
interface Manifest {
  version: number;
  note: string;
  files: FixtureEntry[];
}

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = `${ROOT}fixtures/manifest.json`;
const MEDIA_DIR = `${ROOT}fixtures/media`;

const UPDATE = process.argv.includes('--update');
const FORCE = process.argv.includes('--force');

async function main(): Promise<void> {
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;
  let failures = 0;
  let downloaded = 0;
  let verified = 0;

  for (const entry of manifest.files) {
    const path = `${MEDIA_DIR}/${entry.id}`;
    const cached = Bun.file(path);
    let bytes: Uint8Array<ArrayBuffer> | undefined;

    if (!FORCE && (await cached.exists())) {
      bytes = new Uint8Array(await cached.arrayBuffer());
    } else {
      try {
        bytes = await download(entry.url);
        await Bun.write(path, bytes);
        downloaded++;
      } catch (e) {
        console.error(`  ✗ ${entry.id}: download failed — ${describe(e)}`);
        failures++;
        continue;
      }
    }

    const actual = await sha256Hex(bytes);
    if (UPDATE || entry.sha256 === '') {
      entry.sha256 = actual;
      entry.bytes = bytes.byteLength;
      console.info(`  ✎ ${entry.id}: sha256 ${actual.slice(0, 12)}… (${bytes.byteLength} B)`);
    } else if (actual !== entry.sha256) {
      console.error(
        `  ✗ ${entry.id}: sha256 mismatch\n      expected ${entry.sha256}\n      actual   ${actual}`,
      );
      failures++;
    } else {
      verified++;
      console.info(`  ✓ ${entry.id} (${bytes.byteLength} B)`);
    }
  }

  if (UPDATE) {
    await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.info('\nmanifest updated with computed sha256/bytes.');
  }

  console.info(`\n${verified} verified · ${downloaded} downloaded · ${failures} failed`);
  if (failures > 0) {
    console.error('Fixture verification FAILED. Re-run with --force, or --update to re-pin.');
    process.exit(1);
  }
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

await main();
