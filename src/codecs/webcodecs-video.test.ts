/**
 * Node-side unit tests for the WebCodecs VIDEO codec driver. WebCodecs (`VideoDecoder`/`VideoEncoder`/
 * `VideoFrame`) does not exist in Node and **must never be mocked** (faking is banned, CLAUDE.md §6) —
 * the real decode/encode frame-flow is validated by the parent in the browser harness. Here we cover
 * (a) the PURE helpers that drive the live path (config normalization, GOP/keyframe decision, the
 * defensive presentation-order utilities, the backpressure threshold) — each is real logic that can
 * fail — and (b) the honest absent-WebCodecs behavior: `supports()` returns `{supported:false}` without
 * throwing, and `createDecoder`/`createEncoder` raise a typed {@link CapabilityError}.
 */

import { describe, expect, it } from 'vitest';
import type { EncodedChunk, RawFrame } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import WebcodecsVideoModule, {
  ACCELERATION_PROBE_ORDER,
  type EnqueueSink,
  PendingOutputBackpressure,
  type SupportProbe,
  VIDEO_CODEC_PREFIXES,
  type WarmDecoderFactory,
  type WarmDecoderHandle,
  type WarmDecoderSink,
  WebcodecsVideoDriver,
  combineSupport,
  createWarmVideoDecoderPool,
  decoderErrorToCapabilityMiss,
  enqueueOrClose,
  enqueueOrDrop,
  isVideoCodecString,
  isPresentationOrdered,
  needsAppleH264HorizontalPhaseCompensation,
  normalizeHardwareAcceleration,
  queueIsBackpressured,
  rateControlWarmupTimestamps,
  reorderByTimestamp,
  shouldKeyframe,
  videoEncodeOptions,
} from './webcodecs-video.ts';

/** A fake closable frame that records how many times it was closed (close-exactly-once assertions). */
class FakeFrame {
  closeCount = 0;
  close(): void {
    this.closeCount++;
  }
}

/** A fake enqueue sink that records enqueues and can be told to throw (simulating a closed readable). */
class FakeController<T> implements EnqueueSink<T> {
  readonly enqueued: T[] = [];
  throwOnEnqueue = false;
  enqueue(chunk: T): void {
    if (this.throwOnEnqueue) {
      throw new TypeError('Cannot enqueue a chunk into a closed readable stream');
    }
    this.enqueued.push(chunk);
  }
}

describe('enqueueOrClose — the decoder-output close-race guard (close-exactly-once)', () => {
  it('enqueues a frame when the readable is open; the consumer owns it (not closed here)', () => {
    const ctrl = new FakeController<FakeFrame>();
    const frame = new FakeFrame();
    const handed = enqueueOrClose(ctrl, frame, () => false);
    expect(handed).toBe(true); // consumer now owns it
    expect(ctrl.enqueued).toEqual([frame]);
    expect(frame.closeCount).toBe(0); // the guard did NOT close it (the consumer will)
  });

  it('closes the frame and does NOT enqueue when the readable is already closed', () => {
    const ctrl = new FakeController<FakeFrame>();
    const frame = new FakeFrame();
    const handed = enqueueOrClose(ctrl, frame, () => true); // closed (e.g. seek cancelled the reader)
    expect(handed).toBe(false);
    expect(ctrl.enqueued).toEqual([]); // never enqueued into a dead controller
    expect(frame.closeCount).toBe(1); // closed exactly once by the guard
  });

  it('closes the frame (no rethrow) when enqueue throws the closed-stream race', () => {
    const ctrl = new FakeController<FakeFrame>();
    ctrl.throwOnEnqueue = true; // readable closed between the isClosed() check and the enqueue
    const frame = new FakeFrame();
    let handed: boolean | undefined;
    expect(() => {
      handed = enqueueOrClose(ctrl, frame, () => false);
    }).not.toThrow(); // the WebCodecs output callback must never throw
    expect(handed).toBe(false);
    expect(frame.closeCount).toBe(1); // closed exactly once after the failed handover
  });

  it('closes exactly once across each path (never double-closes)', () => {
    const open = new FakeFrame();
    enqueueOrClose(new FakeController<FakeFrame>(), open, () => false);
    expect(open.closeCount).toBe(0);
    const dropped = new FakeFrame();
    enqueueOrClose(new FakeController<FakeFrame>(), dropped, () => true);
    expect(dropped.closeCount).toBe(1);
  });
});

