/**
 * Progress in media time + bytes without full indexing; resumable range (REQUIREMENTS §5.1, §7.3 — 1.1.6).
 *
 * Bytes progress is always available (totalBytes from `Source.size` or Content-Range, bytesDone from
 * range windows). Media-time progress without indexing uses the constant-sized `PacketMetadataStats`
 * (presentationStartUs/EndUs) — never a per-packet `PacketMetadata[]` allocation — and falls back to a
 * bytes-proportional estimate when stats are absent. The fetcher reports monotonic `Progress` (stage-aware)
 * and exposes `resumeOffset` so a mid-window abort can be retried from the next byte without re-downloading
 * already-cached intervals.
 */

import type { PacketMetadataStats } from '../contracts/driver.ts';
import type { Progress } from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import { throwIfSourceAborted } from './abort.ts';
import type { Source } from './source.ts';

export interface RangeProgress extends Progress {
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  readonly mediaTimeUsDone?: number;
  readonly mediaTimeUsTotal?: number;
  /** Next byte offset to resume from after an abort (start + bytesDone). */
  readonly resumeOffset?: number;
}

function assertFiniteRange(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new InputError(`range-progress: range must be finite [${start}, ${end})`);
  if (!Number.isSafeInteger(Math.trunc(start)) || !Number.isSafeInteger(Math.trunc(end)))
    throw new InputError(`range-progress: range must be safe integers`);
  if (start < 0 || end < 0)
    throw new InputError(`range-progress: range must be non-negative [${start}, ${end})`);
  if (end < start) throw new InputError(`range-progress: end < start [${start}, ${end})`);
}

/** Estimate media time from bytes proportionally, drift-free via bigint half-up. */
export function estimateMediaTimeUs(
  bytesDone: number,
  bytesTotal: number,
  durationUs: number,
): number {
  if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal) || !Number.isFinite(durationUs))
    throw new InputError('estimateMediaTimeUs: args must be finite');
  if (bytesTotal <= 0 || bytesDone <= 0) return 0;
  if (bytesDone >= bytesTotal) return durationUs;
  const d = BigInt(Math.trunc(durationUs));
  const bd = BigInt(Math.trunc(bytesDone));
  const bt = BigInt(Math.trunc(bytesTotal));
  // (bd * d + bt/2) / bt  — half-up
  return Number((bd * d + bt / 2n) / bt);
}

/** Derive media-time range from constant-sized stats without allocating packet rows. */
export function mediaTimeFromStats(stats: PacketMetadataStats | undefined): number | undefined {
  if (stats === undefined) return undefined;
  const { presentationStartUs, presentationEndUs } = stats;
  if (!Number.isFinite(presentationStartUs) || !Number.isFinite(presentationEndUs))
    return undefined;
  const dur = presentationEndUs - presentationStartUs;
  return dur >= 0 && Number.isSafeInteger(dur) ? dur : undefined;
}

export function createRangeProgressReporter(
  emit: ((p: RangeProgress) => void) | undefined,
  stage: string,
  totalBytes?: number,
  totalMediaTimeUs?: number,
): {
  report(bytesDone: number, mediaTimeUsDone?: number): void;
  complete(): void;
  get bytesDone(): number;
  get mediaTimeUsDone(): number | undefined;
} {
  let doneBytes = 0;
  let doneMedia: number | undefined = undefined;
  let lastProgress = 0;
  let closed = false;
  const safeStage = stage.trim() === '' ? 'range' : stage;
  const totalB =
    totalBytes !== undefined && Number.isFinite(totalBytes) && totalBytes >= 0
      ? totalBytes
      : undefined;
  const totalM =
    totalMediaTimeUs !== undefined && Number.isFinite(totalMediaTimeUs) && totalMediaTimeUs >= 0
      ? totalMediaTimeUs
      : undefined;
  return {
    get bytesDone() {
      return doneBytes;
    },
    get mediaTimeUsDone() {
      return doneMedia;
    },
    report(bytesDone: number, mediaTimeUsDone?: number): void {
      if (!Number.isFinite(bytesDone) || bytesDone < 0)
        throw new InputError('range-progress report: bytesDone must be finite >=0');
      if (closed || emit === undefined) return;
      doneBytes = Math.trunc(bytesDone);
      if (mediaTimeUsDone !== undefined) {
        if (!Number.isFinite(mediaTimeUsDone) || mediaTimeUsDone < 0)
          throw new InputError('range-progress report: mediaTimeUsDone must be finite >=0');
        doneMedia = Math.trunc(mediaTimeUsDone);
      } else if (totalB !== undefined && totalM !== undefined) {
        doneMedia = estimateMediaTimeUs(doneBytes, totalB, totalM);
      }
      let done: number;
      if (totalB !== undefined && totalB > 0) done = Math.min(1, doneBytes / totalB);
      else if (totalM !== undefined && totalM > 0 && doneMedia !== undefined)
        done = Math.min(1, doneMedia / totalM);
      else done = 0;
      // monotonic
      if (done < lastProgress) done = lastProgress;
      lastProgress = done;
      emit({
        done,
        total: 1,
        stage: safeStage,
        ...(totalB !== undefined
          ? { bytesDone: doneBytes, bytesTotal: totalB, resumeOffset: doneBytes }
          : {}),
        ...(totalM !== undefined && doneMedia !== undefined
          ? { mediaTimeUsDone: doneMedia, mediaTimeUsTotal: totalM }
          : {}),
      });
    },
    complete(): void {
      if (closed) return;
      closed = true;
      if (emit === undefined) return;
      const finalBytes = totalB ?? doneBytes;
      const finalMedia = totalM ?? doneMedia;
      emit({
        done: 1,
        total: 1,
        stage: safeStage,
        ...(totalB !== undefined
          ? { bytesDone: finalBytes, bytesTotal: totalB, resumeOffset: finalBytes }
          : {}),
        ...(finalMedia !== undefined && totalM !== undefined
          ? { mediaTimeUsDone: finalMedia, mediaTimeUsTotal: totalM }
          : {}),
      });
    },
  };
}

