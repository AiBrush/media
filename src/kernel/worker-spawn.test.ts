/**
 * DOM `Worker` adapter + spawn/handshake gate (BUILD §2/§6; doc 06 §3.3/§5 punch-list 1 & 6) — proves, in
 * Node over an **`EventTarget`-backed** DOM-Worker stand-in, the two properties the production adapter
 * must have on a page-lifetime, pool-reused worker:
 *
 *  1. **Net-zero listeners.** Every job's `#pump` listener (and the handshake's) is attached through the
 *     adapter and detached again when the job settles — the attached-`message`-listener count returns to
 *     its pre-job baseline after EVERY job. (The old adapter's `removeEventListener` was a no-op, so
 *     listeners accumulated forever.)
 *  2. **Stale chunk ⇒ close exactly once.** With a stale-epoch `chunk` carrying a `{close}` frame arriving
 *     on a reused transport, exactly ONE listener (the live job's) closes it. A leaked prior-job listener
 *     would close it a second time — the latent double-close this adapter fix removes.
 *
 * Plus the per-op handshake surface (punch-list 6): `awaitReady` resolves the worker's announced
 * `ready.caps`, a partially-capable worker is kept with its caps recorded, and the handshake listener is
 * itself detached (provable only through the fixed adapter).
 */

import { describe, expect, it } from 'vitest';
import { WorkerStreamBridge } from './worker-bridge.ts';
import { type JobRunner, runOffloadWorker } from './worker-entry.ts';
import type {
  HostMessage,
  MessageLike,
  WorkerMediaCaps,
  WorkerMessage,
} from './worker-protocol.ts';
import { adaptWorker, ensureWorkerBridge } from './worker-spawn.ts';

// ── an EventTarget-backed DOM-Worker stand-in with observable listener bookkeeping ───────────────────

/** A DOM-`Worker`-shaped fake: real `EventTarget` dispatch on the host side, a scope on the far side. */
class FakeDomWorker extends EventTarget {
  /** Mirror of the attached `message` listeners (DOM identity semantics) so the count is observable. */
  readonly #messageListeners = new Set<EventListenerOrEventListenerObject>();
  readonly #toWorker: (m: HostMessage) => void;
  terminated = false;

  constructor(toWorker: (m: HostMessage) => void) {
    super();
    this.#toWorker = toWorker;
  }

  get messageListenerCount(): number {
    return this.#messageListeners.size;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === 'message' && callback !== null) this.#messageListeners.add(callback);
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === 'message' && callback !== null) this.#messageListeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }

  /** Host→worker post (async, mirroring a real port). Transfer semantics are not needed here. */
  postMessage(message: unknown, _transfer?: Transferable[]): void {
    queueMicrotask(() => this.#toWorker(message as HostMessage));
  }

  /** Worker→host delivery: a REAL `MessageEvent` dispatched on the REAL EventTarget. */
  emit(data: WorkerMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Wire a fake DOM worker whose far side runs the REAL {@link runOffloadWorker} with the given runner. */
function fakeDomWorkerRunning(runJob: JobRunner, caps: WorkerMediaCaps): FakeDomWorker {
  const workerListeners = new Set<(ev: { data: HostMessage }) => void>();
  const fake = new FakeDomWorker((m) => {
    for (const l of [...workerListeners]) l({ data: m });
  });
  const scope: MessageLike<HostMessage, WorkerMessage> & { caps?: WorkerMediaCaps } = {
    caps,
    postMessage: (m) => queueMicrotask(() => fake.emit(m)),
    addEventListener: (_t, l) => void workerListeners.add(l),
    removeEventListener: (_t, l) => void workerListeners.delete(l),
  };
  runOffloadWorker(scope, runJob);
  return fake;
}

/** A close-counting frame stand-in (the double-close/leak observable). */
class SpyFrame {
  closeCount = 0;
  readonly codedWidth = 2;
  close(): void {
    this.closeCount += 1;
  }
}

/** A runner: `{n}` payloads emit n byte chunks then close; `{endless:true}` stays live until aborted. */
const runner: JobRunner = (job, ctx) => {
  const p = job.payload as { n?: number; endless?: boolean };
  let i = 0;
  return new ReadableStream<Transferable>({
    start(c): void {
      // The JobRunner contract: honor ctx.signal (the worker aborts it on a host cancel).
      if (p.endless === true) {
        ctx.signal.addEventListener('abort', () => c.error(ctx.signal.reason), { once: true });
      }
    },
    pull(c): void {
      if (p.endless === true) return; // stays live until the abort errors it
      if (i < (p.n ?? 0)) c.enqueue(new Uint8Array([i++]).buffer);
      else c.close();
    },
  });
};

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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ALL: WorkerMediaCaps = { video: true, audio: true };

// ── punch-list 1: net-zero listeners + stale-epoch close-once through the adapter ─────────────────────

describe('adaptWorker — exact-wrapper listener registry (punch-list 1)', () => {
  it('returns the message-listener count to its pre-job baseline after EACH of ≥2 sequential jobs', async () => {
    const fake = fakeDomWorkerRunning(runner, ALL);
    const adapted = adaptWorker(fake);
    const bridge = new WorkerStreamBridge(adapted);
    const baseline = fake.messageListenerCount; // pre-job baseline (nothing attached yet)

    // Job 1: while running, exactly one pump listener is attached; after it settles — none again.
    const stream1 = bridge.runStream({ op: 'convert', payload: { n: 2 } });
    expect(fake.messageListenerCount).toBe(baseline + 1);
    expect(await drain(stream1)).toHaveLength(2);
    expect(fake.messageListenerCount).toBe(baseline); // net-zero, not net-one

    // Job 2 over the SAME bridge/worker (the pool-reuse shape): net-zero again.
    const stream2 = bridge.runStream({ op: 'convert', payload: { n: 3 } });
    expect(fake.messageListenerCount).toBe(baseline + 1); // only THIS job's listener — no accumulation
    expect(await drain(stream2)).toHaveLength(3);
    expect(fake.messageListenerCount).toBe(baseline);
  });

  it('closes a stale-epoch chunk’s frame EXACTLY once (no double-close from a leaked prior listener)', async () => {
    const fake = fakeDomWorkerRunning(runner, ALL);
    const bridge = new WorkerStreamBridge(adaptWorker(fake));

    // Job 1 (epoch 1) runs to completion — its listener must be fully detached now.
    await drain(bridge.runStream({ op: 'convert', payload: { n: 1 } }));

    // Job 2 (epoch 2) is live; its listener is the ONLY one attached.
    const reader = bridge.runStream({ op: 'convert', payload: { endless: true } }).getReader();
    const pending = reader.read(); // keep the pump engaged
    expect(fake.messageListenerCount).toBe(1);

    // A stale in-transit chunk from finished job 1 arrives on the reused transport, carrying a frame the
    // host now owns. The live listener must close it (stale epoch) — and NOTHING else may close it again.
    const frame = new SpyFrame();
    fake.emit({ t: 'chunk', epoch: 1, seq: 9, frame: frame as unknown as Transferable });
    await tick();
    expect(frame.closeCount).toBe(1); // exactly once — a leaked job-1 listener would make this 2

    await reader.cancel();
    await tick();
    expect(fake.messageListenerCount).toBe(0); // and job 2's listener detached on cancel
    void pending.catch(() => {});
  });

  it('is idempotent per listener (DOM dedup) and detaches the exact wrapper it attached', () => {
    const fake = new FakeDomWorker(() => {});
    const adapted = adaptWorker(fake);
    const seen: WorkerMessage[] = [];
    const listener = (ev: { data: WorkerMessage }): void => void seen.push(ev.data);

    adapted.addEventListener('message', listener);
    adapted.addEventListener('message', listener); // DOM semantics: same listener registers once
    expect(fake.messageListenerCount).toBe(1);

    fake.emit({ t: 'done', epoch: 1 });
    expect(seen).toHaveLength(1); // delivered once, not twice

    adapted.removeEventListener('message', listener);
    expect(fake.messageListenerCount).toBe(0); // the EXACT wrapper was removed
    fake.emit({ t: 'done', epoch: 2 });
    expect(seen).toHaveLength(1); // no delivery after removal
    adapted.removeEventListener('message', listener); // removing again is a no-op, never a throw
  });
});

// ── punch-list 6: the caps handshake through ensureWorkerBridge over the adapter ──────────────────────

describe('ensureWorkerBridge over adaptWorker — per-op caps handshake', () => {
  it('resolves a bridge carrying the announced caps and detaches its handshake listener (net-zero)', async () => {
    const fake = fakeDomWorkerRunning(runner, { video: false, audio: true });
    const bridge = await ensureWorkerBridge(() => adaptWorker(fake), 1000);
    expect(bridge).toBeInstanceOf(WorkerStreamBridge);
    expect(bridge?.caps).toEqual({ video: false, audio: true }); // audio-only worker KEPT, caps recorded
    expect(fake.messageListenerCount).toBe(0); // the awaitReady listener is genuinely detached
    expect(fake.terminated).toBe(false);
  });

  it('terminates + downgrades when the worker announces no capable kind at all', async () => {
    const fake = fakeDomWorkerRunning(runner, { video: false, audio: false });
    const bridge = await ensureWorkerBridge(() => adaptWorker(fake), 1000);
    expect(bridge).toBeUndefined();
    expect(fake.terminated).toBe(true);
    expect(fake.messageListenerCount).toBe(0);
  });

  it('runs a real job end-to-end through the adapted transport (bytes arrive in order)', async () => {
    const fake = fakeDomWorkerRunning(runner, ALL);
    const bridge = await ensureWorkerBridge(() => adaptWorker(fake), 1000);
    if (bridge === undefined) throw new Error('expected a bridge');
    const chunks = (await drain(
      bridge.runStream({ op: 'convert', payload: { n: 3 } }),
    )) as ArrayBuffer[];
    expect(chunks.map((b) => [...new Uint8Array(b)][0])).toEqual([0, 1, 2]);
    expect(fake.messageListenerCount).toBe(0);
  });
});
