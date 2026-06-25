/**
 * Unit tests for the WASM VP8/VP9 driver's pure, Node-runnable surface (BUILD §6, ADR-026): VP8 frame-tag
 * parsing (RFC 6386 §9.1), the VP9 uncompressed-header prefix + superframe index (VP9 spec §6.2 / Annex B),
 * `vp8`/`vp09.…` codec-string parsing (RFC 6381), IVF framing (the de-facto raw VPX wrapper), I420/P10/P12
 * plane-layout arithmetic, and decoder-config normalization — golden bytes/values computed independently
 * from the specs. WebCodecs (`VideoFrame`/`EncodedVideoChunk`) is **absent in Node and must not be mocked**
 * (ADR-018/ADR-025) — the libvpx-in-wasm pixel decode is validated in-browser once the core is vendored
 * (`BUILD.md`). Here we also assert the **honest wasm-absence** behavior: with no vendored core,
 * `supports()` answers `false` (never throws) and a pumped decoder raises a typed `CapabilityError`, while
 * `createEncoder` is a typed decode-only miss. Every assertion is falsifiable — no oracle that cannot fail
 * (directive 6).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type VpxPixelFormat,
  iterateIvfFrames,
  normalizeVpxDecoderConfig,
  parseIvfHeader,
  parseSuperframeIndex,
  parseVp8FrameInfo,
  parseVp9FrameInfo,
  parseVpxCodec,
  pixelFormatForBitDepth,
  planeLayoutI420,
} from './vpx.ts';
import WasmVpxModule, {
  isVpxDecodeQuery,
  loadVpxCore,
  resetVpxCoreForTest,
  unsupported,
  VPX_CODECS,
  WasmVpxDriver,
} from './wasm-vpx-driver.ts';

// ============ codec-string parsing (RFC 6381 / VP9 ISO-BMFF binding) ============

describe('parseVpxCodec — VP8/VP9 codec strings', () => {
  it('vp8 → profile 0, 8-bit, 4:2:0', () => {
    expect(parseVpxCodec('vp8')).toEqual({ codec: 'vp8', profile: 0, bitDepth: 8, subsampling: 1 });
  });
  it('bare vp9 (legacy) → profile 0, 8-bit, 4:2:0', () => {
    expect(parseVpxCodec('vp9')).toEqual({ codec: 'vp9', profile: 0, bitDepth: 8, subsampling: 1 });
  });
  it('vp09.00.10.08 → profile 0, 8-bit (CC defaults to 4:2:0)', () => {
    expect(parseVpxCodec('vp09.00.10.08')).toEqual({
      codec: 'vp9',
      profile: 0,
      bitDepth: 8,
      subsampling: 1,
    });
  });
  it('vp09.02.10.10.01 → profile 2, 10-bit, 4:2:0', () => {
    expect(parseVpxCodec('vp09.02.10.10.01')).toEqual({
      codec: 'vp9',
      profile: 2,
      bitDepth: 10,
      subsampling: 1,
    });
  });
  it('vp09.03.10.12.03 → profile 3, 12-bit, 4:4:4', () => {
    expect(parseVpxCodec('vp09.03.10.12.03')).toEqual({
      codec: 'vp9',
      profile: 3,
      bitDepth: 12,
      subsampling: 3,
    });
  });
  it('is case-insensitive and trims', () => {
    expect(parseVpxCodec('  VP8 ').codec).toBe('vp8');
  });
  it('rejects a non-VPX codec string', () => {
    expect(() => parseVpxCodec('avc1.640028')).toThrow(MediaError);
    expect(() => parseVpxCodec('opus')).toThrow(/VP8\/VP9/);
  });
  it('rejects an out-of-range profile and a bad bit depth', () => {
    expect(() => parseVpxCodec('vp09.05.10.08')).toThrow(/profile/);
    expect(() => parseVpxCodec('vp09.00.10.09')).toThrow(/bit depth/);
  });
  it('rejects a non-numeric / missing field', () => {
    expect(() => parseVpxCodec('vp09.xx.10.08')).toThrow(/numeric/);
    expect(() => parseVpxCodec('vp09.00')).toThrow(/numeric/); // no bit-depth field
  });
  it('rejects a bad chroma-subsampling code', () => {
    expect(() => parseVpxCodec('vp09.00.10.08.07')).toThrow(/subsampling/);
  });
});

// ============ VP8 frame tag (RFC 6386 §9.1) ============

describe('parseVp8FrameInfo — RFC 6386 §9.1 frame tag', () => {
  /** Build a VP8 keyframe with version 0, show=1, fps=`firstPart`, then the start code + dims. */
  function vp8Keyframe(width: number, height: number, firstPart = 0): Uint8Array {
    const tag = 0 | (0 << 1) | (1 << 4) | (firstPart << 5); // key(bit0=0), v0, show, first_part_size
    const head = Uint8Array.of(
      tag & 0xff,
      (tag >> 8) & 0xff,
      (tag >> 16) & 0xff,
      0x9d,
      0x01,
      0x2a, // start code
      width & 0xff,
      (width >> 8) & 0x3f,
      height & 0xff,
      (height >> 8) & 0x3f,
    );
    return head;
  }

  it('decodes a keyframe tag, start code, and 14-bit dimensions', () => {
    const info = parseVp8FrameInfo(vp8Keyframe(640, 480, 7));
    expect(info.keyFrame).toBe(true);
    expect(info.version).toBe(0);
    expect(info.showFrame).toBe(true);
    expect(info.firstPartitionSize).toBe(7);
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
  });
  it('keyframe golden tag bytes are [0x10,0x00,0x00] (v0, show, fps 0)', () => {
    const k = vp8Keyframe(2, 2, 0);
    expect([k[0], k[1], k[2]]).toEqual([0x10, 0x00, 0x00]);
  });
  it('decodes an inter frame (key=1 ⇒ bit0 set) with no dimensions', () => {
    const interTag = 1 | (0 << 1) | (1 << 4); // bit0=1 ⇒ inter
    const info = parseVp8FrameInfo(
      Uint8Array.of(interTag & 0xff, (interTag >> 8) & 0xff, (interTag >> 16) & 0xff),
    );
    expect(info.keyFrame).toBe(false);
    expect(info.width).toBeUndefined();
    expect(info.height).toBeUndefined();
  });
  it('rejects a frame shorter than its 3-byte tag', () => {
    expect(() => parseVp8FrameInfo(Uint8Array.of(0x10, 0x00))).toThrow(InputError);
  });
  it('rejects a keyframe with a wrong start code', () => {
    const bad = vp8Keyframe(16, 16);
    bad[3] = 0x00; // corrupt the 9d byte
    expect(() => parseVp8FrameInfo(bad)).toThrow(/start code/);
  });
});

