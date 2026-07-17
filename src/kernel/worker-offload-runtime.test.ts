/**
 * Offload runtime lifecycle + the per-op caps gate (BUILD §2/§6; doc 06 §5 punch-list 6/8) — proves:
 *
 *  - **Scoped shared-pool lifetime (8).** Two engines (two caches) at one pool size share ONE worker
 *    spawn inside one runtime; `dispose()` terminates the shared pool (no worker survives) and later
 *    `ensurePool`s resolve `null`. No module-global reset backdoor exists — tests own their runtime.
 *  - **Per-op caps gating (6).** With a worker announcing `{video:false, audio:true}`, an audio-only
 *    convert PROCEEDS on the worker (bytes actually round-trip) while a video job downgrades to inline
 *    (`undefined`); a video+audio job requires both kinds true.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBytes } from '../sources/source.ts';
import { type JobRunner, runOffloadWorker } from './worker-entry.ts';
import {
  type OffloadPoolCache,
  type SpawnedWorker,
  createOffloadRuntime,
  defaultOffloadRuntime,
  tryOffload,
} from './worker-host.ts';
import { makeJobRunner } from './worker-main.ts';
import type {
  HostMessage,
  MessageLike,
  WorkerMediaCaps,
  WorkerMessage,
} from './worker-protocol.ts';

// ── transport: a real MessageChannel whose far side runs the real worker runtime ──────────────────────

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
      /* one listener per port; the channel is closed on terminate */
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

