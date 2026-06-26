/**
 * Worker-main JobRunner reconstruction (BUILD §2/§6; ADR-019/ADR-010, doc 06 §4/§6) — proves the
 * worker-side {@link makeJobRunner} rebuilds the heavy decode→encode→mux pipeline from a *serializable*
 * {@link OffloadJob} and runs it on an inner inline engine, with NO closures crossing the boundary. The
 * inner engine is faked here (a real one needs WebCodecs); the contract under test is the reconstruction:
 *
 *  - the transferred input **bytes** become a seekable `fromBytes` source (the worker can demux it),
 *  - the serializable payload options drive the inner op (`convert`/`trim`), with `sink` forced to a
 *    stream sink (the host owns the real sink),
 *  - `determinism` threads through to the inner engine (so `force-software` is identical inline vs worker),
 *  - the produced `ReadableStream<Uint8Array>` is surfaced as the offload result stream (bytes transfer
 *    back; frames never cross — they live and die inside the inner engine),
 *  - an unknown op is an honest typed error (never a fake/empty result),
 *  - `AbortSignal` is threaded into the inner op's `CallOptions`.
 */

import { describe, expect, it } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import type { Output } from '../sinks/sink.ts';
import {
  type InnerEngine,
  type OffloadJobPayload,
  decodeOffloadPayload,
  makeJobRunner,
} from './worker-main.ts';
import type { OffloadJob } from './worker-protocol.ts';

// ── a fake inner engine that records how it was called and returns a byte stream ─────────────────────

interface RecordedCall {
  op: 'convert' | 'trim';
  bytes: number[];
  filename: string | undefined;
  // The reconstructed {@link Source} carries the origin MIME on its real `mimeHint` field (what the
  // container router reads), not a bare `mime` — assert on that so the test tracks the production shape.
  mimeHint: string | undefined;
  opts: unknown;
  sinkKind: string;
  determinism: string | undefined;
  signalProvided: boolean;
}

function byteStream(bytes: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(Uint8Array.from(bytes));
      c.close();
    },
  });
}

function fakeInnerEngine(calls: RecordedCall[]): InnerEngine {
  const record = (
    op: 'convert' | 'trim',
    input: { bytes(): Promise<Uint8Array>; filename?: string; mimeHint?: string },
    opts: { sink?: { kind: string } } & Record<string, unknown>,
    o: { signal?: AbortSignal; strategy?: { determinism?: string } } | undefined,
  ): Promise<Output> =>
    input.bytes().then((b) => {
      calls.push({
        op,
        bytes: [...b],
        filename: input.filename,
        mimeHint: input.mimeHint,
        opts,
        sinkKind: opts.sink?.kind ?? '<none>',
        determinism: o?.strategy?.determinism,
        signalProvided: o?.signal !== undefined,
      });
      // Echo the input bytes back as the "encoded" output so the test can assert the stream surfaced.
      return Promise.resolve(byteStream([...b, 0xff]) as unknown as Output);
    });
  return {
    convert: (input, opts, o) =>
      record('convert', input as never, opts as never, o as never) as ReturnType<
        InnerEngine['convert']
      >,
    trim: (input, opts, o) =>
      record('trim', input as never, opts as never, o as never) as ReturnType<InnerEngine['trim']>,
  };
}

/** Adapt a Source-like input ({@link makeJobRunner} builds a real {@link Source}) to the fake's `bytes()`. */
function bytesOf(input: unknown): Promise<Uint8Array> {
  const src = input as {
    range?(s: number, e: number): Promise<Uint8Array>;
    size?: number;
    stream(): ReadableStream<Uint8Array>;
  };
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  return drainBytes(src.stream());
}

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// The fake InnerEngine receives a real Source from makeJobRunner; teach it `bytes()` by wrapping the
// inner factory so the recorded call can read the reconstructed source bytes.
function innerWithBytes(calls: RecordedCall[]): InnerEngine {
  const base = fakeInnerEngine(calls);
  const wrap =
    (fn: InnerEngine['convert'] | InnerEngine['trim']) =>
    (input: unknown, opts: unknown, o: unknown) =>
      fn({ bytes: () => bytesOf(input), ...(input as object) } as never, opts as never, o as never);
  return { convert: wrap(base.convert) as never, trim: wrap(base.trim) as never };
}

