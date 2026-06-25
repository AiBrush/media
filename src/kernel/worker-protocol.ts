/**
 * Worker offload wire protocol (docs/architecture/06 §4/§6, ADR-019/ADR-010) — the serializable
 * message contract between the main-thread {@link WorkerStreamBridge} and the worker-side
 * {@link runOffloadWorker}. Heavy ops (decode/encode/transcode/convert/filter/mux) run off the main
 * thread; this file defines *only* the messages that cross the boundary plus the pure helpers that make
 * the crossing correct: a job is a serializable spec (never a function closure — ADR-010), results
 * stream back under a **credit window** (backpressure), `VideoFrame`/`AudioData`/`ArrayBuffer` cross as
 * **Transferables** (moved, never copied), and a worker-side typed error is reconstructed as the *same*
 * {@link MediaError} subclass on the host (a structured clone would otherwise drop the subclass).
 *
 * Zero runtime DOM dependency: the types name DOM Transferables but the code only touches plain objects,
 * so this module loads in Node (where the protocol is validated with a `MessageChannel` transport) and in
 * a real Worker alike.
 */

import {
  CapabilityError,
  InputError,
  MediaError,
  type MediaErrorCode,
} from '../contracts/errors.ts';

// ============ transport ============

/**
 * The minimal duplex message port the bridge needs — satisfied by a `Worker`, a `MessagePort`, or a
 * `DedicatedWorkerGlobalScope`. Abstracting it lets the real `Worker` carry production traffic while a
 * `MessageChannel` port drives the Node protocol tests against the *same* bridge logic (the Worker is
 * mocked only as transport; the bridge/protocol code under test is real).
 */
export interface MessageLike<TIn, TOut> {
  postMessage(message: TOut, transfer?: readonly Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: { data: TIn }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: TIn }) => void): void;
}

/** A transport that can also be shut down (a real `Worker`). `MessagePort`s expose `close()` instead. */
export interface TerminableTransport {
  terminate(): void;
}

// ============ job ============

/**
 * A serializable heavy-op job (ADR-010): the discriminated op plus a plain-object payload and the input
 * byte buffers to transfer. The payload is whatever the worker-side runner needs to rebuild the pipeline
 * (codec configs, filter specs, container choice, trim range …) — all structured-cloneable; the large
 * inputs travel in `transfer` (moved, not copied). `determinism` threads ADR-007 into the worker.
 */
export interface OffloadJob {
  readonly op: 'decode' | 'encode' | 'convert' | 'transcode' | 'filter' | 'mux' | 'remux';
  readonly payload: unknown;
  readonly determinism?: 'auto' | 'force-software';
}

// ============ host → worker ============

/** Start a job. `transfer` lists the input Transferables (input `ArrayBuffer`s) moved with the message. */
export interface JobMessage {
  readonly t: 'job';
  readonly job: OffloadJob;
  /** Initial backpressure credit: how many result chunks the worker may send before awaiting more. */
  readonly credit: number;
}

/** Replenish backpressure credit as the host consumes result chunks (one credit per consumed chunk). */
export interface CreditMessage {
  readonly t: 'credit';
  readonly n: number;
}

/** Cancel the in-flight job (AbortSignal → worker). The worker tears down and closes in-flight frames. */
export interface CancelMessage {
  readonly t: 'cancel';
}

/** Every message the host sends the worker. */
export type HostMessage = JobMessage | CreditMessage | CancelMessage;

// ============ worker → host ============

/** The worker is initialized and ready to accept a job (sent once on worker start). */
export interface ReadyMessage {
  readonly t: 'ready';
  /** Whether the worker-side substrate (WebCodecs) is actually available — the honest offload gate. */
  readonly webcodecs: boolean;
}

/**
 * One result chunk. `frame` carries a Transferable result (a `VideoFrame`/`AudioData` for a frame stream,
 * or an `ArrayBuffer` for an encoded/muxed byte stream); it is **transferred** (ownership moves to the
 * host, which becomes its sole owner and the last consumer that `close()`s it). `seq` is monotonic so the
 * host can credit precisely.
 */
export interface ChunkMessage {
  readonly t: 'chunk';
  readonly seq: number;
  readonly frame: Transferable;
}

/** Monotonic progress derived from timestamps (doc 06 §8); forwarded to the caller's `onProgress`. */
export interface ProgressMessage {
  readonly t: 'progress';
  readonly done: number;
  readonly total?: number;
  readonly stage: string;
}

/** The job finished successfully; no more chunks follow. */
export interface DoneMessage {
  readonly t: 'done';
}

/** The job failed; `error` is the serialized typed error (rebuilt to its subclass on the host). */
export interface ErrorMessage {
  readonly t: 'error';
  readonly error: SerializedError;
}

/** Every message the worker sends the host. */
export type WorkerMessage =
  | ReadyMessage
  | ChunkMessage
  | ProgressMessage
  | DoneMessage
  | ErrorMessage;

// ============ typed-error transport ============

/**
 * The wire form of a {@link MediaError}: a structured clone strips the subclass (a `CapabilityError`
 * arrives as a plain `Error`), so the typed model crosses the boundary as data — `{ code, message,
 * detail, kind }` — and is rebuilt by {@link deserializeError}. `kind` distinguishes the three concrete
 * subclasses; a non-`MediaError` throw is carried with `kind:'generic'` so the host can wrap it.
 */
