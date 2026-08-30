/**
 * Representative workload taxonomy (REQUIREMENTS §8.2 — 3.7).
 *
 * Performance changes MUST be evaluated on representative tiny, short, long,
 * 4K, high-frame-rate, multitrack, and high-latency range-backed inputs.
 * A microbenchmark win MUST NOT override slower end-to-end execution.
 * This module is the pure, Node-testable taxonomy the runner and CI use —
 * no browser APIs, no fixture branching, never huge-alloc, deterministic.
 */

export type RepresentativeCategory =
  | 'tiny'
  | 'short'
  | 'long'
  | '4K'
  | 'HFR'
  | 'multitrack'
  | 'high-latency-range';

export interface RepresentativeInput {
  readonly category: RepresentativeCategory;
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
  readonly fps: number;
  readonly trackCount: number;
  readonly latencyMs: number;
  readonly rangeBacked: boolean;
}

export const REPRESENTATIVE_INPUTS: readonly RepresentativeInput[] = Object.freeze([
  Object.freeze({
    category: 'tiny',
    width: 640,
    height: 360,
    durationSec: 2,
    fps: 30,
    trackCount: 1,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: 'short',
    width: 1280,
    height: 720,
    durationSec: 5,
    fps: 30,
    trackCount: 1,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: 'long',
    width: 1920,
    height: 1080,
    durationSec: 600,
    fps: 30,
    trackCount: 1,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: '4K',
    width: 3840,
    height: 2160,
    durationSec: 10,
    fps: 30,
    trackCount: 1,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: 'HFR',
    width: 1920,
    height: 1080,
    durationSec: 10,
    fps: 60,
    trackCount: 1,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: 'multitrack',
    width: 1920,
    height: 1080,
    durationSec: 10,
    fps: 30,
    trackCount: 3,
    latencyMs: 10,
    rangeBacked: false,
  } as RepresentativeInput),
  Object.freeze({
    category: 'high-latency-range',
    width: 1920,
    height: 1080,
    durationSec: 10,
    fps: 30,
    trackCount: 1,
    latencyMs: 250,
    rangeBacked: true,
  } as RepresentativeInput),
]);

const CATEGORY_SET = new Set<RepresentativeCategory>([
  'tiny',
  'short',
  'long',
  '4K',
  'HFR',
  'multitrack',
  'high-latency-range',
]);

export function isRepresentativeCategory(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('category must be string');
  if (value.length > 50) throw new RangeError('category too long');
  return CATEGORY_SET.has(value as RepresentativeCategory);
}

export function representativeInputForCategory(
  category: RepresentativeCategory,
): RepresentativeInput {
  if (typeof category !== 'string') throw new RangeError('category must be string');
  if (!CATEGORY_SET.has(category)) throw new RangeError(`unknown category ${category}`);
  const found = REPRESENTATIVE_INPUTS.find((r) => r.category === category);
  // Should never be undefined because REPRESENTATIVE_INPUTS covers all categories
  if (found === undefined) throw new RangeError(`missing representative for ${category}`);
  return found;
}

export function isValidRepresentativeInput(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const r = input as Partial<RepresentativeInput>;
  if (typeof r.category !== 'string' || !CATEGORY_SET.has(r.category as RepresentativeCategory))
    return false;
  const w = r.width;
  if (typeof w !== 'number' || !Number.isSafeInteger(w) || w <= 0 || w > 8192) return false;
  const h = r.height;
  if (typeof h !== 'number' || !Number.isSafeInteger(h) || h <= 0 || h > 8192) return false;
  if (
    typeof r.durationSec !== 'number' ||
    !Number.isFinite(r.durationSec) ||
    r.durationSec <= 0 ||
    r.durationSec > 36000
  )
    return false;
  const f = r.fps;
  if (typeof f !== 'number' || !Number.isSafeInteger(f) || f <= 0 || f > 240) return false;
  const t = r.trackCount;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0 || t > 16) return false;
  const l = r.latencyMs;
  if (typeof l !== 'number' || !Number.isSafeInteger(l) || l < 0 || l > 5000) return false;
  if (typeof r.rangeBacked !== 'boolean') return false;
  return true;
}

/**
 * Assert that a set of evaluated inputs covers every representative category.
 * Throws RangeError when a category is missing or input is malformed, never huge-alloc.
 */
export function assertAllCategoriesCovered(inputs: readonly RepresentativeInput[]): void {
  if (!Array.isArray(inputs)) throw new RangeError('inputs must be array');
  if (inputs.length > 100) throw new RangeError('too many inputs');
  const seen = new Set<RepresentativeCategory>();
  for (const input of inputs) {
    if (!isValidRepresentativeInput(input)) throw new RangeError('invalid representative input');
    seen.add((input as RepresentativeInput).category);
  }
  for (const cat of CATEGORY_SET) {
    if (!seen.has(cat)) throw new RangeError(`representative category not covered: ${cat}`);
  }
}

/** Microbenchmark vs E2E gate: true when E2E is faster or within 5% — a micro win must not override E2E regression. */
export function e2eTakesPrecedenceOverMicro(microRatio: number, e2eRatio: number): boolean {
  if (!Number.isFinite(microRatio) || microRatio <= 0)
    throw new RangeError('microRatio must be finite >0');
  if (!Number.isFinite(e2eRatio) || e2eRatio <= 0)
    throw new RangeError('e2eRatio must be finite >0');
  // microRatio = aibrush/micro / fastest/micro, e2eRatio = aibrush/e2e / fastest/e2e
  // If micro is faster (microRatio <1) but E2E is slower beyond 5% (e2eRatio >1.05), E2E wins -> return false (do not accept micro win)
  if (microRatio < 1 && e2eRatio > 1.05) return false;
  // Otherwise E2E gate passes (E2E not regressed >5% vs fastest)
  return e2eRatio <= 1.05;
}
