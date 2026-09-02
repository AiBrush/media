import { describe, expect, it } from 'vitest';
import { selectWorkerMode } from './worker-mode.ts';

describe('worker-mode — offload default for heavy convert', () => {
  it('unit: undefined worker with Worker available now offloads (heavy win)', () => {
    expect(selectWorkerMode(undefined, true)).toBe('offload');
    expect(selectWorkerMode(true, true)).toBe('offload');
    expect(selectWorkerMode({ pool: 2 }, true)).toBe('offload');
  });

  it('property: explicit false always stays inline', () => {
    expect(selectWorkerMode(false, true)).toBe('inline');
    expect(selectWorkerMode(false, false)).toBe('inline');
  });

  it('boundary: no Worker constructor always inline', () => {
    expect(selectWorkerMode(undefined, false)).toBe('inline');
    expect(selectWorkerMode(true, false)).toBe('inline');
    expect(selectWorkerMode({ pool: 4 }, false)).toBe('inline');
  });

  it('malformed: invalid pool values are clamped to offload with pool 1', () => {
    expect(selectWorkerMode({ pool: 0 } as any, true)).toBe('offload');
    expect(selectWorkerMode({ pool: -1 } as any, true)).toBe('offload');
  });

  it('randomized: 100 seeded combos', () => {
    let seed = 0x12345678;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 100; i++) {
      const workerExists = rand() < 0.5;
      const opts = [undefined, false, true, { pool: 1 }, { pool: 3 }, { pool: 0 }][Math.floor(rand() * 6)];
      const result = selectWorkerMode(opts as any, workerExists);
      if (!workerExists) expect(result).toBe('inline');
      else if (opts === false) expect(result).toBe('inline');
      else expect(result).toBe('offload');
    }
  });
});
