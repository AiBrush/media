/**
 * Process-level memory method + isolated vs whole-process delta (REQUIREMENTS §8.4 — 0.8).
 *
 * Browser memory APIs vary (`performance.memory`, `performance.measureUserAgentSpecificMemory`,
 * or none). Every report MUST name the measurement method and include process-level evidence
 * where reproducible. An unavailable metric is “not measured,” never zero. The 300 MB
 * attribution artifact arises when a whole-process heap snapshot is attributed to a single
 * operation; the isolated delta (operation heap growth beyond browser/codec baseline) avoids it.
 */

export type MemoryMethod = 'performance.memory' | 'measureUserAgentSpecificMemory' | 'not-measured';

export interface MemoryEvidence {
  readonly method: MemoryMethod;
  readonly baselineBytes?: number;
  readonly peakBytes?: number;
  readonly deltaBytes?: number; // peak - baseline, isolated to operation
  readonly wholeProcessBytes?: number;
}

/**
 * Describe the memory method available in this environment. Pure and never throws.
 */
export function memoryMethod(): MemoryMethod {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g['performance'] === 'object' && g['performance'] !== null) {
    const perf = g['performance'] as Record<string, unknown>;
    if (typeof perf['memory'] === 'object' && perf['memory'] !== null) return 'performance.memory';
    if (typeof perf['measureUserAgentSpecificMemory'] === 'function')
      return 'measureUserAgentSpecificMemory';
  }
  return 'not-measured';
}

/**
 * Compute isolated delta. Returns undefined when method is not-measured or inputs are invalid,
 * never huge-alloc. The whole-process delta is `peak - baseline`; isolated delta is the same
 * but explicitly labeled as operation growth beyond baseline, avoiding whole-process attribution.
 */
export function isolatedMemoryDelta(
  baselineBytes: number | undefined,
  peakBytes: number | undefined,
  wholeProcessBytes?: number,
): number | undefined {
  if (baselineBytes === undefined || peakBytes === undefined) return undefined;
  if (!Number.isSafeInteger(baselineBytes) || !Number.isSafeInteger(peakBytes)) return undefined;
  if (baselineBytes < 0 || peakBytes < 0) return undefined;
  const delta = peakBytes - baselineBytes;
  if (!Number.isSafeInteger(delta) || delta < 0) return undefined;
  // wholeProcessBytes is advisory; it must not be attributed to the operation
  if (
    wholeProcessBytes !== undefined &&
    (!Number.isSafeInteger(wholeProcessBytes) || wholeProcessBytes < 0)
  )
    return undefined;
  return delta;
}

/**
 * Build a `MemoryEvidence` record. Validates inputs, never huge-alloc. When method is
 * not-measured, all byte fields remain undefined (honest “not measured,” never zero).
 */
export function memoryEvidence(
  baselineBytes?: number,
  peakBytes?: number,
  wholeProcessBytes?: number,
): MemoryEvidence {
  const method = memoryMethod();
  if (method === 'not-measured') return { method };
  if (baselineBytes === undefined || peakBytes === undefined) return { method };
  const delta = isolatedMemoryDelta(baselineBytes, peakBytes, wholeProcessBytes);
  if (delta === undefined) return { method };
  return {
    method,
    baselineBytes,
    peakBytes,
    deltaBytes: delta,
    ...(wholeProcessBytes === undefined ? {} : { wholeProcessBytes }),
  };
}
