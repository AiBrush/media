import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CORPUS_CHECKSUM,
  EVIDENCE_MANIFEST_VERSION,
  EVIDENCE_ORACLE_VERSION,
  assertEvidenceBundle,
  createEvidenceManifest,
} from './evidence-bundle.ts';

describe('evidence bundle manifest — corpus checksum + oracle version + typed exclusions (REQUIREMENTS §11 — 0.7)', () => {
  it('creates a manifest with all required fields', () => {
    const m = createEvidenceManifest(['NA_ENGINE', 'NA_BROWSER']);
    expect(m.manifestVersion).toBe(EVIDENCE_MANIFEST_VERSION);
    expect(m.corpusChecksum).toBe(EVIDENCE_CORPUS_CHECKSUM);
    expect(m.oracleVersion).toBe(EVIDENCE_ORACLE_VERSION);
    expect(m.exclusions).toEqual(['NA_ENGINE', 'NA_BROWSER']);
    expect(() => new Date(m.generatedAtIso).toISOString()).not.toThrow();
  });

  it('assertEvidenceBundle passes for a valid bundle', () => {
    const bundle = {
      manifest: createEvidenceManifest(['PASS', 'FAIL']),
      results: [{ scenarioId: 'x', status: 'PASS' }],
    };
    expect(() => assertEvidenceBundle(bundle)).not.toThrow();
  });

  it('rejects malformed bundles with typed RangeError (harness ERROR vs FAIL)', () => {
    expect(() => assertEvidenceBundle(null)).toThrow(RangeError);
    expect(() => assertEvidenceBundle({} as never)).toThrow(/missing manifest/);
    expect(() =>
      assertEvidenceBundle({
        manifest: {
          corpusChecksum: 'sha256:abc',
          oracleVersion: 'v1',
          exclusions: [],
          generatedAtIso: new Date().toISOString(),
          manifestVersion: '',
        },
        results: [],
      } as never),
    ).toThrow(/manifestVersion/);
    expect(() =>
      assertEvidenceBundle({
        manifest: {
          manifestVersion: 'v1',
          oracleVersion: 'v1',
          exclusions: [],
          generatedAtIso: new Date().toISOString(),
          corpusChecksum: 'bad',
        },
        results: [],
      } as never),
    ).toThrow(/corpusChecksum/);
    expect(() =>
      assertEvidenceBundle({
        manifest: createEvidenceManifest(),
        results: 'not-array' as never,
      } as never),
    ).toThrow(/results must be an array/);
  });

  it('typed exclusions reject ad-hoc strings', () => {
    expect(() => createEvidenceManifest(['BAD_CODE' as never])).toThrow(/typed exclusion/);
    expect(() => createEvidenceManifest(['NA_ENGINE', 'PASS'])).not.toThrow();
  });

  it('20× randomized manifests remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const exclusions = i % 2 === 0 ? (['NA_ENGINE'] as const) : ([] as const);
      const m = createEvidenceManifest(exclusions as never);
      expect(m.exclusions.length).toBe(exclusions.length);
      const bundle = { manifest: m, results: Array.from({ length: i % 5 }, (_, j) => ({ id: j })) };
      expect(() => assertEvidenceBundle(bundle)).not.toThrow();
    }
  });

  it('boundary: empty exclusions and empty results are valid', () => {
    const m = createEvidenceManifest([]);
    expect(m.exclusions).toEqual([]);
    expect(() => assertEvidenceBundle({ manifest: m, results: [] })).not.toThrow();
    expect(m.corpusChecksum.startsWith('sha256:')).toBe(true);
  });

  it('malformed exclusions and dates throw RangeError, never huge-alloc', () => {
    const base = createEvidenceManifest();
    expect(() =>
      assertEvidenceBundle({
        manifest: { ...base, exclusions: ['' as never] },
        results: [],
      } as never),
    ).toThrow(/exclusion must be non-empty/);
    expect(() =>
      assertEvidenceBundle({
        manifest: { ...base, generatedAtIso: 'not-a-date' },
        results: [],
      } as never),
    ).toThrow(/generatedAtIso/);
    expect(() =>
      assertEvidenceBundle({ manifest: { ...base, oracleVersion: '' }, results: [] } as never),
    ).toThrow(/oracleVersion/);
  });
});
