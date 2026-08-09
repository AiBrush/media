/**
 * Offload job marshaling (doc 06 §4, ADR-010/ADR-019; split out of `worker-host.ts` per punch-list 5) —
 * assemble the serializable {@link OffloadJob} for a heavy `convert`/`trim` (source hints + sink-free
 * public options + the input bytes as the ONE declared transferable), run it on a bridge/pool, and
 * re-expose the worker's Transferable byte chunks as a `ReadableStream<Uint8Array>`. No
 * `VideoFrame`/`AudioData` crosses here — only encoded bytes (frames live and die inside the worker's
 * inner engine). Also owns the per-op caps policy: which media kinds a job needs (punch-list 6).
 */

import { H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS, H264_ABR_MAX_SOURCE_BYTES } from '../api/types.ts';
import type { WasmRuntimeProfile } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import type { Source } from '../sources/source.ts';
import type { RunStreamOptions } from './worker-bridge.ts';
import { readSourceOwned, transferableInput } from './worker-input.ts';
import type { OffloadJobPayload } from './worker-main.ts';
import type { OffloadJob, WorkerMediaCaps } from './worker-protocol.ts';

/**
 * A runner that streams one job's Transferable results — satisfied by both a single `WorkerStreamBridge`
 * and a `WorkerPool` (`runStream` has the same signature on each), so the engine can route a heavy op
 * through a pool of N for `{pool:N}` or a single bridge without naming which.
 */
export interface JobStreamRunner {
  /** Maximum jobs the runner can execute concurrently. A single bridge may omit this (treated as one). */
  readonly size?: number;
  runStream(job: OffloadJob, opts: RunStreamOptions): ReadableStream<Transferable>;
}

/** Options for {@link runOffloadStream}: the per-call backpressure/abort/progress + the job's determinism. */
export interface OffloadStreamOptions extends RunStreamOptions {
  /** Threaded into the worker job so `force-software` is bit-identical inline vs worker (ADR-007). */
  readonly determinism?: 'auto' | 'force-software';
  readonly pinDriver?: string;
  readonly wasmRuntime?: WasmRuntimeProfile;
  readonly wasmAssetBaseUrl?: string;
}

/** A source's serializable routing hints (filename/mime) carried so the worker routes identically. */
interface SourceHints {
  readonly filename?: string;
  readonly mimeHint?: string;
}

/**
 * The shape of public op options the offload helpers accept — any object that *may* carry a `sink`
 * (stripped: the worker always streams bytes back; the host owns the real sink). A generic preserves the
 * caller's concrete fields across the `{ sink, ...rest }` split.
 */
export type WithOptionalSink = { readonly sink?: unknown };

/**
 * Build the serializable {@link OffloadJobPayload} for a heavy op (ADR-010): mime/filename hints (so
 * container routing in the worker matches the host's inline path) plus the public options **minus
 * `sink`**. The `input` placeholder is a *fresh* zero-length buffer per payload — never a shared module
 * constant, which the typed transfer list would detach on first post and then fail to re-transfer —
 * and {@link runOffloadStream} fills it with the real read bytes. All carried fields are flat +
 * structured-cloneable. Accurate trim is the only trim that offloads (keyframe trim is a pure-TS
 * stream-copy, ADR-021), so the worker's inner trim is pinned `mode:'accurate'`.
 */
export function buildOffloadPayload<T extends WithOptionalSink>(
  kind: OffloadJobPayload['kind'],
  hints: SourceHints,
  opts: T,
): OffloadJobPayload {
  const { sink: _sink, ...rest } = opts;
  const common = {
    input: new ArrayBuffer(0),
    ...(hints.filename !== undefined ? { filename: hints.filename } : {}),
    ...(hints.mimeHint !== undefined ? { mime: hints.mimeHint } : {}),
  };
  return kind === 'trim'
    ? { kind: 'trim', ...common, opts: { ...rest, mode: 'accurate' } as never }
    : { kind: 'convert', ...common, opts: rest as never };
}

/**
 * The per-media-kind substrate a job needs, derived from its public options: a kind is needed unless the
 * caller explicitly disabled it (`video:false` / `audio:false` in `ConvertOptions`). Absent fields are
 * conservative (needed) — a trim or a plain convert may touch both kinds. Backend-neutral by design.
 */
export function offloadCapsNeed(opts: unknown): WorkerMediaCaps {
  const o = (typeof opts === 'object' && opts !== null ? opts : {}) as {
    readonly video?: unknown;
    readonly audio?: unknown;
  };
  return { video: o.video !== false, audio: o.audio !== false };
}

/** True when the worker's announced caps cover the needed kinds (`undefined` caps ⇒ unrestricted). */
export function capsSatisfy(caps: WorkerMediaCaps | undefined, need: WorkerMediaCaps): boolean {
  if (caps === undefined) return true;
  return (!need.video || caps.video) && (!need.audio || caps.audio);
}

