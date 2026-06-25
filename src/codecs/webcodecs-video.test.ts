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
import { CapabilityError } from '../contracts/errors.ts';
import WebcodecsVideoModule, {
  ACCELERATION_PROBE_ORDER,
  type EnqueueSink,
  type SupportProbe,
  VIDEO_CODEC_PREFIXES,
  WebcodecsVideoDriver,
  combineSupport,
  decoderErrorToCapabilityMiss,
  enqueueOrClose,
  enqueueOrDrop,
  isVideoCodecString,
  isPresentationOrdered,
  normalizeHardwareAcceleration,
  queueIsBackpressured,
  reorderByTimestamp,
  shouldKeyframe,
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
    expect(err.detail).toMatchObject({ op: 'decode', tried: ['webcodecs-video'] });
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
});
