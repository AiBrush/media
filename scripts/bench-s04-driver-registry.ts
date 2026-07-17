#!/usr/bin/env bun
/**
 * R-S04 driver-contract & registry benchmark — fresh, multi-sample, strict-oracle.
 *
 * Cold rows (one fresh bun child per sample): the two-step capability-miss recovery on a definite MP4
 * mux target — query-selective single-driver registration plus pin resolution on the real registered
 * driver id (R-S04.1) vs the register-all lazy-proxy roster (control). Warm rows (in-process, per-op):
 * full default-roster wiring (R-S04.7/8/10 registration wiring cost), the same-id strict-superset
 * supersession defense (R-S04.2), the real mp4-mux/mp4 module pair with the demux-never-lost invariant,
 * and registry read-side snapshots (the router's per-pick view). Every sample re-asserts its routing or
 * surface oracle before it is counted — a wrong route or a lost capability fails the bench with a
 * nonzero exit; it never becomes a number.
 */

import type { ContainerDriver, ContainerQuery } from '../src/contracts/driver.ts';
import { registerDefaultContainerForQuery } from '../src/drivers/default-container-registration.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS, registerDefaultDrivers } from '../src/drivers/defaults.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';

const CHILD = process.argv[2] === '--child';
const COLD_SAMPLES = 5;
const WARM_SAMPLES = 9;

const COLD_MODES = ['selective-pin', 'selective', 'register-all-control'] as const;
type ColdMode = (typeof COLD_MODES)[number];

const MUX_QUERY: ContainerQuery = { direction: 'mux', extension: 'mp4' };
const MP4_DEMUX_HEAD_QUERY: ContainerQuery = {
  direction: 'demux',
  head: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
};

/** The container/filter rosters `registerDefaultDrivers` must produce (owned by defaults.ts). */
const EXPECTED_CONTAINER_IDS = [...DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => spec.id), 'flac']
  .sort()
  .join(',');
const EXPECTED_FILTER_IDS = [
  'webgpu-video-filter',
  'canvas2d-video-filter',
  'audio-dsp-filter',
  'cpu-video-filter',
]
  .sort()
  .join(',');
const EXPECTED_LAZY_CODEC_IDS = [
  'flac-encode',
  'wasm-vorbis-enc',
  'wasm-vorbis',
  'wasm-aac',
  'wasm-mp3',
  'wasm-opus',
  'wasm-av1',
  'wasm-vpx',
] as const;

interface ColdResult {
  readonly mode: ColdMode;
  readonly pickedId: string;
  readonly containerCount: number;
  readonly elapsedMs: number;
}

interface ColdRow {
  readonly mode: ColdMode;
  readonly freshSamples: number;
  readonly pickedId: string;
  readonly containerCount: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
}

interface WarmRow {
  readonly section: string;
  readonly samples: number;
  readonly iterationsPerSample: number;
  readonly perOpMicrosMin: number;
  readonly perOpMicrosMedian: number;
  readonly perOpMicrosMax: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of no samples');
  return value;
}

function assertRoster(reg: Registry): void {
  const containerIds = reg
    .containers()
    .map((driver) => driver.id)
    .sort()
    .join(',');
  if (containerIds !== EXPECTED_CONTAINER_IDS) {
    throw new Error(`default container roster drifted: ${containerIds}`);
  }
  const filterIds = reg
    .filters()
    .map((driver) => driver.id)
    .sort()
    .join(',');
  if (filterIds !== EXPECTED_FILTER_IDS) {
    throw new Error(`default filter roster drifted: ${filterIds}`);
  }
  const codecIds = new Set(reg.codecs().map((driver) => driver.id));
  for (const id of EXPECTED_LAZY_CODEC_IDS) {
    if (!codecIds.has(id)) throw new Error(`default codec roster lost '${id}'`);
  }
  if (reg.imageOps() === undefined) throw new Error('default roster lost image ops');
}

