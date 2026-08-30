/**
 * Queue depth / chunk size / range coalescing tuning (REQUIREMENTS §8.4 — 3.3).
 *
 * Tuned without increasing peak memory: queue depths, chunk sizes, and range coalescing
 * windows are sized to keep throughput high while staying within the 64 MiB probe / 128 MiB
 * remux budgets and the 10% slow-consumer backpressure invariant.
 */

export interface QueueTuning {
  readonly maxQueuedWindows: number; // RangeCache
  readonly chunkSizeBytes: number; // range chunk
  readonly coalesceWindowBytes: number; // range coalescing
  readonly packetQueueDepth: number; // demux packet queue
}

export const DEFAULT_QUEUE_TUNING: QueueTuning = {
  maxQueuedWindows: 8,
  chunkSizeBytes: 64 * 1024, // 64 KiB
  coalesceWindowBytes: 256 * 1024, // 256 KiB
  packetQueueDepth: 16,
} as const;

/**
 * Tune queue depths for a given input size. Larger inputs get slightly larger queues
 * to amortize range round-trips, but never exceed the memory budgets.
 * Pure, never huge-alloc, deterministic.
 */
export function tunedQueueDepth(inputBytes: number | undefined): QueueTuning {
  if (inputBytes === undefined || !Number.isSafeInteger(inputBytes) || inputBytes < 0)
    return DEFAULT_QUEUE_TUNING;
  if (inputBytes < 10 * 1024 * 1024) return DEFAULT_QUEUE_TUNING;
  if (inputBytes < 100 * 1024 * 1024) {
    return { ...DEFAULT_QUEUE_TUNING, maxQueuedWindows: 12, chunkSizeBytes: 128 * 1024 };
  }
  return {
    ...DEFAULT_QUEUE_TUNING,
    maxQueuedWindows: 16,
    chunkSizeBytes: 256 * 1024,
    coalesceWindowBytes: 512 * 1024,
  };
}

/**
 * Validate that a tuning stays within the memory budgets.
 * Throws RangeError on violation, never huge-alloc.
 */
export function assertQueueTuning(tuning: QueueTuning): void {
  if (tuning.maxQueuedWindows < 1 || tuning.maxQueuedWindows > 32)
    throw new RangeError('maxQueuedWindows out of range');
  if (tuning.chunkSizeBytes < 1024 || tuning.chunkSizeBytes > 1024 * 1024)
    throw new RangeError('chunkSizeBytes out of range');
  if (tuning.coalesceWindowBytes < 1024 || tuning.coalesceWindowBytes > 1024 * 1024)
    throw new RangeError('coalesceWindowBytes out of range');
  if (tuning.packetQueueDepth < 1 || tuning.packetQueueDepth > 64)
    throw new RangeError('packetQueueDepth out of range');
  const maxQueuedBytes = tuning.maxQueuedWindows * tuning.chunkSizeBytes;
  if (maxQueuedBytes > 64 * 1024 * 1024) throw new RangeError('tuning exceeds 64 MiB probe budget');
}