/**
 * Fetch `[start,end)` with progress in bytes + media time, chunk-by-chunk, without indexing.
 * Reports after each successful `source.range` window. Abort via `signal` throws `aborted` and the
 * caller can resume from `start + reporter.bytesDone`.
 */
export async function fetchRangeWithProgress(
  source: Source,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RangeProgress) => void) | undefined,
  options?: {
    chunkSize?: number;
    stage?: string;
    stats?: PacketMetadataStats;
    totalMediaTimeUs?: number;
  },
): Promise<Uint8Array> {
  assertFiniteRange(start, end);
  const lo = Math.max(0, Math.trunc(start));
  let hi = Math.max(lo, Math.trunc(end));
  if (source.size !== undefined) hi = Math.min(hi, source.size);
  const expected = hi - lo;
  if (expected === 0) {
    if (onProgress !== undefined) {
      const dur =
        options?.totalMediaTimeUs ??
        (options?.stats !== undefined ? mediaTimeFromStats(options.stats) : undefined);
      const r = createRangeProgressReporter(onProgress, options?.stage ?? 'range', 0, dur);
      r.report(0, 0);
      r.complete();
    }
    return new Uint8Array(0);
  }
  if (source.range === undefined) {
    throw new MediaError(
      'capability-miss',
      'range-progress: source has no range() (resumable requires random access)',
    );
  }
  const chunkSize =
    options?.chunkSize !== undefined ? Math.max(1, Math.trunc(options.chunkSize)) : 64 * 1024;
  const totalMedia =
    options?.totalMediaTimeUs ??
    (options?.stats !== undefined ? mediaTimeFromStats(options.stats) : undefined);
  const reporter = createRangeProgressReporter(
    onProgress,
    options?.stage ?? 'range',
    expected,
    totalMedia,
  );
  const range = source.range.bind(source);
  const chunks: Uint8Array[] = [];
  let offset = lo;
  let remaining = expected;
  try {
    while (remaining > 0) {
      throwIfSourceAborted(signal);
      const win = Math.min(remaining, chunkSize);
      const got = await range(offset, offset + win, signal);
      throwIfSourceAborted(signal);
      if (got.byteLength === 0) break;
      chunks.push(got);
      offset += got.byteLength;
      remaining -= got.byteLength;
      const bytesDone = expected - remaining;
      reporter.report(bytesDone);
      if (got.byteLength < win) break;
    }
    if (remaining !== 0) {
      // EOF before expected: if size known it's a short-read error, else clamp and report what we got
      if (source.size !== undefined) {
        throw new MediaError(
          'demux-error',
          `range-progress short read: got ${expected - remaining} of ${expected} bytes [${lo}, ${hi})`,
        );
      }
      // unknown size: collected is the real EOF
      const collected = expected - remaining;
      const out = new Uint8Array(collected);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      reporter.report(collected);
      reporter.complete();
      return out;
    }
    if (chunks.length === 1) {
      const single = chunks[0] as Uint8Array;
      // ensure exact expected length (server may over-return, slice)
      const out = single.byteLength === expected ? single : single.subarray(0, expected);
      reporter.complete();
      return out;
    }
    const out = new Uint8Array(expected);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    reporter.complete();
    return out;
  } catch (e) {
    // On abort, emit last progress with resumeOffset for caller resumption
    if (onProgress !== undefined) {
      const bytesDone = expected - remaining;
      try {
        reporter.report(bytesDone);
      } catch {}
    }
    throw e;
  }
}