function syntheticContainer(id: string): ContainerDriver {
  return {
    id,
    apiVersion: 1,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    demux: () => Promise.reject(new Error('unused')),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
}

async function coldChild(mode: ColdMode): Promise<ColdResult> {
  const registry = new Registry();
  const router = new Router({ registry });
  const started = Bun.nanoseconds();
  let picked: ContainerDriver;
  if (mode === 'register-all-control') {
    registerDefaultDrivers(registry);
    picked = router.pickContainer(MUX_QUERY);
  } else {
    const pin = mode === 'selective-pin' ? 'mp4-mux' : undefined;
    if (!(await registerDefaultContainerForQuery(registry, MUX_QUERY, pin))) {
      throw new Error(`${mode} declined a definite MP4 mux query`);
    }
    picked = router.pickContainer(MUX_QUERY, pin === undefined ? {} : { pinDriver: pin });
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

  const expectedId = mode === 'register-all-control' ? 'mp4' : 'mp4-mux';
  if (picked.id !== expectedId) {
    throw new Error(`${mode} routed '${picked.id}', expected '${expectedId}'`);
  }
  const containerCount = registry.containers().length;
  const expectedCount =
    mode === 'register-all-control' ? DEFAULT_LAZY_CONTAINER_SPECS.length + 1 : 1;
  if (containerCount !== expectedCount) {
    throw new Error(`${mode} registered ${containerCount} containers, expected ${expectedCount}`);
  }
  return { mode, pickedId: picked.id, containerCount, elapsedMs };
}

function timeSection(section: string, iterationsPerSample: number, run: () => void): WarmRow {
  const perOpMicros: number[] = [];
  for (let sample = 0; sample < WARM_SAMPLES; sample++) {
    const started = Bun.nanoseconds();
    for (let iteration = 0; iteration < iterationsPerSample; iteration++) run();
    perOpMicros.push((Bun.nanoseconds() - started) / iterationsPerSample / 1_000);
  }
  return {
    section,
    samples: WARM_SAMPLES,
    iterationsPerSample,
    perOpMicrosMin: Math.min(...perOpMicros),
    perOpMicrosMedian: median(perOpMicros),
    perOpMicrosMax: Math.max(...perOpMicros),
  };
}

async function warmRows(): Promise<readonly WarmRow[]> {
  const [{ default: mp4MuxOnlyModule }, { Mp4Module }] = await Promise.all([
    import('../src/drivers/mp4/mp4-mux-driver.ts'),
    import('../src/drivers/mp4/mp4-driver.ts'),
  ]);

  const rows: WarmRow[] = [];

  rows.push(
    timeSection('register-defaults-roster', 300, () => {
      const reg = new Registry();
      registerDefaultDrivers(reg);
      assertRoster(reg);
    }),
  );

  const narrow = syntheticContainer('bench-collide');
  const wide: ContainerDriver = {
    ...syntheticContainer('bench-collide'),
    probe: () => Promise.resolve([]),
    packetInfo: () => Promise.reject(new Error('unused')),
    streamCopy: () => Promise.reject(new Error('unused')),
  };
  rows.push(
    timeSection('same-id-supersession-defense', 2_000, () => {
      const reg = new Registry();
      reg.addContainer(narrow);
      reg.addContainer(wide);
      const survivor = reg.containers()[0];
      if (survivor !== wide || typeof survivor.probe !== 'function') {
        throw new Error('a strictly wider same-id surface failed to supersede');
      }
    }),
  );

  rows.push(
    timeSection('real-mp4-pair-registration', 200, () => {
      const reg = new Registry();
      mp4MuxOnlyModule.register(reg);
      Mp4Module.register(reg);
      const ids = reg.containers().map((driver) => driver.id);
      if (!ids.includes('mp4-mux') || !ids.includes('mp4')) {
        throw new Error(`mp4 module pair collided: ${ids.join(',')}`);
      }
      const demuxCapable = reg.containers().find((d) => d.supports(MP4_DEMUX_HEAD_QUERY));
      if (demuxCapable?.id !== 'mp4') throw new Error('MP4 demux lost across the module pair');
    }),
  );

  const prebuilt = new Registry();
  registerDefaultDrivers(prebuilt);
  const expectedContainers = DEFAULT_LAZY_CONTAINER_SPECS.length + 1;
  rows.push(
    timeSection('registry-read-snapshots', 5_000, () => {
      const containers = prebuilt.containers();
      const codecs = prebuilt.codecs();
      const filters = prebuilt.filters();
      if (containers.length !== expectedContainers || codecs.length === 0 || filters.length !== 4) {
        throw new Error('registry snapshot changed shape mid-benchmark');
      }
    }),
  );

  return rows;
}

function isColdMode(value: string | undefined): value is ColdMode {
  return value !== undefined && (COLD_MODES as readonly string[]).includes(value);
}

if (CHILD) {
  const mode = process.argv[3];
  if (!isColdMode(mode)) throw new Error(`invalid bench-s04 child mode '${String(mode)}'`);
  console.info(JSON.stringify(await coldChild(mode)));
} else {
  const coldResults: ColdResult[] = [];
  for (const mode of COLD_MODES) {
    for (let sample = 0; sample < COLD_SAMPLES; sample++) {
      const child = Bun.spawn([process.execPath, import.meta.path, '--child', mode], {
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const output = await new Response(child.stdout).text();
      const status = await child.exited;
      if (status !== 0) throw new Error(`${mode} child exited ${status}`);
      coldResults.push(JSON.parse(output) as ColdResult);
    }
  }

  const coldRows: ColdRow[] = COLD_MODES.map((mode) => {
    const samples = coldResults.filter((result) => result.mode === mode);
    const first = samples[0];
    if (first === undefined) throw new Error(`no samples for ${mode}`);
    for (const result of samples) {
      if (result.pickedId !== first.pickedId || result.containerCount !== first.containerCount) {
        throw new Error(`${mode} produced inconsistent routes across fresh samples`);
      }
    }
    const times = samples.map((result) => result.elapsedMs);
    return {
      mode,
      freshSamples: samples.length,
      pickedId: first.pickedId,
      containerCount: first.containerCount,
      minMs: Math.min(...times),
      medianMs: median(times),
      maxMs: Math.max(...times),
    };
  });

  console.info(
    JSON.stringify(
      {
        benchmark: 's04-driver-registry',
        freshProcessColdRows: true,
        coldRows,
        warmRows: await warmRows(),
      },
      null,
      2,
    ),
  );
}
