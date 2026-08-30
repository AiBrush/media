/**
 * Before/after evidence per cycle (REQUIREMENTS §11 — C5).
 *
 * Every cycle MUST record before/after PASS counts and file:line refs,
 * then immediately continue with the next highest-impact feature. This
 * module is the pure, Node-testable recorder — no filesystem, no fixture
 * branching, never huge-alloc, deterministic.
 */

export interface CycleEvidence {
  readonly cycle: number;
  readonly beforePass: number;
  readonly afterPass: number;
  readonly beforeFiles: number;
  readonly afterFiles: number;
  readonly deltaPass: number;
  readonly deltaFiles: number;
  readonly refs: readonly string[]; // 5-10 file:line refs
  readonly timestampIso: string;
}

export function createCycleEvidence(params: {
  cycle: number;
  beforePass: number;
  afterPass: number;
  beforeFiles: number;
  afterFiles: number;
  refs: readonly string[];
}): CycleEvidence {
  if (typeof params !== 'object' || params === null) throw new RangeError('params must be object');
  const { cycle, beforePass, afterPass, beforeFiles, afterFiles, refs } = params;
  if (!Number.isSafeInteger(cycle) || cycle < 0 || cycle > 10000) throw new RangeError('cycle must be safe integer 0..10000');
  for (const n of [beforePass, afterPass, beforeFiles, afterFiles]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new RangeError('counts must be safe integer 0..100000');
  }
  if (!Array.isArray(refs) || refs.length < 5 || refs.length > 10) throw new RangeError('refs must be 5-10 file:line entries');
  for (const r of refs) {
    if (typeof r !== 'string' || !r.includes(':') || r.length > 200) throw new RangeError(`invalid ref ${r}`);
  }
  if (afterPass < beforePass) throw new RangeError('afterPass must be >= beforePass');
  if (afterFiles < beforeFiles) throw new RangeError('afterFiles must be >= beforeFiles');
  return Object.freeze({
    cycle,
    beforePass,
    afterPass,
    beforeFiles,
    afterFiles,
    deltaPass: afterPass - beforePass,
    deltaFiles: afterFiles - beforeFiles,
    refs: Object.freeze([...refs]),
    timestampIso: new Date().toISOString(),
  });
}

export function isValidCycleEvidence(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Partial<CycleEvidence>;
  if (typeof c.cycle !== 'number' || !Number.isSafeInteger(c.cycle)) return false;
  if (typeof c.beforePass !== 'number' || typeof c.afterPass !== 'number') return false;
  if (typeof c.deltaPass !== 'number' || c.deltaPass !== c.afterPass - c.beforePass) return false;
  if (!Array.isArray(c.refs) || c.refs.length < 5 || c.refs.length > 10) return false;
  if (typeof c.timestampIso !== 'string' || Number.isNaN(Date.parse(c.timestampIso))) return false;
  return true;
}

export function assertCycleEvidence(ev: unknown): asserts ev is CycleEvidence {
  if (!isValidCycleEvidence(ev)) throw new RangeError('invalid cycle evidence');
}
