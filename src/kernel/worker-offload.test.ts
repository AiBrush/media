/**
 * Worker-offload protocol validation (BUILD_INSTRUCTIONS §2/§6; ADR-019, doc 06 §4) — proves the heavy-op
 * offload bridge end-to-end in Node, with the Worker **mocked only as the transport** while the real
 * {@link WorkerStreamBridge} (host) and {@link runOffloadWorker} (worker) logic runs unchanged.
 *
 * Two transports are used, each for the property it can prove honestly:
 *  - a **real `MessageChannel`** (Node ships it) for the on-the-wire round-trip and **transfer
 *    semantics** — a transferred `ArrayBuffer` is *detached* on the sender (`byteLength === 0`) and
 *    arrives intact on the host (the genuine zero-copy move WebCodecs frames also take);
 *  - a tiny **synchronous fake port** for the **close-exactly-once** frame contract — a real
 *    `MessageChannel` can only transfer real Transferables, so to drive the worker's frame-lifetime code
 *    with a `close()`-recording stand-in we deliver messages in-process (still the real bridge logic).
 *
 * Coverage: round-trip + structured result, input-buffer detach after transfer, frame transfer =
 * close-once (success path) and close-once on cancel/post-failure + host-side queue drain, the
 * credit-window backpressure bound, AbortSignal → worker cancel, and typed-error propagation
 * (CapabilityError/InputError survive as their subclass) + the capability gate.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import {
  DEFAULT_CREDIT,
  InlineBridge,
  WorkerStreamBridge,
  workerOffloadAvailable,
} from './worker-bridge.ts';
import { type JobRunner, runOffloadWorker } from './worker-entry.ts';
import {
  type HostMessage,
  type MessageLike,
  type OffloadJob,
  type WorkerMessage,
  collectTransferables,
  deserializeError,
  isFrameLike,
  serializeError,
} from './worker-protocol.ts';

// ── transports ────────────────────────────────────────────────────────────────────────────────────

/** Adapt a Node `MessagePort` to {@link MessageLike} (it needs `start()` for the `message` listener). */
function adaptPort<TIn, TOut>(port: MessagePort): MessageLike<TIn, TOut> {
  port.start();
  return {
    postMessage: (m, transfer) =>
      transfer && transfer.length > 0
        ? port.postMessage(m, transfer as Transferable[])
        : port.postMessage(m),
    addEventListener: (type, listener) =>
      port.addEventListener(type, (ev) => listener({ data: (ev as MessageEvent).data })),
    removeEventListener: () => {
      /* one listener per test; the channel is torn down in afterEach */
    },
  };
}

/**
 * Wire a real `MessageChannel`: host bridge on port1, the worker runtime (driven by `runJob`) on port2.
 * Returns the bridge + the channel so the test can close it. This is the production transport shape —
 * only the *spawn* (a real `new Worker(url)`) is replaced by an in-process channel.
 */
function channelBridge(runJob: JobRunner): {
  bridge: WorkerStreamBridge;
  channel: MessageChannel;
  /** Count of `chunk` messages the worker has actually posted (for the exact backpressure bound). */
  chunkPosts: () => number;
} {
  const channel = new MessageChannel();
  const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  let posts = 0;
  // Wrap the worker's outbound port to count chunk posts — the worker may only post a chunk when it holds
  // a credit, so `posts - delivered ≤ initialCredit` is the exact, race-free backpressure invariant.
  const countingWorkerPort: MessageLike<HostMessage, WorkerMessage> = {
    ...workerPort,
    postMessage: (m, transfer): void => {
      if (m.t === 'chunk') posts += 1;
      workerPort.postMessage(m, transfer);
    },
  };
  runOffloadWorker({ ...countingWorkerPort, webcodecs: true }, runJob);
  const bridge = new WorkerStreamBridge(hostPort, () => {
    channel.port1.close();
    channel.port2.close();
  });
  return { bridge, channel, chunkPosts: () => posts };
}

/**
 * A synchronous in-process port pair (no real channel) so the worker's frame-lifetime code can be driven
 * with a `close()`-recording stand-in (a real channel rejects a non-Transferable in the transfer list).
 * Delivery is microtask-async to mirror a real port without the structured-clone/transfer machinery —
 * the frame object is passed by reference exactly as a transfer would hand it over.
 */
