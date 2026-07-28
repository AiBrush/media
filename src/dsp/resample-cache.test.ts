import { describe, expect, it } from 'vitest';
import { ResampleLruCache } from './resample-cache.ts';

describe('canonical resampler bounded LRU', () => {
  it('promotes warm hits and evicts the deterministic least-recently-used entry', () => {
    const cache = new ResampleLruCache<{ readonly id: string }>(2, 100);
    expect(cache.set('a', { id: 'a' }, 30)).toBe(true);
    expect(cache.set('b', { id: 'b' }, 30)).toBe(true);

    expect(cache.get('a')).toEqual({ id: 'a' });
    expect(cache.set('c', { id: 'c' }, 30)).toBe(true);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual({ id: 'a' });
    expect(cache.get('c')).toEqual({ id: 'c' });
    expect(cache.size).toBe(2);
    expect(cache.retainedBytes).toBe(60);
  });

  it('enforces its retained-byte budget without displacing entries for an oversized bank', () => {
    const cache = new ResampleLruCache<{ readonly id: string }>(4, 64);
    expect(cache.set('a', { id: 'a' }, 40)).toBe(true);
    expect(cache.set('b', { id: 'b' }, 30)).toBe(true);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual({ id: 'b' });
    expect(cache.size).toBe(1);
    expect(cache.retainedBytes).toBe(30);

    expect(cache.set('oversized', { id: 'oversized' }, 65)).toBe(false);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('b')).toEqual({ id: 'b' });
    expect(cache.size).toBe(1);
    expect(cache.retainedBytes).toBe(30);
  });

  it('re-accounts replacement entries before enforcing both bounds', () => {
    const cache = new ResampleLruCache<{ readonly revision: number }>(2, 70);
    expect(cache.set('a', { revision: 1 }, 20)).toBe(true);
    expect(cache.set('b', { revision: 1 }, 30)).toBe(true);
    expect(cache.set('a', { revision: 2 }, 50)).toBe(true);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual({ revision: 2 });
    expect(cache.size).toBe(1);
    expect(cache.retainedBytes).toBe(50);
  });
});
