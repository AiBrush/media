import { describe, expect, it } from 'vitest';
import {
  REQUIRED_REPORTS,
  assertReportsPublished,
  isReportType,
  isValidReportEntry,
  minimalReports,
  reportsPublished,
} from './reports.ts';

describe('generated reports — 4.7 support/performance/bundle/memory/license/known-limit', () => {
  it('requires 6 reports', () => {
    expect(REQUIRED_REPORTS).toEqual([
      'support',
      'performance',
      'bundle',
      'memory',
      'license',
      'known-limit',
    ]);
    expect(REQUIRED_REPORTS.length).toBe(6);
    for (const t of REQUIRED_REPORTS) expect(isReportType(t)).toBe(true);
    expect(isReportType('unknown')).toBe(false);
    const reps = minimalReports();
    expect(reps.length).toBe(6);
    for (const r of reps) expect(isValidReportEntry(r)).toBe(true);
    expect(() => assertReportsPublished(reps)).not.toThrow();
    expect(reportsPublished(reps)).toBe(true);
  });

  it('fails when report missing', () => {
    const missing = minimalReports().filter((r) => r.type !== 'license');
    expect(() => assertReportsPublished(missing)).toThrow(RangeError);
    expect(reportsPublished(missing)).toBe(false);
    expect(reportsPublished([])).toBe(false);
  });

  it('validates entry fields', () => {
    const good = minimalReports()[0]!;
    expect(isValidReportEntry(good)).toBe(true);
    expect(isValidReportEntry({ ...good, sha256: 'bad' } as never)).toBe(false);
    expect(isValidReportEntry({ ...good, bytes: -1 } as never)).toBe(false);
    expect(isValidReportEntry({ ...good, generatedAtIso: 'not-a-date' } as never)).toBe(false);
    expect(isValidReportEntry(null)).toBe(false);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const reps = minimalReports();
      expect(reportsPublished(reps)).toBe(true);
      const shuffled = [...reps].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(reportsPublished(shuffled)).toBe(true);
      expect(isReportType(REQUIRED_REPORTS[i % REQUIRED_REPORTS.length]!)).toBe(true);
    }
  });

  it('boundary: exactly 6 vs 5, empty vs minimal', () => {
    expect(minimalReports().length).toBe(6);
    expect(() => assertReportsPublished(minimalReports().slice(0, 5) as never)).toThrow(RangeError);
    expect(() => assertReportsPublished([] as never)).toThrow(RangeError);
    expect(isReportType('')).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isReportType(null as never)).toThrow(RangeError);
    expect(() => isReportType('x'.repeat(40) as never)).toThrow(RangeError);
    expect(() => assertReportsPublished(null as never)).toThrow(RangeError);
    expect(() => assertReportsPublished([null as never])).toThrow(RangeError);
    expect(() =>
      assertReportsPublished(Array.from({ length: 21 }, () => minimalReports()[0]!) as never),
    ).toThrow(RangeError);
    expect(isValidReportEntry(null)).toBe(false);
    expect(
      isValidReportEntry({
        type: 'support',
        generatedAtIso: '2020-01-01T00:00:00.000Z',
        sha256: 'sha256:abc',
        bytes: Number.NaN,
      } as never),
    ).toBe(false);
  });
});