function fakePortPair(): {
  host: MessageLike<WorkerMessage, HostMessage>;
  worker: MessageLike<HostMessage, WorkerMessage>;
} {
  const hostListeners = new Set<(ev: { data: WorkerMessage }) => void>();
  const workerListeners = new Set<(ev: { data: HostMessage }) => void>();
  const deliver = <T>(ls: Set<(ev: { data: T }) => void>, data: T): void => {
    queueMicrotask(() => {
      for (const l of ls) l({ data });
    });
  };
  return {
    host: {
      postMessage: (m) => deliver(workerListeners, m),
      addEventListener: (_t, l) => void hostListeners.add(l),
      removeEventListener: (_t, l) => void hostListeners.delete(l),
    },
    worker: {
      postMessage: (m) => deliver(hostListeners, m),
      addEventListener: (_t, l) => void workerListeners.add(l),
      removeEventListener: (_t, l) => void workerListeners.delete(l),
    },
  };
}

// ── synthetic frame stand-in (records close()es to prove close-exactly-once) ───────────────────────

/** A Transferable-shaped media handle that counts `close()`es, so a leak or double-close is observable. */
class FakeFrame {
  closeCount = 0;
  readonly codedWidth = 2;
  readonly codedHeight = 2;
  constructor(readonly id: number) {}
  close(): void {
    this.closeCount += 1;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

function track(channel: MessageChannel): void {
  channels.push(channel);
}

/** Drain a result stream into an array of chunks (closing nothing — the test owns the closes it asserts). */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const job = (payload: unknown): OffloadJob => ({ op: 'convert', payload });

// ── protocol helpers (pure) ─────────────────────────────────────────────────────────────────────────

describe('worker-protocol: transferable detection', () => {
  it('collects an ArrayBuffer and a typed array’s backing buffer, de-duplicated', () => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8Array(buf); // shares `buf`
    const other = new Uint8Array(8);
    const t = collectTransferables({ a: buf, b: view, c: [other], d: 5, e: 'x' });
    expect(t).toContain(buf);
    expect(t).toContain(other.buffer);
    // `buf` and `view` share one buffer → it appears exactly once.
    expect(t.filter((x) => x === buf)).toHaveLength(1);
  });

  it('detects a frame-shaped object structurally (no DOM globals needed)', () => {
    expect(isFrameLike(new FakeFrame(0))).toBe(true);
    expect(isFrameLike({ close: () => {} })).toBe(false); // no geometry field
    expect(isFrameLike({ codedWidth: 2 })).toBe(false); // no close()
    const frame = new FakeFrame(1);
    expect(collectTransferables({ frame })).toEqual([frame]);
  });
});

describe('worker-protocol: typed-error round-trip', () => {
  it('preserves CapabilityError / InputError / MediaError subclass + code + detail', () => {
    const cap = new CapabilityError('capability-miss', 'no driver', { op: 'encode', tried: ['x'] });
    const back = deserializeError(serializeError(cap));
    expect(back).toBeInstanceOf(CapabilityError);
    expect((back as CapabilityError).code).toBe('capability-miss');
    expect((back as CapabilityError).detail).toEqual({ op: 'encode', tried: ['x'] });

    const input = deserializeError(serializeError(new InputError('unsupported-input', 'bad')));
    expect(input).toBeInstanceOf(InputError);

    const media = deserializeError(serializeError(new MediaError('decode-error', 'boom')));
    expect(media).toBeInstanceOf(MediaError);
    expect((media as MediaError).code).toBe('decode-error');
  });

  it('wraps a generic Error with the op-supplied fallback code, else faithful Error', () => {
    const wire = serializeError(new Error('plain'));
    expect(deserializeError(wire, 'encode-error')).toMatchObject({
      name: 'MediaError',
      code: 'encode-error',
      message: 'plain',
    });
    const faithful = deserializeError(wire);
    expect(faithful).toBeInstanceOf(Error);
    expect(faithful).not.toBeInstanceOf(MediaError);
    expect(faithful.message).toBe('plain');
  });

  it('drops a non-cloneable detail without losing the message', () => {
    const wire = serializeError(new MediaError('mux-error', 'x', { fn: () => 1 }));
    expect(wire.detail).toBeUndefined();
    expect(wire.message).toBe('x');
  });
});

// ── round-trip + transfer semantics (REAL MessageChannel transport) ─────────────────────────────────

describe('WorkerStreamBridge over a real MessageChannel', () => {
  it('round-trips a job and streams the worker’s byte-buffer results back in order', async () => {
    const runJob: JobRunner = (j) => {
      const n = (j.payload as { n: number }).n;
      return new ReadableStream<Transferable>({
        start(c): void {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array([i, i + 1]).buffer);
          c.close();
        },
      });
    };
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    const chunks = (await drain(bridge.runStream(job({ n: 3 })))) as ArrayBuffer[];
    expect(chunks).toHaveLength(3);
    const [c0, , c2] = chunks;
    if (c0 === undefined || c2 === undefined) throw new Error('expected 3 transferred chunks');
    expect([...new Uint8Array(c0)]).toEqual([0, 1]);
    expect([...new Uint8Array(c2)]).toEqual([2, 3]);
  });

  it('transfers the input buffer: the host’s source ArrayBuffer is DETACHED after the job posts', async () => {
    let workerSawBytes: number[] = [];
    const runJob: JobRunner = (j) => {
      // The worker received the moved buffer intact (zero-copy) — record it, then emit one ack chunk.
      workerSawBytes = [...new Uint8Array((j.payload as { input: ArrayBuffer }).input)];
      return new ReadableStream<Transferable>({
        start(c): void {
          c.enqueue(new Uint8Array([0xff]).buffer);
          c.close();
        },
      });
    };
    const { bridge, channel } = channelBridge(runJob);
    track(channel);

    const input = new Uint8Array([10, 20, 30, 40]).buffer;
    expect(input.byteLength).toBe(4);
    const out = await drain(bridge.runStream(job({ input })));
    // The transfer moved (not copied) the buffer: the sender's view is now detached.
    expect(input.byteLength).toBe(0);
    expect(workerSawBytes).toEqual([10, 20, 30, 40]); // arrived intact on the worker side
    expect(out).toHaveLength(1);
  });

  it('forwards progress messages to onProgress', async () => {
    const runJob: JobRunner = (_j, ctx) => {
      ctx.progress({ done: 1, total: 2, stage: 'decode' });
      ctx.progress({ done: 2, total: 2, stage: 'decode' });
      return new ReadableStream<Transferable>({
        start(c): void {
          c.close();
        },
      });
    };
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    const seen: { done: number; stage: string }[] = [];
    await drain(bridge.runStream(job({}), { onProgress: (p) => seen.push(p) }));
    expect(seen).toEqual([
      { done: 1, total: 2, stage: 'decode' },
      { done: 2, total: 2, stage: 'decode' },
    ]);
  });
});

