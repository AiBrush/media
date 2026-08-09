/**
 * Offload input marshaling (BUILD §2/§6; doc 06 §5 punch-list 4/5/7) — proves on REAL fixture bytes:
 *
 *  - **Zero-copy adopt (4).** A stream-only source's concatenated read is already the exact transferable;
 *    `runOffloadStream` posts THAT buffer (no `ArrayBuffer.slice` on the marshal path — peak allocation is
 *    ~N, not ~2N). A `range()` read is **borrowed** (it may alias the source's own backing store) and is
 *    always copied — adopting it would detach the caller's source, which a repeat-read oracle catches.
 *  - **Single reader (5).** `readSourceOwned` replaces the deleted `readAllSource` duplicate and yields
 *    byte-identical output vs that legacy implementation (pinned verbatim below) on the same fixture,
 *    through BOTH branches (seekable range / stream drain).
 *  - **Typed transfer list (7, integration).** The posted job's payload carries the input as its one
 *    declared transferable; a frame-shaped plain options object rides along un-moved.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS } from '../api/types.ts';
import { type Source, fromBytes, fromStream } from '../sources/source.ts';
import { readSourceOwned, transferableInput } from './worker-input.ts';
import {
  type JobStreamRunner,
  abrLadderCapsSatisfy,
  buildOffloadPayload,
  capsSatisfy,
  offloadAbrLadder,
  offloadCapsNeed,
  runOffloadStream,
} from './worker-marshal.ts';
import type { OffloadJob } from './worker-protocol.ts';

const FIXTURE = new URL('../../fixtures/media/test.mp4', import.meta.url);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The OLD `worker-host.ts` reader, pinned verbatim — the byte-identity reference for punch-list 5. */
async function legacyReadAllSource(src: Source): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) {
    return src.range(0, src.size);
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c): void {
      if (off >= bytes.byteLength) {
        c.close();
        return;
      }
      // Fresh copies per chunk, as a network stream would produce (never views of one long-lived buffer).
      c.enqueue(bytes.slice(off, Math.min(off + chunkSize, bytes.byteLength)));
      off += chunkSize;
    },
  });
}

/** A capturing stub runner: records the posted job, returns an immediately-closed result stream. */
function captureRunner(): { runner: JobStreamRunner; job: () => OffloadJob } {
  let captured: OffloadJob | undefined;
  return {
    runner: {
      runStream: (job): ReadableStream<Transferable> => {
        captured = job;
        return new ReadableStream<Transferable>({
          start(c): void {
            c.close();
          },
        });
      },
    },
    job: (): OffloadJob => {
      if (captured === undefined) throw new Error('no job was posted');
      return captured;
    },
  };
}

const inputOf = (job: OffloadJob): ArrayBuffer => {
  const input = (job.payload as { input: unknown }).input;
  if (!(input instanceof ArrayBuffer)) throw new Error('posted payload has no input buffer');
  return input;
};

// ── transferableInput: provenance-aware adopt-vs-copy (punch-list 4) ──────────────────────────────────

describe('transferableInput', () => {
  it('ADOPTS an owned, shape-exact buffer (zero-copy identity)', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(transferableInput({ bytes, owned: true })).toBe(bytes.buffer);
  });

  it('copies an owned but offset/short view (a subarray must never transfer its whole pool buffer)', () => {
    const pool = new Uint8Array([9, 1, 2, 3, 9]);
    const view = pool.subarray(1, 4);
    const out = transferableInput({ bytes: view, owned: true });
    expect(out).not.toBe(pool.buffer);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
  });

  it('COPIES a borrowed shape-exact view — adopting would detach the source’s own backing buffer', () => {
    // `fromBytes(x).range(0, size)` returns a subarray view over x's WHOLE buffer: byteOffset 0, exact
    // length. A shape-only rule would adopt (and postMessage would detach) the caller's buffer.
    const callerBuffer = new Uint8Array([5, 6, 7]);
    const borrowed = callerBuffer.subarray(0, 3);
    const out = transferableInput({ bytes: borrowed, owned: false });
    expect(out).not.toBe(callerBuffer.buffer);
    expect([...new Uint8Array(out)]).toEqual([5, 6, 7]);
    expect(callerBuffer.buffer.byteLength).toBe(3); // untouched, not detached
  });

  it('copies a SharedArrayBuffer-backed view into a plain (transferable) ArrayBuffer', () => {
    const sab = new SharedArrayBuffer(3);
    const view = new Uint8Array(sab);
    view.set([7, 8, 9]);
    const out = transferableInput({ bytes: view, owned: true });
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out)]).toEqual([7, 8, 9]);
  });
});