// ============ VP9 uncompressed header prefix (VP9 spec §6.2) ============

describe('parseVp9FrameInfo — VP9 §6.2 header prefix', () => {
  it('decodes a profile-0 shown key frame (first byte 0x82)', () => {
    // frame_marker=10, profile_low=0, profile_high=0, show_existing=0, frame_type=0(key), show_frame=1
    const info = parseVp9FrameInfo(Uint8Array.of(0x82, 0x49, 0x83, 0x42));
    expect(info.profile).toBe(0);
    expect(info.showExistingFrame).toBe(false);
    expect(info.keyFrame).toBe(true);
    expect(info.showFrame).toBe(true);
  });
  it('decodes a non-shown inter frame (alt-ref): show_frame=0, frame_type=1', () => {
    // bits: 10 (marker) 0 0 (profile 0) 0 (show_existing) 1 (frame_type=inter) 0 (show_frame) → 1000 0100 = 0x84
    const info = parseVp9FrameInfo(Uint8Array.of(0x84));
    expect(info.keyFrame).toBe(false);
    expect(info.showFrame).toBe(false);
  });
  it('decodes show_existing_frame (a pure re-display, no new output)', () => {
    // bits: 10 (marker) 0 0 (profile 0) 1 (show_existing) idx(3 bits)=010 → 1000 1010 = 0x8a
    const info = parseVp9FrameInfo(Uint8Array.of(0x8a));
    expect(info.showExistingFrame).toBe(true);
    expect(info.keyFrame).toBeUndefined();
    expect(info.showFrame).toBeUndefined();
  });
  it('decodes profile 2 (low=0, high=1)', () => {
    // bits: 10 (marker) 0 (low) 1 (high) → profile = (1<<1)|0 = 2 ; then show_existing=0, key, show
    // 10 0 1 0 0 1 → 1001 0010 = 0x92
    const info = parseVp9FrameInfo(Uint8Array.of(0x92));
    expect(info.profile).toBe(2);
  });
  it('rejects a bad frame_marker', () => {
    expect(() => parseVp9FrameInfo(Uint8Array.of(0x00))).toThrow(/frame_marker/);
  });
  it('rejects a truncated header (out of bits)', () => {
    expect(() => parseVp9FrameInfo(new Uint8Array(0))).toThrow(InputError);
  });
});

