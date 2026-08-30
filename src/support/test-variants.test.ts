import { describe, expect, it } from 'vitest';
import { REQUIRED_VARIANTS, assertAllVariantsCovered, isVariantKind, minimalVariants, variantsCovered } from './test-variants.ts';

describe('required test variants — C2 unit/property/boundary/malformed/randomized', () => {
  it('requires 5 variants', () => {
    expect(REQUIRED_VARIANTS).toEqual(['unit', 'property', 'boundary', 'malformed', 'randomized']);
    expect(REQUIRED_VARIANTS.length).toBe(5);
    for (const v of REQUIRED_VARIANTS) expect(isVariantKind(v)).toBe(true);
    expect(isVariantKind('unknown')).toBe(false);
    expect(minimalVariants().length).toBe(5);
    expect(() => assertAllVariantsCovered([...REQUIRED_VARIANTS])).not.toThrow();
    expect(variantsCovered([...REQUIRED_VARIANTS])).toBe(true);
  });

  it('fails when variant missing', () => {
    const missing = REQUIRED_VARIANTS.filter((v) => v !== 'randomized');
    expect(() => assertAllVariantsCovered(missing)).toThrow(RangeError);
    expect(variantsCovered(missing)).toBe(false);
    expect(() => assertAllVariantsCovered([])).toThrow(RangeError);
  });

  it('validates variant kind', () => {
    expect(isVariantKind('unit')).toBe(true);
    expect(isVariantKind('property')).toBe(true);
    expect(() => assertAllVariantsCovered(['unit', 'property', 'boundary', 'malformed', 'randomized', 'extra' as never])).toThrow(RangeError);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const shuffled = [...REQUIRED_VARIANTS].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(variantsCovered(shuffled)).toBe(true);
      expect(isVariantKind(REQUIRED_VARIANTS[i % REQUIRED_VARIANTS.length]!)).toBe(true);
    }
  });

  it('boundary: exactly 5 vs 4', () => {
    expect(minimalVariants().length).toBe(5);
    expect(() => assertAllVariantsCovered(minimalVariants() as never)).not.toThrow();
    expect(() => assertAllVariantsCovered(REQUIRED_VARIANTS.slice(0, 4) as never)).toThrow(RangeError);
    expect(isVariantKind('')).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isVariantKind(null as never)).toThrow(RangeError);
    expect(() => isVariantKind('x'.repeat(30) as never)).toThrow(RangeError);
    expect(() => assertAllVariantsCovered(null as never)).toThrow(RangeError);
    expect(() => assertAllVariantsCovered([null as never])).toThrow(RangeError);
    expect(() => assertAllVariantsCovered(Array.from({ length: 21 }, () => 'unit') as never)).toThrow(RangeError);
    expect(isVariantKind('unknown')).toBe(false);
  });
});