// ── typed-error propagation across the worker boundary (REAL channel) ───────────────────────────────

describe('error propagation across the worker boundary', () => {
  it('a worker-side CapabilityError surfaces on the host as the same typed class', async () => {
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        start(): void {
          throw new CapabilityError('capability-miss', 'no codec in worker', {
            op: 'encode',
            tried: ['webcodecs-video'],
          });
        },
      });
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    await expect(drain(bridge.runStream(job({})))).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'capability-miss',
      message: 'no codec in worker',
    });
  });

  it('a generic worker error is wrapped with the op-supplied errorCode', async () => {
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        start(): void {
          throw new Error('kaboom');
        },
      });
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    await expect(
      drain(bridge.runStream(job({}), { errorCode: 'decode-error' })),
    ).rejects.toMatchObject({ name: 'MediaError', code: 'decode-error', message: 'kaboom' });
  });

  it('an error mid-stream errors the host stream after the chunks already delivered', async () => {
    const runJob: JobRunner = () => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (i < 2) {
            c.enqueue(new Uint8Array([i++]).buffer);
          } else {
            c.error(new MediaError('encode-error', 'late failure'));
          }
        },
      });
    };
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    const reader = bridge.runStream(job({})).getReader();
    expect([...new Uint8Array((await reader.read()).value as ArrayBuffer)]).toEqual([0]);
    expect([...new Uint8Array((await reader.read()).value as ArrayBuffer)]).toEqual([1]);
    await expect(reader.read()).rejects.toMatchObject({ code: 'encode-error' });
  });
});

// ── backpressure: the worker never exceeds the credit window ─────────────────────────────────────────

