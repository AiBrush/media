/**
 * VPx-alpha frame subsystem (S13 layer 3, docs/architecture/codec-pipeline.md §3.2): split a decoded
 * RGBA/I420A `VideoFrame` into the opaque-colour + grayscale-alpha pair the dual-VPx encode path feeds,
 * merge decoded colour/alpha planes back into one RGBA frame, the packet→chunk projections
 * (`unwrapPackets`/`alphaChunkStream`), the shared **bounded** timestamp pairing buffer every alpha
 * stream composition uses, and the decode-side pairing (`decodeVideoPacketsWithAlpha`). This layer
 * constructs real `VideoFrame`s and is browser-gated; its control flow (close-exactly-once under
 * success/cancel/error, pairing bounds) is Node-tested with counting fakes and the pixel round-trip is
 * bit-exact-tested (BUILD §6.1).
 *
 * RGBA pixels ride ALONGSIDE a constructed frame in a `WeakMap` sidecar (never an expando property —
 * host `VideoFrame` objects may reject those): weak keys cannot extend a frame's lifetime, the sidecar
 * dies with the frame, and `close()` semantics are untouched (§5 item 5, ADR in docs/decisions).
 */

import type { EncodedChunk, Packet, RawFrame } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { closeFrame } from '../kernel/frames.ts';
import { readFrameRgba } from '../util/frame-rgba.ts';
import { decodedVpxAlphaLuma } from './vpx-alpha-frame-pixels.ts';
import {
  RGBA_BYTES_PER_PIXEL,
  type VpxAlphaPackedSourceFormat,
  mergeVpxAlphaLuma,
  mergeVpxAlphaRgba,
  vpxAlphaI420FromPackedRgba,
  vpxAlphaI420FromPlane,
} from './vpx-alpha-pixels.ts';

/** Packed RGBA pixels + geometry for one frame (the split/merge working representation). */
export interface RgbaFramePixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The split result: an opaque-colour plane and a grayscale-alpha plane, both packed RGBA. */
export interface VpxAlphaSplitPixels {
  readonly color: RgbaFramePixels;
  readonly alpha: RgbaFramePixels;
}

/**
 * RGBA pixels for frames this module itself constructed, keyed weakly by the frame. Reading a frame's
 * pixels through `copyTo` costs a full GPU→CPU readback; a frame built *from* packed RGBA already has
 * them. The `WeakMap` never delays frame reclamation and needs no host-object cooperation.
 */
const rgbaPixelSidecars = new WeakMap<VideoFrame, RgbaFramePixels>();

function assertRgbaPixelsShape(pixels: RgbaFramePixels, op: 'decode' | 'encode'): void {
  const code = op === 'decode' ? 'decode-error' : 'encode-error';
  if (!Number.isSafeInteger(pixels.width) || pixels.width <= 0) {
    throw new MediaError(code, `RGBA pixels have invalid width ${pixels.width}`);
  }
  if (!Number.isSafeInteger(pixels.height) || pixels.height <= 0) {
    throw new MediaError(code, `RGBA pixels have invalid height ${pixels.height}`);
  }
  const minimumSize = pixels.width * pixels.height * RGBA_BYTES_PER_PIXEL;
  if (pixels.data.length < minimumSize) {
    throw new MediaError(
      code,
      `RGBA pixels are truncated: ${pixels.data.length} bytes for ${pixels.width}x${pixels.height}`,
    );
  }
}

function frameDimension(frame: VideoFrame, axis: 'width' | 'height'): number {
  const display = axis === 'width' ? frame.displayWidth : frame.displayHeight;
  const coded = axis === 'width' ? frame.codedWidth : frame.codedHeight;
  const value = display || coded;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MediaError('decode-error', `VPx alpha frame has invalid ${axis} ${value}`);
  }
  return value;
}

export async function rgbaPixelsFromFrame(frame: VideoFrame): Promise<RgbaFramePixels> {
  const width = frameDimension(frame, 'width');
  const height = frameDimension(frame, 'height');
  const sidecar = rgbaPixelSidecars.get(frame);
  if (sidecar !== undefined && sidecar.width === width && sidecar.height === height) {
    return {
      data: sidecar.data.slice(0, width * height * RGBA_BYTES_PER_PIXEL),
      width,
      height,
    };
  }
  return readFrameRgba(frame, { rect: { x: 0, y: 0, width, height } });
}

