import { describe, expect, it } from 'vitest';
import { assertCycleEvidence, createCycleEvidence, isValidCycleEvidence } from './cycle-evidence.ts';

describe('before/after evidence — C5', () => {
  it('creates valid cycle evidence with 5-10 refs', () => {
    const ev = createCycleEvidence({
      cycle: 103,
      beforePass: 5757,
      afterPass: 5763,
      beforeFiles: 350,
      afterFiles: 351,
      refs: ['a.ts:1', 'b.ts:2', 'c.ts:3', 'd.ts:4', 'e.ts:5'],
    });
    expect(ev.deltaPass).toBe(6);
    expect(ev.deltaFiles).toBe(1);
    expect(isValidCycleEvidence(ev)).toBe(true);
    expect(() => assertCycleEvidence(ev)).not.toThrow();
    expect(ev.refs.length).toBe(5);
  });

  it('after must be >= before and refs 5-10', () => {
    expect(() =>
      createCycleEvidence({ cycle: 1, beforePass: 10, afterPass: 9, beforeFiles: 1, afterFiles: 1, refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1'] } as never),
    ).toThrow(RangeError);
    expect(() =>
      createCycleEvidence({ cycle: 1, beforePass: 10, afterPass: 10, beforeFiles: 2, afterFiles: 1, refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1'] } as never),
    ).toThrow(RangeError);
    expect(() =>
      createCycleEvidence({ cycle: 1, beforePass: 10, afterPass: 10, beforeFiles: 1, afterFiles: 1, refs: ['a:1', 'b:1', 'c:1', 'd:1'] } as never),
    ).toThrow(RangeError);
    expect(() =>
      createCycleEvidence({ cycle: 1, beforePass: 10, afterPass: 10, beforeFiles: 1, afterFiles: 1, refs: Array.from({ length: 11 }, () => 'a:1') } as never),
    ).toThrow(RangeError);
  });

  it('delta computed correctly', () => {
    const ev = createCycleEvidence({
      cycle: 10,
      beforePass: 100,
      afterPass: 110,
      beforeFiles: 10,
      afterFiles: 12,
      refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1', 'f:1'],
    });
    expect(ev.deltaPass).toBe(10);
    expect(ev.deltaFiles).toBe(2);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const before = 5000 + i * 10;
      const after = before + (i % 3);
      const ev = createCycleEvidence({
        cycle: 100 + i,
        beforePass: before,
        afterPass: after,
        beforeFiles: 300 + i,
        afterFiles: 300 + i + (i % 2),
        refs: ['a:1', 'b:2', 'c:3', 'd:4', 'e:5'],
      });
      expect(isValidCycleEvidence(ev)).toBe(true);
      expect(ev.deltaPass).toBe(after - before);
    }
  });

  it('boundary: exactly 5 and 10 refs', () => {
    const five = createCycleEvidence({ cycle: 1, beforePass: 1, afterPass: 1, beforeFiles: 1, afterFiles: 1, refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1'] });
    expect(five.refs.length).toBe(5);
    const ten = createCycleEvidence({
      cycle: 1,
      beforePass: 1,
      afterPass: 1,
      beforeFiles: 1,
      afterFiles: 1,
      refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1', 'f:1', 'g:1', 'h:1', 'i:1', 'j:1'],
    });
    expect(ten.refs.length).toBe(10);
    expect(() => createCycleEvidence({ cycle: 1, beforePass: 1, afterPass: 1, beforeFiles: 1, afterFiles: 1, refs: ['a:1', 'b:1', 'c:1', 'd:1'] } as never)).toThrow(RangeError);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => createCycleEvidence(null as never)).toThrow(RangeError);
    expect(() => createCycleEvidence({} as never)).toThrow(RangeError);
    expect(() => createCycleEvidence({ cycle: NaN as never, beforePass: 1 as never, afterPass: 1 as never, beforeFiles: 1 as never, afterFiles: 1 as never, refs: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1'] } as never)).toThrow(RangeError);
    expect(() => createCycleEvidence({ cycle: 1 as never, beforePass: 1 as never, afterPass: 1 as never, beforeFiles: 1 as never, afterFiles: 1 as never, refs: ['bad'] } as never)).toThrow(RangeError);
    expect(() => createCycleEvidence({ cycle: 1 as never, beforePass: 1 as never, afterPass: 1 as never, beforeFiles: 1 as never, afterFiles: 1 as never, refs: ['a'.repeat(300) as never, 'b:1', 'c:1', 'd:1', 'e:1'] } as never)).toThrow(RangeError);
    expect(isValidCycleEvidence(null)).toBe(false);
    expect(isValidCycleEvidence({})).toBe(false);
  });
});
