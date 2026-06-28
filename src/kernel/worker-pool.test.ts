/**
 * Worker pool / ABR fan-out validation (BUILD §2/§6; ADR-019, doc 06 §4) — proves the pool spreads K
 * independent jobs across N worker bridges in Node, with the Worker **mocked only as transport** while the
 * real {@link WorkerStreamBridge} (host) + {@link runOffloadWorker} (worker) logic runs unchanged. This is
 * the ABR ladder substrate: one source → a ladder of renditions encoded concurrently, one job per worker.
 *
 * Coverage: K>N jobs all complete (bounded concurrency = N, work-stealing as workers free up), the
 * per-worker busy-guard is respected (no worker runs two jobs at once), close-exactly-once under fan-out
 * (synthetic frame streams), graceful single-{@link InlineBridge} fallback when no `Worker` exists, and
 * cancellation (abortAll tears every in-flight + queued job down).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { InlineBridge, WorkerStreamBridge } from './worker-bridge.ts';
import { type JobRunner, runOffloadWorker } from './worker-entry.ts';
import { WorkerPool, type WorkerPoolTransport, inlineWorkerPool } from './worker-pool.ts';
import type { HostMessage, MessageLike, OffloadJob, WorkerMessage } from './worker-protocol.ts';

// ── transport: a real MessageChannel per spawned worker, driven by a shared JobRunner ─────────────────

/** Adapt a Node `MessagePort` to {@link MessageLike} (needs `start()` to receive `message` events). */
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
      /* one listener per port; channels torn down in afterEach */
    },
  };
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

/**
 * A {@link WorkerPoolTransport} that, instead of `new Worker(url)`, wires a real `MessageChannel`: the
 * worker runtime (driven by `runJob`) lives on port2, the host {@link WorkerStreamBridge} on port1. This
 * is the production pool shape — only the *spawn* is replaced by an in-process channel.
 */
function channelTransport(runJob: JobRunner): WorkerPoolTransport {
  return () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
    const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
    runOffloadWorker({ ...workerPort, webcodecs: true }, runJob);
    return new WorkerStreamBridge(hostPort, () => {
      channel.port1.close();
      channel.port2.close();
    });
  };
}

/**
 * A {@link WorkerPoolTransport} over a **synchronous in-process port pair** (no real channel) so a
 * `close()`-recording {@link FakeFrame} stand-in can drive the frame-lifetime code: a real
 * `MessageChannel` rejects a non-Transferable in its transfer list, so the close-exactly-once contract is
 * exercised by passing the frame object by reference (exactly as a real transfer would hand it over),
 * still running the real bridge + worker logic. Mirrors `fakePortPair` in worker-offload.test.ts.
 */
function fakePortTransport(runJob: JobRunner): WorkerPoolTransport {
  return () => {
    const hostListeners = new Set<(ev: { data: WorkerMessage }) => void>();
    const workerListeners = new Set<(ev: { data: HostMessage }) => void>();
    const deliver = <T>(ls: Set<(ev: { data: T }) => void>, data: T): void => {
      queueMicrotask(() => {
        for (const l of ls) l({ data });
      });
    };
    const host: MessageLike<WorkerMessage, HostMessage> = {
      postMessage: (m) => deliver(workerListeners, m),
      addEventListener: (_t, l) => void hostListeners.add(l),
      removeEventListener: (_t, l) => void hostListeners.delete(l),
    };
    const worker: MessageLike<HostMessage, WorkerMessage> = {
      postMessage: (m) => deliver(hostListeners, m),
      addEventListener: (_t, l) => void workerListeners.add(l),
      removeEventListener: (_t, l) => void workerListeners.delete(l),
    };
    runOffloadWorker({ ...worker, webcodecs: true }, runJob);
    return new WorkerStreamBridge(host);
  };
}

// ── synthetic frame stand-in (records close()es to prove close-exactly-once under fan-out) ────────────

class FakeFrame {
  closeCount = 0;
  readonly codedWidth = 2;
  readonly codedHeight = 2;
  constructor(
    readonly jobId: number,
    readonly seq: number,
  ) {}
  close(): void {
    this.closeCount += 1;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

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

const convertJob = (payload: unknown): OffloadJob => ({ op: 'convert', payload });

// ── concurrency: K independent jobs across N workers (N < K) all complete ─────────────────────────────

describe('WorkerPool concurrency (ABR fan-out)', () => {
  it('runs K jobs across N<K workers; all complete with the right per-job results', async () => {
    // Each job emits its own id `n` times so a result is unambiguously attributable to its job.
    const runJob: JobRunner = (j) => {
      const { id, n } = j.payload as { id: number; n: number };
      return new ReadableStream<Transferable>({
        start(c): void {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array([id, i]).buffer);
          c.close();
        },
      });
    };
    const N = 2;
    const K = 7;
    const pool = new WorkerPool({ size: N, transport: channelTransport(runJob) });
    try {
      const jobs = Array.from({ length: K }, (_, id) => convertJob({ id, n: id + 1 }));
      const streams = await pool.runMany(jobs);
      expect(streams).toHaveLength(K);
      const results = await Promise.all(streams.map((s) => drain(s) as Promise<ArrayBuffer[]>));
      results.forEach((chunks, id) => {
        expect(chunks).toHaveLength(id + 1);
        for (const [i, buf] of chunks.entries()) {
          expect([...new Uint8Array(buf)]).toEqual([id, i]);
        }
      });
    } finally {
      await pool.terminate();
    }
  });

  it('bounds concurrency to N: never more than N jobs run their producer simultaneously', async () => {
    let active = 0;
    let peak = 0;
    // A runner that holds each job "active" across an async tick so overlap is observable, then completes.
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        async start(c): Promise<void> {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((r) => setTimeout(r, 5));
          c.enqueue(new Uint8Array([1]).buffer);
          active -= 1;
          c.close();
        },
      });
    const N = 3;
    const K = 12;
    const pool = new WorkerPool({ size: N, transport: channelTransport(runJob) });
    try {
      const streams = await pool.runMany(Array.from({ length: K }, () => convertJob({})));
      await Promise.all(streams.map((s) => drain(s)));
      expect(peak).toBeLessThanOrEqual(N);
      expect(peak).toBeGreaterThan(1); // fan-out actually happened (not serialized)
    } finally {
      await pool.terminate();
    }
  });
});