// ── readSourceOwned: the single reader, byte-identical to the deleted duplicate (punch-list 5) ────────

describe('readSourceOwned', () => {
  const fixture = new Uint8Array(readFileSync(FIXTURE));

  it('yields byte-identical output vs the legacy reader on the same fixture (range branch)', async () => {
    const src = fromBytes(fixture);
    const modern = await readSourceOwned(src, undefined);
    const legacy = await legacyReadAllSource(fromBytes(fixture));
    expect(modern.owned).toBe(false); // a range() result may alias the source — tagged borrowed
    expect(modern.bytes.byteLength).toBe(fixture.byteLength);
    expect(sha256(modern.bytes)).toBe(sha256(legacy));
  });

  it('yields byte-identical output vs the legacy reader on the same fixture (stream branch)', async () => {
    const modern = await readSourceOwned(fromStream(chunkedStream(fixture, 64 * 1024)), undefined);
    const legacy = await legacyReadAllSource(fromStream(chunkedStream(fixture, 64 * 1024)));
    expect(modern.owned).toBe(true); // the concat run was allocated here — safe to adopt
    expect(sha256(modern.bytes)).toBe(sha256(legacy));
    expect(sha256(modern.bytes)).toBe(sha256(fixture));
  });

  it('rejects with a typed aborted error when the signal has already fired', async () => {
    await expect(readSourceOwned(fromBytes(fixture), AbortSignal.abort())).rejects.toMatchObject({
      name: 'MediaError',
      code: 'aborted',
    });
  });

  it('cancels an unknown-length worker source as soon as its explicit byte ceiling is crossed', async () => {
    let cancelled = false;
    const src = fromStream(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(Uint8Array.of(1, 2, 3));
          controller.enqueue(Uint8Array.of(4, 5, 6));
        },
        cancel(): void {
          cancelled = true;
        },
      }),
    );
    await expect(readSourceOwned(src, undefined, 5)).rejects.toMatchObject({
      code: 'unsupported-input',
      detail: { observedBytes: 6, maximumBytes: 5 },
    });
    expect(cancelled).toBe(true);
  });
});

// ── runOffloadStream: zero-copy adopt on the stream path, exact copy on the range path ────────────────