describe('enqueueOrDrop — the encoder-output close-race guard (EncodedChunks: no close, just drop)', () => {
  // EncodedVideoChunk has no close(); a dropped chunk is a plain byte buffer the GC frees — so the only
  // observable is "was it enqueued?". A fake chunk stands in (the guard never calls a method on it).
  it('enqueues a chunk when the readable is open', () => {
    const ctrl = new FakeController<object>();
    const chunk = { byteLength: 4 };
    expect(enqueueOrDrop(ctrl, chunk, () => false)).toBe(true);
    expect(ctrl.enqueued).toEqual([chunk]);
  });
  it('drops the chunk (no enqueue) when the readable is already closed', () => {
    const ctrl = new FakeController<object>();
    expect(enqueueOrDrop(ctrl, { byteLength: 4 }, () => true)).toBe(false);
    expect(ctrl.enqueued).toEqual([]); // never enqueued into a dead controller; no throw
  });
  it('drops the chunk (no rethrow) when enqueue throws the closed-stream race', () => {
    const ctrl = new FakeController<object>();
    ctrl.throwOnEnqueue = true; // readable closed between the isClosed() check and the enqueue
    let result: boolean | undefined;
    expect(() => {
      result = enqueueOrDrop(ctrl, { byteLength: 4 }, () => false);
    }).not.toThrow(); // the WebCodecs encoder output callback must never throw
    expect(result).toBe(false);
  });
});

describe('decoderErrorToCapabilityMiss — native-decoder failure → cross-browser capability miss (NA)', () => {
  // WebKit/Safari throws EncodingError "Decoder failure" on streams its own isConfigSupported approved
  // (measured: a 2x2 H.264 the engine demuxes correctly and Chromium decodes). The driver must classify
  // that as a CapabilityError so the engine/harness degrade to NA, never an unhandled DOMException.
  it('maps a decoder DOMException to a CapabilityError (capability-miss), preserving the cause', () => {
    const dom = new DOMException('Decoder failure', 'EncodingError');
    const err = decoderErrorToCapabilityMiss(dom, 'webcodecs-video', 'avc1.64000A');
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe('capability-miss');
    expect(err.message).toContain('avc1.64000A');
    expect(err.message).toContain('EncodingError');
    expect(err.message).toContain('Decoder failure');
    expect(err.detail).toMatchObject({
      op: { kind: 'route', id: 'decode' },
      tried: ['webcodecs-video'],
    });
    expect(err.cause).toBe(dom);
  });
  it('names the driver and degrades gracefully when the codec is unknown', () => {
    const err = decoderErrorToCapabilityMiss(new Error('boom'), 'webcodecs-video', undefined);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toContain('webcodecs-video');
    expect(err.message).toContain('this stream'); // graceful when no codec string is known
  });
});

describe('isVideoCodecString — the codec families this driver routes (RFC 6381 prefixes)', () => {
  it('matches the canonical strings the transcode planner builds, per codec', () => {
    // h264 (avc1/avc3), hevc (hvc1/hev1), vp8, vp9 (vp09), av1 (av01) — the full target set.
    for (const codec of [
      'avc1.42001f', // H.264 Constrained Baseline L3.1 (the planner default)
      'avc1.640028', // H.264 High L4.0
      'avc3.640028',
      'hvc1.1.6.L93.B0', // HEVC Main
      'hev1.1.6.L93.B0',
      'vp8',
      'vp09.00.10.08', // VP9 Profile 0 8-bit
      'av01.0.04M.08', // AV1 Main
    ]) {
      expect(isVideoCodecString(codec)).toBe(true);
    }
  });
  it('rejects non-video / audio codec strings', () => {
    for (const codec of ['opus', 'mp4a.40.2', 'mp3', 'flac', 'vorbis', 'theora', '']) {
      expect(isVideoCodecString(codec)).toBe(false);
    }
  });
  it('exposes every prefix exactly once (no duplicates) for the planner to agree on', () => {
    expect(new Set(VIDEO_CODEC_PREFIXES).size).toBe(VIDEO_CODEC_PREFIXES.length);
    expect([...VIDEO_CODEC_PREFIXES]).toEqual([
      'avc1',
      'avc3',
      'hvc1',
      'hev1',
      'vp8',
      'vp09',
      'av01',
    ]);
  });
});