/**
 * The single host entry the engine calls to offload a heavy `convert`/`trim`: build the payload from the
 * source hints + public options, run it on the bridge/pool, return the encoded byte stream.
 */
export function offloadHeavyOp<T extends WithOptionalSink>(
  runner: JobStreamRunner,
  src: Source,
  kind: OffloadJobPayload['kind'],
  publicOpts: T,
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  return runOffloadStream(runner, src, buildOffloadPayload(kind, src, publicOpts), opts);
}

/**
 * Run one heavy job on a worker bridge/pool and return its produced byte stream. Reads the whole source
 * to bytes (the worker rebuilds a *seekable* `fromBytes` source for demux), fills the payload's `input`
 * with the transferable buffer — **adopting** the read buffer zero-copy when this side owns it, copying
 * only a borrowed `range()` view (punch-list 4; `transferableInput`) — and re-exposes the worker's
 * Transferable result chunks as `Uint8Array`s.
 */
export async function runOffloadStream(
  runner: JobStreamRunner,
  src: Source,
  payload: OffloadJobPayload,
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const read = await readSourceOwned(src, opts.signal);
  const job: OffloadJob = {
    op: payload.kind,
    payload: { ...payload, input: transferableInput(read) },
    ...(opts.determinism !== undefined ? { determinism: opts.determinism } : {}),
    ...(opts.pinDriver !== undefined ? { pinDriver: opts.pinDriver } : {}),
    ...(opts.wasmRuntime !== undefined ? { wasmRuntime: opts.wasmRuntime } : {}),
    ...(opts.wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl: opts.wasmAssetBaseUrl } : {}),
  };
  return asBytes(runner.runStream(job, runOptionsOf(opts)));
}

/**
 * One ABR rendition: the public `convert` options for a single ladder rung. `opts` carries an index
 * signature (unlike the generic param of {@link offloadHeavyOp}) so an inline ladder literal is accepted
 * directly — a declared field can't infer a per-element generic.
 */
export interface AbrRendition {
  /** Convert options for this rung (`to`, `video`, `audio`, …); `sink` is ignored (bytes stream back). */
  readonly opts: { readonly sink?: unknown; readonly [key: string]: unknown };
}

/**
 * ABR offload is allowed only with an affirmative worker handshake that covers every rendition. Unlike
 * the generic single-job helper, missing caps are not treated as unrestricted: a ladder would otherwise
 * start several expensive jobs before discovering that the worker cannot execute one of their media paths.
 */
export function abrLadderCapsSatisfy(
  caps: WorkerMediaCaps | undefined,
  ladder: readonly AbrRendition[],
): boolean {
  return (
    caps !== undefined &&
    ladder.every((rendition) => capsSatisfy(caps, offloadCapsNeed(rendition.opts)))
  );
}

/**
 * Encode an **ABR ladder** from one source across a pool, returning a byte stream per rendition **in input
 * order**. Source copies are allocated only when a bounded scheduler dispatches a rendition, so a K-rung
 * ladder retains at most `min(N,K)` transferable copies instead of eagerly retaining K. A ladder containing
 * an objective-quality rung is deliberately serialized in full: the bounded quality runner already owns
 * sizeable candidate + RGBA/luma audit buffers, and overlapping it with another rung would defeat its
 * per-operation memory ceiling. Bitrate-only ladders retain pool fan-out.
 */
export async function offloadAbrLadder(
  pool: JobStreamRunner,
  src: Source,
  ladder: readonly AbrRendition[],
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>[]> {
  const { bytes } = await readSourceOwned(src, opts.signal, H264_ABR_MAX_SOURCE_BYTES);
  const { determinism, pinDriver, wasmRuntime, wasmAssetBaseUrl } = opts;
  const runOpts = runOptionsOf(opts);
  const containsQualityConstraint = ladder.some((rung) => isQualityConstrainedRendition(rung));
  const declaredConcurrency = Number.isFinite(pool.size)
    ? Math.max(1, Math.floor(pool.size as number))
    : 1;
  const permits = abrPermits(
    containsQualityConstraint
      ? 1
      : Math.min(declaredConcurrency, ladder.length, H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS),
  );

  return ladder.map((rung) =>
    scheduledAbrStream(
      pool,
      permits,
      () => ({
        op: 'convert' as const,
        // A worker must exclusively own its transferred input. Allocate this copy only after the scheduler
        // grants a slot; `TypedArray.slice` always returns a fresh plain ArrayBuffer-backed typed array.
        payload: {
          ...buildOffloadPayload('convert', src, rung.opts),
          input: bytes.slice().buffer as ArrayBuffer,
        },
        ...(determinism !== undefined ? { determinism } : {}),
        ...(pinDriver !== undefined ? { pinDriver } : {}),
        ...(wasmRuntime !== undefined ? { wasmRuntime } : {}),
        ...(wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl } : {}),
      }),
      runOpts,
    ),
  );
}