describe('runOffloadStream input marshaling (punch-list 4)', () => {
  const MIB = 1024 * 1024;

  it('stream-only source: posts the concat buffer ITSELF — no ArrayBuffer.slice on the marshal path', async () => {
    const total = 8 * MIB;
    const big = new Uint8Array(total);
    for (let i = 0; i < total; i += 4096) big[i] = (i >> 12) & 0xff;
    const digest = sha256(big);
    const src = fromStream(chunkedStream(big, MIB));
    const { runner, job } = captureRunner();

    const sliceSpy = vi.spyOn(ArrayBuffer.prototype, 'slice');
    try {
      await runOffloadStream(runner, src, { kind: 'convert', input: new ArrayBuffer(0), opts: {} });
      // Zero-copy adopt: nothing sliced a full-size buffer during the marshal (the per-chunk producer
      // copies are Uint8Array.slice, not ArrayBuffer.slice; the 8 MiB run itself is adopted as-is).
      const fullSizeSlices = sliceSpy.mock.contexts.filter(
        (buf) => (buf as ArrayBuffer).byteLength === total,
      );
      expect(fullSizeSlices).toHaveLength(0);
    } finally {
      sliceSpy.mockRestore();
    }
    const input = inputOf(job());
    expect(input.byteLength).toBe(total); // exact-length (a pool/subview transfer would over-share)
    expect(sha256(new Uint8Array(input))).toBe(digest); // bit-exact content oracle
  });

  it('range source: still transfers an exact-length COPY and never detaches the caller’s buffer', async () => {
    const total = MIB;
    const caller = new Uint8Array(total);
    for (let i = 0; i < total; i += 1024) caller[i] = (i >> 10) & 0xff;
    const digest = sha256(caller);
    const src = fromBytes(caller);
    const { runner, job } = captureRunner();

    await runOffloadStream(runner, src, { kind: 'convert', input: new ArrayBuffer(0), opts: {} });
    const input = inputOf(job());
    expect(input).not.toBe(caller.buffer); // a copy, never the source's own backing store
    expect(input.byteLength).toBe(total);
    expect(sha256(new Uint8Array(input))).toBe(digest);
    expect(caller.buffer.byteLength).toBe(total); // NOT detached…
    // …so the SAME source remains fully readable — the regression a shape-only adopt would cause.
    const again = await readSourceOwned(src, undefined);
    expect(sha256(again.bytes)).toBe(digest);
  });

  it('carries the payload input as the one declared transferable; frame-shaped opts ride unmoved (7)', async () => {
    const frameShaped = { close: (): void => {}, width: 2 };
    const { runner, job } = captureRunner();
    await runOffloadStream(runner, fromBytes(new Uint8Array([1, 2, 3])), {
      kind: 'convert',
      input: new ArrayBuffer(0),
      opts: { overlay: frameShaped } as never,
    });
    const posted = job();
    const payload = posted.payload as { input: ArrayBuffer; opts: { overlay: unknown } };
    expect(payload.input.byteLength).toBe(3);
    expect(payload.opts.overlay).toBe(frameShaped); // still a plain field of the payload, never moved
  });
});

// ── payload assembly + the per-op caps policy (punch-list 6) ──────────────────────────────────────────

describe('buildOffloadPayload', () => {
  it('uses a FRESH zero-length input placeholder per payload (a shared one would arrive detached)', () => {
    const a = buildOffloadPayload('convert', {}, { to: 'mp4' } as { to: string; sink?: unknown });
    const b = buildOffloadPayload('convert', {}, { to: 'mp4' } as { to: string; sink?: unknown });
    expect(a.input).not.toBe(b.input); // the typed transfer list detaches input on EVERY post
    expect(a.input.byteLength).toBe(0);
  });

  it('strips sink, carries hints, and pins offloaded trim to accurate mode', () => {
    const payload = buildOffloadPayload(
      'trim',
      { filename: 'clip.mp4', mimeHint: 'video/mp4' },
      { start: 1, end: 2, sink: { kind: 'blob' } },
    );
    expect(payload.kind).toBe('trim');
    expect(payload.filename).toBe('clip.mp4');
    expect(payload.mime).toBe('video/mp4');
    expect(payload.opts).toMatchObject({ start: 1, end: 2, mode: 'accurate' });
    expect('sink' in payload.opts).toBe(false);
  });
});

