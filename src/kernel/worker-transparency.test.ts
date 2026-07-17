/**
 * Runtime transparency gate (BUILD §2/§6; doc 06 §5 punch-list 9) — the oracle that the worker runtime
 * **adds nothing and drops nothing**: an offloaded `convert` of a real B-frame-reorder fixture and a real
 * VFR fixture each produce a **byte-identical** result (same SHA-256) to the inline `convert` of the same
 * fixture. The full production offload machinery runs — payload marshal, transfer, epochs, credit window,
 * worker-side reconstruction onto a REAL inner `MediaEngineImpl` — with only the `new Worker(url)` spawn
 * replaced by an in-process `MessageChannel` (Node has no module Worker; the browser harness runs the
 * same oracle on a real thread). Fixture traits are asserted structurally from packet truth, not trusted:
 * the B-frame fixture must actually reorder (pts≠dts) and the VFR fixture must have >2 distinct packet
 * durations, so this gate cannot silently rot into a trivial pass.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MediaEngineImpl } from '../api/engine.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { toStream } from '../sinks/sink.ts';
import { fromBytes } from '../sources/source.ts';
import { WorkerStreamBridge } from './worker-bridge.ts';
import { runOffloadWorker } from './worker-entry.ts';
import { offloadHeavyOp } from './worker-host.ts';
import { type InnerEngine, makeJobRunner } from './worker-main.ts';
import type { HostMessage, MessageLike, WorkerMessage } from './worker-protocol.ts';

const MEDIA = (name: string): URL => new URL(`../../fixtures/media/${name}`, import.meta.url);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

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
      /* one listener per port; the channel closes on terminate */
    },
  };
}

/**
 * The production worker shape over a real channel: `runOffloadWorker` + `makeJobRunner` + a REAL inner
 * `MediaEngineImpl({worker:false})` — exactly what `worker.ts` boots, minus the dynamic import. Counts
 * `chunk` posts so the test proves the result genuinely crossed the wire (no passthrough-as-work).
 */
function realEngineBridge(): {
  bridge: WorkerStreamBridge;
  chunkPosts: () => number;
  close: () => void;
} {
  const channel = new MessageChannel();
  const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
  const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
  let posts = 0;
  const counting: MessageLike<HostMessage, WorkerMessage> = {
    ...workerPort,
    postMessage: (m, transfer): void => {
      if (m.t === 'chunk') posts += 1;
      workerPort.postMessage(m, transfer);
    },
  };
  const runJob = makeJobRunner(
    (determinism, runtime) =>
      new MediaEngineImpl({ worker: false, determinism }, runtime) as unknown as InnerEngine,
  );
  runOffloadWorker({ ...counting, caps: { video: true, audio: true } }, runJob);
  const close = (): void => {
    channel.port1.close();
    channel.port2.close();
  };
  return { bridge: new WorkerStreamBridge(hostPort, close), chunkPosts: () => posts, close };
}

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

interface PacketShape {
  readonly ptsUs?: number;
  readonly dtsUs?: number;
  readonly durationUs?: number;
}

/** Structural packet truth for the fixture preconditions (reorder count + distinct durations). */
async function packetTruth(bytes: Uint8Array): Promise<{ reordered: number; durations: number }> {
  const packetInfo = Mp4Driver.packetInfo;
  if (packetInfo === undefined) throw new Error('MP4 driver must expose packetInfo');
  const table = await packetInfo.call(Mp4Driver, fromBytes(bytes, { mime: 'video/mp4' }));
  let reordered = 0;
  const durations = new Set<number>();
  for (const p of table.packets as readonly PacketShape[]) {
    if (p.ptsUs !== undefined && p.dtsUs !== undefined && p.ptsUs !== p.dtsUs) reordered += 1;
    if (p.durationUs !== undefined) durations.add(p.durationUs);
  }
  return { reordered, durations: durations.size };
}

/** Probe geometry, then run the SAME convert inline and offloaded; return both digests + wire proof. */
async function convertBothWays(
  bytes: Uint8Array,
): Promise<{ inline: string; offloaded: string; chunksCrossed: number; outBytes: number }> {
  const probeEngine = new MediaEngineImpl({ worker: false });
  const info = await probeEngine.probe(fromBytes(bytes));
  const video = info.tracks.find((t) => t.type === 'video');
  if (video?.width === undefined || video.height === undefined) {
    throw new Error('fixture must expose video geometry');
  }
  const publicOpts = {
    to: 'mp4',
    video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
  } as { to: string; sink?: unknown };

  // Inline reference: the same op, same stream sink, on this thread.
  const inlineEngine = new MediaEngineImpl({ worker: false, determinism: 'auto' });
  const inlineOut = await inlineEngine.convert(fromBytes(bytes), {
    ...publicOpts,
    sink: toStream(),
  } as never);
  if (!(inlineOut instanceof ReadableStream)) throw new Error('expected a stream sink result');
  const inlineBytes = await drainBytes(inlineOut as ReadableStream<Uint8Array>);

  // Offloaded: the identical op through the full production offload machinery.
  const { bridge, chunkPosts } = realEngineBridge();
  const offloadStream = await offloadHeavyOp(bridge, fromBytes(bytes), 'convert', publicOpts);
  const offloadBytes = await drainBytes(offloadStream);
  bridge.terminate();

  return {
    inline: sha256(inlineBytes),
    offloaded: sha256(offloadBytes),
    chunksCrossed: chunkPosts(),
    outBytes: offloadBytes.byteLength,
  };
}

describe('worker runtime transparency (punch-list 9): offloaded convert ≡ inline convert, bit-exact', () => {
  it(
    'B-frame-reorder fixture (test.mp4): byte-identical SHA-256 across the boundary',
    { timeout: 120_000 },
    async () => {
      const bytes = new Uint8Array(readFileSync(MEDIA('test.mp4')));
      const truth = await packetTruth(bytes);
      expect(truth.reordered).toBeGreaterThan(0); // genuinely reorders (pts≠dts) — precondition, not trust

      const r = await convertBothWays(bytes);
      expect(r.outBytes).toBeGreaterThan(0);
      expect(r.chunksCrossed).toBeGreaterThan(0); // the result really crossed the worker wire
      expect(r.offloaded).toBe(r.inline); // the runtime added nothing and dropped nothing
    },
  );

  it(
    'VFR fixture (obs-remux-variable-aac.mp4): byte-identical SHA-256 across the boundary',
    { timeout: 120_000 },
    async () => {
      const bytes = new Uint8Array(readFileSync(MEDIA('obs-remux-variable-aac.mp4')));
      const truth = await packetTruth(bytes);
      expect(truth.durations).toBeGreaterThan(2); // genuinely variable frame durations — precondition

      const r = await convertBothWays(bytes);
      expect(r.outBytes).toBeGreaterThan(0);
      expect(r.chunksCrossed).toBeGreaterThan(0);
      expect(r.offloaded).toBe(r.inline);
    },
  );
});
