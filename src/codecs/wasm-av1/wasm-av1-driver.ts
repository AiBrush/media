/**
 * The **WASM AV1** codec driver — a dav1d decode fallback for browsers whose WebCodecs `VideoDecoder`
 * misses AV1 (docs/architecture/04 wasm tier, 05 §CodecDriver). It is `tier:'wasm'`, so the router ranks
 * it behind WebCodecs and only builds it on a real AV1 miss when explicitly registered.
 *
 * This file is an honest scaffold until `dav1d-core.js` + `dav1d_wasm_bg.wasm` are vendored beside it.
 * `supports()` may load the small JS glue chunk to determine whether the core exists, but it does **not**
 * instantiate/fetch the `.wasm`; the heavy core is loaded only in `createDecoder()` through
 * `new URL('./dav1d_wasm_bg.wasm', import.meta.url)`. With no core, `supports()` returns false and a
 * misrouted decoder raises a typed `CapabilityError` rather than fabricating AV1 output.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DecoderConfig,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  RawFrame,
  Registry,
  StageOptions,
  WasmRuntimeProfile,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { resolveWasmRuntimeProfile, wasmInitForProfile } from '../../kernel/wasm-runtime.ts';
import {
  type Av1DecodedFrame,
  type Av1DecoderInit,
  type Av1PixelFormat,
  type Dav1dWasmCore,
  type Dav1dWasmDecoder,
  type DisplayTimestamp,
  normalizeAv1DecoderConfig,
  parseAv1Codec,
  planeLayoutI420,
  pushDisplayTimestamp,
  shiftDisplayTimestamp,
} from './av1.ts';

/** This driver serves AV1 video decode only. */
export const AV1_CODEC = 'av1' as const;

/** True when a query targets AV1 video decode, independent of core availability. */
export function isAv1DecodeQuery(q: CodecQuery): boolean {
  if (q.mediaType !== 'video' || q.direction !== 'decode') return false;
  try {
    parseAv1Codec(q.config.codec);
    return true;
  } catch {
    return false;
  }
}

/** Cheap non-support result for the router. */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

/** This driver needs browser host frame objects at the public codec seam. */
export function hasVideoFrameSeam(): boolean {
  return typeof EncodedVideoChunk !== 'undefined' && typeof VideoFrame !== 'undefined';
}

let probePromise: Promise<boolean> | undefined;
let corePromise: Promise<Dav1dWasmCore | null> | undefined;

/**
 * Probe whether the build-emitted dav1d glue chunk is vendored. This imports only `dav1d-core.js`; it does
 * not call the glue's default init and therefore does not fetch or instantiate `dav1d_wasm_bg.wasm`.
 */
export async function probeAv1Core(): Promise<boolean> {
  probePromise ??= (async (): Promise<boolean> => {
    try {
      const mod = await import('./dav1d-core.js');
      return typeof mod.createDav1dCore === 'function';
    } catch {
      return false;
    }
  })();
  return probePromise;
}

/**
 * Load the dav1d WASM core lazily and at most once. This is the first point that instantiates/fetches the
 * heavy `.wasm`, and it is called only from `createDecoder()` after the router has selected this tail.
 */
export async function loadAv1Core(runtime?: WasmRuntimeProfile): Promise<Dav1dWasmCore | null> {
  corePromise ??= (async (): Promise<Dav1dWasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      const mod = await import('./dav1d-core.js');
      await mod.default(
        wasmInitForProfile(new URL('./dav1d_wasm_bg.wasm', import.meta.url), profile),
      );
      return mod.createDav1dCore();
    } catch {
      return null;
    }
  })();
  return corePromise;
}

/** Reset memoized core/probe state (tests only). */
export function resetAv1CoreForTest(): void {
  probePromise = undefined;
  corePromise = undefined;
}

function coreMissing(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    'wasm-av1 dav1d core is not available (not vendored)',
    {
      op,
      tried: ['wasm-av1'],
      suggestion: 'build + vendor dav1d per src/codecs/wasm-av1/BUILD.md',
    },
  );
}

function seamMissing(): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    'wasm-av1 requires browser EncodedVideoChunk and VideoFrame host objects',
    {
      op: 'decode',
      tried: ['wasm-av1'],
      suggestion: 'run AV1 software decode in a browser runtime with WebCodecs frame objects',
    },
  );
}

function encodeUnsupported(): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    'wasm-av1 is a dav1d decode-only fallback; AV1 software encode is out of scope',
    {
      op: 'encode',
      tried: ['wasm-av1'],
      suggestion: 'encode AV1 via WebCodecs or a future SVT-AV1 tail',
    },
  );
}

async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'video') return unsupported('wasm-av1 handles video only');
  if (q.direction === 'encode') {
    return unsupported('wasm-av1 is a decode-only fallback (dav1d has no encoder)');
  }

  let init: Av1DecoderInit;
  try {
    init = normalizeAv1DecoderConfig(q.config as VideoDecoderConfig);
  } catch {
    return unsupported(`wasm-av1 handles AV1 only, not '${q.config.codec}'`);
  }
  const coreEnvelope = dav1dEnvelopeMiss(init);
  if (coreEnvelope !== undefined) return coreEnvelope;

  if (!hasVideoFrameSeam()) {
    return unsupported('wasm-av1 requires browser EncodedVideoChunk + VideoFrame');
  }
  if (!(await probeAv1Core())) {
    return unsupported('wasm-av1 dav1d core is not vendored (see BUILD.md)');
  }

  const loadedCore = corePromise === undefined ? undefined : await corePromise;
  if (loadedCore === null) return unsupported('wasm-av1 dav1d core failed to instantiate');
  if (loadedCore?.supports?.(init) === false) {
    return unsupported(
      `wasm-av1 dav1d core does not support profile ${init.profile}, ${init.bitDepth}-bit ${init.chromaSubsampling}`,
    );
  }
  return { supported: true, hardwareAccelerated: false };
}