describe('combineSupport — hardware-first, software-fallback probe combination (transcode coverage)', () => {
  it('probes hardware first, then software (the order matters for honest hardwareAccelerated)', () => {
    expect([...ACCELERATION_PROBE_ORDER]).toEqual(['prefer-hardware', 'no-preference']);
  });
  it('reports hardwareAccelerated when the hardware probe wins', () => {
    const probes: SupportProbe[] = [{ supported: true, acceleration: 'prefer-hardware' }];
    expect(combineSupport(probes)).toEqual({ supported: true, hardwareAccelerated: true });
  });
  it('recovers a software-only codec via the no-preference fallback (NOT accelerated)', () => {
    // The hardware probe said NO (e.g. VP9/AV1 with no hw encoder); the software probe said YES.
    const probes: SupportProbe[] = [
      { supported: false },
      { supported: true, acceleration: 'no-preference' },
    ];
    expect(combineSupport(probes)).toEqual({ supported: true, hardwareAccelerated: false });
  });
  it('reports unsupported (with a reason) when no probe supports it', () => {
    expect(combineSupport([{ supported: false }, { supported: false }], 'nope')).toEqual({
      supported: false,
      reason: 'nope',
    });
  });
  it('reports a bare unsupported when there is no reason', () => {
    expect(combineSupport([])).toEqual({ supported: false });
  });
  it('the first supporting probe wins even if a later one differs', () => {
    const probes: SupportProbe[] = [
      { supported: true, acceleration: 'prefer-hardware' },
      { supported: true, acceleration: 'no-preference' },
    ];
    expect(combineSupport(probes).hardwareAccelerated).toBe(true); // hardware win short-circuits
  });
});

describe('normalizeHardwareAcceleration — determinism maps to a WebCodecs acceleration hint', () => {
  it('defaults to no-preference (UA accelerates when it can, else a software coder — software codecs work)', () => {
    // NOT prefer-hardware: pinning hardware would fail to *configure* a software-only codec (VP8/VP9/AV1).
    expect(normalizeHardwareAcceleration(undefined)).toBe('no-preference');
    expect(normalizeHardwareAcceleration('auto')).toBe('no-preference');
  });

  it('force-software pins prefer-software for cross-machine reproducibility (ADR-007)', () => {
    expect(normalizeHardwareAcceleration('force-software')).toBe('prefer-software');
  });
});

describe('needsAppleH264HorizontalPhaseCompensation — odd chroma-crop geometry', () => {
  it('selects only H.264 widths congruent to 2 modulo 4 on Apple platforms', () => {
    expect(
      needsAppleH264HorizontalPhaseCompensation(
        { codec: 'avc1.64001F', width: 854, height: 480 },
        'MacIntel',
      ),
    ).toBe(true);
    expect(
      needsAppleH264HorizontalPhaseCompensation(
        { codec: 'avc3.4D401F', width: 638, height: 360 },
        'iPhone',
      ),
    ).toBe(true);
  });

  it('keeps aligned H.264, other codecs, and non-Apple platforms untouched', () => {
    expect(
      needsAppleH264HorizontalPhaseCompensation(
        { codec: 'avc1.64001F', width: 856, height: 480 },
        'MacIntel',
      ),
    ).toBe(false);
    expect(
      needsAppleH264HorizontalPhaseCompensation(
        { codec: 'vp09.00.10.08', width: 854, height: 480 },
        'MacIntel',
      ),
    ).toBe(false);
    expect(
      needsAppleH264HorizontalPhaseCompensation(
        { codec: 'avc1.64001F', width: 854, height: 480 },
        'Win32',
      ),
    ).toBe(false);
  });
});

describe('shouldKeyframe — GOP / keyframe-interval decision', () => {
  it('always forces a keyframe at frame 0 (a stream must open on a key frame)', () => {
    expect(shouldKeyframe(0, 30)).toBe(true);
    expect(shouldKeyframe(0, undefined)).toBe(true);
    expect(shouldKeyframe(0, 0)).toBe(true);
  });

  it('forces a keyframe every Nth frame for a positive interval', () => {
    expect(shouldKeyframe(30, 30)).toBe(true);
    expect(shouldKeyframe(60, 30)).toBe(true);
    expect(shouldKeyframe(1, 30)).toBe(false);
    expect(shouldKeyframe(29, 30)).toBe(false);
    expect(shouldKeyframe(31, 30)).toBe(false);
  });

  it('with interval 1, every frame is a keyframe (all-intra)', () => {
    for (let i = 0; i < 5; i++) expect(shouldKeyframe(i, 1)).toBe(true);
  });

  it('without a positive interval, only frame 0 is forced (encoder decides the rest)', () => {
    expect(shouldKeyframe(5, undefined)).toBe(false);
    expect(shouldKeyframe(5, 0)).toBe(false);
    expect(shouldKeyframe(5, -10)).toBe(false);
  });

  it('rejects a non-integer / negative frame index (a programming error, not silent)', () => {
    expect(() => shouldKeyframe(-1, 30)).toThrow(RangeError);
    expect(() => shouldKeyframe(1.5, 30)).toThrow(RangeError);
  });
});

