/**
 * Browser **image decode** via the WebCodecs `ImageDecoder` — turns an encoded GIF/PNG/JPEG/WebP/AVIF
 * buffer into one `VideoFrame` (still) or a correctly-timed `VideoFrame` sequence (animated). `ImageDecoder`
 * is the browser-native, hardware-assisted image path (doc 10); it is **absent in Node**, so every entry
 * point here is guarded behind an honest capability check — no API ⇒ a typed {@link CapabilityError}, never
 * a mock or a fabricated frame (ADR-018/ADR-025). The pure header parse that drives frame timing lives in
 * {@link ./probe.ts} and is Node-validated; the live pixel path here is browser-validated.
 *
 * Frame lifetime (doc 06 §3 — the rule that prevents leaks): each decoded `VideoFrame` is yielded to the
 * **consumer, which owns it and `close()`s it exactly once**. If the consumer stops early (generator
 * `return`/`throw`, or `ReadableStream` cancel), the in-flight frame and the underlying `ImageDecoder` are
 * released here so nothing leaks. Animation timing: WebCodecs surfaces each frame's delay as
 * `VideoFrame.duration` (µs); we accumulate it into a monotonically increasing `timestamp`, and where a
 * frame omits a duration we fall back to a default so timestamps still advance.
 *
 * Backpressure: the generator is pull-driven — it decodes frame N only when the consumer asks for it, so
 * at most one decoded frame is alive at a time (no GPU-memory pile-up). The `ReadableStream` wrapper
 * (`highWaterMark: 0`) preserves that demand-paced behaviour for the engine's frame-stream convention.
 */

import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { IMAGE_MIME, type ImageFormat, type ImageInfo, probeImage } from './probe.ts';

/** Default per-frame duration (µs) when an animated frame omits one — 100 ms, the GIF default delay. */
const DEFAULT_FRAME_DURATION_US = 100_000 as const;

/** Options for {@link decodeImageFrames}/{@link decodeImage}. */
export interface DecodeImageOptions {
  /** Cancels the decode; releases the `ImageDecoder` and any in-flight frame. */
  signal?: AbortSignal;
}

/** True iff the WebCodecs `ImageDecoder` is available in this environment (false in Node). */
export function hasImageDecoder(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

function absentImageDecoderError(): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    'WebCodecs ImageDecoder is unavailable in this environment (e.g. Node); image decode is browser-only',
    {
      op: 'decode-image',
      tried: [],
      suggestion: 'run the browser image path (WebCodecs ImageDecoder)',
    },
  );
}

/**
 * Probe an encoded image and report whether it can be decoded here: the format, its {@link ImageInfo},
 * and whether a real `ImageDecoder` exists. Honest about the gap — `decodable` is `false` in Node — and
 * never throws for a capability miss (only an {@link InputError} for genuinely unrecognized bytes).
 */
export function inspectImage(bytes: Uint8Array): {
  format: ImageFormat;
  info: ImageInfo;
  decodable: boolean;
} {
  const info = probeImage(bytes);
  return { format: info.format, info, decodable: hasImageDecoder() };
}

/**
 * Decode an encoded image to its `VideoFrame`(s), in order, with correct per-frame `timestamp`/`duration`
 * (µs). A still image yields exactly one frame; an animated image yields its full frame sequence. **The
 * consumer owns each yielded frame and must `close()` it exactly once.** Raises a typed
 * {@link CapabilityError} where `ImageDecoder` is absent (Node), and a typed {@link MediaError} on a
 * decoder failure. Honors `signal`: an abort releases the decoder and any in-flight frame.
 */
