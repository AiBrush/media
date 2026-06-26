/**
 * Host-side worker offload glue (BUILD §2/§6; ADR-019, doc 06 §4) — the seam the engine calls to run a
 * heavy `convert`/`trim` off the main thread: read the source to bytes, build the serializable
 * {@link OffloadJob}, stream the worker's encoded bytes back, and re-expose them as a
 * `ReadableStream<Uint8Array>` the engine materializes into the caller's sink. Tested in Node with the
 * Worker **mocked as transport** (a `MessageChannel` driving the real worker runtime) so the glue —
 * payload assembly, byte round-trip, the `ready.webcodecs` handshake gate, and abort — is provable.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { type Source, fromBytes, fromStream } from '../sources/source.ts';
import { WorkerStreamBridge } from './worker-bridge.ts';
import { type JobRunner, runOffloadWorker } from './worker-entry.ts';
import {
  type OffloadPoolCache,
  type OffloadStreamOptions,
  type SpawnedWorker,
  __resetSharedOffloadPools,
  createWorkerPool,
  ensureOffloadPool,
  ensureWorkerBridge,
  offloadAbrLadder,
  offloadHeavyOp,
  runOffloadStream,
} from './worker-host.ts';
import { type OffloadJobPayload, makeJobRunner } from './worker-main.ts';
import type { HostMessage, MessageLike, WorkerMessage } from './worker-protocol.ts';

// ── a MessageChannel transport driving the real worker runtime ───────────────────────────────────────

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
      /* one listener per port; torn down in afterEach */
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
 * A synchronous in-process port pair (no real channel) so a frame-shaped (non-Transferable) stand-in can
 * drive the worker's byte-path contract-break code — a real `MessageChannel` rejects a non-Transferable in
 * its transfer list. Mirrors `fakePortPair` in worker-offload.test.ts.
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

function channelBridge(runJob: JobRunner): WorkerStreamBridge {
  const channel = new MessageChannel();
  channels.push(channel);
  const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  runOffloadWorker({ ...workerPort, webcodecs: true }, runJob);
  return new WorkerStreamBridge(hostPort, () => {
    channel.port1.close();
    channel.port2.close();
  });
}

// A worker runner that echoes the input bytes back (so the test asserts the byte round-trip), capturing
// how the job was reconstructed via a real inner-engine-shaped fake.
function echoRunner(seen: { kind?: string; bytes?: number[] }): JobRunner {
  return makeJobRunner((determinism) => ({
    convert: (input, opts, _o) => {
      void determinism;
      void opts;
      seen.kind = 'convert';
      return readAll(input).then((b) => {
        seen.bytes = [...b];
        return Promise.resolve(byteStream([...b, 0xee]) as never);
      });
    },
    trim: (input, opts, _o) => {
      void opts;
      seen.kind = 'trim';
      return readAll(input).then((b) => {
        seen.bytes = [...b];
        return Promise.resolve(byteStream([...b, 0xdd]) as never);
      });
    },
  }));
}

function byteStream(bytes: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(Uint8Array.from(bytes));
      c.close();
    },
  });
}

async function readAll(src: Source): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
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

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return out;
}

