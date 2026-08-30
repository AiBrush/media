/**
 * Required test variants per change (REQUIREMENTS §8.1 — C2).
 *
 * Every fixed defect MUST add a minimal regression test plus at least one
 * generalized or mutated variant. Every parser and muxer MUST pass
 * round-trip/property tests, truncation tests, boundary-size tests, and
 * fuzzing. This module is the pure, Node-testable inventory — no browser
 * APIs, no fixture branching, never huge-alloc, deterministic.
 */

export type VariantKind = 'unit' | 'property' | 'boundary' | 'malformed' | 'randomized';

export const REQUIRED_VARIANTS: readonly VariantKind[] = Object.freeze([
  'unit',
  'property',
  'boundary',
  'malformed',
  'randomized',
] as const);

export function isVariantKind(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('variant must be string');
  if (value.length > 20) throw new RangeError('variant too long');
  return (REQUIRED_VARIANTS as readonly string[]).includes(value);
}

export function assertAllVariantsCovered(variants: readonly string[]): void {
  if (!Array.isArray(variants)) throw new RangeError('variants must be array');
  if (variants.length > 20) throw new RangeError('too many variants');
  const set = new Set(variants);
  for (const req of REQUIRED_VARIANTS) if (!set.has(req)) throw new RangeError(`variant not covered: ${req}`);
  for (const v of variants) if (!isVariantKind(v)) throw new RangeError(`unknown variant ${v}`);
}

export function variantsCovered(variants: readonly string[]): boolean {
  try {
    assertAllVariantsCovered(variants);
    return true;
  } catch {
    return false;
  }
}

export function minimalVariants(): readonly VariantKind[] {
  return REQUIRED_VARIANTS;
}
