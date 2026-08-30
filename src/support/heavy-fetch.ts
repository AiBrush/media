/**
 * Heavy-fetch planning / preload exposure (REQUIREMENTS §8.3 — 3.5).
 *
 * A route MUST NOT fetch a module larger than 1 MiB without exposing that
 * cost during planning or preload. This module is the pure, Node-testable
 * invariant for that gate — no filesystem, no fixture branching, never
 * huge-alloc, deterministic. The runner can feed it a route's JS+WASM bytes
 * and assert that heavy costs are declared before first successful output.
 */

export const HEAVY_FETCH_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB

export interface RouteFetchCost {
  readonly jsBytes: number;
  readonly wasmBytes: number;
  readonly totalBytes: number;
}

export interface HeavyExposure {
  readonly requiresExposure: boolean;
  readonly exposed: boolean;
  readonly passes: boolean;
  readonly method: 'none' | 'planning' | 'preload' | 'both';
}

/**
 * Build a validated RouteFetchCost. Throws RangeError on malformed, never huge-alloc.
 */
export function routeFetchCost(jsBytes: number, wasmBytes: number): RouteFetchCost {
  if (!Number.isSafeInteger(jsBytes) || jsBytes < 0)
    throw new RangeError('jsBytes must be safe integer >=0');
  if (!Number.isSafeInteger(wasmBytes) || wasmBytes < 0)
    throw new RangeError('wasmBytes must be safe integer >=0');
  if (jsBytes > 10 * 1024 * 1024) throw new RangeError('jsBytes exceeds plausible 10 MiB');
  if (wasmBytes > 10 * 1024 * 1024) throw new RangeError('wasmBytes exceeds plausible 10 MiB');
  const total = jsBytes + wasmBytes;
  if (!Number.isSafeInteger(total)) throw new RangeError('total overflow');
  return Object.freeze({ jsBytes, wasmBytes, totalBytes: total });
}

/** Whether a cost requires exposure (>1 MiB). */
export function requiresHeavyExposure(cost: RouteFetchCost): boolean {
  if (cost === null || typeof cost !== 'object') throw new RangeError('cost must be object');
  if (!Number.isSafeInteger(cost.totalBytes) || cost.totalBytes < 0)
    throw new RangeError('totalBytes invalid');
  return cost.totalBytes > HEAVY_FETCH_THRESHOLD_BYTES;
}

/**
 * Evaluate exposure for a route. `opts` declares whether the cost was
 * surfaced during planning (`planningExposed`) or via `preload()` (`preloadDeclared`).
 * Returns stable `HeavyExposure` with `passes` true when the §8.3 gate is met.
 */
export function heavyExposure(
  cost: RouteFetchCost,
  opts: { planningExposed?: boolean; preloadDeclared?: boolean } = {},
): HeavyExposure {
  if (cost === null || typeof cost !== 'object') throw new RangeError('cost must be object');
  if (!Number.isSafeInteger(cost.totalBytes) || cost.totalBytes < 0)
    throw new RangeError('totalBytes invalid');
  if (opts === null || typeof opts !== 'object') throw new RangeError('opts must be object');
  if (opts.planningExposed !== undefined && typeof opts.planningExposed !== 'boolean')
    throw new RangeError('planningExposed must be boolean');
  if (opts.preloadDeclared !== undefined && typeof opts.preloadDeclared !== 'boolean')
    throw new RangeError('preloadDeclared must be boolean');
  const planningExposed = opts.planningExposed ?? false;
  const preloadDeclared = opts.preloadDeclared ?? false;
  const requiresExposure = cost.totalBytes > HEAVY_FETCH_THRESHOLD_BYTES;
  const exposed = planningExposed || preloadDeclared;
  let method: HeavyExposure['method'] = 'none';
  if (planningExposed && preloadDeclared) method = 'both';
  else if (planningExposed) method = 'planning';
  else if (preloadDeclared) method = 'preload';
  const passes = !requiresExposure || exposed;
  return Object.freeze({ requiresExposure, exposed, passes, method });
}

/**
 * Assert that a heavy fetch is exposed. Throws RangeError with gate context
 * when `cost` >1 MiB but neither planning nor preload exposed it.
 */
export function assertHeavyFetchExposed(
  cost: RouteFetchCost,
  opts: { planningExposed?: boolean; preloadDeclared?: boolean } = {},
): void {
  const exp = heavyExposure(cost, opts);
  if (!exp.passes)
    throw new RangeError(
      `route ${cost.totalBytes} exceeds 1 MiB without planning/preload exposure`,
    );
}

/**
 * Totally-ordered planning token for a heavy route — surfaced before first
 * output. Pure, deterministic, never huge-alloc.
 */
export function planningTokenForHeavyRoute(cost: RouteFetchCost): string {
  if (cost === null || typeof cost !== 'object') throw new RangeError('cost must be object');
  if (!Number.isSafeInteger(cost.totalBytes) || cost.totalBytes < 0)
    throw new RangeError('totalBytes invalid');
  if (cost.totalBytes <= HEAVY_FETCH_THRESHOLD_BYTES) return 'no-heavy-fetch';
  return `heavy-fetch:${cost.jsBytes}+${cost.wasmBytes}=${cost.totalBytes}`;
}