function rgbaPixelsToFrame(
  pixels: RgbaFramePixels,
  color: VideoFrame,
  sidecarOwnership: 'copy' | 'adopt' = 'copy',
): VideoFrame {
  const base: VideoFrameBufferInit = {
    format: 'RGBA',
    codedWidth: pixels.width,
    codedHeight: pixels.height,
    timestamp: color.timestamp,
    layout: [{ offset: 0, stride: pixels.width * RGBA_BYTES_PER_PIXEL }],
  };
  const init: VideoFrameBufferInit =
    color.duration === null ? base : { ...base, duration: color.duration };
  const frame = new VideoFrame(pixels.data, init);
  rgbaPixelSidecars.set(frame, {
    data: sidecarOwnership === 'adopt' ? pixels.data : pixels.data.slice(),
    width: pixels.width,
    height: pixels.height,
  });
  return frame;
}

export function bufferInitFromSourceFrame(
  frame: VideoFrame,
  format: VideoPixelFormat,
  width: number,
  height: number,
  layout: readonly PlaneLayout[],
): VideoFrameBufferInit {
  const base: VideoFrameBufferInit = {
    format,
    codedWidth: width,
    codedHeight: height,
    timestamp: frame.timestamp,
    layout: [...layout],
  };
  return frame.duration === null ? base : { ...base, duration: frame.duration };
}

function packedSourceFormat(
  format: VideoPixelFormat | null,
): VpxAlphaPackedSourceFormat | undefined {
  if (format === 'RGBA' || format === 'BGRA') return format;
  return undefined;
}

function compactAlphaSplitCanUseNativeLayout(
  frame: VideoFrame,
  width: number,
  height: number,
): boolean {
  return frame.codedWidth === width && frame.codedHeight === height;
}

function requiredPlaneLayout(layout: readonly PlaneLayout[], index: number): PlaneLayout {
  const plane = layout[index];
  if (plane === undefined) {
    throw new MediaError('encode-error', `VPx alpha copy returned no plane ${index}`);
  }
  return plane;
}

/** Split packed RGBA pixels into an opaque-colour plane and a grayscale-alpha plane (pure, bit-exact). */
export function splitRgbaForVpxAlpha(pixels: RgbaFramePixels): VpxAlphaSplitPixels {
  assertRgbaPixelsShape(pixels, 'encode');
  const minimumSize = pixels.width * pixels.height * RGBA_BYTES_PER_PIXEL;
  const color = new Uint8ClampedArray(minimumSize);
  const alpha = new Uint8ClampedArray(minimumSize);
  for (let i = 0; i < minimumSize; i += RGBA_BYTES_PER_PIXEL) {
    const a = pixels.data[i + 3] as number;
    color[i] = pixels.data[i] as number;
    color[i + 1] = pixels.data[i + 1] as number;
    color[i + 2] = pixels.data[i + 2] as number;
    color[i + 3] = 0xff;
    alpha[i] = a;
    alpha[i + 1] = a;
    alpha[i + 2] = a;
    alpha[i + 3] = 0xff;
  }
  return {
    color: { data: color, width: pixels.width, height: pixels.height },
    alpha: { data: alpha, width: pixels.width, height: pixels.height },
  };
}

async function splitPackedFrameForVpxAlphaInline(
  frame: VideoFrame,
  width: number,
  height: number,
  sourceFormat: VpxAlphaPackedSourceFormat,
): Promise<{ color: VideoFrame; alpha: VideoFrame }> {
  const source = new Uint8Array(frame.allocationSize());
  const sourceLayout = await frame.copyTo(source);
  const colorPlane = requiredPlaneLayout(sourceLayout, 0);
  const alpha = vpxAlphaI420FromPackedRgba(source, width, height, colorPlane, sourceFormat);
  let colorFrame: VideoFrame | undefined;
  let alphaFrame: VideoFrame | undefined;
  try {
    colorFrame = frame.clone();
    alphaFrame = new VideoFrame(
      alpha.data,
      bufferInitFromSourceFrame(frame, 'I420', width, height, alpha.layout),
    );
    return { color: colorFrame, alpha: alphaFrame };
  } catch (error) {
    if (colorFrame !== undefined) closeFrame(colorFrame);
    if (alphaFrame !== undefined) closeFrame(alphaFrame);
    throw error;
  }
}

async function splitI420AFrameForVpxAlpha(
  frame: VideoFrame,
  width: number,
  height: number,
): Promise<{ color: VideoFrame; alpha: VideoFrame }> {
  const source = new Uint8Array(frame.allocationSize());
  const sourceLayout = await frame.copyTo(source);
  const alpha = vpxAlphaI420FromPlane(source, width, height, requiredPlaneLayout(sourceLayout, 3));
  let colorFrame: VideoFrame | undefined;
  let alphaFrame: VideoFrame | undefined;
  try {
    colorFrame = frame.clone();
    alphaFrame = new VideoFrame(
      alpha.data,
      bufferInitFromSourceFrame(frame, 'I420', width, height, alpha.layout),
    );
    return { color: colorFrame, alpha: alphaFrame };
  } catch (error) {
    if (colorFrame !== undefined) closeFrame(colorFrame);
    if (alphaFrame !== undefined) closeFrame(alphaFrame);
    throw error;
  }
}

