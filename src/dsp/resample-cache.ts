interface SizedCacheEntry<T> {
  readonly value: T;
  readonly retainedBytes: number;
}

/**
 * Internal deterministic LRU for immutable resampler state.
 *
 * This module is deliberately not re-exported from the DSP/package entry points. Keeping the small
 * container separate lets its eviction and accounting invariants be tested without adding cache
 * controls to the public resample API.
 */
export class ResampleLruCache<T> {
  private readonly entries = new Map<string, SizedCacheEntry<T>>();
  private retainedByteCount = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxRetainedBytes: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      !Number.isSafeInteger(maxRetainedBytes) ||
      maxRetainedBytes < 0
    ) {
      throw new RangeError('cache bounds must be non-negative safe integers');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get retainedBytes(): number {
    return this.retainedByteCount;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, retainedBytes: number): boolean {
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
      throw new RangeError('cache entry size must be a non-negative safe integer');
    }
    if (this.maxEntries === 0 || retainedBytes > this.maxRetainedBytes) return false;

    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.retainedByteCount -= previous.retainedBytes;
    }

    while (
      this.entries.size >= this.maxEntries ||
      this.retainedByteCount + retainedBytes > this.maxRetainedBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.retainedByteCount -= oldest?.retainedBytes ?? 0;
    }

    this.entries.set(key, { value, retainedBytes });
    this.retainedByteCount += retainedBytes;
    return true;
  }
}
