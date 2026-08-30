/**
 * Reproducible clean-checkout evidence bundle (REQUIREMENTS §11 — 4.5).
 *
 * Every candidate release MUST publish a machine-readable evidence bundle
 * containing package version, commit, clean/dirty state, build flags, lockfile
 * hash, artifact hashes, browser/OS/device/GPU/isolation, manifest, timings,
 * bytes, memory, longTasks, hashes, quality metrics, and license inventory.
 * This module is the pure, Node-testable validator — no browser APIs, no
 * fixture branching, never huge-alloc, deterministic.
 */

import type { EvidenceBundle } from './evidence-bundle.ts';
import { assertEvidenceBundle } from './evidence-bundle.ts';

export interface ReproBundle extends EvidenceBundle {
  readonly packageVersion: string;
  readonly commit: string; // 7-40 hex
  readonly dirty: boolean;
  readonly buildFlags: readonly string[];
  readonly lockfileHash: string; // sha256:...
  readonly artifactHashes: Readonly<Record<string, string>>; // file -> sha256:...
  readonly browser: string;
  readonly os: string;
  readonly device: string;
  readonly gpu: string;
  readonly isolation: 'isolated' | 'non-isolated';
  readonly timings: Readonly<Record<string, number>>;
  readonly bytes: Readonly<Record<string, number>>;
  readonly memory: Readonly<Record<string, number | undefined>>;
  readonly longTasks: readonly number[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly qualityMetrics: Readonly<Record<string, number>>;
  readonly licenseInventory: readonly string[];
}

function isHex40or7(v: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(v);
}

export function isCleanCheckout(bundle: ReproBundle): boolean {
  if (typeof bundle !== 'object' || bundle === null) throw new RangeError('bundle must be object');
  return bundle.dirty === false;
}

export function assertReproBundle(bundle: unknown): asserts bundle is ReproBundle {
  assertEvidenceBundle(bundle);
  const b = bundle as unknown as Record<string, unknown>;
  if (typeof b['packageVersion'] !== 'string' || !b['packageVersion'])
    throw new RangeError('packageVersion required');
  if (typeof b['commit'] !== 'string' || !isHex40or7(b['commit'] as string))
    throw new RangeError('commit must be 7-40 hex');
  if (typeof b['dirty'] !== 'boolean') throw new RangeError('dirty must be boolean');
  if (!Array.isArray(b['buildFlags'])) throw new RangeError('buildFlags must be array');
  if (typeof b['lockfileHash'] !== 'string' || !(b['lockfileHash'] as string).startsWith('sha256:'))
    throw new RangeError('lockfileHash must be sha256:...');
  if (
    typeof b['artifactHashes'] !== 'object' ||
    b['artifactHashes'] === null ||
    Array.isArray(b['artifactHashes'])
  )
    throw new RangeError('artifactHashes must be object');
  for (const [k, v] of Object.entries(b['artifactHashes'] as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) throw new RangeError('artifact file must be non-empty string');
    if (typeof v !== 'string' || !(v as string).startsWith('sha256:'))
      throw new RangeError(`artifact hash for ${k} must be sha256:...`);
  }
  for (const f of ['browser', 'os', 'device', 'gpu'] as const) {
    if (typeof b[f] !== 'string' || !(b[f] as string)) throw new RangeError(`${f} required`);
  }
  if (b['isolation'] !== 'isolated' && b['isolation'] !== 'non-isolated')
    throw new RangeError('isolation must be isolated|non-isolated');
  for (const f of ['timings', 'bytes', 'memory', 'hashes', 'qualityMetrics'] as const) {
    if (typeof b[f] !== 'object' || b[f] === null || Array.isArray(b[f]))
      throw new RangeError(`${f} must be object`);
  }
  if (!Array.isArray(b['longTasks'])) throw new RangeError('longTasks must be array');
  for (const t of b['longTasks'] as unknown[])
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0)
      throw new RangeError('longTask must be finite >=0');
  if (!Array.isArray(b['licenseInventory'])) throw new RangeError('licenseInventory must be array');
  for (const s of b['licenseInventory'] as unknown[])
    if (typeof s !== 'string' || !s) throw new RangeError('license entry must be non-empty string');
}

export function assertReproducibleCleanCheckout(bundle: unknown): void {
  assertReproBundle(bundle);
  if ((bundle as ReproBundle).dirty) throw new RangeError('dirty checkout not reproducible');
  const count = Object.keys((bundle as ReproBundle).artifactHashes).length;
  if (count === 0) throw new RangeError('artifactHashes empty — build not reproducible');
}

export function minimalReproBundle(overrides: Partial<ReproBundle> = {}): ReproBundle {
  const base: ReproBundle = {
    manifest: {
      manifestVersion: 'aibrush-evidence-manifest@1',
      corpusChecksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      oracleVersion: 'aibrush-oracle@1',
      exclusions: [],
      generatedAtIso: new Date().toISOString(),
    },
    results: [],
    packageVersion: '0.0.0',
    commit: 'abc1234',
    dirty: false,
    buildFlags: ['--target=es2022'],
    lockfileHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    artifactHashes: {
      'dist/index.js': 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
    browser: 'chromium-150',
    os: 'macos-14',
    device: 'm4',
    gpu: 'angle-m4',
    isolation: 'isolated',
    timings: { medianMs: 10 },
    bytes: { in: 1000 },
    memory: { peakMB: 64 },
    longTasks: [5],
    hashes: { output: 'sha256:abc' },
    qualityMetrics: { ssim: 0.95 },
    licenseInventory: ['MIT'],
    ...overrides,
  } as ReproBundle;
  return base;
}
