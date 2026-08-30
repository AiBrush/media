/**
 * Required browser / device matrix (REQUIREMENTS §9 — 4.1).
 *
 * Release CI MUST cover the latest two stable majors for Chromium, Firefox,
 * and Safari plus current iOS Safari, across Apple Silicon + x86-64, low-mem
 * mobile, isolated vs non-isolated, workers/WebGPU/OPFS/range on/off, and
 * HW-accel on + forced software. Feature support MUST be probe-based, UA only
 * when probe impossible. This module is the pure, Node-testable taxonomy for
 * that matrix — no browser APIs, no fixture branching, never huge-alloc,
 * deterministic.
 */

export type BrowserFamily = 'chromium' | 'firefox' | 'webkit' | 'ios-webkit';
export type CpuArch = 'arm64' | 'x64';
export type DeviceClass = 'desktop' | 'mobile-low-mem';
export type Isolation = 'isolated' | 'non-isolated';
export type Toggle = 'on' | 'off';

export interface MatrixCell {
  readonly browser: BrowserFamily;
  readonly arch: CpuArch;
  readonly deviceClass: DeviceClass;
  readonly isolation: Isolation;
  readonly workers: Toggle;
  readonly webgpu: Toggle;
  readonly opfs: Toggle;
  readonly range: Toggle;
  readonly hwAccel: Toggle; // on = HW accel enabled, off = forced software/fallback
}

export const REQUIRED_BROWSERS: readonly BrowserFamily[] = Object.freeze([
  'chromium',
  'firefox',
  'webkit',
  'ios-webkit',
] as const);
export const REQUIRED_ARCHS: readonly CpuArch[] = Object.freeze(['arm64', 'x64'] as const);
export const REQUIRED_DEVICE_CLASSES: readonly DeviceClass[] = Object.freeze([
  'desktop',
  'mobile-low-mem',
] as const);

export const BROWSER_VERSION_COUNT: Record<BrowserFamily, number> = Object.freeze({
  chromium: 2,
  firefox: 2,
  webkit: 2,
  'ios-webkit': 1,
} as const);

// Minimal representative matrix: each REQUIRED_BROWSERS × key toggles.
// Real CI expands this combinatorically; taxonomy here is the invariant to assert coverage.
export const MINIMAL_MATRIX_CELLS: readonly MatrixCell[] = Object.freeze([
  Object.freeze({
    browser: 'chromium',
    arch: 'arm64',
    deviceClass: 'desktop',
    isolation: 'isolated',
    workers: 'on',
    webgpu: 'on',
    opfs: 'on',
    range: 'on',
    hwAccel: 'on',
  } as MatrixCell),
  Object.freeze({
    browser: 'chromium',
    arch: 'x64',
    deviceClass: 'desktop',
    isolation: 'non-isolated',
    workers: 'on',
    webgpu: 'off',
    opfs: 'off',
    range: 'off',
    hwAccel: 'off',
  } as MatrixCell),
  Object.freeze({
    browser: 'firefox',
    arch: 'arm64',
    deviceClass: 'desktop',
    isolation: 'isolated',
    workers: 'on',
    webgpu: 'on',
    opfs: 'on',
    range: 'on',
    hwAccel: 'on',
  } as MatrixCell),
  Object.freeze({
    browser: 'firefox',
    arch: 'x64',
    deviceClass: 'desktop',
    isolation: 'non-isolated',
    workers: 'off',
    webgpu: 'off',
    opfs: 'off',
    range: 'off',
    hwAccel: 'off',
  } as MatrixCell),
  Object.freeze({
    browser: 'webkit',
    arch: 'arm64',
    deviceClass: 'desktop',
    isolation: 'isolated',
    workers: 'on',
    webgpu: 'on',
    opfs: 'on',
    range: 'on',
    hwAccel: 'on',
  } as MatrixCell),
  Object.freeze({
    browser: 'webkit',
    arch: 'arm64',
    deviceClass: 'mobile-low-mem',
    isolation: 'non-isolated',
    workers: 'on',
    webgpu: 'off',
    opfs: 'off',
    range: 'on',
    hwAccel: 'off',
  } as MatrixCell),
  Object.freeze({
    browser: 'ios-webkit',
    arch: 'arm64',
    deviceClass: 'mobile-low-mem',
    isolation: 'non-isolated',
    workers: 'on',
    webgpu: 'off',
    opfs: 'off',
    range: 'off',
    hwAccel: 'on',
  } as MatrixCell),
]);

