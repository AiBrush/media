import { describe, expect, it } from 'vitest';
import {
  BROWSER_VERSION_COUNT,
  MINIMAL_MATRIX_CELLS,
  REQUIRED_BROWSERS,
  assertMatrixCoversRequired,
  coversMinimalMatrix,
  isBrowserFamily,
  isValidMatrixCell,
} from './browser-matrix.ts';

describe('browser/device matrix — §9 4.1', () => {
  it('required browsers and version counts', () => {
    expect(REQUIRED_BROWSERS).toEqual(['chromium', 'firefox', 'webkit', 'ios-webkit']);
    expect(BROWSER_VERSION_COUNT.chromium).toBe(2);
    expect(BROWSER_VERSION_COUNT.firefox).toBe(2);
    expect(BROWSER_VERSION_COUNT.webkit).toBe(2);
    expect(BROWSER_VERSION_COUNT['ios-webkit']).toBe(1);
    expect(isBrowserFamily('chromium')).toBe(true);
    expect(isBrowserFamily('webkit')).toBe(true);
    expect(isBrowserFamily('unknown')).toBe(false);
  });

  it('minimal matrix covers all required dimensions', () => {
    expect(MINIMAL_MATRIX_CELLS.length).toBe(7);
    for (const c of MINIMAL_MATRIX_CELLS) expect(isValidMatrixCell(c)).toBe(true);
    expect(() => assertMatrixCoversRequired([...MINIMAL_MATRIX_CELLS])).not.toThrow();
    expect(coversMinimalMatrix([...MINIMAL_MATRIX_CELLS])).toBe(true);
    // each toggle has both on and off
    for (const k of ['workers', 'webgpu', 'opfs', 'range', 'hwAccel'] as const) {
      const vals = new Set(
        MINIMAL_MATRIX_CELLS.map((c) => (c as unknown as Record<string, string>)[k]),
      );
      expect(vals.has('on')).toBe(true);
      expect(vals.has('off')).toBe(true);
    }
  });

  it('fails when browser or dimension missing', () => {
    const missingBrowser = MINIMAL_MATRIX_CELLS.filter((c) => c.browser !== 'ios-webkit');
    expect(() => assertMatrixCoversRequired(missingBrowser)).toThrow(RangeError);
    const onlyArm = MINIMAL_MATRIX_CELLS.filter((c) => c.arch === 'arm64');
    expect(() => assertMatrixCoversRequired(onlyArm)).toThrow(RangeError);
    const noMobile = MINIMAL_MATRIX_CELLS.filter((c) => c.deviceClass !== 'mobile-low-mem');
    expect(() => assertMatrixCoversRequired(noMobile)).toThrow(RangeError);
    expect(coversMinimalMatrix(missingBrowser)).toBe(false);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const shuffled = [...MINIMAL_MATRIX_CELLS].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(() => assertMatrixCoversRequired(shuffled)).not.toThrow();
      expect(coversMinimalMatrix(shuffled)).toBe(true);
      expect(isBrowserFamily(REQUIRED_BROWSERS[i % REQUIRED_BROWSERS.length]!)).toBe(true);
      const cell = MINIMAL_MATRIX_CELLS[i % MINIMAL_MATRIX_CELLS.length]!;
      expect(isValidMatrixCell(cell)).toBe(true);
    }
  });

  it('boundary: exactly minimal vs one cell missing', () => {
    expect(coversMinimalMatrix([...MINIMAL_MATRIX_CELLS])).toBe(true);
    const oneMissing = MINIMAL_MATRIX_CELLS.slice(0, MINIMAL_MATRIX_CELLS.length - 1);
    expect(coversMinimalMatrix(oneMissing)).toBe(false);
    expect(() => assertMatrixCoversRequired([])).toThrow(RangeError);
    expect(isValidMatrixCell({})).toBe(false);
    expect(
      isValidMatrixCell({
        browser: 'chromium',
        arch: 'arm64',
        deviceClass: 'desktop',
        isolation: 'isolated',
        workers: 'on',
        webgpu: 'on',
        opfs: 'on',
        range: 'on',
        hwAccel: 'on',
      }),
    ).toBe(true);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isBrowserFamily(null as never)).toThrow(RangeError);
    expect(() => isBrowserFamily('x'.repeat(30) as never)).toThrow(RangeError);
    expect(() => assertMatrixCoversRequired(null as never)).toThrow(RangeError);
    expect(() => assertMatrixCoversRequired([null as never])).toThrow(RangeError);
    expect(() =>
      assertMatrixCoversRequired(
        Array.from({ length: 501 }, () => MINIMAL_MATRIX_CELLS[0]!) as never,
      ),
    ).toThrow(RangeError);
    expect(() => coversMinimalMatrix(null as never)).toThrow(RangeError);
    expect(isValidMatrixCell(null)).toBe(false);
    expect(
      isValidMatrixCell({
        browser: 'unknown',
        arch: 'arm64',
        deviceClass: 'desktop',
        isolation: 'isolated',
        workers: 'on',
        webgpu: 'on',
        opfs: 'on',
        range: 'on',
        hwAccel: 'on',
      }),
    ).toBe(false);
  });
});
