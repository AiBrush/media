/**
 * Presentation-ordered async collection (`kernel`) — the fused stream consumer behind bounded
 * frame-level pipelines (ADR-002 keeps the decoder GPU-side; this stops the *consumer* from
 * serializing behind the producer).
 *
 * A WebCodecs `VideoDecoder` emits frames in **presentation order** (W3C WebCodecs: decoded outputs
 * are emitted in presentation order; the video codec driver relies on the same guarantee and never
 * reorders — see `codecs/webcodecs-video.ts`). A consumer that fully drains such a stream before
 * transforming each item (rasterize → hash → …) pays `drain + transform` *serially* and retains
 * every native surface for the whole window. This collector instead starts each arrival's transform
 * immediately, keeps at most `inFlight` transforms running (surfaces are released as soon as their
 * own transform has copied them out), and joins results in (timestamp, arrival-index) order.
 *
 * The stop policy is reorder-safe: when the arrivals so far are non-decreasing, a monotonic prefix
 * of a presentation-ordered stream *is* its sorted prefix, so exactly `maxItems` results suffice and
 * the readable is cancelled immediately; on a monotonicity violation the collector keeps reading for
 * `reorderMargin` more arrivals (the classic B-frame reorder window), then sorts and truncates — the
 * same total order a drain-then-stable-sort produces. Results are therefore identical to draining,
 * sorting, and mapping the first `maxItems` items, at lower latency and bounded retention.
 */

import { MediaError } from '../contracts/errors.ts';

/** Options for {@link collectPresentationOrdered}. */
export interface PresentationPipeline<T, R> {
  /** Presentation key of an arrival (µs timestamp). Must be finite; violations fail with `decode-error`. */
  keyOf(item: T): number;
  /**
   * Per-item async transform, started as soon as the item arrives. Every item read from the stream
   * is passed to `map` exactly once — the transform owns releasing the item. Transforms must be
   * independent (no shared staging) since up to `inFlight` run concurrently; results join in
   * presentation order.
   */
  map(item: T): Promise<R>;
  /**
   * Concurrent `map` ceiling (≥ 1; `Infinity` disables backpressure). Bounds live transformed
   * items mid-stream, hence peak memory for large payloads.
   */
  inFlight: number;
  /** Number of presentation-ordered results wanted. `Infinity` drains the whole stream. */
  maxItems: number;
  /** Extra arrivals to read after a monotonicity violation (the reorder window). Default 0. */
  reorderMargin?: number;
}

interface Job<R> {
  readonly key: number;
  readonly arrival: number;
  readonly promise: Promise<R>;
}

/**
 * Consume `items` with a bounded-concurrency `map`, resolving to at most `maxItems` results in
 * (timestamp, arrival) order.
 *
 * Cancellation: once the stop condition is met — and always before settling — the readable is
 * cancelled so pull-driven producers (decoders) tear down their queued surfaces; items already
 * handed to this consumer still reach `map` exactly once. Any transform/read/key error settles
 * every started transform first, then rejects with that error.
 */
export async function collectPresentationOrdered<T, R>(
  items: ReadableStream<T>,
  options: PresentationPipeline<T, R>,
): Promise<R[]> {
  const { keyOf, map } = options;
  const rawMax = options.maxItems;
  const maxItems = Number.isFinite(rawMax)
    ? Math.max(0, Math.floor(rawMax))
    : Number.POSITIVE_INFINITY;
  const rawInFlight = options.inFlight;
  const inFlight = Number.isFinite(rawInFlight)
    ? Math.max(1, Math.floor(rawInFlight))
    : Number.POSITIVE_INFINITY;
  const rawMargin = options.reorderMargin ?? 0;
  const margin = Number.isFinite(rawMargin) ? Math.max(0, Math.floor(rawMargin)) : 0;
  const reader = items.getReader();
  const jobs: Array<Job<R>> = [];
  let firstError: unknown;
  let failed = false;
  let monotonic = true;
  let lastKey = Number.NEGATIVE_INFINITY;
  let ended = false;
  let joined = 0;
  const record = (error: unknown): void => {
    if (!failed) {
      failed = true;
      firstError = error;
    }
  };
  try {
    for (;;) {
      if (failed || ended) break;
      if (monotonic && jobs.length >= maxItems) break;
      if (Number.isFinite(maxItems) && jobs.length >= maxItems + margin) break;
      let value: T;
      try {
        const read = await reader.read();
        if (read.done) {
          ended = true;
          continue;
        }
        value = read.value;
      } catch (error) {
        record(error ?? new MediaError('aborted', 'stream read rejected without a reason'));
        break;
      }
      let key = 0;
      try {
        key = keyOf(value);
        if (!Number.isFinite(key)) {
          throw new MediaError('decode-error', `presentation key ${key} is not a finite number`);
        }
      } catch (error) {
        // Ownership stays exactly-once: the item still reaches `map` (which releases it), then the
        // operation fails with the key violation.
        const poison: Job<R> = {
          key: Number.isFinite(key) ? key : 0,
          arrival: jobs.length,
          promise: map(value),
        };
        poison.promise.catch(() => undefined);
        jobs.push(poison);
        record(error);
        break;
      }
      if (key < lastKey) monotonic = false;
      lastKey = key;
      const job: Job<R> = { key, arrival: jobs.length, promise: map(value) };
      job.promise.catch((error: unknown) => record(error));
      jobs.push(job);
      // Bounded-concurrency backpressure: only pull the next arrival once the oldest transform slot
      // frees up. Awaiting the head is FIFO and can never deadlock (the head is always started).
      while (jobs.length - joined > inFlight) {
        const head = jobs[joined];
        if (head === undefined) break;
        joined += 1;
        try {
          await head.promise;
        } catch {
          /* recorded by the job continuation above */
        }
      }
    }
    // Settle every started transform before returning or rejecting (each one owns a surface).
    while (joined < jobs.length) {
      const head = jobs[joined];
      joined += 1;
      if (head === undefined) break;
      try {
        await head.promise;
      } catch {
        /* recorded */
      }
    }
    if (failed) throw firstError;
    const done: Array<{ job: Job<R>; value: R }> = [];
    for (const job of jobs) {
      done.push({ job, value: await job.promise });
    }
    if (!monotonic) {
      done.sort((a, b) => a.job.key - b.job.key || a.job.arrival - b.job.arrival);
    }
    return done.slice(0, maxItems).map((entry) => entry.value);
  } finally {
    // Cancel even after natural completion: pull-driven producer pipelines (decoders) use the
    // cancellation signal to tear down their own queued surfaces. The lock releases exactly once.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