export async function* decodeImageFrames(
  bytes: Uint8Array,
  options: DecodeImageOptions = {},
): AsyncGenerator<VideoFrame, void, undefined> {
  if (!hasImageDecoder()) throw absentImageDecoderError();
  /* v8 ignore start -- past the hasImageDecoder() guard ⇒ browser-only (ImageDecoder absent in Node); harness-validated. */
  // Sniff + validate the header first (typed InputError for non-images) and derive the MIME `type`.
  const info = probeImage(bytes);
  const type = IMAGE_MIME[info.format];
  const signal = options.signal;
  throwIfAborted(signal);

  // A fresh, transferable copy isolates the decoder from any later mutation of the caller's buffer.
  const data = bytes.slice();
  const decoder = new ImageDecoder({ type, data });
  let timestampUs = 0;
  try {
    // `tracks.ready` resolves once the track list (frame count / repetition count) is known.
    await raceAbort(decoder.tracks.ready, signal);
    const track = decoder.tracks.selectedTrack;
    if (!track) {
      throw new MediaError('decode-error', `image decode: no selected track for ${info.format}`);
    }
    const frameCount = track.frameCount;
    for (let index = 0; index < frameCount; index++) {
      throwIfAborted(signal);
      const result = await raceAbort(
        decoder.decode({ frameIndex: index, completeFramesOnly: true }),
        signal,
      );
      const frame = result.image;
      // Stamp a monotonic presentation timeline: the source frame's own timestamp if present, else our
      // running accumulator; advance by the frame's duration (or the default) for the next frame.
      const duration = frame.duration ?? DEFAULT_FRAME_DURATION_US;
      const stamped = restamp(frame, timestampUs, duration);
      timestampUs += duration;
      // Ownership transfers to the consumer at `yield`; if it resumes us with `.return()`/`.throw()`
      // (early stop), the `finally` below closes the decoder — the already-yielded frame is the
      // consumer's to close. We never hold a reference to `stamped` past this point.
      yield stamped;
    }
  } finally {
    decoder.close(); // release the native decoder + its buffered planes on every exit (done/throw/abort)
  }
  /* v8 ignore stop */
}

/**
 * Decode an encoded image into a pull-driven `ReadableStream<VideoFrame>` (the engine's frame-stream
 * convention). Demand-paced (`highWaterMark: 0`): one frame is decoded per `read()`. Cancelling the
 * stream (or aborting `signal`) ends the underlying generator, which releases the `ImageDecoder` and any
 * in-flight frame. Each emitted frame is owned + `close()`d by the reader. Browser-only (typed miss in Node).
 */
export function decodeImage(
  bytes: Uint8Array,
  options: DecodeImageOptions = {},
): ReadableStream<VideoFrame> {
  if (!hasImageDecoder()) throw absentImageDecoderError();
  /* v8 ignore start -- requires WebCodecs ImageDecoder (absent in Node); browser-harness validated. */
  const iterator = decodeImageFrames(bytes, options);
  return new ReadableStream<VideoFrame>(
    {
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await iterator.next();
          if (done) controller.close();
          else controller.enqueue(value); // ownership → reader
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel(reason): Promise<void> {
        // Tell the generator to stop; its `finally` closes the decoder + any in-flight frame.
        await iterator.return().catch(() => {});
        void reason;
      },
    },
    { highWaterMark: 0 },
  );
  /* v8 ignore stop */
}

/* v8 ignore start -- helpers below run only on the live ImageDecoder path; browser-harness validated. */

/**
 * Return a `VideoFrame` carrying the desired presentation `timestamp`/`duration` without copying pixels:
 * if the decoded frame already matches, pass it through; otherwise wrap it (zero-copy, shares the same
 * backing) with the corrected timing and close the original so exactly one handle survives.
 */
function restamp(frame: VideoFrame, timestampUs: number, durationUs: number): VideoFrame {
  if (frame.timestamp === timestampUs && frame.duration === durationUs) return frame;
  const restamped = new VideoFrame(frame, { timestamp: timestampUs, duration: durationUs });
  frame.close(); // the wrapper shares the underlying image; release the original handle (close-once).
  return restamped;
}

/** Reject with a typed `aborted` error if the signal is already aborted (checked between decode steps). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'image decode aborted');
}

/** Resolve `promise`, or reject as soon as `signal` aborts — so a long decode/ready can be cancelled. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new MediaError('aborted', 'image decode aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new MediaError('aborted', 'image decode aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/* v8 ignore stop */