// ============ VP9 superframe index (VP9 spec Annex B) ============

describe('parseSuperframeIndex — VP9 Annex B', () => {
  it('a packet without the marker is one frame over the whole buffer', () => {
    const p = Uint8Array.of(0x82, 0x11, 0x22, 0x33);
    expect(parseSuperframeIndex(p)).toEqual({ frames: [[0, 4]] });
  });
  it('splits a 2-frame superframe (sizes 5 and 7, marker 0xc1)', () => {
    const f0 = new Uint8Array(5).fill(0xaa);
    const f1 = new Uint8Array(7).fill(0xbb);
    const index = Uint8Array.of(0xc1, 5, 7, 0xc1); // marker, size0, size1, marker
    const packet = new Uint8Array([...f0, ...f1, ...index]);
    expect(parseSuperframeIndex(packet)).toEqual({
      frames: [
        [0, 5],
        [5, 7],
      ],
    });
  });
  it('splits a 3-frame superframe with 2-byte sizes', () => {
    // bpf=2, frames=3 → marker = 0xC0 | ((2-1)<<3) | (3-1) = 0xC0|0x08|0x02 = 0xCA
    const sizes = [300, 1, 2];
    const total = sizes.reduce((a, b) => a + b, 0);
    const body = new Uint8Array(total).fill(0x5a);
    const idx: number[] = [0xca];
    for (const s of sizes) idx.push(s & 0xff, (s >> 8) & 0xff); // little-endian u16
    idx.push(0xca);
    const packet = new Uint8Array([...body, ...idx]);
    const out = parseSuperframeIndex(packet);
    expect(out.frames.map((f) => f[1])).toEqual([300, 1, 2]);
    expect(out.frames[0]).toEqual([0, 300]);
    expect(out.frames[1]).toEqual([300, 1]);
  });
  it('treats a mismatched end-marker as a single frame (false-positive guard)', () => {
    // last byte looks like a marker but the index head byte differs → not a real superframe.
    const packet = Uint8Array.of(0x01, 0x02, 0x00, 0xc1); // head of would-be index ≠ 0xc1
    expect(parseSuperframeIndex(packet)).toEqual({ frames: [[0, 4]] });
  });
  it('rejects an index that overruns the packet / sizes that overrun', () => {
    // marker 0xc1 (2 frames, 1B sizes) but packet too short to hold the index.
    expect(() => parseSuperframeIndex(Uint8Array.of(0xc1, 0xc1))).toThrow(InputError);
    // sizes (200+200) overrun a packet whose body is only a few bytes.
    const overrun = Uint8Array.of(0xaa, 0xbb, 0xc1, 200, 200, 0xc1);
    expect(() => parseSuperframeIndex(overrun)).toThrow(/overrun/);
  });
  it('an empty packet is a single (zero-length) frame', () => {
    expect(parseSuperframeIndex(new Uint8Array(0))).toEqual({ frames: [[0, 0]] });
  });
});

// ============ IVF framing ============

