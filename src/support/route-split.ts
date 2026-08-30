/**
 * Route split / dedup + tree-shakable entrypoints (REQUIREMENTS §8.3 — 3.4).
 *
 * Every feature must meet the route-size gate and remain independently
 * tree-shakable. The build emits a split graph (esbuild `splitting:true`);
 * a route's cost is the transitive closure of its entry, not the tarball sum,
 * and shared chunks are deduplicated (union, not sum). This module is the
 * pure, Node-testable invariant for that gate — no filesystem or fixture
 * branching, never huge-alloc, deterministic.
 */

export const EAGER_BUDGET_BYTES = 50 * 1024; // 50 KiB
export const TYPICAL_ROUTE_BUDGET_BYTES = 250 * 1024; // 250 KiB
export const HEAVY_FETCH_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB — must be exposed at planning

export const TREE_SHAKEABLE_ENTRYPOINTS: readonly string[] = Object.freeze([
  'index',
  'core',
  'image',
  'wav',
  'mp4-packet-info',
  'drivers/adts',
  'drivers/aiff',
  'drivers/avi',
  'drivers/caf',
  'drivers/flac',
  'drivers/hls',
  'drivers/mp3',
  'drivers/mp4',
  'drivers/mpegts',
  'drivers/ogg',
  'drivers/wav',
  'drivers/webm',
]);

const ENTRY_RE =
  /^(?:index|core|image|wav|mp4-packet-info|drivers\/(?:adts|aiff|avi|caf|flac|hls|mp3|mp4|mpegts|ogg|wav|webm))(?:\.js)?$/;

/**
 * Whether an entry is a public tree-shakable entrypoint.
 * Throws RangeError on non-string or absurdly long input (never huge-alloc).
 */
export function isTreeShakeableEntrypoint(entry: string): boolean {
  if (typeof entry !== 'string') throw new RangeError('entry must be string');
  if (entry.length > 256) throw new RangeError('entry too long');
  const normalized = entry.replace(/^\.\//, '');
  return ENTRY_RE.test(normalized);
}

/**
 * Validate that a route's JS closure size is within budget.
 * Throws RangeError on malformed or over-budget, never huge-alloc.
 */
export function assertRouteBudget(
  bytes: number,
  budget: number = TYPICAL_ROUTE_BUDGET_BYTES,
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new RangeError('bytes must be safe integer >=0');
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new RangeError('budget must be safe integer >0');
  if (bytes > 1024 * 1024 * 10) throw new RangeError('bytes exceeds plausible 10 MiB');
  if (bytes > budget) throw new RangeError(`route ${bytes} exceeds budget ${budget}`);
}

/** Eager-kernel budget check (50 KiB). */
export function assertEagerBudget(bytes: number): void {
  assertRouteBudget(bytes, EAGER_BUDGET_BYTES);
}

/**
 * Deduplicated saving from sharing chunks across routes.
 * `closures` is an array of closures, each closure is an array of file names.
 * Returns `savingPercent` in [0,1): 0 = no sharing, ~0.5 = half deduplicated.
 * Throws RangeError on malformed / huge input, never huge-alloc (>1000 closures or >10000 files).
 */
export function dedupSavingPercent(closures: readonly (readonly string[])[]): number {
  if (!Array.isArray(closures)) throw new RangeError('closures must be array');
  if (closures.length > 1000) throw new RangeError('too many closures');
  let total = 0;
  const union = new Set<string>();
  for (const c of closures) {
    if (!Array.isArray(c)) throw new RangeError('closure must be array');
    if (c.length > 10000) throw new RangeError('closure too large');
    total += c.length;
    for (const f of c) {
      if (typeof f !== 'string') throw new RangeError('file must be string');
      if (f.length > 500) throw new RangeError('file name too long');
      union.add(f);
    }
  }
  if (total === 0) return 0;
  return 1 - union.size / total;
}

/**
 * Validate that a heavy fetch (>1 MiB) is exposed at planning/preload time.
 * Returns true when exposure is required and the caller has declared it.
 */
export function heavyFetchExposed(bytes: number, exposedAtPlanning: boolean): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new RangeError('bytes must be safe integer >=0');
  if (typeof exposedAtPlanning !== 'boolean')
    throw new RangeError('exposedAtPlanning must be boolean');
  if (bytes > HEAVY_FETCH_THRESHOLD_BYTES) return exposedAtPlanning;
  return true;
}