describe('videoEncodeOptions — keyframe plus codec-specific quantizer options', () => {
  it('emits only a keyFrame flag when CRF/quantizer mode is not requested', () => {
    expect(videoEncodeOptions(0, 30, 'avc1.42E01E', undefined)).toEqual({ keyFrame: true });
    expect(videoEncodeOptions(1, 30, 'avc1.42E01E', undefined)).toEqual({ keyFrame: false });
  });

  it('maps a constant quantizer onto the WebCodecs codec-specific option object', () => {
    expect(videoEncodeOptions(0, 30, 'avc1.42E01E', 23)).toEqual({
      keyFrame: true,
      avc: { quantizer: 23 },
    });
    expect(videoEncodeOptions(1, 30, 'hvc1.1.6.L93.B0', 24)).toEqual({
      keyFrame: false,
      hevc: { quantizer: 24 },
    });
    expect(videoEncodeOptions(2, 30, 'vp09.00.10.08', 31)).toEqual({
      keyFrame: false,
      vp9: { quantizer: 31 },
    });
    expect(videoEncodeOptions(3, 30, 'av01.0.04M.08', 32)).toEqual({
      keyFrame: false,
      av1: { quantizer: 32 },
    });
  });

  it('rejects invalid quantizer requests before a frame is submitted', () => {
    expect(() => videoEncodeOptions(0, 30, 'vp8', 12)).toThrow(CapabilityError);
    expect(() => videoEncodeOptions(0, 30, 'avc1.42E01E', Number.NaN)).toThrow(RangeError);
  });
});

describe('rateControlWarmupTimestamps — disposable encoder preroll timeline', () => {
  it('places every preroll picture strictly before a positive or negative first PTS', () => {
    expect(rateControlWarmupTimestamps(1_000_000, 40_000, 25, 3)).toEqual([
      880_000, 920_000, 960_000,
    ]);
    expect(rateControlWarmupTimestamps(-50_000, null, 50, 2)).toEqual([-90_000, -70_000]);
  });

  it('uses a stable cadence fallback and declines unsafe timestamp arithmetic', () => {
    expect(rateControlWarmupTimestamps(100_000, null, undefined, 2)).toEqual([33_334, 66_667]);
    expect(rateControlWarmupTimestamps(100_000, 0, 50, 2)).toEqual([60_000, 80_000]);
    expect(rateControlWarmupTimestamps(100_000, Number.NaN, Number.POSITIVE_INFINITY, 2)).toEqual([
      33_334, 66_667,
    ]);
    expect(rateControlWarmupTimestamps(100_000, null, 2_000_000, 2)).toEqual([99_998, 99_999]);
    expect(rateControlWarmupTimestamps(Number.NaN, 40_000, 25, 3)).toEqual([]);
    expect(rateControlWarmupTimestamps(Number.MIN_SAFE_INTEGER, 40_000, 25, 3)).toEqual([]);
  });

  it('treats an explicit zero warmup as a no-op', () => {
    expect(rateControlWarmupTimestamps(100_000, 40_000, 25, 0)).toEqual([]);
  });

  it('rejects invalid counts instead of constructing an unbounded preroll', () => {
    expect(() => rateControlWarmupTimestamps(0, 40_000, 25, -1)).toThrow(RangeError);
    expect(() => rateControlWarmupTimestamps(0, 40_000, 25, 17)).toThrow(RangeError);
    expect(() => rateControlWarmupTimestamps(0, 40_000, 25, 1.5)).toThrow(RangeError);
  });
});

describe('queueIsBackpressured — decode/encode queue threshold', () => {
  it('is backpressured at or above the high-water mark', () => {
    expect(queueIsBackpressured(8, 8)).toBe(true);
    expect(queueIsBackpressured(9, 8)).toBe(true);
  });

  it('is not backpressured below the high-water mark', () => {
    expect(queueIsBackpressured(0, 8)).toBe(false);
    expect(queueIsBackpressured(7, 8)).toBe(false);
  });

  it('rejects a non-positive high-water mark (would stall forever)', () => {
    expect(() => queueIsBackpressured(1, 0)).toThrow(RangeError);
    expect(() => queueIsBackpressured(1, -1)).toThrow(RangeError);
  });
});

