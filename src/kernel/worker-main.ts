/**
 * Worker-side heavy-op reconstruction (docs/architecture/06 §4/§6, ADR-019/ADR-010/ADR-086) — the **pure,
 * Node-testable** core of the worker offload: it builds the production {@link JobRunner} that, given a
 * *serializable* {@link OffloadJob}, rebuilds the heavy `convert`/`trim` pipeline and runs it on an inner
 * engine, streaming the encoded output bytes back to the host. The `self`-bound boot that actually wires
 * this into a real `Worker` (and constructs the real {@link MediaEngineImpl}) lives in the tiny browser-only
 * {@link file://./worker.ts}; keeping it separate lets this module be validated entirely in Node against a
 * fake inner engine (no closure ever crosses the boundary — ADR-010).
 *
 * The reconstruction is a **thin adapter, not a reimplementation** (Prime Directive 3, no dead/duplicated
 * code): it rebuilds a seekable {@link Source} from the transferred input **bytes** via `fromBytes`, rebuilds
 * the public op options, forces `sink: toStream()` (the host owns the real sink), threads `determinism`
 * (`force-software` is literally the same code inline vs worker) and the `AbortSignal`, and calls the **same
 * public op** (`convert`/`trim`) on the inner engine. The entire graph — codec routing, GPU filters, frame
 * close-once — is reused verbatim, now on the worker thread (the boot constructs the inner engine
 * `worker:false` so it runs inline and never re-spawns a worker).
 *
 * Frame lifetime: on this convert/trim path **no `VideoFrame`/`AudioData` ever crosses the boundary** —
 * every frame lives and dies inside the inner engine's inline pipeline; only encoded `Uint8Array` chunks
 * transfer back to the host (doc 06 §4, the byte seam). This sidesteps cross-thread frame ownership.
 */

import type { ConvertOptions, TrimOptions } from '../api/types.ts';
import type { Determinism } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type Output, toStream } from '../sinks/sink.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import type { JobRunner, ProgressSink } from './worker-entry.ts';
import type { OffloadJob } from './worker-protocol.ts';

// ── serializable job payloads (ADR-010: data, never a closure) ───────────────────────────────────────

/** A serializable `convert` job: the input bytes (transferred) + the sink-free public convert options. */
export interface ConvertOffloadPayload {
  readonly kind: 'convert';
  /** The whole input as a transferable `ArrayBuffer` (moved, not copied — doc 06 §4). */
  readonly input: ArrayBuffer;
  /** The original filename hint, so container routing by extension matches the inline path. */
  readonly filename?: string;
  /** The origin MIME hint, so container routing by mime matches the inline path. */
  readonly mime?: string;
  /** Public convert options minus `sink` (the host owns the real sink); flat + structured-cloneable. */
  readonly opts: Omit<ConvertOptions, 'sink'>;
}

/** A serializable accurate-`trim` job: input bytes (transferred) + the sink-free public trim options. */
export interface TrimOffloadPayload {
  readonly kind: 'trim';
  readonly input: ArrayBuffer;
  readonly filename?: string;
  readonly mime?: string;
  readonly opts: Omit<TrimOptions, 'sink'>;
}

/** Every heavy-op payload the worker can reconstruct (the union carried in {@link OffloadJob.payload}). */
export type OffloadJobPayload = ConvertOffloadPayload | TrimOffloadPayload;

// ── the inner engine seam (satisfied by MediaEngineImpl; faked in unit tests) ─────────────────────────

/**
 * The minimal engine surface the {@link JobRunner} drives — exactly the two byte-producing heavy ops it
 * offloads. `MediaEngineImpl` satisfies it structurally; a unit test supplies a fake so the
 * reconstruction is provable without WebCodecs. Each op takes a {@link Source} (rebuilt from bytes), the
 * sink-bearing public options, and per-call options (signal + determinism), and yields the produced
 * byte {@link Output} (a `ReadableStream<Uint8Array>` because the sink is `toStream()`).
 */
export interface InnerEngine {
  convert(
    input: Source,
    opts: ConvertOptions,
    o?: { signal?: AbortSignal; strategy?: { determinism?: Determinism } },
  ): Promise<Output> & { cancel?(): void };
  trim(
    input: Source,
    opts: TrimOptions,
    o?: { signal?: AbortSignal; strategy?: { determinism?: Determinism } },
  ): Promise<Output> & { cancel?(): void };
}

/** Build the inner engine for a job (lazily, once per job). Overridable in tests. */
export type InnerEngineFactory = (determinism: Determinism) => InnerEngine;

// ── payload decode (the serializable contract is checked, never trusted blindly) ──────────────────────

/**
 * Validate + narrow an untyped {@link OffloadJob.payload} to a typed {@link OffloadJobPayload}. The wire
 * is structured-clone data we did not author in-process, so the discriminant + the input-buffer type are
 * checked and a bad shape is an honest typed {@link InputError} (never a silent/empty result — Prime
 * Directive 6). The `opts` object is passed through as-is (the inner op re-validates every field).
 */
export function decodeOffloadPayload(payload: unknown): OffloadJobPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new InputError('unsupported-input', 'worker job payload is not an object');
  }
  const p = payload as { kind?: unknown; input?: unknown; opts?: unknown };
  if (!(p.input instanceof ArrayBuffer)) {
    throw new InputError('unsupported-input', 'worker job payload.input must be an ArrayBuffer');
  }
  if (p.kind !== 'convert' && p.kind !== 'trim') {
    throw new InputError('unsupported-input', `unknown worker job kind '${String(p.kind)}'`);
  }
  return payload as OffloadJobPayload;
}