/**
 * Split one decoded frame into the opaque-colour + grayscale-alpha `VideoFrame` pair. The INPUT frame is
 * left open (the caller closes it exactly once); on any construction failure every derived frame built so
 * far is closed before the error propagates, so a half-split never leaks.
 */
export async function splitFrameForVpxAlpha(
  frame: VideoFrame,
): Promise<{ color: VideoFrame; alpha: VideoFrame }> {
  const width = frameDimension(frame, 'width');
  const height = frameDimension(frame, 'height');
  if (compactAlphaSplitCanUseNativeLayout(frame, width, height)) {
    const sourceFormat = packedSourceFormat(frame.format);
    if (sourceFormat !== undefined) {
      return splitPackedFrameForVpxAlphaInline(frame, width, height, sourceFormat);
    }
    if (frame.format === 'I420A') {
      return splitI420AFrameForVpxAlpha(frame, width, height);
    }
  }
  const split = splitRgbaForVpxAlpha(await rgbaPixelsFromFrame(frame));
  let colorFrame: VideoFrame | undefined;
  let alphaFrame: VideoFrame | undefined;
  try {
    colorFrame = rgbaPixelsToFrame(split.color, frame);
    alphaFrame = rgbaPixelsToFrame(split.alpha, frame);
    return { color: colorFrame, alpha: alphaFrame };
  } catch (error) {
    if (colorFrame !== undefined) closeFrame(colorFrame);
    if (alphaFrame !== undefined) closeFrame(alphaFrame);
    throw error;
  }
}

/**
 * Merge decoded colour + alpha frames into one fresh RGBA frame (the alpha plane's R channel becomes the
 * output A channel). Inputs are left open — the caller owns closing both exactly once — and the returned
 * frame is owned by the downstream consumer.
 */
export async function mergeAlphaFrames(color: VideoFrame, alpha: VideoFrame): Promise<VideoFrame> {
  const width = frameDimension(color, 'width');
  const height = frameDimension(color, 'height');
  if (frameDimension(alpha, 'width') !== width || frameDimension(alpha, 'height') !== height) {
    throw new MediaError(
      'decode-error',
      `VPx alpha plane dimensions ${frameDimension(alpha, 'width')}x${frameDimension(alpha, 'height')} do not match color frame ${width}x${height}`,
    );
  }

  const [colorPixels, alphaLuma] = await Promise.all([
    rgbaPixelsFromFrame(color),
    decodedVpxAlphaLuma(alpha, width, height),
  ]);
  if (alphaLuma === undefined) {
    mergeVpxAlphaRgba(colorPixels.data, (await rgbaPixelsFromFrame(alpha)).data);
  } else {
    mergeVpxAlphaLuma(colorPixels.data, alphaLuma);
  }
  return rgbaPixelsToFrame(colorPixels, color, 'adopt');
}

/** Enqueue a frame, closing it if the controller rejects it (stream already errored/cancelled). */
export function enqueueFrame(
  controller: ReadableStreamDefaultController<VideoFrame>,
  frame: VideoFrame,
): void {
  let handedOff = false;
  try {
    controller.enqueue(frame);
    handedOff = true;
  } finally {
    if (!handedOff) closeFrame(frame);
  }
}

/**
 * Project a packet stream through `project`, skipping packets that yield `undefined`. Reader-based —
 * one source read per downstream demand, `{ highWaterMark: 0 }`, cancel-through — deliberately NOT a
 * `TransformStream` pipe: an interior pipe adds a queue ahead of the consumer and (observed under
 * Node's WHATWG streams) can leak an unhandled rejection when a multi-pipe chain is cancelled with a
 * pending interior write. One shape serves both chunk projection and alpha side-chunk selection.
 */
