import { describe, expect, it } from 'vitest';
import { assertGateOutputValidity, gatePassesWithValidOutput, isGateName, isValidGateOutput } from './gate-validity.ts';

describe('gate output validity — C4 inspect content not status', () => {
  it('valid gate outputs pass', () => {
    expect(isGateName('typecheck')).toBe(true);
    expect(isGateName('bundle')).toBe(true);
    expect(isGateName('unknown')).toBe(false);
    const ok = { gate: 'typecheck' as const, status: 'pass' as const, files: ['dist/index.d.ts', 'dist/core.d.ts'], bytes: 1000, errors: [] };
    expect(isValidGateOutput(ok)).toBe(true);
    expect(() => assertGateOutputValidity(ok)).not.toThrow();
    expect(gatePassesWithValidOutput(ok)).toBe(true);
    const bundleOk = { gate: 'bundle' as const, status: 'pass' as const, files: ['dist/index.js'], bytes: 50000 };
    expect(() => assertGateOutputValidity(bundleOk)).not.toThrow();
  });

  it('pass with errors or missing files or zero bytes fails', () => {
    const withErrors = { gate: 'typecheck' as const, status: 'pass' as const, files: ['dist/index.d.ts', 'dist/core.d.ts'], errors: ['error'] };
    expect(() => assertGateOutputValidity(withErrors)).toThrow(RangeError);
    const missingFile = { gate: 'typecheck' as const, status: 'pass' as const, files: ['dist/index.d.ts'] };
    expect(() => assertGateOutputValidity(missingFile)).toThrow(RangeError);
    const zeroBytes = { gate: 'bundle' as const, status: 'pass' as const, files: ['dist/index.js'], bytes: 0 };
    expect(() => assertGateOutputValidity(zeroBytes)).toThrow(RangeError);
    expect(gatePassesWithValidOutput(withErrors)).toBe(false);
  });

  it('fail without errors fails', () => {
    const failNoErrors = { gate: 'build' as const, status: 'fail' as const, files: [] };
    expect(() => assertGateOutputValidity(failNoErrors)).toThrow(RangeError);
    const failWithErrors = { gate: 'build' as const, status: 'fail' as const, errors: ['build failed'] };
    expect(() => assertGateOutputValidity(failWithErrors)).not.toThrow();
    expect(gatePassesWithValidOutput(failWithErrors)).toBe(false);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const gates = ['typecheck', 'docs', 'build', 'bundle', 'integrity'] as const;
      const gate = gates[i % gates.length]!;
      const pass = i % 3 !== 0;
      const output = pass
        ? {
            gate,
            status: 'pass' as const,
            files: gate === 'typecheck' ? ['dist/index.d.ts', 'dist/core.d.ts'] : gate === 'docs' ? ['docs/runtime-and-capabilities.md'] : ['dist/index.js', 'dist/core.js'],
            bytes: 1000 + i,
            errors: [],
          }
        : { gate, status: 'fail' as const, errors: ['err'] };
      expect(isValidGateOutput(output)).toBe(true);
      expect(typeof gatePassesWithValidOutput(output)).toBe('boolean');
    }
  });

  it('boundary: exactly required files vs missing one', () => {
    const ok = { gate: 'typecheck' as const, status: 'pass' as const, files: ['dist/index.d.ts', 'dist/core.d.ts'] };
    expect(() => assertGateOutputValidity(ok)).not.toThrow();
    expect(() => assertGateOutputValidity({ gate: 'typecheck' as const, status: 'pass' as const, files: ['dist/index.d.ts'] } as never)).toThrow(RangeError);
    expect(isGateName('')).toBe(false);
    expect(isGateName('typecheck')).toBe(true);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isGateName(null as never)).toThrow(RangeError);
    expect(() => isGateName('x'.repeat(30) as never)).toThrow(RangeError);
    expect(isValidGateOutput(null)).toBe(false);
    expect(() => assertGateOutputValidity(null as never)).toThrow(RangeError);
    expect(() => assertGateOutputValidity({ gate: 'unknown' as never, status: 'pass' as never } as never)).toThrow(RangeError);
    expect(() => assertGateOutputValidity({ gate: 'typecheck' as const, status: 'pass' as const, bytes: NaN as never } as never)).toThrow(RangeError);
    expect(isValidGateOutput({ gate: 'typecheck', status: 'pass', files: [null as never] } as never)).toBe(false);
  });
});
