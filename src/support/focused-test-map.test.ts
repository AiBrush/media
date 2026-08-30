import { describe, expect, it } from 'vitest';
import { assertRelevantFamilyCovered, familiesForChanges, relevantFamilyForPath } from './focused-test-map.ts';

describe('focused test → relevant family — C3', () => {
  it('maps src paths to families', () => {
    expect(relevantFamilyForPath('src/drivers/mp4/parse.ts')).toBe('probe');
    expect(relevantFamilyForPath('src/drivers/webm/ebml-write.ts')).toBe('mux');
    expect(relevantFamilyForPath('src/dsp/resample.ts')).toBe('transcode');
    expect(relevantFamilyForPath('src/crypto/aes.ts')).toBe('encryption');
    expect(relevantFamilyForPath('src/support/perf-evidence.ts')).toBe('performance');
    expect(relevantFamilyForPath('src/unknown/file.ts')).toBe('probe');
  });

  it('familiesForChanges deduplicates and sorts', () => {
    expect(familiesForChanges(['src/drivers/mp4/a.ts', 'src/drivers/mp4/b.ts'])).toEqual(['probe']);
    expect(familiesForChanges(['src/drivers/mp4/a.ts', 'src/dsp/x.ts'])).toEqual(['probe', 'transcode']);
    expect(familiesForChanges([])).toEqual([]);
  });

  it('asserts covered families', () => {
    expect(() => assertRelevantFamilyCovered(['src/drivers/mp4/a.ts'], ['probe'])).not.toThrow();
    expect(() => assertRelevantFamilyCovered(['src/drivers/mp4/a.ts', 'src/dsp/x.ts'], ['probe'])).toThrow(RangeError);
    expect(() => assertRelevantFamilyCovered(['src/drivers/mp4/a.ts', 'src/dsp/x.ts'], ['probe', 'transcode'])).not.toThrow();
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const paths = i % 2 === 0 ? ['src/drivers/mp4/a.ts'] : ['src/dsp/x.ts', 'src/crypto/aes.ts'];
      const fams = familiesForChanges(paths);
      expect(fams.length).toBeGreaterThan(0);
      expect(fams.length).toBeLessThanOrEqual(2);
      expect(() => assertRelevantFamilyCovered(paths, fams as never)).not.toThrow();
    }
  });

  it('boundary: empty vs single', () => {
    expect(familiesForChanges([])).toEqual([]);
    expect(() => assertRelevantFamilyCovered([], [])).not.toThrow();
    expect(relevantFamilyForPath('')).toBe('probe');
    expect(() => assertRelevantFamilyCovered(['src/drivers/mp4/a.ts'], [] as never)).toThrow(RangeError);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => relevantFamilyForPath(null as never)).toThrow(RangeError);
    expect(() => relevantFamilyForPath('x'.repeat(600) as never)).toThrow(RangeError);
    expect(() => familiesForChanges(null as never)).toThrow(RangeError);
    expect(() => familiesForChanges(Array.from({ length: 101 }, () => 'a') as never)).toThrow(RangeError);
    expect(() => assertRelevantFamilyCovered(null as never, [] as never)).toThrow(RangeError);
    expect(() => assertRelevantFamilyCovered(['a'], [null as never] as never)).toThrow(RangeError);
    expect(() => assertRelevantFamilyCovered(Array.from({ length: 101 }, () => 'a') as never, [] as never)).toThrow(RangeError);
  });
});