function projectPacketStream(
  packets: ReadableStream<Packet>,
  project: (packet: Packet) => EncodedChunk | undefined,
): ReadableStream<EncodedChunk> {
  const reader = packets.getReader();
  let released = false;
  let cancelPromise: Promise<void> | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancelAndRelease = (reason: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).finally(release);
    return cancelPromise;
  };
  return new ReadableStream<EncodedChunk>(
    {
      async pull(controller): Promise<void> {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              release();
              controller.close();
              return;
            }
            const projected = project(value);
            if (projected !== undefined) {
              controller.enqueue(projected);
              return;
            }
          }
        } catch (error) {
          await cancelAndRelease(error).catch(() => undefined);
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        await cancelAndRelease(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Project a packet stream to its VPx alpha side chunks (packets without alpha are skipped). */
export function alphaChunkStream(packets: ReadableStream<Packet>): ReadableStream<EncodedChunk> {
  return projectPacketStream(packets, (packet) => packet.alpha);
}

// ============ bounded timestamp pairing (shared by every alpha composition) ============

/**
 * The maximum number of ahead-of-target alpha items the pairing buffer may hold. Both planes are encoded
 * by identically-configured encoders over the same PTS set, and WebCodecs encoders emit output in decode
 * order, so the pairing skew between the two streams is the encoder reorder distance — a small constant,
 * never the clip length (§3.4 backpressure; §5 item 8). Exceeding it means the streams are pathologically
 * misaligned; the pairer then fails LOUDLY with a typed error instead of buffering (silently dropping
 * alpha, or growing without bound, would both be forbidden silent degradations).
 */
export const VPX_ALPHA_MAX_REORDER_AHEAD = 16;

type TimestampedReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>;

/**
 * Exact-PTS pairing buffer over one alpha-branch reader. `claim(t)` drops stale items (< t, via
 * `onDrop`), returns the item at exactly `t` when buffered or next on the stream, and otherwise buffers
 * ONE ahead item and yields `undefined` — so the alpha branch is only ever read while resolving the
 * current colour timestamp (plus one opt-in prefetch), which is what keeps a slow consumer from forcing
 * an unbounded queue. The buffer is capped at {@link VPX_ALPHA_MAX_REORDER_AHEAD}.
 */
export class AlphaPairingBuffer<T extends { readonly timestamp: number }> {
  readonly #reader: ReadableStreamDefaultReader<T>;
  readonly #onDrop: (item: T) => void;
  readonly #overflow: (bufferedCount: number, timestamp: number) => Error;
  readonly #byTimestamp = new Map<number, T>();
  #done = false;
  #pendingRead: Promise<TimestampedReadResult<T>> | undefined;

  constructor(
    reader: ReadableStreamDefaultReader<T>,
    onDrop: (item: T) => void,
    overflow: (bufferedCount: number, timestamp: number) => Error,
  ) {
    this.#reader = reader;
    this.#onDrop = onDrop;
    this.#overflow = overflow;
  }

  /** Start (or reuse) one in-flight read so the alpha branch overlaps the colour read. */
  prefetch(): void {
    if (this.#done || this.#pendingRead !== undefined) return;
    this.#pendingRead = this.#reader.read();
  }

  /** The in-flight read, if any — cancellation paths await it so no read is left dangling. */
  get pending(): Promise<unknown> | undefined {
    return this.#pendingRead;
  }

  /** Close/release every buffered item through `onEach` (teardown owns buffered frame lifetime). */
  drainBuffered(onEach: (item: T) => void): void {
    for (const item of this.#byTimestamp.values()) onEach(item);
    this.#byTimestamp.clear();
  }

  async claim(timestamp: number): Promise<T | undefined> {
    for (const [bufferedTimestamp, item] of this.#byTimestamp) {
      if (bufferedTimestamp >= timestamp) continue;
      this.#byTimestamp.delete(bufferedTimestamp);
      this.#onDrop(item);
    }
    const cached = this.#byTimestamp.get(timestamp);
    if (cached !== undefined) {
      this.#byTimestamp.delete(timestamp);
      return cached;
    }
    while (!this.#done) {
      const read = this.#pendingRead ?? this.#reader.read();
      this.#pendingRead = undefined;
      const { done, value } = await read;
      if (done) {
        this.#done = true;
        return undefined;
      }
      if (value.timestamp < timestamp) {
        this.#onDrop(value);
        continue;
      }
      if (value.timestamp === timestamp) return value;
      this.#byTimestamp.set(value.timestamp, value);
      if (this.#byTimestamp.size > VPX_ALPHA_MAX_REORDER_AHEAD) {
        throw this.#overflow(this.#byTimestamp.size, value.timestamp);
      }
      return undefined;
    }
    return undefined;
  }
}

/** The typed loud-failure error for a pairing buffer pushed past the reorder bound. */
export function alphaPairingOverflow(
  op: 'encode' | 'decode',
  what: string,
): (bufferedCount: number, timestamp: number) => Error {
  return (bufferedCount, timestamp) =>
    new MediaError(
      op === 'encode' ? 'encode-error' : 'decode-error',
      `VPx alpha pairing buffered ${bufferedCount} ${what} beyond the reorder bound at timestamp ${timestamp}; the colour and alpha streams are misaligned`,
    );
}

/** Stale encoded chunks are plain host objects with no close() contract; dropping frees nothing. */
export const dropEncodedChunk = (): void => {};

/**
 * Drop the DTS side-channel: project a {@link Packet} stream back to the bare {@link EncodedChunk}s a
 * WebCodecs decoder consumes (the decoder only needs the coded bytes + PTS in `timestamp`; DTS is a
 * muxer concern). Used at every demux→decode seam in the engine. Pins `{ highWaterMark: 0 }` so no
 * queue forms ahead of the decoder. Pure stream plumbing — Node-testable with fake packets.
 */
export function unwrapPackets(packets: ReadableStream<Packet>): ReadableStream<EncodedChunk> {
  return projectPacketStream(packets, (packet) => packet.chunk);
}

/** Decode the two elementary VPx planes independently for geometry-only alpha transcodes. */
export function decodeVpxAlphaPacketStreams(
  packets: ReadableStream<Packet>,
  createDecoder: () => TransformStream<EncodedChunk, RawFrame>,
  createAlphaDecoder: () => TransformStream<EncodedChunk, RawFrame> = createDecoder,
): { readonly color: ReadableStream<VideoFrame>; readonly alpha: ReadableStream<VideoFrame> } {
  const [colorPackets, alphaPackets] = packets.tee();
  const color = unwrapPackets(colorPackets).pipeThrough(
    createDecoder(),
  ) as ReadableStream<VideoFrame>;
  const alpha = alphaChunkStream(alphaPackets).pipeThrough(
    createAlphaDecoder(),
  ) as ReadableStream<VideoFrame>;
  return { color, alpha };
}

/**
 * Decode WebM/Matroska VPx packets whose alpha plane rides as BlockAdditions. WebCodecs accepts one VPx
 * elementary stream per decoder, so color and alpha are decoded separately, then paired by timestamp and
 * merged into a fresh RGBA `VideoFrame`. Every intermediate color/alpha frame is closed exactly once;
 * the merged output frame is owned by the downstream consumer. Use only for tracks that are already
 * known to carry alpha side data, otherwise the alpha branch would needlessly drain a whole filtered
 * packet stream before the first color frame can be released.
 */
export function decodeVideoPacketsWithAlpha(
  packets: ReadableStream<Packet>,
  createDecoder: () => TransformStream<EncodedChunk, RawFrame>,
  createAlphaDecoder?: () => TransformStream<EncodedChunk, RawFrame>,
): ReadableStream<VideoFrame> {
  const { color: colorFrames, alpha: alphaFrames } = decodeVpxAlphaPacketStreams(
    packets,
    createDecoder,
    createAlphaDecoder,
  );
  const colorReader = colorFrames.getReader();
  const alphaReader = alphaFrames.getReader();
  const pairing = new AlphaPairingBuffer<VideoFrame>(
    alphaReader,
    closeFrame,
    alphaPairingOverflow('decode', 'alpha frames'),
  );
  let teardownPromise: Promise<void> | undefined;

  const teardown = (reason: unknown): Promise<void> => {
    if (teardownPromise !== undefined) return teardownPromise;
    pairing.drainBuffered(closeFrame);
    teardownPromise = Promise.allSettled([
      colorReader.cancel(reason),
      alphaReader.cancel(reason),
      ...(pairing.pending === undefined ? [] : [pairing.pending]),
    ]).then(() => undefined);
    return teardownPromise;
  };

  return new ReadableStream<VideoFrame>(
    {
      async pull(controller): Promise<void> {
        let color: VideoFrame | undefined;
        let alpha: VideoFrame | undefined;
        let output: VideoFrame | undefined;
        try {
          const result = await colorReader.read();
          if (result.done) {
            await teardown('color stream ended');
            controller.close();
            return;
          }
          color = result.value;
          alpha = await pairing.claim(color.timestamp);
          if (alpha === undefined) {
            const directOutput = color;
            color = undefined;
            enqueueFrame(controller, directOutput);
            return;
          }
          output = await mergeAlphaFrames(color, alpha);
          const consumedColor = color;
          color = undefined;
          closeFrame(consumedColor);
          const consumedAlpha = alpha;
          alpha = undefined;
          closeFrame(consumedAlpha);
          const mergedOutput = output;
          output = undefined;
          enqueueFrame(controller, mergedOutput);
        } catch (error) {
          if (color !== undefined) closeFrame(color);
          if (alpha !== undefined) closeFrame(alpha);
          if (output !== undefined) closeFrame(output);
          await teardown(error);
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        await teardown(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
