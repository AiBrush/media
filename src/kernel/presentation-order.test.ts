/**
 * Node-unit tests for the presentation-ordered fused collector. Pure orchestration over synthetic
 * streams — no WebCodecs, no fixtures: the semantics under test are the generic contract
 * (bounded-concurrency join order, reorder-safe stop, exactly-once `map`, cancel-based teardown).
 */

import { describe, expect, it } from 'vitest';
import { collectPresentationOrdered } from './presentation-order.ts';

interface Item {
  readonly pts: number;
  readonly arrivalOrder: number;
}

function trackedStream(items: readonly Item[]): {
  stream: ReadableStream<Item>;
  state: { cancelled: boolean; delivered: number };
} {
  let index = 0;
  const state = { cancelled: false, delivered: 0 };
  const stream = new ReadableStream<Item>({
    pull(controller): void {
      if (index < items.length) {
        state.delivered++;
        controller.enqueue(items[index++]);
      } else {
        controller.close();
      }
    },
    cancel(): void {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** Deterministic LCG so the randomized variant never depends on wall time or Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const keyOf = (item: Item): number => item.pts;

/** drain → stable sort by (pts, arrival) → truncate: the reference semantics being fused. */
function drainSortTruncate(items: readonly Item[], maxItems: number): number[] {
  return [...items]
    .sort((a, b) => a.pts - b.pts || a.arrivalOrder - b.arrivalOrder)
    .slice(0, maxItems)
    .map((item) => item.pts);
}

describe('collectPresentationOrdered', () => {
  it('unit: monotonic stream yields the sorted prefix, maps each arrival exactly once, cancels early', async () => {
    const arrivals = [0, 1, 2, 3, 4, 5, 6].map((pts, arrivalOrder) => ({ pts, arrivalOrder }));
    const { stream, state } = trackedStream(arrivals);
    const mapped: number[] = [];
    const out = await collectPresentationOrdered(stream, {
      keyOf,
      map: async (item) => {
        mapped.push(item.pts);
        return item.pts * 10;
      },
      inFlight: 2,
      maxItems: 4,
      reorderMargin: 3,
    });
    expect(out).toEqual([0, 10, 20, 30]);
    // Exactly-once ownership: only the 4 read arrivals were mapped, none twice.
    expect(mapped).toEqual([0, 1, 2, 3]);
    expect(state.cancelled).toBe(true);
  });

  it('property: output equals the reference over the read window, and the whole stream is read only when needed', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = lcg(seed);
      const n = 1 + Math.floor(rand() * 24);
      const items = Array.from({ length: n }, (_, i) => ({ pts: i * 100, arrivalOrder: i }));
      // Random reorderings (single swaps) — no fixture-shaped special cases.
      const swaps = Math.floor(rand() * 4);
      for (let s = 0; s < swaps; s++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        const ia = items[a];
        const ib = items[b];
        if (ia === undefined || ib === undefined) continue;
        items[a] = ib;
        items[b] = ia;
      }
      const maxItems = 1 + Math.floor(rand() * Math.max(1, n - 1));
      const margin = Math.floor(rand() * 8);
      const inFlight = 1 + Math.floor(rand() * 3);
      const { stream } = trackedStream(items);
      const read: Item[] = [];
      const out = await collectPresentationOrdered(stream, {
        keyOf,
        map: async (item) => {
          read.push(item);
          return item.pts;
        },
        inFlight,
        maxItems,
        reorderMargin: margin,
      });
      // (a) The result is exactly the reference drain→sort→truncate over the items that were read.
      expect(out).toEqual(drainSortTruncate(read, maxItems));
      // (b) Reads never exceed the reorder-bounded window.
      expect(read.length).toBeLessThanOrEqual(maxItems + margin);
      // (c) When the whole stream was consumed (no early stop), the fused result equals the
      //     reference over the complete input.
      // (c) When every item was consumed, the fused result equals the reference over the complete
      //     input; otherwise the collector stopped on the reorder-bounded window.
      if (read.length === n) {
        expect(out).toEqual(drainSortTruncate(items, maxItems));
      } else {
        // Early cancel: either a monotonic prefix of exactly maxItems, or the full reorder window.
        let seenMonotonic = true;
        for (let i = 1; i < read.length; i++) {
          const prev = read[i - 1];
          const cur = read[i];
          if (prev !== undefined && cur !== undefined && cur.pts < prev.pts) seenMonotonic = false;
        }
        expect(read.length).toBe(seenMonotonic ? maxItems : maxItems + margin);
      }
    }
  });

  it('boundary: zero items, exact-length streams, reorder windows, and Infinity drain', async () => {
    expect(
      await collectPresentationOrdered(streamOfItems([{ pts: 5 }]), {
        keyOf,
        map: async (item) => item.pts,
        inFlight: 1,
        maxItems: 0,
      }),
    ).toEqual([]);
    // Exactly maxItems arrivals, monotonic → full prefix.
    expect(
      await collectPresentationOrdered(streamOfItems([{ pts: 1 }, { pts: 2 }, { pts: 3 }]), {
        keyOf,
        map: async (item) => item.pts,
        inFlight: 4,
        maxItems: 3,
        reorderMargin: 16,
      }),
    ).toEqual([1, 2, 3]);
    // Non-monotonic within margin: the window sorts like drain-then-stable-sort.
    expect(
      await collectPresentationOrdered(streamOfItems([{ pts: 2 }, { pts: 1 }, { pts: 3 }]), {
        keyOf,
        map: async (item) => item.pts,
        inFlight: 8,
        maxItems: 2,
        reorderMargin: 1,
      }),
    ).toEqual([1, 2]);
    // Short non-monotonic stream with Infinity: everything is drained and sorted.
    expect(
      await collectPresentationOrdered(streamOfItems([{ pts: 9 }, { pts: 4 }]), {
        keyOf,
        map: async (item) => item.pts,
        inFlight: 2,
        maxItems: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([4, 9]);
    // Equal keys keep arrival order (stable).
    expect(
      await collectPresentationOrdered(streamOfItems([{ pts: 7 }, { pts: 7 }, { pts: 7 }]), {
        keyOf,
        map: async (item) => item.arrivalOrder,
        inFlight: 3,
        maxItems: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([0, 1, 2]);
  });

  it('malformed: non-finite keys fail with decode-error after mapping the item exactly once', async () => {
    const badPts = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const pts of badPts) {
      let mapped = 0;
      await expect(
        collectPresentationOrdered(streamOfItems([{ pts: 1 }, { pts }, { pts: 3 }]), {
          keyOf,
          map: async (item) => {
            void item;
            mapped++;
            return 0;
          },
          inFlight: 2,
          maxItems: 10,
        }),
      ).rejects.toMatchObject({ code: 'decode-error' });
      // The violating arrival still reached its transform (exactly-once ownership).
      expect(mapped).toBe(2);
    }
    // A throwing keyOf is also an honest rejection after ownership transfer.
    await expect(
      collectPresentationOrdered(streamOfItems([{ pts: 1 }]), {
        keyOf: () => {
          throw new TypeError('no key here');
        },
        map: async () => 1,
        inFlight: 1,
        maxItems: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('randomized: a failing transform rejects, settles every started transform, and never loses items', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = lcg(seed);
      const n = 2 + Math.floor(rand() * 20);
      const items = Array.from({ length: n }, (_, i) => ({ pts: i * 7, arrivalOrder: i }));
      const failAt = Math.floor(rand() * n);
      let started = 0;
      let finished = 0;
      const inFlight = 1 + Math.floor(rand() * 3);
      await expect(
        collectPresentationOrdered(streamOfItems(items), {
          keyOf,
          map: async (item) => {
            started++;
            if (item.arrivalOrder === failAt) throw new Error(`boom@${item.arrivalOrder}`);
            await new Promise((resolve) => setTimeout(resolve, 0));
            finished++;
            return item.pts;
          },
          inFlight,
          // A window that covers the whole stream: the only thing that may stop reads is the error.
          maxItems: n + 42,
          reorderMargin: Math.floor(rand() * 4),
        }),
      ).rejects.toThrow(`boom@${failAt}`);
      // Reads stop within one already-issued lookahead of the failing arrival; every transform that
      // was started ran to completion (its owner releases exactly-once) before the rejection settled.
      expect(started).toBeGreaterThanOrEqual(Math.min(n, failAt + 1));
      expect(started).toBeLessThanOrEqual(Math.min(n, failAt + 2));
      expect(finished).toBe(started - 1);
    }
  });
});

function streamOfItems(items: readonly { pts: number }[]): ReadableStream<Item> {
  const full: Item[] = items.map((item, arrivalOrder) => ({ pts: item.pts, arrivalOrder }));
  return trackedStream(full).stream;
}