function isQualityConstrainedRendition(rung: AbrRendition): boolean {
  const { video } = rung.opts;
  return (
    typeof video === 'object' &&
    video !== null &&
    'quality' in video &&
    (video as { readonly quality?: unknown }).quality !== undefined
  );
}

interface AbrPermits {
  acquire(signal: AbortSignal): Promise<() => void>;
  fail(error: unknown): void;
}

/** Small abort-aware semaphore used only for ABR job/source-copy lifetime. */
function abrPermits(limit: number): AbrPermits {
  let active = 0;
  let failure: { readonly error: unknown } | undefined;
  const waiting: Array<{
    readonly signal: AbortSignal;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: unknown) => void;
    readonly onAbort: () => void;
  }> = [];

  const grant = (resolve: (release: () => void) => void): void => {
    active += 1;
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      active -= 1;
      while (waiting.length > 0) {
        const next = waiting.shift();
        if (next === undefined) break;
        next.signal.removeEventListener('abort', next.onAbort);
        if (next.signal.aborted) {
          next.reject(abrAbortError());
          continue;
        }
        grant(next.resolve);
        break;
      }
    });
  };

  return {
    acquire(signal): Promise<() => void> {
      if (failure !== undefined) return Promise.reject(failure.error);
      if (signal.aborted) return Promise.reject(abrAbortError());
      if (active < limit) {
        return new Promise((resolve) => grant(resolve));
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          signal,
          resolve,
          reject,
          onAbort: (): void => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(abrAbortError());
          },
        };
        waiting.push(entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      });
    },
    fail(error): void {
      if (failure !== undefined) return;
      failure = { error };
      for (const pending of waiting.splice(0)) {
        pending.signal.removeEventListener('abort', pending.onAbort);
        pending.reject(error);
      }
    },
  };
}

/** Lazily allocate + dispatch one rendition after the bounded scheduler grants it a slot. */
function scheduledAbrStream(
  pool: JobStreamRunner,
  permits: AbrPermits,
  buildJob: () => OffloadJob,
  opts: RunStreamOptions,
): ReadableStream<Uint8Array> {
  const operation = new AbortController();
  const parentSignal = opts.signal;
  const onParentAbort = (): void => operation.abort(parentSignal?.reason);
  if (parentSignal?.aborted) operation.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let opening: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  let releasePermit: (() => void) | undefined;
  let settled = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    parentSignal?.removeEventListener('abort', onParentAbort);
    releasePermit?.();
    releasePermit = undefined;
  };
  const open = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    releasePermit = await permits.acquire(operation.signal);
    if (operation.signal.aborted) {
      settle();
      throw abrAbortError();
    }
    try {
      const stream = asBytes(pool.runStream(buildJob(), { ...opts, signal: operation.signal }));
      reader = stream.getReader();
      return reader;
    } catch (error) {
      settle();
      throw error;
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          opening ??= open();
          const active = await opening;
          const { done, value } = await active.read();
          if (done) {
            active.releaseLock();
            reader = undefined;
            settle();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          permits.fail(error);
          reader?.releaseLock();
          reader = undefined;
          settle();
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        operation.abort(reason);
        const active = reader ?? (await opening?.catch(() => undefined));
        if (active !== undefined) {
          await active.cancel(reason).catch(() => {});
          active.releaseLock();
        }
        reader = undefined;
        settle();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
}

function abrAbortError(): MediaError {
  return new MediaError('aborted', 'ABR rendition cancelled');
}

/** Strip the job-level fields, keeping only the per-call stream options the bridge consumes. */
function runOptionsOf(opts: OffloadStreamOptions): RunStreamOptions {
  const {
    determinism: _determinism,
    pinDriver: _pinDriver,
    wasmRuntime: _wasmRuntime,
    wasmAssetBaseUrl: _wasmAssetBaseUrl,
    ...runOpts
  } = opts;
  return runOpts;
}

/** Re-type the worker's Transferable byte stream as `Uint8Array` chunks (each chunk is an `ArrayBuffer`). */
function asBytes(stream: ReadableStream<Transferable>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value instanceof ArrayBuffer) {
        controller.enqueue(new Uint8Array(value));
        return;
      }
      // A non-buffer Transferable on the byte path is an internal contract break (the convert/trim worker
      // only ever transfers encoded ArrayBuffers) — fail loudly rather than emit a wrong-typed chunk.
      controller.error(
        new MediaError(
          'encode-error',
          'worker offload produced a non-byte result on the byte path',
        ),
      );
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
