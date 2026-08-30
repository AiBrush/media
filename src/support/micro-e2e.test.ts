import { describe, expect, it } from 'vitest';
import {
  E2E_TOLERANCE_RATIO,
  assertMicroNotOverridingE2e,
  evaluateMicroE2eGate,
  microE2eGatePasses,
} from './micro-e2e.ts';

describe('micro vs E2E — micro win must not override slower E2E (REQUIREMENTS §8.2 — 3.9)', () => {
  it('tolerance is 1.05 and E2E alone gates', () => {
    expect(E2E_TOLERANCE_RATIO).toBe(1.05);
    expect(evaluateMicroE2eGate({ microRatio: 1, e2eRatio: 1 }).passes).toBe(true);
    expect(evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1 }).passes).toBe(true);
    expect(microE2eGatePasses({ microRatio: 0.9, e2eRatio: 1 })).toBe(true);
  });

  it('micro win but E2E regressed >5% must FAIL', () => {
    const r = evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1.1 });
    expect(r.passes).toBe(false);
    expect(r.microWinButE2eRegressed).toBe(true);
    expect(() => assertMicroNotOverridingE2e({ microRatio: 0.9, e2eRatio: 1.1 })).toThrow(
      RangeError,
    );
    // same E2E regression without micro win also fails — E2E is the gate
    expect(evaluateMicroE2eGate({ microRatio: 1, e2eRatio: 1.06 }).passes).toBe(false);
    expect(evaluateMicroE2eGate({ microRatio: 1.05, e2eRatio: 1.06 }).passes).toBe(false);
  });

  it('micro win with E2E within 5% passes', () => {
    expect(evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1.03 }).passes).toBe(true);
    expect(evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1.03 }).microWinButE2eRegressed).toBe(
      false,
    );
    expect(() => assertMicroNotOverridingE2e({ microRatio: 0.9, e2eRatio: 1.03 })).not.toThrow();
    expect(evaluateMicroE2eGate({ microRatio: 1, e2eRatio: 1.05 }).passes).toBe(true); // exactly at tolerance
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const micro = 0.85 + (i % 7) * 0.05; // 0.85..1.15
      const e2e = 0.9 + (i % 6) * 0.05;
      const r = evaluateMicroE2eGate({ microRatio: micro, e2eRatio: e2e });
      expect(r.passes).toBe(e2e <= 1.05);
      expect(r.microWinButE2eRegressed).toBe(micro < 1 && e2e > 1.05);
      expect(typeof microE2eGatePasses({ microRatio: micro, e2eRatio: e2e })).toBe('boolean');
    }
  });

  it('boundary: exactly 1.05 passes, 1.05001 fails', () => {
    expect(evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1.05 }).passes).toBe(true);
    expect(evaluateMicroE2eGate({ microRatio: 0.9, e2eRatio: 1.05001 }).passes).toBe(false);
    expect(evaluateMicroE2eGate({ microRatio: 1, e2eRatio: 1.05 }).microWinButE2eRegressed).toBe(
      false,
    );
    expect(evaluateMicroE2eGate({ microRatio: 0.99, e2eRatio: 1.06 }).microWinButE2eRegressed).toBe(
      true,
    );
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => evaluateMicroE2eGate(null as never)).toThrow(RangeError);
    expect(() => evaluateMicroE2eGate({} as never)).toThrow(RangeError);
    expect(() =>
      evaluateMicroE2eGate({ microRatio: Number.NaN as never, e2eRatio: 1 } as never),
    ).toThrow(RangeError);
    expect(() =>
      evaluateMicroE2eGate({
        microRatio: 1 as never,
        e2eRatio: Number.POSITIVE_INFINITY as never,
      } as never),
    ).toThrow(RangeError);
    expect(() => evaluateMicroE2eGate({ microRatio: -1 as never, e2eRatio: 1 } as never)).toThrow(
      RangeError,
    );
    expect(() => evaluateMicroE2eGate({ microRatio: 0 as never, e2eRatio: 1 } as never)).toThrow(
      RangeError,
    );
    expect(() =>
      assertMicroNotOverridingE2e({ microRatio: 0.9, e2eRatio: Number.NaN as never } as never),
    ).toThrow(RangeError);
    expect(() => microE2eGatePasses(null as never)).toThrow(RangeError);
  });
});