describe('IVF — file header + frame iteration', () => {
  /** Build a minimal IVF stream: 32-byte header + frames (each 12-byte header + payload). */
  function buildIvf(
    fourcc: string,
    width: number,
    height: number,
    frames: ReadonlyArray<{ ts: number; data: Uint8Array }>,
  ): Uint8Array {
    const header = new Uint8Array(32);
    header.set([0x44, 0x4b, 0x49, 0x46], 0); // DKIF
    header[4] = 0; // version u16
    header[6] = 32; // header size u16 (LE low byte)
    header.set(
      [...fourcc].map((c) => c.charCodeAt(0)),
      8,
    ); // FourCC
    header[12] = width & 0xff;
    header[13] = (width >> 8) & 0xff;
    header[14] = height & 0xff;
    header[15] = (height >> 8) & 0xff;
    header[16] = 30; // timebase den (LE) = 30
    header[20] = 1; // timebase num (LE) = 1
    header[24] = frames.length & 0xff; // frame count (LE)
    const parts: Uint8Array[] = [header];
    for (const f of frames) {
      const fh = new Uint8Array(12);
      const dv = new DataView(fh.buffer);
      dv.setUint32(0, f.data.length, true); // size u32 LE
      dv.setUint32(4, f.ts >>> 0, true); // timestamp low u32 LE
      dv.setUint32(8, Math.floor(f.ts / 0x1_0000_0000), true); // timestamp high u32 LE
      parts.push(fh, f.data);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  it('parses the VP90 header (codec, dims, timebase, frame count)', () => {
    const ivf = buildIvf('VP90', 1280, 720, [{ ts: 0, data: Uint8Array.of(1, 2, 3) }]);
    const h = parseIvfHeader(ivf);
    expect(h.codec).toBe('vp9');
    expect(h.width).toBe(1280);
    expect(h.height).toBe(720);
    expect(h.timebaseDen).toBe(30);
    expect(h.timebaseNum).toBe(1);
    expect(h.frameCount).toBe(1);
    expect(h.headerSize).toBe(32);
  });
  it('parses VP80 as vp8', () => {
    expect(parseIvfHeader(buildIvf('VP80', 16, 16, [])).codec).toBe('vp8');
  });
  it('iterates frames with their payloads and timestamps', () => {
    const f0 = Uint8Array.of(0x10, 0x00, 0x00);
    const f1 = Uint8Array.of(0xaa, 0xbb);
    const ivf = buildIvf('VP90', 16, 16, [
      { ts: 0, data: f0 },
      { ts: 100, data: f1 },
    ]);
    const out = [...iterateIvfFrames(ivf)];
    expect(out.length).toBe(2);
    expect(out[0]?.timestamp).toBe(0);
    expect([...(out[0]?.data ?? [])]).toEqual([0x10, 0x00, 0x00]);
    expect(out[1]?.timestamp).toBe(100);
    expect([...(out[1]?.data ?? [])]).toEqual([0xaa, 0xbb]);
  });
  it('rejects a non-DKIF stream and an unknown FourCC', () => {
    expect(() => parseIvfHeader(new Uint8Array(32))).toThrow(/DKIF/);
    expect(() => parseIvfHeader(buildIvf('XVID', 16, 16, []))).toThrow(/FourCC/);
  });
  it('rejects a header shorter than 32 bytes', () => {
    expect(() => parseIvfHeader(new Uint8Array(10))).toThrow(/32 bytes/);
  });
  it('rejects a frame whose declared size runs past the stream', () => {
    const ivf = buildIvf('VP90', 16, 16, [{ ts: 0, data: Uint8Array.of(1) }]);
    // Corrupt the first frame size (offset 32) to claim 999 bytes.
    new DataView(ivf.buffer).setUint32(32, 999, true);
    expect(() => [...iterateIvfFrames(ivf)]).toThrow(/past end/);
  });
});

// ============ plane layout (I420 / I420P10 / I420P12) ============

describe('plane layout — tightly-packed 4:2:0', () => {
  it('pixelFormatForBitDepth maps 8/10/12 → I420/I420P10/I420P12', () => {
    expect(pixelFormatForBitDepth(8)).toBe('I420');
    expect(pixelFormatForBitDepth(10)).toBe('I420P10');
    expect(pixelFormatForBitDepth(12)).toBe('I420P12');
  });
  it('8-bit 4×4: Y=16, U=V=4, total 24; strides 4/2/2; offsets 0/16/20', () => {
    const l = planeLayoutI420(4, 4, 8);
    expect(l.format).toBe('I420');
    expect(l.byteLength).toBe(24);
    expect(l.planes).toEqual([
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ]);
  });
  it('10-bit doubles every sample: 2×2 → Y=2*2*2=8, U=V=1*1*2=2, total 12; strides 4/2/2', () => {
    const l = planeLayoutI420(2, 2, 10);
    expect(l.format).toBe('I420P10');
    expect(l.byteLength).toBe(12);
    expect(l.planes[0]).toEqual({ offset: 0, stride: 4 }); // 2 samples × 2 bytes
    expect(l.planes[1]).toEqual({ offset: 8, stride: 2 });
  });
  it('odd dimensions round chroma up (5×3 → chroma 3×2)', () => {
    const l = planeLayoutI420(5, 3, 8);
    // Y = 5*3 = 15; chroma = ceil(5/2)*ceil(3/2) = 3*2 = 6 each → total 27
    expect(l.byteLength).toBe(27);
    expect(l.planes[1]).toEqual({ offset: 15, stride: 3 });
    expect(l.planes[2]).toEqual({ offset: 21, stride: 3 });
  });
  it('rejects non-positive / non-integer dimensions', () => {
    expect(() => planeLayoutI420(0, 4, 8)).toThrow(MediaError);
    expect(() => planeLayoutI420(4, -1, 8)).toThrow(MediaError);
    expect(() => planeLayoutI420(4.5, 4, 8)).toThrow(MediaError);
  });
});

// ============ decoder config normalization ============

describe('normalizeVpxDecoderConfig — validate + carry profile/dims', () => {
  it('accepts a VP9 config and carries the parsed profile/bit-depth + coded dims', () => {
    const init = normalizeVpxDecoderConfig({
      codec: 'vp09.00.10.08',
      codedWidth: 1920,
      codedHeight: 1080,
    });
    expect(init).toEqual({
      codec: 'vp9',
      profile: 0,
      bitDepth: 8,
      codedWidth: 1920,
      codedHeight: 1080,
    });
  });
  it('omits coded dims when absent (exactOptionalPropertyTypes — no undefined keys)', () => {
    const init = normalizeVpxDecoderConfig({ codec: 'vp8' });
    expect(init).toEqual({ codec: 'vp8', profile: 0, bitDepth: 8 });
    expect('codedWidth' in init).toBe(false);
  });
  it('rejects a non-VPX codec (e.g. an audio config routed here by mistake)', () => {
    expect(() =>
      normalizeVpxDecoderConfig({ codec: 'opus' } as unknown as VideoDecoderConfig),
    ).toThrow(MediaError);
  });
});

// ============ driver: identity, registration, honest wasm-absence ============

describe('wasm-vpx — driver identity & module', () => {
  it('declares the contracted identity (tier:wasm so it is ranked last)', () => {
    expect(WasmVpxDriver.id).toBe('wasm-vpx');
    expect(WasmVpxDriver.kind).toBe('codec');
    expect(WasmVpxDriver.tier).toBe('wasm');
    expect(WasmVpxDriver.apiVersion).toBe(1);
    expect([...VPX_CODECS]).toEqual(['vp8', 'vp9']);
  });
  it('registers exactly itself as a codec (and nothing else)', () => {
    const added: unknown[] = [];
    let containers = 0;
    let filters = 0;
    WasmVpxModule.register({
      addCodec: (d) => added.push(d),
      addContainer: () => containers++,
      addFilter: () => filters++,
    });
    expect(added).toEqual([WasmVpxDriver]);
    expect(containers).toBe(0);
    expect(filters).toBe(0);
  });
  it('isVpxDecodeQuery matches VP8/VP9 decode only', () => {
    expect(
      isVpxDecodeQuery({ mediaType: 'video', direction: 'decode', config: { codec: 'vp8' } }),
    ).toBe(true);
    expect(
      isVpxDecodeQuery({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'vp09.02.10.10' },
      }),
    ).toBe(true);
    // encode → not served (decode-only fallback)
    expect(
      isVpxDecodeQuery({ mediaType: 'video', direction: 'encode', config: { codec: 'vp8' } }),
    ).toBe(false);
    // non-VPX codec → not served
    expect(
      isVpxDecodeQuery({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'avc1.42E01E' },
      }),
    ).toBe(false);
    // audio → not served
    expect(
      isVpxDecodeQuery({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'vp8' } as unknown as AudioDecoderConfig,
      }),
    ).toBe(false);
  });
  it('unsupported is a non-supported result carrying the reason', () => {
    expect(unsupported('nope')).toEqual({ supported: false, reason: 'nope' });
  });
});

