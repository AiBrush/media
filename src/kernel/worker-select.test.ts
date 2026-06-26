/**
 * Worker bridge SELECTION (BUILD §2/§6; ADR-019, doc 06 §4) — the pure decision the engine makes from
 * `CreateMediaOptions.worker` + `Worker` availability: route the heavy decode→encode graph to a worker,
 * or stay inline (the honest fallback). Tested directly so the policy is provable in Node without spawning
 * a real `Worker` (which Node lacks for module workers in this harness).
 *
 *  - `worker:true` (default) + `Worker` present  → offload
 *  - `worker:false`                              → inline (explicit opt-out)
 *  - `Worker` absent                             → inline (honest fallback, Prime Directive 6)
 *  - `worker:{pool:N}`                           → offload, pool size N (N≥1; clamped)
 */

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