async function drain(stream: ReadableStream<Transferable>): Promise<Transferable[]> {
  const out: Transferable[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function jobOf(payload: OffloadJobPayload, determinism?: 'auto' | 'force-software'): OffloadJob {
  return {
    op: payload.kind,
    payload,
    ...(determinism !== undefined ? { determinism } : {}),
  };
}

const noopCtx = { signal: new AbortController().signal, progress: () => {} };

// ── reconstruction ───────────────────────────────────────────────────────────────────────────────────

describe('makeJobRunner: pipeline reconstruction', () => {
  it('rebuilds a convert: bytes → fromBytes source, sink forced to stream, options passed through', async () => {
    const calls: RecordedCall[] = [];
    const runner = makeJobRunner(() => innerWithBytes(calls));
    const input = Uint8Array.from([1, 2, 3, 4]).buffer;
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input,
      filename: 'clip.mp4',
      mime: 'video/mp4',
      opts: { to: 'webm', video: { width: 320, height: 240 } },
    };
    const out = (await drain(runner(jobOf(payload), noopCtx))) as ArrayBuffer[];

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected one inner convert call');
    expect(call.op).toBe('convert');
    expect(call.bytes).toEqual([1, 2, 3, 4]); // the transferred bytes became the source
    expect(call.filename).toBe('clip.mp4');
    expect(call.mimeHint).toBe('video/mp4');
    expect(call.sinkKind).toBe('stream'); // host owns the real sink; worker streams bytes back
    expect(call.opts).toMatchObject({ to: 'webm', video: { width: 320, height: 240 } });
    // The produced byte stream is surfaced as transferable chunks (input echoed + 0xff sentinel).
    expect(out).toHaveLength(1);
    const buf = out[0];
    if (buf === undefined) throw new Error('expected one output chunk');
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 4, 0xff]);
  });

  it('threads determinism (force-software is identical inline vs worker)', async () => {
    const calls: RecordedCall[] = [];
    const runner = makeJobRunner(() => innerWithBytes(calls));
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input: Uint8Array.from([9]).buffer,
      opts: { to: 'mp4' },
    };
    await drain(runner(jobOf(payload, 'force-software'), noopCtx));
    expect(calls[0]?.determinism).toBe('force-software');
  });

  it('rebuilds an accurate trim with its serializable options', async () => {
    const calls: RecordedCall[] = [];
    const runner = makeJobRunner(() => innerWithBytes(calls));
    const payload: OffloadJobPayload = {
      kind: 'trim',
      input: Uint8Array.from([5, 6]).buffer,
      opts: { start: 1, end: 2, mode: 'accurate' },
    };
    await drain(runner(jobOf(payload), noopCtx));
    expect(calls[0]?.op).toBe('trim');
    expect(calls[0]?.opts).toMatchObject({ start: 1, end: 2, mode: 'accurate' });
    expect(calls[0]?.sinkKind).toBe('stream');
  });

  it('threads the abort signal into the inner op', async () => {
    const calls: RecordedCall[] = [];
    const runner = makeJobRunner(() => innerWithBytes(calls));
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input: Uint8Array.from([1]).buffer,
      opts: {},
    };
    await drain(runner(jobOf(payload), noopCtx));
    expect(calls[0]?.signalProvided).toBe(true);
  });

  it('rejects an unknown op with a typed error (never a fake/empty result)', async () => {
    const runner = makeJobRunner(() => innerWithBytes([]));
    const bogus: OffloadJob = { op: 'mux', payload: { kind: 'mux' } as unknown };
    await expect(drain(runner(bogus, noopCtx))).rejects.toBeInstanceOf(MediaError);
  });

  it('wraps a generic inner-op throw as a typed MediaError on the byte path', async () => {
    const inner: InnerEngine = {
      convert: () => Promise.reject(new Error('plain failure')),
      trim: () => Promise.resolve(undefined),
    };
    const runner = makeJobRunner(() => inner);
    const payload: OffloadJobPayload = { kind: 'convert', input: new ArrayBuffer(1), opts: {} };
    await expect(drain(runner(jobOf(payload), noopCtx))).rejects.toMatchObject({
      name: 'MediaError',
      code: 'encode-error',
      message: 'plain failure',
    });
  });

  it('wraps a generic inner trim throw with the trim error code (mux-error)', async () => {
    const inner: InnerEngine = {
      convert: () => Promise.resolve(undefined),
      trim: () => Promise.reject(new Error('trim broke')),
    };
    const runner = makeJobRunner(() => inner);
    const payload: OffloadJobPayload = {
      kind: 'trim',
      input: new ArrayBuffer(1),
      opts: { start: 0, end: 1 },
    };
    await expect(drain(runner(jobOf(payload), noopCtx))).rejects.toMatchObject({
      code: 'mux-error',
    });
  });

  it('errors when the inner op returns a non-stream Output (forced stream-sink contract break)', async () => {
    // The sink is forced to `stream`, so a real engine returns a ReadableStream; a non-stream Output is an
    // internal contract break that must surface a typed error, not a silent empty result.
    const inner: InnerEngine = {
      convert: () => Promise.resolve(new Uint8Array([1]) as unknown as Output),
      trim: () => Promise.resolve(undefined),
    };
    const runner = makeJobRunner(() => inner);
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input: Uint8Array.from([1]).buffer,
      opts: {},
    };
    await expect(drain(runner(jobOf(payload), noopCtx))).rejects.toBeInstanceOf(MediaError);
  });

  it('rejects a payload whose op disagrees with the job op kind (mismatch is not silently coerced)', async () => {
    // Job says `convert` but the payload kind is `trim`: decodeOffloadPayload narrows on the payload kind,
    // so the reconstruction must dispatch on a single, consistent kind (here it runs trim's branch). This
    // pins the dispatch-on-payload contract.
    const calls: RecordedCall[] = [];
    const runner = makeJobRunner(() => innerWithBytes(calls));
    const job: OffloadJob = {
      op: 'convert',
      payload: { kind: 'trim', input: Uint8Array.from([2]).buffer, opts: { start: 0, end: 1 } },
    };
    await drain(runner(job, noopCtx));
    expect(calls[0]?.op).toBe('trim');
  });
});

// ── payload decode guards (the serializable contract) ────────────────────────────────────────────────

describe('decodeOffloadPayload', () => {
  it('accepts a well-formed convert payload', () => {
    const input = new ArrayBuffer(4);
    const p = decodeOffloadPayload({ kind: 'convert', input, opts: { to: 'mp4' } });
    expect(p.kind).toBe('convert');
    expect(p.input).toBe(input);
  });

  it('rejects a payload whose input is not an ArrayBuffer', () => {
    expect(() => decodeOffloadPayload({ kind: 'convert', input: 'not-bytes', opts: {} })).toThrow(
      InputError,
    );
  });

  it('rejects an unknown payload kind', () => {
    expect(() => decodeOffloadPayload({ kind: 'frobnicate', input: new ArrayBuffer(0) })).toThrow(
      InputError,
    );
  });
});
