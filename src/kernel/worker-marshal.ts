/**
 * Offload job marshaling (doc 06 §4, ADR-010/ADR-019; split out of `worker-host.ts` per punch-list 5) —
 * assemble the serializable {@link OffloadJob} for a heavy `convert`/`trim` (source hints + sink-free
 * public options + the input bytes as the ONE declared transferable), run it on a bridge/pool, and
 * re-expose the worker's Transferable byte chunks as a `ReadableStream<Uint8Array>`. No
 * `VideoFrame`/`AudioData` crosses here — only encoded bytes (frames live and die inside the worker's
 * inner engine). Also owns the per-op caps policy: which media kinds a job needs (punch-list 6).
 */

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
 * Encode an **ABR ladder** from one source across a pool: fan the K renditions out as K independent
 * `convert` jobs (concurrency `min(N,K)`), returning a byte stream per rendition **in input order**.
 * Because a transfer detaches the input buffer, each rendition gets its **own copy** of the source bytes
 * (a worker must own a transferable buffer) — unavoidable and explicit.
 */
export async function offloadAbrLadder(
  pool: JobStreamRunner,
  src: Source,
  ladder: readonly AbrRendition[],
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>[]> {
  const { bytes } = await readSourceOwned(src, opts.signal);
  const { determinism, pinDriver, wasmRuntime, wasmAssetBaseUrl } = opts;
  const jobs: OffloadJob[] = ladder.map((rung) => ({
    op: 'convert' as const,
    // Per-rendition copy: each job transfers (detaches) its own input buffer, so they cannot share one.
    // `TypedArray.slice` always allocates a fresh plain ArrayBuffer (never an SAB), so the cast is sound.
    payload: {
      ...buildOffloadPayload('convert', src, rung.opts),
      input: bytes.slice().buffer as ArrayBuffer,
    },
    ...(determinism !== undefined ? { determinism } : {}),
    ...(pinDriver !== undefined ? { pinDriver } : {}),
    ...(wasmRuntime !== undefined ? { wasmRuntime } : {}),
    ...(wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl } : {}),
  }));
  const runOpts = runOptionsOf(opts);
  return jobs.map((job) => asBytes(pool.runStream(job, runOpts)));
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