describe('PendingOutputBackpressure — bounded encoder output accounting', () => {
  it('waits at the exact bound and wakes when one output completes', async () => {
    const gate = new PendingOutputBackpressure(2);
    gate.submitted();
    gate.submitted();
    let released = false;
    const waiting = gate.waitForRoom(undefined).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(gate.pending).toBe(2);

    gate.completed();
    await waiting;
    expect(released).toBe(true);
    expect(gate.pending).toBe(1);
  });

  it('accounts for synchronous encode failure without underflowing', async () => {
    const gate = new PendingOutputBackpressure(1);
    gate.submitted();
    gate.completed();
    gate.completed();
    expect(gate.pending).toBe(0);
    await expect(gate.waitForRoom(undefined)).resolves.toBeUndefined();
  });

  it('rejects a blocked writer on abort and removes its waiter', async () => {
    const gate = new PendingOutputBackpressure(1);
    const abort = new AbortController();
    gate.submitted();
    const waiting = gate.waitForRoom(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    gate.completed();
    await expect(gate.waitForRoom(undefined)).resolves.toBeUndefined();
  });

  it('propagates a terminal encoder error to current and future submissions', async () => {
    const gate = new PendingOutputBackpressure(1);
    const error = new Error('native encoder failed');
    gate.submitted();
    const waiting = gate.waitForRoom(undefined);
    gate.fail(error);
    await expect(waiting).rejects.toBe(error);
    expect(() => gate.submitted()).toThrow(error);
    await expect(gate.waitForRoom(undefined)).rejects.toBe(error);
  });

  it('rejects a non-positive bound', () => {
    expect(() => new PendingOutputBackpressure(0)).toThrow(RangeError);
    expect(() => new PendingOutputBackpressure(-1)).toThrow(RangeError);
  });
});

describe('reorderByTimestamp / isPresentationOrdered — defensive, NOT on the live path', () => {
  // The live decoder relies on the WebCodecs guarantee that VideoDecoder emits in presentation order
  // (W3C WebCodecs: "decoded video data outputs emitted … in presentation order"), so it never sorts.
  // These pure helpers exist for tests/tools that must assert or impose ordering on a captured stream.
  it('sorts ascending by timestamp, stably (a pure copy; does not mutate the input)', () => {
    const input = [
      { timestamp: 3000 },
      { timestamp: 1000 },
      { timestamp: 2000 },
      { timestamp: 1000, tag: 'a' },
    ];
    const out = reorderByTimestamp(input);
    expect(out.map((f) => f.timestamp)).toEqual([1000, 1000, 2000, 3000]);
    // stable: equal timestamps keep input order (1000 before 1000-with-tag)
    expect(out[0]).toBe(input[1]);
    expect(out[1]).toBe(input[3]);
    expect(input.map((f) => f.timestamp)).toEqual([3000, 1000, 2000, 1000]); // input untouched
  });

  it('treats an empty / single-element sequence as already ordered', () => {
    expect(reorderByTimestamp([])).toEqual([]);
    expect(isPresentationOrdered([])).toBe(true);
    expect(isPresentationOrdered([{ timestamp: 42 }])).toBe(true);
  });

  it('detects presentation order (non-decreasing timestamps)', () => {
    expect(isPresentationOrdered([{ timestamp: 0 }, { timestamp: 0 }, { timestamp: 1 }])).toBe(
      true,
    );
    expect(isPresentationOrdered([{ timestamp: 0 }, { timestamp: 2 }, { timestamp: 1 }])).toBe(
      false,
    );
  });
});

describe('WebcodecsVideoDriver — identity & contract surface', () => {
  it('declares the codec driver identity (hardware tier, current apiVersion)', () => {
    expect(WebcodecsVideoDriver.id).toBe('webcodecs-video');
    expect(WebcodecsVideoDriver.kind).toBe('codec');
    expect(WebcodecsVideoDriver.tier).toBe('hardware');
    expect(WebcodecsVideoDriver.apiVersion).toBe(1);
  });

  it('the DriverModule registers exactly this codec driver (and nothing else)', () => {
    const added: string[] = [];
    WebcodecsVideoModule.register({
      addCodec: (d) => {
        added.push(d.id);
        expect(d).toBe(WebcodecsVideoDriver);
      },
      addContainer: () => {
        throw new Error('must not register a container');
      },
      addFilter: () => {
        throw new Error('must not register a filter');
      },
    });
    expect(added).toEqual(['webcodecs-video']);
    expect(WebcodecsVideoModule.apiVersion).toBe(1);
  });
});

describe('WebcodecsVideoDriver.supports — honest under absent WebCodecs (Node reality)', () => {
  // In Node, VideoDecoder/VideoEncoder are undefined. supports() must answer false, never throw
  // (the router walks the ladder calling supports() on every candidate — a throw would abort it).
  it('returns {supported:false} for video decode when WebCodecs is absent', async () => {
    expect(typeof VideoDecoder).toBe('undefined'); // precondition: the Node reality these tests assert
    const s = await WebcodecsVideoDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toBeDefined();
  });

  it('returns {supported:false} for video encode when WebCodecs is absent', async () => {
    const s = await WebcodecsVideoDriver.supports({
      mediaType: 'video',
      direction: 'encode',
      config: { codec: 'avc1.640028', width: 1920, height: 1080 },
    });
    expect(s.supported).toBe(false);
  });

  it('returns a deterministic miss for video-shaped codec strings this driver does not route', async () => {
    const decode = await WebcodecsVideoDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'theora', codedWidth: 16, codedHeight: 16 },
    });
    expect(decode).toEqual({
      supported: false,
      reason: "unsupported video codec string 'theora'",
    });

    const encode = await WebcodecsVideoDriver.supports({
      mediaType: 'video',
      direction: 'encode',
      config: { codec: 'ap4h', width: 16, height: 16 },
    });
    expect(encode).toEqual({
      supported: false,
      reason: "unsupported video codec string 'ap4h'",
    });
  });

  it('returns {supported:false} (never throws) for an audio query — this is the VIDEO driver', async () => {
    const s = await WebcodecsVideoDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    });
    expect(s.supported).toBe(false);
  });

  it('never throws even on a garbage config (router-walk safety)', async () => {
    await expect(
      WebcodecsVideoDriver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: '' },
      }),
    ).resolves.toEqual(expect.objectContaining({ supported: false }));
  });
});

