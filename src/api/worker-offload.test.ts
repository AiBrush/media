/**
 * Engine worker-offload wiring (BUILD §2/§6; ADR-019/ADR-086, doc 06 §4) — proves the engine's offload
 * path end-to-end in Node, with the Worker **mocked as transport** (a `MessageChannel` driving the REAL
 * worker runtime whose inner engine is a REAL `MediaEngineImpl`). The killer oracle is **byte-identity**: a
 * `convert` run through the full host↔worker channel loop produces the *exact same bytes* as the inline
 * convert — so offload changes where the work runs, never what it produces (Prime Directive 6: no fake, no
 * drift). PCM `wav→wav` is used because it runs entirely in pure TS (no WebCodecs), so the real engine
 * executes on both sides in Node; the lossy/video tier is byte-validated the same way in the browser harness.
 *
 * Also covered: the static worker-mode decision the engine makes (`selectWorkerMode`/`resolvePoolSize`), and
 * that determinism threads across the boundary (a `force-software` job carries it to the inner op).
 */

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerStreamBridge } from '../kernel/worker-bridge.ts';
import { runOffloadWorker } from '../kernel/worker-entry.ts';
import { runOffloadStream } from '../kernel/worker-host.ts';
import { type InnerEngine, type OffloadJobPayload, makeJobRunner } from '../kernel/worker-main.ts';
import { resolvePoolSize, selectWorkerMode } from '../kernel/worker-mode.ts';
import type { HostMessage, MessageLike, WorkerMessage } from '../kernel/worker-protocol.ts';
import { fromBytes } from '../sources/source.ts';
import { MediaEngineImpl } from './engine.ts';

// ── a real MessageChannel driving the real worker runtime + a real inner MediaEngineImpl ──────────────

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
 * Wire a real `MessageChannel`: the worker runtime runs {@link makeJobRunner} over a REAL inner
 * `MediaEngineImpl({worker:false})` (so the *same* engine code executes inside the "worker"). Returns the
 * host bridge — the production shape, only the real `new Worker(url)` spawn replaced by an in-process channel.
 */
function channelBridgeWithRealEngine(): WorkerStreamBridge {
  const channel = new MessageChannel();
  channels.push(channel);
  const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  const runJob = makeJobRunner(
    (determinism) => new MediaEngineImpl({ worker: false, determinism }) as unknown as InnerEngine,
  );
  runOffloadWorker({ ...workerPort, webcodecs: true }, runJob);
  return new WorkerStreamBridge(hostPort, () => {
    channel.port1.close();
    channel.port2.close();
  });
}

async function blobBytes(out: unknown): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob result');
  return new Uint8Array(await out.arrayBuffer());
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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

const WAV = new URL('../../fixtures/media/speech.wav', import.meta.url);
async function wavBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(WAV));
}

// ── the static worker-mode decision the engine makes ─────────────────────────────────────────────────

describe('engine worker-mode selection', () => {
  it('offloads only when EXPLICITLY opted in (worker:true/{pool}) AND a Worker exists; inline otherwise', () => {
    // The engine computes its mode from exactly these two inputs (constructor), so asserting the pure
    // decision pins the engine policy without spawning a real worker (Node has none for module workers).
    // Offload is OPT-IN: an unset `worker` runs inline (the safe default — no surprise Worker spawn).
    expect(selectWorkerMode(true, true)).toBe('offload'); // explicit opt-in
    expect(selectWorkerMode({ pool: 3 }, true)).toBe('offload'); // explicit opt-in (pooled)
    expect(selectWorkerMode(undefined, true)).toBe('inline'); // unset ⇒ inline (offload is opt-in)
    expect(selectWorkerMode(false, true)).toBe('inline'); // explicit opt-out
    expect(selectWorkerMode(true, false)).toBe('inline'); // no Worker → honest fallback
  });

  it('sizes the pool from the worker option (1 for true/unset, N for {pool:N})', () => {
    expect(resolvePoolSize(true)).toBe(1);
    expect(resolvePoolSize(undefined)).toBe(1);
    expect(resolvePoolSize({ pool: 4 })).toBe(4);
    expect(resolvePoolSize({ pool: 0 })).toBe(1); // clamped
  });

  it('in Node (no Worker) an engine created with worker:true runs inline (never throws for lack of a worker)', async () => {
    // No `Worker` global in Node ⇒ #workerMode is 'inline' ⇒ convert runs the inline pure-TS path and still
    // succeeds (the honest fallback, not a capability error).
    expect(typeof Worker).toBe('undefined');
    const eng = new MediaEngineImpl({ worker: true });
    const out = await eng.convert(await wavBytes(), {
      to: 'wav',
      audio: { gainDb: -6, codec: 'pcm-s16' },
    });
    expect(out).toBeInstanceOf(Blob);
    expect((out as Blob).size).toBeGreaterThan(0);
  });
});

// ── BYTE-IDENTITY: the offloaded convert == the inline convert, byte for byte ─────────────────────────

describe('offload byte-identity (worker path == inline path)', () => {
  it('a convert run through the full host↔worker loop produces byte-identical output to inline', async () => {
    const bytes = await wavBytes();
    const convertOpts = { to: 'wav' as const, audio: { gainDb: -6, codec: 'pcm-s16' as const } };

    // Inline: the engine runs the PCM transform on this thread.
    const inlineEngine = new MediaEngineImpl({ worker: false });
    const inline = await blobBytes(
      await inlineEngine.convert(fromBytes(bytes.slice()), convertOpts),
    );

    // Offloaded: the SAME convert, run inside the worker runtime over a real channel, streamed back as bytes.
    const bridge = channelBridgeWithRealEngine();
    const payload: OffloadJobPayload = {
      kind: 'convert',
      input: new ArrayBuffer(0), // runOffloadStream fills the real bytes
      opts: convertOpts,
    };
    const offloaded = await streamBytes(
      await runOffloadStream(bridge, fromBytes(bytes.slice()), payload, {}),
    );

    // Same length, same every byte — offload moved the work, not the result.
    expect(offloaded.byteLength).toBe(inline.byteLength);
    expect(offloaded).toEqual(inline);
  });

  it('threads force-software determinism across the boundary (still byte-identical)', async () => {
    const bytes = await wavBytes();
    const convertOpts = {
      to: 'wav' as const,
      audio: { sampleRate: 22050, codec: 'pcm-s16' as const },
    };

    const inline = await blobBytes(
      await new MediaEngineImpl({ worker: false, determinism: 'force-software' }).convert(
        fromBytes(bytes.slice()),
        convertOpts,
        { strategy: { determinism: 'force-software' } },
      ),
    );

    const bridge = channelBridgeWithRealEngine();
    const offloaded = await streamBytes(
      await runOffloadStream(
        bridge,
        fromBytes(bytes.slice()),
        { kind: 'convert', input: new ArrayBuffer(0), opts: convertOpts },
        { determinism: 'force-software' },
      ),
    );
    expect(offloaded).toEqual(inline);
  });
});
