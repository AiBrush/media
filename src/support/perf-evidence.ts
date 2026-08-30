/**
 * Cold/warm timing + p95/dispersion evidence helpers (REQUIREMENTS §8.2 — 0.2).
 *
 * Every benchmark MUST include warm-up followed by at least 30 recorded samples or enough for a
 * stable confidence interval, and the report MUST include median, p95, dispersion, input/output
 * throughput, startup time, and main-thread long-task time. This module is the pure, Node-testable
 * math the runner and future CI use — no browser APIs, no fixture branching.
 */

export interface TimingSample {
  readonly durationMs: number;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
}

export interface TimingEvidence {
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly meanMs: number;
  readonly stdevMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly dispersion: number; // (p95 - median) / median, 0 when median 0
  readonly throughput?: { readonly inBytesPerSec?: number; readonly outBytesPerSec?: number };
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) throw new RangeError('percentile requires at least one sample');
  if (p <= 0) return sortedValues[0] as number;
  if (p >= 1) return sortedValues.at(-1) as number;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.min(index, sortedValues.length - 1)] as number;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: readonly number[], meanValue: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - meanValue) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Build `TimingEvidence` from at least 30 samples (or fewer when the caller explicitly opts into
 * a smaller stable-interval check — the function itself enforces the 30-sample gate when `require30`
 * is true, which is the CI default).
 */
export function timingEvidence(
  samples: readonly TimingSample[],
  options: { require30?: boolean; totalBytesIn?: number; totalBytesOut?: number } = {},
): TimingEvidence {
  const require30 = options.require30 ?? true;
  if (require30 && samples.length < 30) {
    throw new RangeError(`timing evidence requires at least 30 samples, got ${samples.length}`);
  }
  if (samples.length === 0) throw new RangeError('timing evidence requires at least one sample');
  const durations = samples.map((s) => s.durationMs);
  for (const d of durations) {
    if (!Number.isFinite(d) || d < 0) throw new RangeError(`invalid durationMs ${d}`);
  }
  const s = sorted(durations);
  const median = percentile(s, 0.5);
  const p95 = percentile(s, 0.95);
  const m = mean(durations);
  const sd = stdev(durations, m);
  const dispersion = median === 0 ? 0 : (p95 - median) / median;
  const totalDurationSec = durations.reduce((a, b) => a + b, 0) / 1000;
  const inBytes = options.totalBytesIn ?? samples.reduce((a, b) => a + (b.bytesIn ?? 0), 0);
  const outBytes = options.totalBytesOut ?? samples.reduce((a, b) => a + (b.bytesOut ?? 0), 0);
  const throughput =
    totalDurationSec > 0 && (inBytes > 0 || outBytes > 0)
      ? {
          ...(inBytes > 0 ? { inBytesPerSec: inBytes / totalDurationSec } : {}),
          ...(outBytes > 0 ? { outBytesPerSec: outBytes / totalDurationSec } : {}),
        }
      : undefined;
  return {
    count: samples.length,
    medianMs: median,
    p95Ms: p95,
    meanMs: m,
    stdevMs: sd,
    minMs: s[0] as number,
    maxMs: s.at(-1) as number,
    dispersion,
    ...(throughput ? { throughput } : {}),
  };
}

/** Cold vs warm evidence: first sample is cold start, rest are warm throughput. */
export function coldWarmEvidence(samples: readonly TimingSample[]): {
  cold: TimingEvidence;
  warm: TimingEvidence;
} {
  if (samples.length < 31)
    throw new RangeError('cold/warm evidence requires at least 31 samples (1 cold + 30 warm)');
  const cold = timingEvidence([samples[0] as TimingSample], { require30: false });
  const warm = timingEvidence(samples.slice(1), { require30: true });
  return { cold, warm };
}