describe('WebcodecsVideoDriver coder factories — typed miss when WebCodecs is absent', () => {
  it('createDecoder throws CapabilityError (capability-miss) in Node', () => {
    expect(() =>
      WebcodecsVideoDriver.createDecoder({ codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 }),
    ).toThrow(CapabilityError);
  });

  it('createEncoder throws CapabilityError (capability-miss) in Node', () => {
    expect(() =>
      WebcodecsVideoDriver.createEncoder({ codec: 'avc1.640028', width: 16, height: 16 }),
    ).toThrow(CapabilityError);
  });

  it('the CapabilityError names the op and that nothing was tried', () => {
    try {
      WebcodecsVideoDriver.createDecoder({ codec: 'vp8', codedWidth: 16, codedHeight: 16 });
      expect.unreachable('createDecoder must throw when WebCodecs is absent');
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityError);
      expect((e as CapabilityError).code).toBe('capability-miss');
    }
  });

  it('throws a typed capability miss for unsupported video codec strings before touching WebCodecs', () => {
    expect(() =>
      WebcodecsVideoDriver.createDecoder({ codec: 'theora', codedWidth: 16, codedHeight: 16 }),
    ).toThrow(CapabilityError);
    expect(() =>
      WebcodecsVideoDriver.createEncoder({ codec: 'ap4h', width: 16, height: 16 }),
    ).toThrow(CapabilityError);
  });
});

// ── warm VideoDecoder pool (reuse / discard / frame-lifetime state machine, Node-driven with a fake) ──
// WebCodecs is absent in Node and must never be mocked; instead a fake WarmDecoderHandle (NOT a fake
// VideoDecoder) is injected through the pool's factory seam, so the reuse-vs-rebuild, concurrent-refusal,
// discard-on-error, and close-exactly-once logic is exercised as real code. The real handle's
// build+configure is browser-harness-validated (v8-ignored). Every frame is a Closable that counts closes.

/** A fake decoded frame: a Closable with a PTS, recording close-exactly-once. */
class PoolFakeFrame {
  closeCount = 0;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closeCount++;
  }
}

/** A fake encoded chunk (only its `timestamp` and keyframe-ish `type` are read by the fake). */
class PoolFakeChunk {
  constructor(
    readonly timestamp: number,
    readonly type: 'key' | 'delta' = 'key',
  ) {}
}