describe('offloadCapsNeed / capsSatisfy', () => {
  it('derives the needed kinds from the public options (explicit false disables a kind)', () => {
    expect(offloadCapsNeed({ to: 'mp4' })).toEqual({ video: true, audio: true });
    expect(offloadCapsNeed({ to: 'mp3', video: false })).toEqual({ video: false, audio: true });
    expect(offloadCapsNeed({ to: 'mp4', audio: false })).toEqual({ video: true, audio: false });
    expect(offloadCapsNeed(undefined)).toEqual({ video: true, audio: true }); // conservative
  });

  it('matches needs against announced caps; unreported caps are unrestricted', () => {
    const audioOnly = { video: false, audio: true };
    expect(capsSatisfy(audioOnly, { video: false, audio: true })).toBe(true); // audio job proceeds
    expect(capsSatisfy(audioOnly, { video: true, audio: false })).toBe(false); // video job downgrades
    expect(capsSatisfy(audioOnly, { video: true, audio: true })).toBe(false); // av needs both
    expect(capsSatisfy({ video: true, audio: true }, { video: true, audio: true })).toBe(true);
    expect(capsSatisfy(undefined, { video: true, audio: true })).toBe(true); // no handshake ⇒ open
  });

  it('requires affirmative caps for every ABR rendition', () => {
    const ladder = [
      { opts: { to: 'mp4', video: { codec: 'h264' } } },
      { opts: { to: 'mp4', video: { codec: 'h264' }, audio: false } },
    ];
    expect(abrLadderCapsSatisfy(undefined, ladder)).toBe(false);
    expect(abrLadderCapsSatisfy({ video: true, audio: false }, ladder)).toBe(false);
    expect(abrLadderCapsSatisfy({ video: false, audio: true }, ladder)).toBe(false);
    expect(abrLadderCapsSatisfy({ video: true, audio: true }, ladder)).toBe(true);
  });
});

describe('offloadAbrLadder bounded scheduling', () => {
  async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
    const out: number[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(...value);
    }
  }

  function trackingRunner(size: number): {
    readonly runner: JobStreamRunner;
    readonly peak: () => number;
  } {
    let active = 0;
    let peak = 0;
    return {
      runner: {
        size,
        runStream: (job): ReadableStream<Transferable> => {
          active += 1;
          peak = Math.max(peak, active);
          const opts = (
            job.payload as { readonly opts?: { readonly video?: { readonly width?: number } } }
          ).opts;
          const marker = opts?.video?.width ?? 0;
          let emitted = false;
          return new ReadableStream<Transferable>({
            async pull(controller): Promise<void> {
              if (emitted) return;
              emitted = true;
              await new Promise<void>((resolve) => setTimeout(resolve, 1));
              controller.enqueue(Uint8Array.of(marker & 0xff).buffer);
              active -= 1;
              controller.close();
            },
          });
        },
      },
      peak: () => peak,
    };
  }

  it('keeps legacy source copies/jobs bounded to the runner size', async () => {
    const tracked = trackingRunner(2);
    const streams = await offloadAbrLadder(
      tracked.runner,
      fromBytes(Uint8Array.of(1, 2, 3)),
      Array.from({ length: 7 }, (_, index) => ({
        opts: { to: 'mp4', video: { codec: 'h264', width: 320 + index } },
      })),
    );
    await Promise.all(streams.map(drainBytes));
    expect(tracked.peak()).toBe(2);
  });

  it('caps legacy fanout even when a caller configures a much larger worker pool', async () => {
    const tracked = trackingRunner(99);
    const streams = await offloadAbrLadder(
      tracked.runner,
      fromBytes(Uint8Array.of(1, 2, 3)),
      Array.from({ length: 7 }, (_, index) => ({
        opts: { to: 'mp4', video: { codec: 'h264', width: 320 + index } },
      })),
    );
    await Promise.all(streams.map(drainBytes));
    expect(tracked.peak()).toBe(H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS);
  });

  it('serializes the full ladder when any rung carries an objective-quality constraint', async () => {
    const tracked = trackingRunner(4);
    const streams = await offloadAbrLadder(tracked.runner, fromBytes(Uint8Array.of(1, 2, 3)), [
      {
        opts: {
          to: 'mp4',
          video: {
            codec: 'h264',
            width: 1_920,
            bitrate: 4_000_000,
            maxAverageBitrate: 5_200_000,
            quality: { metric: 'ssim-luma-v1', minimumMean: 0.95 },
          },
        },
      },
      { opts: { to: 'mp4', video: { codec: 'h264', width: 1_280, bitrate: 2_000_000 } } },
      { opts: { to: 'mp4', video: { codec: 'h264', width: 854, bitrate: 1_000_000 } } },
    ]);
    await Promise.all(streams.map(drainBytes));
    expect(tracked.peak()).toBe(1);
  });
});