/** An echo worker announcing `caps`, running the REAL runtime + reconstruction over a real channel. */
function echoWorker(caps: WorkerMediaCaps, terminated?: { value: boolean }): SpawnedWorker {
  const channel = new MessageChannel();
  channels.push(channel);
  const host = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  const runJob: JobRunner = makeJobRunner(() => ({
    convert: async (input) => {
      const bytes =
        input.range && input.size !== undefined
          ? await input.range(0, input.size)
          : new Uint8Array(0);
      return byteStream([...bytes, 0xee]) as never;
    },
    trim: () => Promise.reject(new Error('unused')) as never,
  }));
  runOffloadWorker({ ...workerPort, caps }, runJob);
  return {
    postMessage: (m, transfer) => host.postMessage(m, transfer),
    addEventListener: (t, l) => host.addEventListener(t, l),
    removeEventListener: (t, l) => host.removeEventListener(t, l),
    terminate: () => {
      if (terminated) terminated.value = true;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function byteStream(bytes: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(Uint8Array.from(bytes));
      c.close();
    },
  });
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

// ── punch-list 8: scoped lifetime, one spawn per runtime, disposal terminates ─────────────────────────

describe('createOffloadRuntime — owned registry, disposable lifetime', () => {
  it('two engines at the same pool size share ONE worker spawn; dispose terminates it', async () => {
    const runtime = createOffloadRuntime();
    let spawnCount = 0;
    const terminated = { value: false };
    const spawn = (): SpawnedWorker => {
      spawnCount += 1;
      return echoWorker({ video: true, audio: true }, terminated);
    };

    const engineACache: OffloadPoolCache = {};
    const engineBCache: OffloadPoolCache = {};
    const a = await runtime.ensurePool(1, spawn);
    const streamViaA = await tryOffload(
      engineACache,
      1,
      fromBytes(new Uint8Array([1, 2])),
      'convert',
      { to: 'mp4' } as { to: string; sink?: unknown },
      {},
      { spawn, runtime },
    );
    const streamViaB = await tryOffload(
      engineBCache,
      1,
      fromBytes(new Uint8Array([1, 2])),
      'convert',
      { to: 'mp4' } as { to: string; sink?: unknown },
      {},
      { spawn, runtime },
    );
    expect(spawnCount).toBe(1); // ONE spawn across the direct ensure + two engines' offloads
    expect(a).not.toBeNull();
    expect(engineACache.pool).toBe(a);
    expect(engineBCache.pool).toBe(a); // both engines resolved the SAME shared pool
    if (streamViaA === undefined || streamViaB === undefined) {
      throw new Error('expected both engines to offload');
    }
    expect(await drainBytes(streamViaA)).toEqual([1, 2, 0xee]);
    expect(await drainBytes(streamViaB)).toEqual([1, 2, 0xee]);

    await runtime.dispose(); // the OWNER tears the shared pool down — no backdoor reset
    expect(terminated.value).toBe(true); // no worker survives disposal
    expect(runtime.disposed).toBe(true);
    await expect(runtime.ensurePool(1, spawn)).resolves.toBeNull(); // disposed ⇒ honest inline verdict
    expect(spawnCount).toBe(1); // and no further spawn happened
  });

  it('dispose is idempotent and safe while a spawn is still settling', async () => {
    const runtime = createOffloadRuntime();
    const terminated = { value: false };
    const pending = runtime.ensurePool(1, () => echoWorker({ video: true, audio: true }, terminated));
    await runtime.dispose();
    await runtime.dispose(); // idempotent
    await pending; // the in-flight spawn settles…
    expect(terminated.value).toBe(true); // …and its pool was still terminated by the disposer
  });

  it('the process-default runtime is one shared instance, and is replaced after disposal', async () => {
    const first = defaultOffloadRuntime();
    expect(defaultOffloadRuntime()).toBe(first); // the ADR-087 cross-engine sharing point
    await first.dispose();
    const second = defaultOffloadRuntime();
    expect(second).not.toBe(first); // a disposed default never wedges the process into inline forever
    expect(second.disposed).toBe(false);
  });
});

// ── punch-list 6: the per-op caps gate (audio-only worker) ────────────────────────────────────────────

describe('tryOffload — per-op caps gate', () => {
  it('audio-only job PROCEEDS on a {video:false, audio:true} worker; a video job downgrades inline', async () => {
    const runtime = createOffloadRuntime();
    const spawn = (): SpawnedWorker => echoWorker({ video: false, audio: true });
    const cache: OffloadPoolCache = {};

    // Audio-only convert (video explicitly disabled): the worker HAS audio — offload proceeds, bytes flow.
    const audioOnly = await tryOffload(
      cache,
      1,
      fromBytes(new Uint8Array([7])),
      'convert',
      { to: 'mp3', video: false } as { to: string; video: false; sink?: unknown },
      {},
      { spawn, runtime },
    );
    if (audioOnly === undefined) throw new Error('audio-only job must offload');
    expect(await drainBytes(audioOnly)).toEqual([7, 0xee]);

    // A job that may need video (no explicit video:false): the worker lacks video — inline fallback.
    const needsVideo = await tryOffload(
      cache,
      1,
      fromBytes(new Uint8Array([7])),
      'convert',
      { to: 'mp4' } as { to: string; sink?: unknown },
      {},
      { spawn, runtime },
    );
    expect(needsVideo).toBeUndefined();
    await runtime.dispose();
  });

  it('a video+audio job requires BOTH kinds true (video-only worker downgrades it)', async () => {
    const runtime = createOffloadRuntime();
    const spawn = (): SpawnedWorker => echoWorker({ video: true, audio: false });
    const av = await tryOffload(
      {},
      1,
      fromBytes(new Uint8Array([7])),
      'convert',
      { to: 'mp4' } as { to: string; sink?: unknown },
      {},
      { spawn, runtime },
    );
    expect(av).toBeUndefined();

    // …while a video-only job (audio explicitly disabled) still offloads to that same worker.
    const videoOnly = await tryOffload(
      {},
      1,
      fromBytes(new Uint8Array([7])),
      'convert',
      { to: 'mp4', audio: false } as { to: string; audio: false; sink?: unknown },
      {},
      { spawn, runtime },
    );
    if (videoOnly === undefined) throw new Error('video-only job must offload');
    expect(await drainBytes(videoOnly)).toEqual([7, 0xee]);
    await runtime.dispose();
  });
});