// ── the real JobRunner ────────────────────────────────────────────────────────────────────────────────

/**
 * Build the production {@link JobRunner}: it reconstructs the heavy pipeline from a serializable
 * {@link OffloadJob} and runs it on a fresh inner {@link InnerEngine}, surfacing the produced byte stream
 * as the offload result (`ReadableStream<Uint8Array>` ≡ `ReadableStream<Transferable>`; each chunk's
 * backing buffer transfers back to the host). `makeInner` is injected so production uses a real
 * `MediaEngineImpl` while tests inject a fake (the reconstruction is what we validate; the inline graph is
 * already covered elsewhere + in the browser harness).
 *
 * Cancellation: the `ctx.signal` (raised by the host's `{t:'cancel'}`) is threaded into the inner op's
 * `CallOptions.signal`, so an abort tears the inline pipeline down — releasing WebCodecs/WASM and closing
 * in-flight frames (doc 06 §7) — and the produced stream ends.
 */
export function makeJobRunner(makeInner: InnerEngineFactory): JobRunner {
  return (job, ctx) => streamForJob(job, ctx, makeInner);
}

/**
 * Run one reconstructed job to a byte stream. Errors (bad payload, inner-op rejection) surface as the
 * stream erroring — {@link runOffloadWorker} serializes that to a typed error on the wire. The inner
 * op's produced stream is returned directly (its chunks ARE the transferables); a lazy `pull` wrapper
 * defers the inner op's first byte until the host actually reads, preserving backpressure end to end.
 */
function streamForJob(
  job: OffloadJob,
  ctx: { signal: AbortSignal; progress: ProgressSink },
  makeInner: InnerEngineFactory,
): ReadableStream<Transferable> {
  let inner: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let started = false;

  const start = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    const payload = decodeOffloadPayload(job.payload);
    const determinism: Determinism = job.determinism ?? 'auto';
    const engine = makeInner(determinism);
    const source = sourceFromPayload(payload);
    const callOptions = {
      signal: ctx.signal,
      strategy: { determinism },
      onProgress: ctx.progress,
    };
    const output = await runInnerOp(engine, source, payload, callOptions);
    const stream = asByteStream(output, payload.kind);
    return stream.getReader();
  };

  return new ReadableStream<Transferable>({
    async pull(controller): Promise<void> {
      try {
        if (!started) {
          started = true;
          inner = await start();
        }
        /* v8 ignore next 4 -- defensive: start() always resolves a reader, so `inner` is never undefined here. */
        if (inner === undefined) {
          controller.close();
          return;
        }
        const { done, value } = await inner.read();
        if (done) {
          controller.close();
          return;
        }
        // Hand the chunk's backing buffer to the host as a Transferable (it is moved by the worker pump).
        controller.enqueue(value.buffer as ArrayBuffer);
      } catch (e) {
        controller.error(toTypedError(e, job));
      }
    },
    async cancel(reason): Promise<void> {
      await inner?.cancel(reason).catch(() => {});
    },
  });
}

/** Dispatch to the inner op the payload names. Exhaustive over {@link OffloadJobPayload['kind']}. */
function runInnerOp(
  engine: InnerEngine,
  source: Source,
  payload: OffloadJobPayload,
  o: { signal: AbortSignal; strategy: { determinism: Determinism }; onProgress: ProgressSink },
): Promise<Output> {
  switch (payload.kind) {
    case 'convert':
      return engine.convert(source, { ...payload.opts, sink: toStream() }, o);
    case 'trim':
      return engine.trim(source, { ...payload.opts, sink: toStream() }, o);
    /* v8 ignore next 2 -- exhaustive over the validated payload kind; the default is unreachable. */
    default:
      return assertNever(payload);
  }
}

/** Rebuild a seekable {@link Source} from a payload's transferred bytes (carrying the mime/filename hints). */
function sourceFromPayload(payload: OffloadJobPayload): Source {
  const base = fromBytes(payload.input, payload.mime !== undefined ? { mime: payload.mime } : {});
  // `fromBytes` does not take a filename; attach the hint so container routing-by-extension matches the
  // host's inline path exactly (the host read these bytes from a named source). A spread keeps Source's
  // own `stream`/`range` closures intact.
  return payload.filename !== undefined ? { ...base, filename: payload.filename } : base;
}

/**
 * Narrow the inner op's {@link Output} to the `ReadableStream<Uint8Array>` the stream sink guarantees. The
 * offloaded ops always pass `sink: toStream()`, so a non-stream `Output` would be an internal contract
 * break — a typed error, never a silent wrong result.
 */
function asByteStream(output: Output, op: string): ReadableStream<Uint8Array> {
  if (output instanceof ReadableStream) return output as ReadableStream<Uint8Array>;
  throw new MediaError(
    op === 'trim' ? 'mux-error' : 'encode-error',
    `worker ${op} produced no byte stream (expected a stream sink result)`,
  );
}

/** Map a thrown value to a typed error for the wire (a {@link MediaError} subclass passes through). */
function toTypedError(e: unknown, job: OffloadJob): Error {
  if (e instanceof MediaError) return e;
  if (e instanceof CapabilityError || e instanceof InputError) return e;
  return new MediaError(
    job.op === 'trim' ? 'mux-error' : 'encode-error',
    e instanceof Error ? e.message : String(e),
  );
}

/* v8 ignore start -- unreachable exhaustiveness guard (the payload kind is validated before dispatch). */
function assertNever(x: never): never {
  throw new MediaError('decode-error', `unreachable offload payload: ${JSON.stringify(x)}`);
}
/* v8 ignore stop */