interface FakePoolState {
  builds: number;
  closes: number;
  readonly frames: PoolFakeFrame[];
  /** When a chunk with this PTS is decoded, the fake raises a native decoder error instead of a frame. */
  failAt: number | undefined;
}

/**
 * A {@link WarmDecoderFactory} that builds a fake handle: `decode` produces a frame (async, mirroring a
 * real decoder's `output` callback) unless the chunk's PTS matches `failAt`, in which case it raises a
 * native error; `flush` drains pending frames; `close` counts. It never touches WebCodecs, so the pool's
 * whole state machine runs in Node.
 */
function fakeWarmFactory(state: FakePoolState): WarmDecoderFactory {
  return () => {
    state.builds++;
    let sink: WarmDecoderSink | undefined;
    let closed = false;
    const pending: PoolFakeFrame[] = [];
    const emit = (): void => {
      for (let frame = pending.shift(); frame !== undefined; frame = pending.shift()) {
        if (sink !== undefined) sink.onFrame(frame as unknown as VideoFrame);
        else frame.close();
      }
    };
    const handle: WarmDecoderHandle = {
      bind: (s): void => {
        sink = s;
      },
      decode: (chunk): void => {
        const ts = (chunk as unknown as PoolFakeChunk).timestamp;
        if (state.failAt !== undefined && ts === state.failAt) {
          sink?.onError(new DOMException('Decoder failure', 'EncodingError'));
          return;
        }
        const frame = new PoolFakeFrame(ts);
        state.frames.push(frame);
        pending.push(frame);
        queueMicrotask(emit);
      },
      flush: (): Promise<void> => {
        emit();
        return Promise.resolve();
      },
      get decodeQueueSize(): number {
        return 0;
      },
      awaitDequeue: (): Promise<void> => Promise.resolve(),
      close: (): void => {
        if (closed) return;
        closed = true;
        state.closes++;
      },
      get closed(): boolean {
        return closed;
      },
    };
    return Promise.resolve(handle);
  };
}

/** Drive a borrow like `seekFrame`: drop frames before `targetUs` (closing them), return the first at/after. */
async function runFakeSeek(
  stream: TransformStream<EncodedChunk, RawFrame> | undefined,
  chunks: readonly PoolFakeChunk[],
  targetUs: number,
): Promise<PoolFakeFrame> {
  if (stream === undefined) throw new Error('expected a pooled decoder transform stream');
  const source = new ReadableStream<EncodedChunk>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk as unknown as EncodedChunk);
      controller.close();
    },
  });
  const out = source.pipeThrough(stream) as unknown as ReadableStream<PoolFakeFrame>;
  const reader = out.getReader();
  let last: PoolFakeFrame | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.timestamp >= targetUs) {
        if (last !== undefined) last.close();
        await reader.cancel(); // clean early stop → the pool drains + keeps the decoder warm
        return value;
      }
      if (last !== undefined) last.close();
      last = value;
    }
  } finally {
    reader.releaseLock();
  }
  if (last !== undefined) return last; // sought past the last PTS → closest available
  throw new Error('no frame decoded');
}

const POOL_H264: VideoDecoderConfig = { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64 };