describe('backpressure (credit window)', () => {
  it('bounds the worker’s posted-but-unconsumed chunks to the credit window', async () => {
    const CREDIT = 3;
    const TOTAL = 12;
    const runJob: JobRunner = () => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (i < TOTAL) c.enqueue(new Uint8Array([i++]).buffer);
          else c.close();
        },
      });
    };
    const { bridge, channel, chunkPosts } = channelBridge(runJob);
    track(channel);

    // Consume slowly, sampling the EXACT outstanding (worker posts minus consumer-delivered). The worker
    // may only post a chunk while it holds a credit, and the host returns one credit per consumed chunk,
    // so total posts ≤ initialCredit + delivered ⇒ outstanding ≤ CREDIT at every point (doc 06 §10).
    const reader = bridge.runStream(job({}), { credit: CREDIT }).getReader();
    let delivered = 0;
    let maxOutstanding = 0;
    for (;;) {
      maxOutstanding = Math.max(maxOutstanding, chunkPosts() - delivered);
      const { done } = await reader.read();
      if (done) break;
      delivered += 1;
      // Let the freed credit reach the worker and any permitted chunk be posted before the next sample.
      await new Promise<void>((r) => setTimeout(r, 0));
      maxOutstanding = Math.max(maxOutstanding, chunkPosts() - delivered);
    }
    expect(delivered).toBe(TOTAL);
    expect(maxOutstanding).toBeLessThanOrEqual(CREDIT);
    expect(maxOutstanding).toBeGreaterThan(0); // backpressure is actually exercised (not a trivial pass)
  });

  it('defaults the credit window to DEFAULT_CREDIT', () => {
    expect(DEFAULT_CREDIT).toBeGreaterThan(0);
  });
});

// ── cancellation: AbortSignal → worker Cancel, op rejects aborted, no leak ──────────────────────────

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const { bridge, channel } = channelBridge(
      () => new ReadableStream<Transferable>({ start: (c) => c.close() }),
    );
    track(channel);
    await expect(
      drain(bridge.runStream(job({}), { signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts an in-flight job: posts Cancel, the worker tears down, the op rejects aborted', async () => {
    let workerAborted = false;
    const runJob: JobRunner = (_j, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        workerAborted = true;
      });
      // An endless producer the host will cancel mid-stream.
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          c.enqueue(new Uint8Array([i++]).buffer);
        },
      });
    };
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    const ctrl = new AbortController();
    const reader = bridge.runStream(job({}), { signal: ctrl.signal, credit: 2 }).getReader();
    await reader.read(); // pull one chunk so the pipeline is live
    ctrl.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'MediaError', code: 'aborted' });
    // Give the Cancel message a turn to reach the worker.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(workerAborted).toBe(true);
  });
});

// ── frame transfer = close-exactly-once (synthetic frame, real lifetime logic) ──────────────────────

