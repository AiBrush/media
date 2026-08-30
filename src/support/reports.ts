/**
 * Generated report inventory (REQUIREMENTS §11 — 4.7).
 *
 * Release MUST publish generated support, performance, bundle, memory,
 * license, and known-limit reports. This module is the pure, Node-testable
 * inventory for that gate — no filesystem, no fixture branching, never
 * huge-alloc, deterministic.
 */

export type ReportType =
  | 'support'
  | 'performance'
  | 'bundle'
  | 'memory'
  | 'license'
  | 'known-limit';

export const REQUIRED_REPORTS: readonly ReportType[] = Object.freeze([
  'support',
  'performance',
  'bundle',
  'memory',
  'license',
  'known-limit',
] as const);

export interface ReportEntry {
  readonly type: ReportType;
  readonly generatedAtIso: string;
  readonly sha256: string; // sha256:...
  readonly bytes: number;
}

export function isReportType(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('report type must be string');
  if (value.length > 30) throw new RangeError('report type too long');
  return (REQUIRED_REPORTS as readonly string[]).includes(value);
}

export function isValidReportEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const r = entry as Partial<ReportEntry>;
  if (typeof r.type !== 'string' || !isReportType(r.type)) return false;
  if (typeof r.generatedAtIso !== 'string' || Number.isNaN(Date.parse(r.generatedAtIso)))
    return false;
  if (typeof r.sha256 !== 'string' || !r.sha256.startsWith('sha256:') || r.sha256.length < 10)
    return false;
  if (
    typeof r.bytes !== 'number' ||
    !Number.isSafeInteger(r.bytes) ||
    r.bytes < 0 ||
    r.bytes > 10 * 1024 * 1024
  )
    return false;
  return true;
}

export function assertReportsPublished(
  reports: unknown,
): asserts reports is readonly ReportEntry[] {
  if (!Array.isArray(reports)) throw new RangeError('reports must be array');
  if (reports.length > 20) throw new RangeError('too many reports');
  for (const e of reports) if (!isValidReportEntry(e)) throw new RangeError('invalid report entry');
  const types = new Set((reports as ReportEntry[]).map((r) => r.type));
  for (const req of REQUIRED_REPORTS)
    if (!types.has(req)) throw new RangeError(`report not published: ${req}`);
}

export function reportsPublished(reports: readonly ReportEntry[]): boolean {
  try {
    assertReportsPublished(reports);
    return true;
  } catch {
    return false;
  }
}

export function minimalReports(): readonly ReportEntry[] {
  const iso = new Date().toISOString();
  return Object.freeze(
    REQUIRED_REPORTS.map((type) =>
      Object.freeze({
        type,
        generatedAtIso: iso,
        sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        bytes: 1024,
      } as ReportEntry),
    ),
  );
}
