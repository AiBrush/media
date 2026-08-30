/**
 * Holistic SOTA eligibility (REQUIREMENTS §14 — SOTA gate).
 *
 * The project is eligible for a best-in-class claim only when every
 * correctness/speed/bundle/memory gate passes and results reproduce from a
 * clean checkout. This module is the pure aggregator for that final gate —
 * no browser APIs, no fixture branching, never huge-alloc, deterministic.
 */

import type { ReviewGates } from './evidence-review.ts';
import { reviewPasses } from './evidence-review.ts';

export interface HolisticGates extends ReviewGates {
  readonly fullCorpusZeroFailError: boolean; // full functional pillar 591 zero FAIL/ERROR
  readonly cleanCheckout: boolean;
}

export const HOLISTIC_REQUIRED: readonly (keyof HolisticGates)[] = Object.freeze([
  'correctnessZeroFailError',
  'bundlePass',
  'memoryPass',
  'speedPass',
  'reportsPublished',
  'heldOutPass',
  'comparisonPinned',
  'soakPass',
  'fuzzPass',
  'browserMatrixCovered',
  'fullCorpusZeroFailError',
  'cleanCheckout',
] as const);

export function isHolisticGates(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<HolisticGates>;
  for (const k of HOLISTIC_REQUIRED) if (typeof o[k] !== 'boolean') return false;
  return true;
}

export function holisticPasses(gates: HolisticGates): boolean {
  if (!isHolisticGates(gates)) throw new RangeError('invalid holistic gates');
  for (const k of HOLISTIC_REQUIRED) if (!gates[k]) return false;
  return reviewPasses(gates);
}

export function assertHolisticPasses(gates: HolisticGates): void {
  if (!holisticPasses(gates)) {
    const missing = HOLISTIC_REQUIRED.filter((k) => !gates[k]);
    throw new RangeError(`holistic SOTA not eligible — gates failed: ${missing.join(', ')}`);
  }
}

export function minimalHolisticPass(): HolisticGates {
  return Object.freeze({
    correctnessZeroFailError: true,
    bundlePass: true,
    memoryPass: true,
    speedPass: true,
    reportsPublished: true,
    heldOutPass: true,
    comparisonPinned: true,
    soakPass: true,
    fuzzPass: true,
    browserMatrixCovered: true,
    fullCorpusZeroFailError: true,
    cleanCheckout: true,
  } as HolisticGates);
}

export function currentHolisticStatus(partial: Partial<HolisticGates>): HolisticGates {
  const base = minimalHolisticPass();
  return Object.freeze({ ...base, ...partial } as HolisticGates);
}