describe('frame transfer + close-exactly-once', () => {
  it('on success the worker relinquishes each frame (does NOT close it); the consumer owns the close', async () => {
    const frames = [new FakeFrame(0), new FakeFrame(1), new FakeFrame(2)];
    const runJob: JobRunner = () => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (i < frames.length) c.enqueue(frames[i++] as unknown as Transferable);
          else c.close();
        },
      });
    };
    const { host, worker } = fakePortPair();
    runOffloadWorker({ ...worker, webcodecs: true }, runJob);
    const bridge = new WorkerStreamBridge(host);

    const received = (await drain(bridge.runStream(job({})))) as unknown as FakeFrame[];
    expect(received.map((f) => f.id)).toEqual([0, 1, 2]);
    // The worker transferred ownership: it must NOT have closed any frame (the host consumer will).
    for (const f of frames) expect(f.closeCount).toBe(0);
    // The consumer (this test) is now the sole owner; closing each is the one-and-only close.
    for (const f of received) f.close();
    for (const f of frames) expect(f.closeCount).toBe(1);
  });

  it('on cancel, a frame still queued on the HOST side is closed exactly once (no leak, no double)', async () => {
    const frames = [new FakeFrame(0), new FakeFrame(1), new FakeFrame(2), new FakeFrame(3)];
    const runJob: JobRunner = () => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (i < frames.length) c.enqueue(frames[i++] as unknown as Transferable);
          else c.close();
        },
      });
    };
    const { host, worker } = fakePortPair();
    runOffloadWorker({ ...worker, webcodecs: true }, runJob);
    const bridge = new WorkerStreamBridge(host);

    const ctrl = new AbortController();
    const stream = bridge.runStream(job({}), { signal: ctrl.signal, credit: 4 });
    const reader = stream.getReader();
    const first = (await reader.read()).value as unknown as FakeFrame;
    // Let the remaining frames (credit window = 4) land in the host's buffer so the abort exercises the
    // host-side queue drain (not just the in-transit late-close path — both must close exactly once).
    await new Promise<void>((r) => setTimeout(r, 5));
    // Abort with frames buffered on the host; the host drains its queue closing each undelivered frame.
    ctrl.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
    await new Promise<void>((r) => setTimeout(r, 5));

    // The one frame handed to the consumer is owned by the consumer (still its responsibility to close).
    expect(first.id).toBe(0);
    expect(first.closeCount).toBe(0);
    first.close();
    expect(first.closeCount).toBe(1);
    // Every frame is closed exactly once in total (consumer-owned one + host-drained remainder),
    // and none is closed twice.
    for (const f of frames) expect(f.closeCount).toBeLessThanOrEqual(1);
    const totalClosed = frames.filter((f) => f.closeCount === 1).length;
    expect(totalClosed).toBe(frames.length);
  });

  it('closes the in-flight frame exactly once when the host post throws (frame undeliverable)', async () => {
    const frame = new FakeFrame(7);
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        start(c): void {
          c.enqueue(frame as unknown as Transferable);
          c.close();
        },
      });
    // A worker scope whose postMessage throws on a chunk (e.g. the frame is already detached/closed). It
    // records its own message listener so the test can hand it a Job directly (no host bridge needed for
    // this frame-lifetime unit).
    let readyDelivered = false;
    let workerListener: ((ev: { data: HostMessage }) => void) | undefined;
    const throwingScope: MessageLike<HostMessage, WorkerMessage> & { webcodecs: boolean } = {
      webcodecs: true,
      postMessage: (m): void => {
        if (m.t === 'ready') {
          readyDelivered = true;
          return;
        }
        if (m.t === 'chunk') throw new DOMException('frame detached', 'DataCloneError');
        // The follow-up `error` message is swallowed (no host listening) — fine for this unit.
      },
      addEventListener: (_t, l) => {
        workerListener = l;
      },
      removeEventListener: () => {
        workerListener = undefined;
      },
    };
    runOffloadWorker(throwingScope, runJob);
    expect(readyDelivered).toBe(true);
    expect(workerListener).toBeDefined();
    workerListener?.({ data: { t: 'job', job: job({}), credit: 4 } });
    await new Promise<void>((r) => setTimeout(r, 5));
    // The post failed, so the worker closed the otherwise-leaked frame exactly once.
    expect(frame.closeCount).toBe(1);
  });
});

// ── capability gate + inline fallback ───────────────────────────────────────────────────────────────

describe('capability gate', () => {
  it('reports Worker availability honestly (true in this Node runtime)', () => {
    expect(workerOffloadAvailable()).toBe(typeof Worker === 'function');
  });

  it('the InlineBridge fallback runs a closure on the calling thread', async () => {
    const bridge = new InlineBridge();
    await expect(bridge.run(async () => 6 * 7)).resolves.toBe(42);
  });

  it('a terminated bridge rejects further runs (idempotent terminate)', async () => {
    const { bridge, channel } = channelBridge(
      () => new ReadableStream<Transferable>({ start: (c) => c.close() }),
    );
    track(channel);
    bridge.terminate();
    bridge.terminate(); // idempotent
    await expect(drain(bridge.runStream(job({})))).rejects.toMatchObject({ code: 'aborted' });
  });

  it('a busy bridge rejects a second concurrent job (one job per worker; use a pool)', async () => {
    // A runner that never finishes its first job keeps the bridge busy.
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        pull(): void {
          /* never enqueue, never close — stays busy */
        },
      });
    const { bridge, channel } = channelBridge(runJob);
    track(channel);
    const first = bridge.runStream(job({})); // claims the bridge
    void first.getReader().read(); // start pumping
    await expect(drain(bridge.runStream(job({})))).rejects.toMatchObject({
      name: 'MediaError',
      message: expect.stringContaining('busy'),
    });
  });
});
