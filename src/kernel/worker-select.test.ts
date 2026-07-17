/**
 * Worker bridge SELECTION (BUILD §2/§6; ADR-019/ADR-087, doc 06 §4) — the pure decision the engine makes
 * from `CreateMediaOptions.worker` + `Worker` availability: route the heavy decode→encode graph to a
 * worker, or stay inline (the honest fallback). Tested directly so the policy is provable in Node without
 * spawning a real `Worker` (which Node lacks for module workers in this harness). Offload is OPT-IN:
 *
 *  - `worker` unset / `worker:false`             → inline (the safe default / explicit opt-out)
 *  - `worker:true` + `Worker` present            → offload (explicit opt-in)
 *  - `worker:{pool:N}` + `Worker` present        → offload, pool size N (N≥1; clamped)
 *  - `Worker` absent                             → inline (honest fallback, Prime Directive 6)
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type WorkerSelection, resolvePoolSize, selectWorkerMode } from './worker-bridge.ts';

function select(
  worker: boolean | { pool?: number } | undefined,
  workerExists: boolean,
): WorkerSelection {
  return selectWorkerMode(worker, workerExists);
}

describe('selectWorkerMode', () => {
  it('defaults to INLINE when worker is unset (offload is opt-in), even if Worker exists', () => {
    expect(select(undefined, true)).toBe('inline');
  });

  it('matches its own JSDoc: the doc states the opt-in reality, never "unset defaults to offload"', () => {
    // Punch-list 2 (doc/code drift): the leading JSDoc once claimed `true`/`{pool}`/unset "default to
    // offload" while the body returns 'inline' for unset. Pin BOTH sides: the behavior…
    expect(selectWorkerMode(undefined, true)).toBe('inline');
    expect(selectWorkerMode(true, true)).toBe('offload');
    // …and the prose. The doc must describe offload as opt-in and must not claim an unset default
    // offloads (the exact drift this guards against).
    const source = readFileSync(new URL('./worker-mode.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/opt-in/i);
    expect(source).not.toMatch(/unset\s+default(?:s)?\s+to\s+offload/i);
    expect(source).not.toMatch(/`\{pool\}`\/unset default to offload/);
  });

  it('offloads when worker:true and Worker exists', () => {
    expect(select(true, true)).toBe('offload');
  });

  it('offloads when worker:{pool} and Worker exists', () => {
    expect(select({ pool: 3 }, true)).toBe('offload');
  });

  it('stays inline when worker:false (explicit opt-out), even if Worker exists', () => {
    expect(select(false, true)).toBe('inline');
  });

  it('stays inline when no Worker exists (honest fallback), regardless of the opt', () => {
    expect(select(true, false)).toBe('inline');
    expect(select(undefined, false)).toBe('inline');
    expect(select({ pool: 4 }, false)).toBe('inline');
  });
});

describe('resolvePoolSize', () => {
  it('reads an explicit pool size', () => {
    expect(resolvePoolSize({ pool: 4 })).toBe(4);
  });

  it('clamps a non-positive or fractional pool size to at least 1', () => {
    expect(resolvePoolSize({ pool: 0 })).toBe(1);
    expect(resolvePoolSize({ pool: -2 })).toBe(1);
    expect(resolvePoolSize({ pool: 2.7 })).toBe(2);
  });

  it('defaults to 1 for worker:true / unset / worker:false (single worker, no fan-out)', () => {
    expect(resolvePoolSize(true)).toBe(1);
    expect(resolvePoolSize(undefined)).toBe(1);
    expect(resolvePoolSize(false)).toBe(1);
    expect(resolvePoolSize({})).toBe(1);
  });
});
