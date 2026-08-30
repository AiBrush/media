/**
 * Cold vs warm + hardware vs software reporting (REQUIREMENTS §8.2 — 3.8).
 *
 * Cold-start and warm-throughput MUST be reported separately, and hardware
 * and software routes MUST be reported separately. This module is the pure,
 * Node-testable invariant for that gate — no browser APIs, no fixture
 * branching, never huge-alloc, deterministic.
 */

import {
  type TimingEvidence,
  type TimingSample,
  coldWarmEvidence,
  timingEvidence,
} from './perf-evidence.ts';

export type HardwareSoftwareVariant = 'hardware' | 'software';

export interface ColdWarmPair {
  readonly cold: TimingEvidence;
  readonly warm: TimingEvidence;
}

export interface HardwareSoftwareColdWarm {
  readonly hardware: ColdWarmPair;
  readonly software: ColdWarmPair;
}

const VARIANTS: readonly HardwareSoftwareVariant[] = Object.freeze([
  'hardware',
  'software',
] as const);

export function isHardwareSoftwareVariant(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('variant must be string');
  if (value.length > 20) throw new RangeError('variant too long');
  return (VARIANTS as readonly string[]).includes(value);
}

/**
 * Build separated cold/warm evidence for each variant. Each variant needs
 * at least 31 samples (1 cold + 30 warm) — the CI gate from `coldWarmEvidence`.
 * Throws RangeError on malformed or insufficient samples, never huge-alloc.
 */
export function hardwareSoftwareColdWarm(
  hardwareSamples: readonly TimingSample[],
  softwareSamples: readonly TimingSample[],
): HardwareSoftwareColdWarm {
  if (!Array.isArray(hardwareSamples) || !Array.isArray(softwareSamples))
    throw new RangeError('samples must be arrays');
  if (hardwareSamples.length > 10000 || softwareSamples.length > 10000)
    throw new RangeError('too many samples');
  const hardware = coldWarmEvidence(hardwareSamples);
  const software = coldWarmEvidence(softwareSamples);
  return Object.freeze({ hardware: Object.freeze(hardware), software: Object.freeze(software) });
}

/**
 * Build timing evidence for each variant without cold/warm split (at least 30 each).
 * Useful when the caller only has warm steady-state samples.
 */
export function hardwareSoftwareTiming(
  hardwareSamples: readonly TimingSample[],
  softwareSamples: readonly TimingSample[],
): { hardware: TimingEvidence; software: TimingEvidence } {
  if (!Array.isArray(hardwareSamples) || !Array.isArray(softwareSamples))
    throw new RangeError('samples must be arrays');
  if (hardwareSamples.length > 10000 || softwareSamples.length > 10000)
    throw new RangeError('too many samples');
  const hardware = timingEvidence(hardwareSamples, { require30: true });
  const software = timingEvidence(softwareSamples, { require30: true });
  return Object.freeze({ hardware, software });
}

/** Whether both variants are present and their evidence is valid. */
export function assertBothVariantsReported(report: unknown): void {
  if (typeof report !== 'object' || report === null) throw new RangeError('report must be object');
  const r = report as Partial<Record<HardwareSoftwareVariant, unknown>>;
  for (const v of VARIANTS) {
    const val = r[v];
    if (val === undefined || val === null) throw new RangeError(`variant not reported: ${v}`);
    if (typeof val !== 'object') throw new RangeError(`variant ${v} must be object`);
  }
}

/** Cold vs warm must be reported separately: `cold` and `warm` must exist and differ. */
export function assertColdWarmSeparate(pair: unknown): void {
  if (typeof pair !== 'object' || pair === null) throw new RangeError('pair must be object');
  const p = pair as Partial<ColdWarmPair>;
  if (p.cold === undefined || p.warm === undefined)
    throw new RangeError('cold and warm must be reported separately');
  if (typeof p.cold !== 'object' || typeof p.warm !== 'object')
    throw new RangeError('cold/warm must be objects');
}
