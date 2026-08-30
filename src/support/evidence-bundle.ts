/**
 * Evidence bundle manifest helpers (REQUIREMENTS §11, §10 — 0.7).
 *
 * Every candidate release MUST publish a machine-readable evidence bundle containing
 * execution manifest, corpus checksum, oracle version, and typed exclusions.
 * This module is the pure, Node-testable source for those fields — no browser APIs,
 * no fixture branching. The engine's `Output`/`ExecutionReport` can embed the
 * manifest via `createEvidenceManifest()`, and CI can validate it via
 * `assertEvidenceBundle()`.
 */

export const EVIDENCE_MANIFEST_VERSION = 'aibrush-evidence-manifest@1';
export const EVIDENCE_ORACLE_VERSION = 'aibrush-oracle@1';
export const EVIDENCE_CORPUS_CHECKSUM =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

export interface EvidenceManifest {
  readonly manifestVersion: string;
  readonly corpusChecksum: string;
  readonly oracleVersion: string;
  readonly exclusions: readonly string[]; // typed exclusion codes, e.g. 'NA_ENGINE', 'NA_BROWSER'
  readonly generatedAtIso: string;
}

export interface EvidenceBundle {
  readonly manifest: EvidenceManifest;
  readonly results: readonly unknown[];
}

/**
 * Create a minimal evidence manifest. `exclusions` are typed (e.g. 'NA_ENGINE') — callers
 * must not invent ad-hoc strings; the test suite asserts the allowed set.
 */
export function createEvidenceManifest(
  exclusions: readonly string[] = [],
  overrides: Partial<EvidenceManifest> = {},
): EvidenceManifest {
  const allowed = new Set(['NA_ENGINE', 'NA_ASSET', 'NA_BROWSER', 'FAIL', 'PASS', 'ERROR']);
  for (const code of exclusions) {
    if (!allowed.has(code))
      throw new RangeError(
        `typed exclusion must be one of ${[...allowed].join(', ')}, got '${code}'`,
      );
  }
  return {
    manifestVersion: EVIDENCE_MANIFEST_VERSION,
    corpusChecksum: EVIDENCE_CORPUS_CHECKSUM,
    oracleVersion: EVIDENCE_ORACLE_VERSION,
    exclusions: [...exclusions],
    generatedAtIso: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Validate that an evidence bundle contains the required manifest fields and typed exclusions.
 * Throws `RangeError` on malformed, never huge-alloc.
 */
export function assertEvidenceBundle(bundle: unknown): asserts bundle is EvidenceBundle {
  if (typeof bundle !== 'object' || bundle === null)
    throw new RangeError('evidence bundle must be an object');
  const b = bundle as Record<string, unknown>;
  if (typeof b['manifest'] !== 'object' || b['manifest'] === null)
    throw new RangeError('evidence bundle missing manifest');
  const m = b['manifest'] as Record<string, unknown>;
  if (typeof m['manifestVersion'] !== 'string' || !m['manifestVersion'])
    throw new RangeError('manifestVersion is required');
  if (
    typeof m['corpusChecksum'] !== 'string' ||
    !(m['corpusChecksum'] as string).startsWith('sha256:')
  )
    throw new RangeError('corpusChecksum must be sha256:…');
  if (typeof m['oracleVersion'] !== 'string' || !m['oracleVersion'])
    throw new RangeError('oracleVersion is required');
  if (!Array.isArray(m['exclusions'])) throw new RangeError('exclusions must be an array');
  for (const code of m['exclusions'] as unknown[]) {
    if (typeof code !== 'string' || !code)
      throw new RangeError(`exclusion must be non-empty string, got ${String(code)}`);
  }
  if (
    typeof m['generatedAtIso'] !== 'string' ||
    Number.isNaN(Date.parse(m['generatedAtIso'] as string))
  )
    throw new RangeError('generatedAtIso must be valid ISO date');
  if (!Array.isArray(b['results'])) throw new RangeError('results must be an array');
}
