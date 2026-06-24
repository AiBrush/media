/**
 * Test-only corpus loader (BUILD_INSTRUCTIONS §6.1). Reads the **verified local cache** under
 * `fixtures/media/` (never the network) so validation/benchmark tests run on real downloaded media. A
 * missing file fails loudly with the command to fix it. Not shipped (excluded from the build + the
 * library tsconfig); typed with bun-types via tsconfig.test.json.
 */

import { access, readFile } from 'node:fs/promises';
import { type Source, fromBytes } from '../sources/source.ts';

export interface FixtureEntry {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  source: string;
  container: string;
  video?: string;
  audio?: string;
  traits: string[];
}
export interface Manifest {
  version: number;
  note: string;
  files: FixtureEntry[];
}

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const MANIFEST_PATH = `${ROOT}fixtures/manifest.json`;
const GOLDEN_DIR = `${ROOT}fixtures/golden`;

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  adts: 'audio/aac',
};

let manifestCache: Manifest | undefined;

/** Load and cache the committed manifest. */
export async function loadManifest(): Promise<Manifest> {
  manifestCache ??= JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Manifest;
  return manifestCache;
}

/** The manifest entry for a fixture id (throws if absent). */
export async function fixtureEntry(id: string): Promise<FixtureEntry> {
  const entry = (await loadManifest()).files.find((f) => f.id === id);
  if (!entry) throw new Error(`no manifest entry for fixture '${id}'`);
  return entry;
}

/** Read a cached fixture's bytes (throws loudly if it was never fetched). */
export async function loadFixture(id: string): Promise<Uint8Array<ArrayBuffer>> {
  const path = `${MEDIA_DIR}/${id}`;
  try {
    await access(path);
  } catch {
    throw new Error(`fixture '${id}' is not cached — run \`bun run fetch-fixtures\` first`);
  }
  return new Uint8Array(await readFile(path));
}

/** A normalized {@link Source} for a fixture, with the right MIME hint for routing. */
export async function fixtureSource(id: string): Promise<Source> {
  const entry = await fixtureEntry(id);
  const bytes = await loadFixture(id);
  const mime = CONTAINER_MIME[entry.container];
  return fromBytes(bytes, mime ? { mime } : {});
}

/** All manifest entries with the given container token. */
export async function fixturesByContainer(container: string): Promise<FixtureEntry[]> {
  return (await loadManifest()).files.filter((f) => f.container === container);
}

/** All manifest entries carrying the given trait. */
export async function fixturesByTrait(trait: string): Promise<FixtureEntry[]> {
  return (await loadManifest()).files.filter((f) => f.traits.includes(trait));
}

/** Load a committed golden-metadata reference (`fixtures/golden/metadata/<id>.json`). */
export async function loadGoldenMetadata(id: string): Promise<unknown> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}/metadata/${id}.json`, 'utf8'));
}