// ── busy-guard: one job per worker at a time ─────────────────────────────────────────────────────────

describe('WorkerPool per-worker busy-guard', () => {
  it('never dispatches two jobs to the same worker at once (no "busy" rejection leaks out)', async () => {
    // If the pool ever handed a second job to a still-busy bridge, runStream would reject with "busy";
    // a clean all-resolve proves the pool serializes per worker.
    const runJob: JobRunner = (j) => {
      const { n } = j.payload as { n: number };
      return new ReadableStream<Transferable>({
        async start(c): Promise<void> {
          await new Promise<void>((r) => setTimeout(r, 2));
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array([i]).buffer);
          c.close();
        },
      });
    };
    const pool = new WorkerPool({ size: 1, transport: channelTransport(runJob) });
    try {
      // size 1 forces strict serialization through one worker; all must still complete.
      const streams = await pool.runMany([
        convertJob({ n: 1 }),
        convertJob({ n: 2 }),
        convertJob({ n: 3 }),
      ]);
      const results = await Promise.all(streams.map((s) => drain(s)));
      expect(results.map((r) => r.length)).toEqual([1, 2, 3]);
    } finally {
      await pool.terminate();
    }
  });
});

// ── close-exactly-once under fan-out (synthetic frames) ──────────────────────────────────────────────

describe('WorkerPool frame close-exactly-once under fan-out', () => {
  it('every frame across every job is closed exactly once by its consumer', async () => {
    const made = new Map<number, FakeFrame[]>();
    const runJob: JobRunner = (j) => {
      const { id, n } = j.payload as { id: number; n: number };
      const frames = Array.from({ length: n }, (_, seq) => new FakeFrame(id, seq));
      made.set(id, frames);
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (i < frames.length) c.enqueue(frames[i++] as unknown as Transferable);
          else c.close();
        },
      });
    };
    // Synchronous fake-port transport so the FakeFrame stand-ins (non-Transferables) drive the real
    // close-once frame lifetime without a real channel's transferList rejection.
    const pool = new WorkerPool({ size: 2, transport: fakePortTransport(runJob) });
    try {
      const K = 5;
      const streams = pool.runMany(
        Array.from({ length: K }, (_, id) => convertJob({ id, n: id + 2 })),
      );
      const received = await Promise.all(
        streams.map((s) => drain(s) as unknown as Promise<FakeFrame[]>),
      );
      // The consumer owns the close: nothing closed yet, then close each exactly once.
      for (const frames of made.values()) for (const f of frames) expect(f.closeCount).toBe(0);
      for (const frames of received) for (const f of frames) f.close();
      for (const frames of made.values()) for (const f of frames) expect(f.closeCount).toBe(1);
    } finally {
      await pool.terminate();
    }
  });
});

// ── cancellation ─────────────────────────────────────────────────────────────────────────────────────

describe('WorkerPool cancellation', () => {
  it('abortAll rejects in-flight jobs and never starts queued ones', async () => {
    let started = 0;
    const runJob: JobRunner = (_j, ctx) => {
      started += 1;
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (ctx.signal.aborted) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array([i++]).buffer);
        },
      });
    };
    const N = 1;
    const K = 4;
    const pool = new WorkerPool({ size: N, transport: channelTransport(runJob) });
    const streams = await pool.runMany(Array.from({ length: K }, () => convertJob({})));
    // Read one chunk from the first stream so a job is genuinely live, then abort everything.
    const reader0 = streams[0]?.getReader();
    if (!reader0) throw new Error('expected at least one job stream');
    await reader0.read();
    pool.abortAll();
    await expect(reader0.read()).rejects.toMatchObject({ code: 'aborted' });
    // The queued jobs (N=1, K=4) never reached a worker once aborted.
    await pool.terminate();
    expect(started).toBeLessThan(K);
  });
});

// ── per-call signal + consumer cancel ────────────────────────────────────────────────────────────────