describe('createWarmVideoDecoderPool — reuse a configured decoder across sequential same-config seeks', () => {
  it('builds ONE decoder and reuses it across many same-config seeks (warm, never closed between them)', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    for (let i = 0; i < 4; i++) {
      const frame = await runFakeSeek(
        pool.borrow(POOL_H264, undefined),
        [new PoolFakeChunk(0), new PoolFakeChunk(1000, 'delta')],
        0,
      );
      expect(frame.timestamp).toBe(0);
      expect(frame.closeCount).toBe(0); // the target frame is the caller's; the pool never closed it
      frame.close();
    }
    expect(state.builds).toBe(1); // constructed + configured exactly once, then reused
    expect(state.closes).toBe(0); // kept warm across every seek (the whole optimization)
    for (const frame of state.frames) expect(frame.closeCount).toBe(1); // every frame closed exactly once
  });

  it('returns the closest frame when seeking past the last PTS and still keeps the decoder warm (EOF drain)', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    const frame = await runFakeSeek(
      pool.borrow(POOL_H264, undefined),
      [new PoolFakeChunk(0), new PoolFakeChunk(1000, 'delta')],
      9_999_999,
    );
    expect(frame.timestamp).toBe(1000); // closest available (last decoded)
    expect(frame.closeCount).toBe(0);
    frame.close();
    // reuse after a clean EOF drain
    const next = await runFakeSeek(pool.borrow(POOL_H264, undefined), [new PoolFakeChunk(0)], 0);
    next.close();
    expect(state.builds).toBe(1);
    expect(state.closes).toBe(0);
    for (const f of state.frames) expect(f.closeCount).toBe(1);
  });

  it('reuses one decoder across a seeded sequence of forward, backward, repeated, and boundary targets', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    const timestamps = [0, 1_000, 2_500, 9_000] as const;
    const targets = [-1_000, 0, 2_500, 2_500, 9_001, 0, 9_000, 1_001];
    let randomState = 0x51ee7a11;
    for (let index = 0; index < 64; index++) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      targets.push(((randomState >>> 0) % 12_001) - 1_000);
    }

    for (const target of targets) {
      const frame = await runFakeSeek(
        pool.borrow(POOL_H264, undefined),
        timestamps.map(
          (timestamp, index) => new PoolFakeChunk(timestamp, index === 0 ? 'key' : 'delta'),
        ),
        target,
      );
      const expected = timestamps.find((timestamp) => timestamp >= target) ?? timestamps.at(-1);
      expect(frame.timestamp).toBe(expected);
      frame.close();
    }

    expect(state.builds).toBe(1);
    expect(state.closes).toBe(0);
    for (const frame of state.frames) expect(frame.closeCount).toBe(1);
    pool.dispose();
    expect(state.closes).toBe(1);
  });

  it('closes the old decoder and builds a new one when the config changes (config-keyed)', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    (await runFakeSeek(pool.borrow(POOL_H264, undefined), [new PoolFakeChunk(0)], 0)).close();
    const other: VideoDecoderConfig = { codec: 'vp09.00.10.08', codedWidth: 32, codedHeight: 32 };
    (await runFakeSeek(pool.borrow(other, undefined), [new PoolFakeChunk(0)], 0)).close();
    expect(state.builds).toBe(2); // the changed config forced a rebuild
    expect(state.closes).toBe(1); // the previous warm decoder was closed on the config change
  });

  it('refuses a concurrent borrow (one decoder never serves two streams) — the caller falls back to fresh', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    const first = pool.borrow(POOL_H264, undefined);
    const second = pool.borrow(POOL_H264, undefined); // a borrow is already active
    expect(first).toBeDefined();
    expect(second).toBeUndefined(); // busy → undefined, so the seek path uses a fresh decoder
    (await runFakeSeek(first, [new PoolFakeChunk(0)], 0)).close();
    // once released, the pool serves again (reusing the same warm decoder)
    expect(pool.borrow(POOL_H264, undefined)).toBeDefined();
  });

  it('discards (closes) the decoder on a decode error, then rebuilds on the next borrow', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: 0 };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    await expect(
      runFakeSeek(pool.borrow(POOL_H264, undefined), [new PoolFakeChunk(0)], 0),
    ).rejects.toBeInstanceOf(CapabilityError); // native decoder failure → typed capability miss
    expect(state.builds).toBe(1);
    expect(state.closes).toBe(1); // the errored decoder is dropped, not reused
    state.failAt = undefined;
    const frame = await runFakeSeek(pool.borrow(POOL_H264, undefined), [new PoolFakeChunk(0)], 0);
    frame.close();
    expect(state.builds).toBe(2); // rebuilt after the discard
  });

  it('dispose closes the warm decoder and refuses further borrows', async () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    (await runFakeSeek(pool.borrow(POOL_H264, undefined), [new PoolFakeChunk(0)], 0)).close();
    expect(state.closes).toBe(0); // warm
    pool.dispose();
    expect(state.closes).toBe(1); // disposed → the warm decoder is closed
    expect(pool.borrow(POOL_H264, undefined)).toBeUndefined(); // and no further borrows are served
  });

  it('returns undefined (no build) for audio / non-video-codec configs — the caller uses a fresh path', () => {
    const state: FakePoolState = { builds: 0, closes: 0, frames: [], failAt: undefined };
    const pool = createWarmVideoDecoderPool(fakeWarmFactory(state));
    expect(
      pool.borrow({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }, undefined),
    ).toBeUndefined(); // not a video decoder config
    expect(
      pool.borrow({ codec: 'theora', codedWidth: 16, codedHeight: 16 }, undefined),
    ).toBeUndefined(); // not a codec this driver routes
    expect(state.builds).toBe(0);
  });
});