export interface SerializedError {
  readonly kind: 'media' | 'capability' | 'input' | 'generic';
  readonly code?: MediaErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}

/** Serialize a thrown value for the wire, preserving a {@link MediaError}'s code/subclass + `detail`. */
export function serializeError(e: unknown): SerializedError {
  if (e instanceof CapabilityError) {
    return { kind: 'capability', code: e.code, message: e.message, detail: safeDetail(e.detail) };
  }
  if (e instanceof InputError) {
    return { kind: 'input', code: e.code, message: e.message, detail: safeDetail(e.detail) };
  }
  if (e instanceof MediaError) {
    return { kind: 'media', code: e.code, message: e.message, detail: safeDetail(e.detail) };
  }
  return { kind: 'generic', message: e instanceof Error ? e.message : String(e) };
}

/**
 * Rebuild a host-side error from the wire form. A {@link MediaError} subclass is reconstructed with its
 * original code/detail so `instanceof CapabilityError` and `.code` hold across the boundary; a generic
 * error is wrapped with `fallbackCode` (the op's `errorCode`) when provided, else a faithful `Error`.
 */
export function deserializeError(s: SerializedError, fallbackCode?: MediaErrorCode): Error {
  switch (s.kind) {
    case 'capability':
      return new CapabilityError(s.code ?? 'capability-miss', s.message, s.detail);
    case 'input':
      return new InputError(s.code ?? 'unsupported-input', s.message, s.detail);
    case 'media':
      return new MediaError(s.code ?? 'decode-error', s.message, s.detail);
    case 'generic':
      return fallbackCode !== undefined
        ? new MediaError(fallbackCode, s.message)
        : new Error(s.message);
    default:
      return assertNever(s.kind);
  }
}

/** `detail` may itself be unserializable (e.g. a live object); keep only clone-safe shapes, else drop. */
function safeDetail(detail: unknown): unknown {
  if (detail === undefined || detail === null) return detail;
  try {
    return structuredClone(detail);
  } catch {
    // The detail held something non-cloneable (a function, a live handle); the message survives without it.
    return undefined;
  }
}

// ============ transferables ============

/**
 * Collect the Transferables reachable in `value` (for the `postMessage` transfer list) so each is **moved,
 * not structured-clone-copied** (doc 06 §4). Recognizes the spec Transferable interfaces —
 * `ArrayBuffer`, `MessagePort`, the stream types, `ImageBitmap`, and the WebCodecs `VideoFrame`/
 * `AudioData` (and `OffscreenCanvas`) — plus a typed array / `DataView`, whose backing `.buffer` is the
 * Transferable. A frame is matched structurally (a `close`-bearing object exposing `codedWidth` or
 * `numberOfFrames`) so the helper needs no DOM globals and works identically in Node and the browser.
 * De-duplicates (a buffer shared by two views transfers once). Pure; never throws.
 */
export function collectTransferables(value: unknown): Transferable[] {
  const out: Transferable[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || depth > 4) return;
    if (isTransferableObject(v)) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v as Transferable);
      }
      return;
    }
    if (ArrayBuffer.isView(v)) {
      const buf = (v as ArrayBufferView).buffer;
      if (buf instanceof ArrayBuffer && !seen.has(buf)) {
        seen.add(buf);
        out.push(buf);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    for (const item of Object.values(v as Record<string, unknown>)) visit(item, depth + 1);
  };
  visit(value, 0);
  return out;
}

/** True for an object that is itself a structured-clone Transferable (moved by `postMessage`'s 2nd arg). */
function isTransferableObject(v: object): boolean {
  if (v instanceof ArrayBuffer) return true;
  if (typeof MessagePort !== 'undefined' && v instanceof MessagePort) return true;
  if (typeof ReadableStream !== 'undefined' && v instanceof ReadableStream) return true;
  if (typeof WritableStream !== 'undefined' && v instanceof WritableStream) return true;
  if (typeof TransformStream !== 'undefined' && v instanceof TransformStream) return true;
  // WebCodecs frames + ImageBitmap/OffscreenCanvas have no Node global; match them structurally by their
  // distinctive close()+geometry surface so the host needn't construct a real VideoFrame to detect one.
  return isFrameLike(v);
}

/**
 * Structural test for a Transferable media handle (`VideoFrame`/`AudioData`/`ImageBitmap`): a `close`
 * method plus a frame-shaped field (`codedWidth` for video / `ImageBitmap`-`width`+`close`, or
 * `numberOfFrames` for audio). Lets the protocol carry real frames in the browser while a Node test can
 * supply a stand-in that satisfies the same shape — the transfer/close-once contract is what we validate.
 */
export function isFrameLike(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const o = v as {
    close?: unknown;
    codedWidth?: unknown;
    numberOfFrames?: unknown;
    width?: unknown;
  };
  if (typeof o.close !== 'function') return false;
  return (
    typeof o.codedWidth === 'number' ||
    typeof o.numberOfFrames === 'number' ||
    typeof o.width === 'number'
  );
}

function assertNever(x: never): never {
  throw new MediaError('decode-error', `unreachable worker message kind: ${String(x)}`);
}