function dav1dEnvelopeMiss(init: Av1DecoderInit): CodecSupport | undefined {
  if (init.bitDepth !== 8) {
    return unsupported(`wasm-av1 dav1d core does not support ${init.bitDepth}-bit AV1`);
  }
  if (init.chromaSubsampling !== '420') {
    return unsupported(
      `wasm-av1 dav1d core supports 4:2:0 AV1 only, not ${init.chromaSubsampling}`,
    );
  }
  if (init.monochrome) {
    return unsupported('wasm-av1 dav1d core does not support monochrome AV1 output');
  }
  return undefined;
}

/* v8 ignore start -- requires browser WebCodecs frame globals and a vendored dav1d core. */

function asVideoChunk(chunk: EncodedChunk): EncodedVideoChunk {
  if (chunk instanceof EncodedVideoChunk) return chunk;
  throw new MediaError(
    'decode-error',
    'wasm-av1 received a non-video chunk (router/seam mismatch)',
  );
}

function chunkBytes(chunk: EncodedVideoChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
}

function asVideoPixelFormat(format: Av1PixelFormat): VideoPixelFormat {
  return format as VideoPixelFormat;
}

function buildVideoFrame(decoded: Av1DecodedFrame, timing: DisplayTimestamp): VideoFrame {
  const layout = planeLayoutI420(decoded.width, decoded.height, decoded.bitDepth);
  if (decoded.data.byteLength !== layout.byteLength) {
    throw new MediaError(
      'decode-error',
      `av1: decoded plane buffer is ${decoded.data.byteLength}B, expected ${layout.byteLength}B`,
    );
  }
  const base: VideoFrameBufferInit = {
    format: asVideoPixelFormat(layout.format),
    codedWidth: layout.codedWidth,
    codedHeight: layout.codedHeight,
    timestamp: timing.timestampUs,
    layout: [...layout.planes],
  };
  const init: VideoFrameBufferInit =
    timing.durationUs === null ? base : { ...base, duration: timing.durationUs };
  return new VideoFrame(decoded.data, init);
}

function wrapDecodeError(err: unknown, phase: string): MediaError {
  if (err instanceof MediaError) return err;
  return new MediaError('decode-error', `wasm-av1 dav1d ${phase} failed`, { cause: err });
}

function enqueueDecodedFrames(
  controller: TransformStreamDefaultController<RawFrame>,
  frames: readonly Av1DecodedFrame[],
  displayQueue: DisplayTimestamp[],
  pendingFrames: Set<VideoFrame>,
): void {
  for (const decoded of frames) {
    const timing = shiftDisplayTimestamp(displayQueue) ?? { timestampUs: 0, durationUs: null };
    const frame = buildVideoFrame(decoded, timing);
    pendingFrames.add(frame);
    try {
      controller.enqueue(frame);
      pendingFrames.delete(frame);
    } catch (err: unknown) {
      pendingFrames.delete(frame);
      frame.close();
      throw wrapDecodeError(err, 'enqueue');
    }
  }
}

/* v8 ignore stop */

function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  const init = normalizeAv1DecoderConfig(config as VideoDecoderConfig);
  if (!hasVideoFrameSeam()) throw seamMissing();

  /* v8 ignore start -- requires browser WebCodecs frame globals and a vendored dav1d core. */
  let decoder: Dav1dWasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  const pendingFrames = new Set<VideoFrame>();
  const displayQueue: DisplayTimestamp[] = [];

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    for (const frame of pendingFrames) frame.close();
    pendingFrames.clear();
    decoder?.free();
    decoder = undefined;
    displayQueue.length = 0;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadAv1Core(o?.wasmRuntime);
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      if (core === null) {
        controller.error(coreMissing('decode'));
        return;
      }
      if (core.supports?.(init) === false) {
        controller.error(
          new CapabilityError(
            'capability-miss',
            'wasm-av1 dav1d core does not support this AV1 config',
            {
              op: init,
              tried: ['wasm-av1'],
              suggestion:
                'try WebCodecs, another browser, or a dav1d build with broader pixel-format support',
            },
          ),
        );
        return;
      }
      decoder = await core.createDecoder(init);
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(chunk, controller): void {
      const dec = decoder;
      if (!dec) throw new MediaError('decode-error', 'wasm-av1 decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const videoChunk = asVideoChunk(chunk);
      pushDisplayTimestamp(displayQueue, {
        timestampUs: videoChunk.timestamp,
        durationUs: videoChunk.duration,
      });
      let frames: Av1DecodedFrame[];
      try {
        frames = dec.decode(chunkBytes(videoChunk));
      } catch (err: unknown) {
        throw wrapDecodeError(err, 'decode');
      }
      enqueueDecodedFrames(controller, frames, displayQueue, pendingFrames);
    },
    flush(controller): void {
      const dec = decoder;
      if (dec?.flush) {
        try {
          enqueueDecodedFrames(controller, dec.flush(), displayQueue, pendingFrames);
        } catch (err: unknown) {
          throw wrapDecodeError(err, 'flush');
        }
      }
      teardown();
    },
  });
  /* v8 ignore stop */
}

function createEncoder(
  _config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  throw encodeUnsupported();
}

/** The dav1d-backed AV1 decode fallback. */
export const WasmAv1Driver: CodecDriver = {
  id: 'wasm-av1',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** Driver module for explicit registration once the dav1d core is vendored. */
export const WasmAv1Module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmAv1Driver);
  },
};

export default WasmAv1Module;