describe('WorkerPool per-call signal + cancel', () => {
  it('honors a per-call AbortSignal: aborting it rejects that job', async () => {
    const runJob: JobRunner = (_j, ctx) => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (ctx.signal.aborted) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array([i++]).buffer);
        },
      });
    };
    const pool = new WorkerPool({ size: 1, transport: channelTransport(runJob) });
    try {
      const ctrl = new AbortController();
      const stream = pool.run(convertJob({}), { signal: ctrl.signal });
      const reader = stream.getReader();
      await reader.read(); // live
      ctrl.abort();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      await pool.terminate();
    }
  });

  it('threads a per-call AbortSignal through runMany fan-out jobs', async () => {
    const runJob: JobRunner = (_j, ctx) => {
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (ctx.signal.aborted) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array([i++]).buffer);
        },
      });
    };
    const pool = new WorkerPool({ size: 1, transport: channelTransport(runJob) });
    try {
      const ctrl = new AbortController();
      const [stream] = pool.runMany([convertJob({})], { signal: ctrl.signal });
      if (stream === undefined) throw new Error('expected one stream');
      const reader = stream.getReader();
      await reader.read();
      ctrl.abort();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      await pool.terminate();
    }
  });

  it('cancelling the consumer stream tears the job down and frees the worker for the next job', async () => {
    // Job 0 is endless (so we cancel it mid-stream); job 1 is finite. After cancelling job 0 the freed
    // worker must run job 1 to completion, and job 1's stream must carry ONLY job-1 bytes (no leakage from
    // the cancelled job 0 across the reused bridge).
    const runJob: JobRunner = (j) => {
      const { id, finite } = j.payload as { id: number; finite: boolean };
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (finite && i >= 2) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array([id, i++]).buffer);
        },
      });
    };
    const pool = new WorkerPool({ size: 1, transport: channelTransport(runJob) });
    try {
      const [s0, s1] = pool.runMany([
        convertJob({ id: 0, finite: false }),
        convertJob({ id: 1, finite: true }),
      ]);
      if (s0 === undefined || s1 === undefined) throw new Error('expected two streams');
      const r0 = s0.getReader();
      await r0.read(); // start job 0 (endless)
      await r0.cancel(new Error('consumer done')); // cancel → frees worker → job 1 dispatches
      const out1 = (await drain(s1)) as ArrayBuffer[];
      // Every chunk job 1's consumer sees is a job-1 byte (id===1) — no cross-talk from the reused bridge.
      for (const buf of out1) expect(new Uint8Array(buf)[0]).toBe(1);
      expect(out1.length).toBe(2);
    } finally {
      await pool.terminate();
    }
  });
});

// ── failure isolation + terminated guard ─────────────────────────────────────────────────────────────

describe('WorkerPool failure isolation', () => {
  it('one rendition failing rejects only its stream; the pool keeps serving the rest', async () => {
    // Job 0 fails mid-stream; jobs 1+ must still complete (a failure must not wedge the pool).
    const runJob: JobRunner = (j) => {
      const { id } = j.payload as { id: number };
      let i = 0;
      return new ReadableStream<Transferable>({
        pull(c): void {
          if (id === 0) {
            c.error(new MediaError('encode-error', 'rendition 0 failed'));
            return;
          }
          if (i < 2) c.enqueue(new Uint8Array([id, i++]).buffer);
          else c.close();
        },
      });
    };
    const pool = new WorkerPool({ size: 1, transport: channelTransport(runJob) });
    try {
      const streams = pool.runMany([convertJob({ id: 0 }), convertJob({ id: 1 })]);
      const [s0, s1] = streams;
      if (s0 === undefined || s1 === undefined) throw new Error('expected two job streams');
      // The failing rendition rejects…
      await expect(drain(s0)).rejects.toMatchObject({ code: 'encode-error' });
      // …and the worker it was on (size 1) is released back, so the next rendition completes cleanly.
      const out1 = (await drain(s1)) as ArrayBuffer[];
      expect(out1.map((b) => [...new Uint8Array(b)])).toEqual([
        [1, 0],
        [1, 1],
      ]);
    } finally {
      await pool.terminate();
    }
  });

  it('a terminated pool errors any further run', async () => {
    const pool = new WorkerPool({
      size: 1,
      transport: channelTransport(
        () => new ReadableStream<Transferable>({ start: (c) => c.close() }),
      ),
    });
    await pool.terminate();
    await expect(drain(pool.run(convertJob({})))).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ── inline fallback (no Worker) ──────────────────────────────────────────────────────────────────────

describe('inlineWorkerPool fallback', () => {
  it('runs jobs sequentially on an InlineBridge when no Worker is available', async () => {
    // The inline pool runs a host-supplied inline runner (a closure) — the honest no-Worker path.
    const ran: number[] = [];
    const pool = inlineWorkerPool();
    const results = await pool.run([
      async () => {
        ran.push(1);
        return 10;
      },
      async () => {
        ran.push(2);
        return 20;
      },
    ]);
    expect(results).toEqual([10, 20]);
    expect(ran).toEqual([1, 2]);
    expect(pool.bridge).toBeInstanceOf(InlineBridge);
  });
});