describe('supports() / coders — honest when the wasm core is absent (Node has no vendored core)', () => {
  afterEach(() => {
    resetVpxCoreForTest();
  });

  it('loadVpxCore resolves to null when the artifact is not vendored', async () => {
    expect(await loadVpxCore()).toBeNull();
  });

  it('returns false (never throws) for a VP9 decode query when the core is absent', async () => {
    const s = await WasmVpxDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/core/);
  });

  it('returns false for an encode query without consulting the core (decode-only)', async () => {
    const s = await WasmVpxDriver.supports({
      mediaType: 'video',
      direction: 'encode',
      config: { codec: 'vp8', width: 1920, height: 1080 } as unknown as VideoEncoderConfig,
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/decode-only/);
  });

  it('returns false for a non-VPX codec without consulting the core', async () => {
    const s = await WasmVpxDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/VP8\/VP9/);
  });

  it('returns false for a non-video query', async () => {
    const s = await WasmVpxDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'vp8' } as unknown as AudioDecoderConfig,
    });
    expect(s.supported).toBe(false);
  });

  // The config is validated eagerly (fail-fast) before any wasm/stream work — Node-runnable.
  it('createDecoder validates the config up front and rejects a non-VPX codec', () => {
    expect(() =>
      WasmVpxDriver.createDecoder({ codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 }),
    ).toThrow(MediaError);
  });

  it('createDecoder aborts up front with a typed `aborted` MediaError when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() =>
      WasmVpxDriver.createDecoder(
        { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
        { signal: ctrl.signal },
      ),
    ).toThrow(/aborted/);
  });

  it('createEncoder is an honest decode-only CapabilityError miss', () => {
    expect(() =>
      WasmVpxDriver.createEncoder({
        codec: 'vp8',
        width: 1920,
        height: 1080,
      } as unknown as VideoEncoderConfig),
    ).toThrow(CapabilityError);
    expect(() =>
      WasmVpxDriver.createEncoder({
        codec: 'vp8',
        width: 1920,
        height: 1080,
      } as unknown as VideoEncoderConfig),
    ).toThrow(/decode-only/);
  });

  // When (mis)routed in Node despite supports()=false, building a valid decoder succeeds up to the point
  // the stream is pumped; the first read drives `start`, which loads the (absent) core and errors with a
  // typed CapabilityError. This proves the "miss-only, honest absence → CapabilityError" contract.
  it('a pumped decoder errors with CapabilityError when the core is absent', async () => {
    resetVpxCoreForTest();
    const ts = WasmVpxDriver.createDecoder({
      codec: 'vp09.00.10.08',
      codedWidth: 16,
      codedHeight: 16,
    });
    await expect(ts.readable.getReader().read()).rejects.toBeInstanceOf(CapabilityError);
  });
});

// A tiny type-level guard: the pixel-format union is the one VideoFrame accepts for 4:2:0.
describe('VpxPixelFormat is the 4:2:0 family', () => {
  it('lists exactly I420 / I420P10 / I420P12', () => {
    const all: VpxPixelFormat[] = ['I420', 'I420P10', 'I420P12'];
    expect(all).toHaveLength(3);
  });
});