describe('runOffloadStream', () => {
  it('reads the source to bytes, ships a convert job, and streams the worker bytes back', async () => {
    const seen: { kind?: string; bytes?: number[] } = {};
    const bridge = channelBridge(echoRunner(seen));
    const src = fromBytes(Uint8Array.from([1, 2, 3]));
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input: new ArrayBuffer(0), // overwritten by runOffloadStream from the source bytes
      opts: { to: 'webm' },
    };
    const stream = await runOffloadStream(bridge, src, payload, {});
    const bytes = await drainBytes(stream);
    expect(seen.kind).toBe('convert');
    expect(seen.bytes).toEqual([1, 2, 3]); // the worker received the source bytes
    expect(bytes).toEqual([1, 2, 3, 0xee]); // echoed back through the byte seam
  });

  it('threads determinism onto the job (force-software is identical inline vs worker)', async () => {
    const seenDet: { determinism?: string | undefined } = {};
    const runJob: JobRunner = makeJobRunner(() => ({
      convert: (input, _opts, o) => {
        seenDet.determinism = o?.strategy?.determinism;
        return readAll(input).then((b) => Promise.resolve(byteStream([...b]) as never));
      },
      trim: () => Promise.reject(new Error('unused')) as never,
    }));
    const bridge = channelBridge(runJob);
    const opts: OffloadStreamOptions = { determinism: 'force-software' };
    await drainBytes(
      await runOffloadStream(
        bridge,
        fromBytes(Uint8Array.from([7])),
        { kind: 'convert', input: new ArrayBuffer(0), opts: {} },
        opts,
      ),
    );
    expect(seenDet.determinism).toBe('force-software');
  });

  it('propagates a worker-side typed error through the byte stream', async () => {
    // A runner that fails inside the inner op surfaces as the host stream rejecting (not a silent empty).
    const runJob: JobRunner = makeJobRunner(() => ({
      convert: () => Promise.reject(new MediaError('encode-error', 'inner boom')) as never,
      trim: () => Promise.reject(new Error('unused')) as never,
    }));
    const bridge = channelBridge(runJob);
    await expect(
      drainBytes(
        await runOffloadStream(
          bridge,
          fromBytes(Uint8Array.from([1])),
          { kind: 'convert', input: new ArrayBuffer(0), opts: {} },
          {},
        ),
      ),
    ).rejects.toMatchObject({ code: 'encode-error' });
  });

  it('reads a non-seekable stream source to bytes before shipping the job', async () => {
    const seen: { kind?: string; bytes?: number[] } = {};
    const bridge = channelBridge(echoRunner(seen));
    // A `fromStream` source has no range()/size — exercises readAllSource's stream-drain branch.
    const src = fromStream(
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(Uint8Array.from([4, 5]));
          c.enqueue(Uint8Array.from([6]));
          c.close();
        },
      }),
    );
    const stream = await runOffloadStream(
      bridge,
      src,
      { kind: 'convert', input: new ArrayBuffer(0), opts: {} },
      {},
    );
    expect(await drainBytes(stream)).toEqual([4, 5, 6, 0xee]);
    expect(seen.bytes).toEqual([4, 5, 6]);
  });

  it('errors the byte stream if the worker transfers a non-byte result (contract break)', async () => {
    // A runner that emits a frame-shaped Transferable on the byte path must surface a typed error, not a
    // wrong-typed chunk. Drive it directly (a fake frame can't cross a real channel) via a fake port pair.
    const frame = { close: () => {}, codedWidth: 2 };
    const runJob: JobRunner = () =>
      new ReadableStream<Transferable>({
        start(c): void {
          c.enqueue(frame as unknown as Transferable);
          c.close();
        },
      });
    const { host, worker } = fakePortPair();
    runOffloadWorker({ ...worker, webcodecs: true }, runJob);
    const bridge = new WorkerStreamBridge(host);
    await expect(
      drainBytes(
        await runOffloadStream(
          bridge,
          fromBytes(Uint8Array.from([1])),
          { kind: 'convert', input: new ArrayBuffer(0), opts: {} },
          {},
        ),
      ),
    ).rejects.toMatchObject({ code: 'encode-error' });
  });

  it('rejects before shipping a job when the signal is already aborted', async () => {
    const bridge = channelBridge(
      makeJobRunner(() => ({
        convert: (input) =>
          readAll(input).then((b) => Promise.resolve(byteStream([...b]) as never)),
        trim: () => Promise.reject(new Error('unused')) as never,
      })),
    );
    await expect(
      runOffloadStream(
        bridge,
        fromBytes(Uint8Array.from([1, 2])),
        { kind: 'convert', input: new ArrayBuffer(0), opts: {} },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ── ensureWorkerBridge: the spawn + ready{webcodecs} handshake gate (injected fake spawn) ─────────────

/**
 * A fake {@link SpawnedWorker} backed by one side of a `MessageChannel`, plus a knob to post a `ready`
 * (or never). The bridge/handshake code runs unchanged over a real port; only the `new Worker(url)` spawn
 * is replaced (Node has no module Worker). `posts` records messages the host sent (to assert no job ships
 * when the handshake fails).
 */
function fakeSpawnedWorker(opts: {
  ready?: { webcodecs: boolean };
  terminated: { value: boolean };
}): SpawnedWorker {
  const channel = new MessageChannel();
  channels.push(channel);
  const host = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  // The "worker" side posts the ready handshake (if requested) on the next tick, mirroring a booted worker.
  if (opts.ready !== undefined) {
    channel.port2.start();
    queueMicrotask(() =>
      channel.port2.postMessage({ t: 'ready', webcodecs: opts.ready?.webcodecs }),
    );
  }
  return {
    postMessage: (m, transfer) => host.postMessage(m, transfer),
    addEventListener: (t, l) => host.addEventListener(t, l),
    removeEventListener: (t, l) => host.removeEventListener(t, l),
    terminate: () => {
      opts.terminated.value = true;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('ensureWorkerBridge handshake', () => {
  it('resolves a bridge when the worker reports ready{webcodecs:true}', async () => {
    const terminated = { value: false };
    const bridge = await ensureWorkerBridge(
      () => fakeSpawnedWorker({ ready: { webcodecs: true }, terminated }),
      1000,
    );
    expect(bridge).toBeInstanceOf(WorkerStreamBridge);
    expect(terminated.value).toBe(false);
    bridge?.terminate();
  });

  it('downgrades to inline (undefined) + terminates the worker when webcodecs:false', async () => {
    const terminated = { value: false };
    const bridge = await ensureWorkerBridge(
      () => fakeSpawnedWorker({ ready: { webcodecs: false }, terminated }),
      1000,
    );
    expect(bridge).toBeUndefined();
    expect(terminated.value).toBe(true); // the useless worker is killed
  });

  it('downgrades to inline (undefined) on a handshake timeout', async () => {
    const terminated = { value: false };
    // No `ready` ever posted → the (short) timeout fires → inline.
    const bridge = await ensureWorkerBridge(() => fakeSpawnedWorker({ terminated }), 10);
    expect(bridge).toBeUndefined();
    expect(terminated.value).toBe(true);
  });

  it('downgrades to inline (undefined) when spawn returns undefined (no Worker)', async () => {
    expect(await ensureWorkerBridge(() => undefined, 1000)).toBeUndefined();
  });

  it('downgrades to inline (undefined) when spawn throws (no module-worker support)', async () => {
    expect(
      await ensureWorkerBridge(() => {
        throw new Error('module workers unsupported');
      }, 1000),
    ).toBeUndefined();
  });
});

// ── createWorkerPool / offloadHeavyOp / offloadAbrLadder (handshake-gated pool + fan-out) ─────────────

/**
 * A fake {@link SpawnedWorker} that ALSO runs the real {@link runOffloadWorker} on its far side (driven by
 * `runJob`) so a pool built from it can actually process jobs — and posts the `ready{webcodecs:true}`
 * handshake. Used to exercise `createWorkerPool` end to end (gate → pool → job) in Node.
 */
function fakeRunningWorker(runJob: JobRunner): SpawnedWorker {
  const channel = new MessageChannel();
  channels.push(channel);
  const host = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  runOffloadWorker({ ...workerPort, webcodecs: true }, runJob);
  return {
    postMessage: (m, transfer) => host.postMessage(m, transfer),
    addEventListener: (t, l) => host.addEventListener(t, l),
    removeEventListener: (t, l) => host.removeEventListener(t, l),
    terminate: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('createWorkerPool', () => {
  it('gates on the probe handshake then builds a pool of `size` workers that run jobs', async () => {
    let spawned = 0;
    const pool = await createWorkerPool(
      2,
      () => {
        spawned += 1;
        return fakeRunningWorker(echoRunner({}));
      },
      1000,
    );
    expect(pool).toBeDefined();
    expect(pool?.size).toBe(2);
    expect(spawned).toBe(2); // the probe is reused as worker #1; one more bare-spawned
    // The pool actually runs a job end to end through offloadHeavyOp. The convert opts are typed (the
    // generic infers the caller's concrete shape; a bare inline literal would hit excess-property check).
    const convertOpts: { to: string; sink?: unknown } = { to: 'mp4' };
    const stream = await offloadHeavyOp(
      pool as NonNullable<typeof pool>,
      fromBytes(Uint8Array.from([3, 4])),
      'convert',
      convertOpts,
    );
    expect(await drainBytes(stream)).toEqual([3, 4, 0xee]);
    await pool?.terminate();
  });

  it('downgrades to undefined (run inline) when the probe handshake fails', async () => {
    const terminated = { value: false };
    const pool = await createWorkerPool(
      4,
      () => fakeSpawnedWorker({ ready: { webcodecs: false }, terminated }),
      1000,
    );
    expect(pool).toBeUndefined();
    expect(terminated.value).toBe(true);
  });
});

describe('offloadAbrLadder (ABR fan-out)', () => {
  it('fans K renditions across the pool, one byte stream per rung, each with its own input copy', async () => {
    // Each job echoes its input + a rung-specific marker so streams are attributable; a shared source
    // buffer would be detached by the first transfer, so the helper must copy per rung.
    const runJob: JobRunner = makeJobRunner(() => ({
      convert: (input, opts, _o) => {
        const marker = ((opts as { to?: string }).to ?? '?').charCodeAt(0);
        return readAll(input).then((b) => Promise.resolve(byteStream([...b, marker]) as never));
      },
      trim: () => Promise.reject(new Error('unused')) as never,
    }));
    const pool = await createWorkerPool(2, () => fakeRunningWorker(runJob), 1000);
    if (!pool) throw new Error('expected a pool');
    const streams = await offloadAbrLadder(pool, fromBytes(Uint8Array.from([1, 2])), [
      { opts: { to: 'mp4' } },
      { opts: { to: 'webm' } },
      { opts: { to: 'mov' } },
    ]);
    expect(streams).toHaveLength(3);
    const results = await Promise.all(streams.map(drainBytes));
    expect(results[0]).toEqual([1, 2, 'm'.charCodeAt(0)]);
    expect(results[1]).toEqual([1, 2, 'w'.charCodeAt(0)]);
    expect(results[2]).toEqual([1, 2, 'm'.charCodeAt(0)]); // 'mov' → 'm'
    await pool.terminate();
  });
});

// ── process-wide single-worker reuse (the §3.E crash fix) ─────────────────────────────────────────────

describe('ensureOffloadPool — one Worker per page, shared across engines', () => {
  afterEach(() => __resetSharedOffloadPools());

  it('spawns ONE worker for N engines at the same pool size (no per-engine spawn storm)', async () => {
    // The media-test adapter creates a fresh `createMedia({worker:true})` PER op, so each engine gets its
    // own OffloadPoolCache. Without the module-level shared pool, that is one Worker per op → the wasm
    // re-load storm that crashed the baseline. Assert the injected spawn runs exactly once across N caches.
    let spawnCount = 0;
    const terminated = { value: false };
    const spawn = () => {
      spawnCount += 1;
      return fakeSpawnedWorker({ ready: { webcodecs: true }, terminated });
    };
    const pools = await Promise.all(
      Array.from({ length: 6 }, () => {
        const cache: OffloadPoolCache = {}; // a DISTINCT per-engine cache each time
        return ensureOffloadPool(cache, 1, spawn);
      }),
    );
    expect(spawnCount).toBe(1); // ONE worker for all six engines
    // Every engine resolved the SAME shared pool instance (so they share the single worker).
    const first = pools[0];
    expect(first).not.toBeNull();
    for (const p of pools) expect(p).toBe(first);
    first?.terminate();
  });

  it('keeps distinct pools for distinct sizes (a {pool:N} engine does not share a worker:true pool)', async () => {
    let spawnCount = 0;
    const terminated = { value: false };
    const spawn = () => {
      spawnCount += 1;
      return fakeSpawnedWorker({ ready: { webcodecs: true }, terminated });
    };
    const a = await ensureOffloadPool({}, 1, spawn); // size-1 pool: 1 worker
    expect(spawnCount).toBe(1);
    const b = await ensureOffloadPool({}, 3, spawn); // size-3 pool: its OWN 3 workers (separate pool)
    expect(spawnCount).toBe(4); // 1 (size-1) + 3 (size-3)
    const beforeReuse = spawnCount;
    const aAgain = await ensureOffloadPool({}, 1, spawn); // size 1 reuses the first pool — ZERO new spawns
    expect(spawnCount).toBe(beforeReuse);
    expect(aAgain).toBe(a);
    expect(b).not.toBe(a);
    a?.terminate();
    b?.terminate();
  });

  it('memoizes within a single engine cache (repeat ops never re-await a spawn)', async () => {
    let spawnCount = 0;
    const spawn = () => {
      spawnCount += 1;
      return fakeSpawnedWorker({ ready: { webcodecs: true }, terminated: { value: false } });
    };
    const cache: OffloadPoolCache = {};
    const p1 = await ensureOffloadPool(cache, 1, spawn);
    const p2 = await ensureOffloadPool(cache, 1, spawn); // same cache, second op
    expect(spawnCount).toBe(1);
    expect(p2).toBe(p1);
    p1?.terminate();
  });
});