export function isBrowserFamily(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('browser must be string');
  if (value.length > 20) throw new RangeError('browser too long');
  return (REQUIRED_BROWSERS as readonly string[]).includes(value);
}

export function isValidMatrixCell(cell: unknown): boolean {
  if (typeof cell !== 'object' || cell === null) return false;
  const c = cell as Partial<MatrixCell>;
  if (typeof c.browser !== 'string' || !isBrowserFamily(c.browser)) return false;
  if (c.arch !== 'arm64' && c.arch !== 'x64') return false;
  if (c.deviceClass !== 'desktop' && c.deviceClass !== 'mobile-low-mem') return false;
  if (c.isolation !== 'isolated' && c.isolation !== 'non-isolated') return false;
  for (const k of ['workers', 'webgpu', 'opfs', 'range', 'hwAccel'] as const) {
    const v = (c as Record<string, unknown>)[k];
    if (v !== 'on' && v !== 'off') return false;
  }
  return true;
}

function cellKey(cell: MatrixCell): string {
  return `${cell.browser}|${cell.arch}|${cell.deviceClass}|${cell.isolation}|${cell.workers}|${cell.webgpu}|${cell.opfs}|${cell.range}|${cell.hwAccel}`;
}

/**
 * Assert that a reported matrix covers the minimal required cells and dimensions.
 * - Every REQUIRED_BROWSERS family appears
 * - Both arm64 and x64 appear (where available)
 * - Both desktop and mobile-low-mem appear
 * - Both isolated and non-isolated appear
 * - Each of workers/webgpu/opfs/range/hwAccel has at least one on and one off
 * Throws RangeError on missing coverage or malformed, never huge-alloc (>500 cells).
 */
export function assertMatrixCoversRequired(cells: readonly MatrixCell[]): void {
  if (!Array.isArray(cells)) throw new RangeError('cells must be array');
  if (cells.length > 500) throw new RangeError('too many cells');
  if (cells.length === 0) throw new RangeError('matrix empty');
  for (const c of cells) if (!isValidMatrixCell(c)) throw new RangeError('invalid matrix cell');
  const browsers = new Set(cells.map((c) => c.browser));
  for (const b of REQUIRED_BROWSERS)
    if (!browsers.has(b)) throw new RangeError(`browser not covered: ${b}`);
  const archs = new Set(cells.map((c) => c.arch));
  if (!archs.has('arm64') || !archs.has('x64')) throw new RangeError('both arm64 and x64 required');
  const devices = new Set(cells.map((c) => c.deviceClass));
  if (!devices.has('desktop') || !devices.has('mobile-low-mem'))
    throw new RangeError('both desktop and mobile-low-mem required');
  const isolations = new Set(cells.map((c) => c.isolation));
  if (!isolations.has('isolated') || !isolations.has('non-isolated'))
    throw new RangeError('both isolated and non-isolated required');
  for (const k of ['workers', 'webgpu', 'opfs', 'range', 'hwAccel'] as const) {
    const vals = new Set(cells.map((c) => (c as unknown as Record<string, string>)[k]));
    if (!vals.has('on') || !vals.has('off')) throw new RangeError(`${k} must have both on and off`);
  }
}

/** Whether a reported matrix already covers the minimal cells (set cover, not exact equality). */
export function coversMinimalMatrix(cells: readonly MatrixCell[]): boolean {
  if (!Array.isArray(cells)) throw new RangeError('cells must be array');
  if (cells.length > 500) throw new RangeError('too many cells');
  const have = new Set(cells.map(cellKey));
  for (const req of MINIMAL_MATRIX_CELLS) if (!have.has(cellKey(req))) return false;
  return true;
}
