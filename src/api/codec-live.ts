/**
 * Live stream composition (S13 layer 3, docs/architecture/codec-pipeline.md §3.2): the drains, seek
 * control flow, abort domains, and VPx-alpha encode pairing that connect demuxers, codec drivers, and
 * muxers under WHATWG backpressure (the frame-pixel split/merge, packet projection, and decode-side
 * pairing live in `vpx-alpha.ts`). These compose real streams but touch only `.timestamp`/`.type` and
 * `close()` on the items, so the control flow (close-exactly-once under success/cancel/error, abort
 * domains, pairing bounds) is Node-tested with counting fakes; the live round-trips with real
 * `VideoFrame`s are validated in the browser harness (ADR-016, BUILD §6.1).
 *
 * Every pairing output pins `{ highWaterMark: 0 }` — like `unwrapPackets` — so no queue forms ahead of
 * the consumer and the alpha-pairing buffer stays bounded by the encoder reorder distance (§5 item 8).
 */

import type {
  DecoderConfig,
  EncodedChunk,
  Packet,
  RawFrame,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import { closeFrame } from '../kernel/frames.ts';
import type { GaplessNativeSuppressionProbe } from './gapless-native-suppression.ts';
import {
  AlphaPairingBuffer,
  alphaChunkStream,
  alphaPairingOverflow,
  dropEncodedChunk,
  splitFrameForVpxAlpha,
  unwrapPackets,
} from './vpx-alpha.ts';

// ============ stream-factory option shapes ============

export interface VpxAlphaEncodeOptions {
  readonly config: VideoEncoderConfig;
  readonly createEncoder: (
    config: VideoEncoderConfig,
    o?: StageOptions,
  ) => TransformStream<RawFrame, EncodedChunk>;
  readonly colorStage?: StageOptions;
  readonly alphaStage?: StageOptions;
}

export interface VpxAlphaPacketTranscodeOptions {
  readonly decodeConfig: DecoderConfig;
  readonly encodeConfig: VideoEncoderConfig;
  readonly createDecoder: (
    config: DecoderConfig,
    o?: StageOptions,
  ) => TransformStream<EncodedChunk, RawFrame>;
  readonly createEncoder: (
    config: VideoEncoderConfig,
    o?: StageOptions,
  ) => TransformStream<RawFrame, EncodedChunk>;
  readonly decodeStage?: StageOptions;
  readonly colorStage?: StageOptions;
  readonly alphaStage?: StageOptions;
  /** Preserve same-codec alpha access units instead of decoding and re-encoding that independent plane. */
  readonly copyAlpha?: boolean;
}

export interface VpxAlphaFrameTranscodeOptions {
  readonly createEncoder: (
    config: VideoEncoderConfig,
    o?: StageOptions,
  ) => TransformStream<RawFrame, EncodedChunk>;
  readonly encodeConfig: VideoEncoderConfig;
  readonly colorStage?: StageOptions;
  readonly alphaStage?: StageOptions;
}

// ============ seek: drop-until-target predicate ============

/**
 * Frame-accurate seek bookkeeping: given a decoded frame's presentation `timestamp` (µs) and the seek
 * `target` (µs), should the frame be **kept** (it is the first frame at/after the target) or dropped
 * (it precedes the target and must be `close()`d)? Pure and total, exercised directly in Node. The live
 * loop ({@link seekFrame}) closes every dropped frame and returns the first kept one.
 */
export function frameSatisfiesSeek(timestampUs: number, targetUs: number): boolean {
  return timestampUs >= targetUs;
}

/** Apply parsed encoder-delay/padding facts to a decoded audio stream, or preserve identity when absent. */
export async function decodedAudioStreamWithGapless(
  frames: ReadableStream<AudioData>,
  track: TrackInfo,
  suppressionProbe?: GaplessNativeSuppressionProbe,
): Promise<ReadableStream<AudioData>> {
  if (track.gapless === undefined) return frames;
  let gapless = track.gapless;
  const leadingSamples = gapless.leadingSamples;
  const config = track.config;
  if (
    suppressionProbe !== undefined &&
    gapless.basis === 'mp4-edit-list' &&
    leadingSamples !== undefined &&
    config !== undefined &&
    'sampleRate' in config
  ) {
    const { nativeSuppressedMp4EditSamples } = await import('./gapless-native-suppression.ts');
    const nativeSuppressed = await nativeSuppressedMp4EditSamples(
      suppressionProbe,
      leadingSamples,
      config.sampleRate,
    );
    if (nativeSuppressed > 0) {
      gapless = { ...gapless, leadingSamples: Math.max(0, leadingSamples - nativeSuppressed) };
    }
  }
  const { restampAudioDataRange, trimAudioGaplessFrameStream } = await import('./trim-streams.ts');
  return trimAudioGaplessFrameStream(frames, gapless, restampAudioDataRange);
}

/** The minimal `Muxer` surface {@link drainEncoderToMuxer} needs (addTrack + write a {@link Packet}). */
export interface MuxerSink {
  addTrack(info: TrackInfo): number;
  write(trackId: number, packet: Packet): Promise<void>;
}

/** One operation-scoped abort domain for concurrent encoder/packet drains. */
export interface DrainTaskGroup {
  readonly signal: AbortSignal;
  run(tasks: readonly Promise<void>[]): Promise<void>;
  dispose(): void;
}

/**
 * Link sibling drains without aborting the caller-owned parent controller. The first task failure is the
 * public error; it aborts every sibling reader, waits for all teardown to settle, then rethrows that same
 * error. Parent cancellation enters the same domain and the explicit dispose removes its listener.
 */
export function createDrainTaskGroup(parent: AbortSignal): DrainTaskGroup {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) onParentAbort();
  else parent.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    async run(tasks): Promise<void> {
      try {
        await Promise.all(tasks);
      } catch (error) {
        controller.abort(error);
        await Promise.allSettled(tasks);
        throw error;
      }
    },
    dispose(): void {
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Normalize a seam item to a {@link Packet}: a bare {@link EncodedChunk} from an *encoder* (PTS only, the
 * muxer recovers DTS from arrival/durations) is wrapped `{ chunk }`; a {@link Packet} from a *demuxer*
 * (verbatim remux — already carries `dtsUs`) passes through. `'chunk' in v` cleanly discriminates: the
 * sealed `Encoded*Chunk` host objects have no `chunk` property. Pure + total.
 */
function toPacket(v: EncodedChunk | Packet): Packet {
  return v instanceof Object && 'chunk' in v ? v : { chunk: v };
}

/**
 * Encode an RGBA VPx stream as Matroska/WebM-compatible colour packets plus VPx alpha side packets.
 * Chromium's WebCodecs encoder does not expose a second alpha chunk from a single encode call, while our
 * WebM muxer writes the Matroska alpha form through `Packet.alpha`. We therefore split each input frame
 * into an opaque-colour frame and a grayscale-alpha frame, feed two identical VPx encoders, then pair the
 * encoded chunks by timestamp. The original input frame is closed exactly once after its pixels have been
 * copied; the derived frames are owned and closed by the encoder drivers.
 */
export function encodeVideoFramesWithAlpha(
  frames: ReadableStream<VideoFrame>,
  options: VpxAlphaEncodeOptions,
): ReadableStream<Packet> {
  const colorEncoder = options.createEncoder(options.config, options.colorStage);
  const alphaEncoder = options.createEncoder(options.config, options.alphaStage);
  const inputReader = frames.getReader();
  const colorWriter = colorEncoder.writable.getWriter();
  const alphaWriter = alphaEncoder.writable.getWriter();
  const colorReader = colorEncoder.readable.getReader();
  const alphaReader = alphaEncoder.readable.getReader();
  const alphaChunks = new AlphaPairingBuffer<EncodedChunk>(
    alphaReader,
    dropEncodedChunk,
    alphaPairingOverflow('encode', 'alpha packets'),
  );
  let pumpPromise: Promise<void> | undefined;
  const writeDerivedFrame = async (
    writer: WritableStreamDefaultWriter<RawFrame>,
    frame: VideoFrame,
  ): Promise<void> => {
    try {
      await writer.ready;
    } catch (error) {
      closeFrame(frame);
      throw error;
    }
    // Before write, this function owns the derived frame. Once write is invoked, the encoder driver
    // owns it on both success and failure and closes it from its transform's finally block.
    await writer.write(frame);
  };

  const pumpInput = (): Promise<void> => {
    pumpPromise ??= (async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await inputReader.read();
          if (done) break;
          let split: { color: VideoFrame; alpha: VideoFrame } | undefined;
          try {
            split = await splitFrameForVpxAlpha(value);
          } finally {
            closeFrame(value);
          }
          await Promise.all([
            writeDerivedFrame(colorWriter, split.color),
            writeDerivedFrame(alphaWriter, split.alpha),
          ]);
        }
        await Promise.all([colorWriter.close(), alphaWriter.close()]);
      } catch (error) {
        await Promise.allSettled([colorWriter.abort(error), alphaWriter.abort(error)]);
        // Cancel the upstream producer, not merely release it: undelivered decoded frames belong to
        // the source (its cancel closes them). Releasing alone would orphan them un-closed (item 7).
        await inputReader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        inputReader.releaseLock();
        colorWriter.releaseLock();
        alphaWriter.releaseLock();
      }
    })();
    return pumpPromise;
  };

  return new ReadableStream<Packet>(
    {
      start(): void {
        void pumpInput().catch(() => undefined);
      },
      async pull(controller): Promise<void> {
        try {
          const { done, value: color } = await colorReader.read();
          if (done) {
            await pumpInput();
            controller.close();
            return;
          }
          const alpha = await alphaChunks.claim(color.timestamp);
          if (alpha === undefined) {
            throw new MediaError(
              'encode-error',
              `VPx alpha encode produced no alpha packet for timestamp ${color.timestamp}`,
            );
          }
          controller.enqueue({ chunk: color, alpha });
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        await Promise.allSettled([
          inputReader.cancel(reason),
          colorReader.cancel(reason),
          alphaReader.cancel(reason),
          colorWriter.abort(reason),
          alphaWriter.abort(reason),
          ...(alphaChunks.pending === undefined ? [] : [alphaChunks.pending]),
        ]);
        await pumpPromise?.catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Transcode a WebM/Matroska VPx-alpha packet stream without materializing merged RGBA frames. The demuxer
 * already exposes color chunks and alpha side chunks separately, so an unfiltered alpha-preserving VPx
 * transcode can decode+encode each elementary stream independently and pair the re-encoded packets by PTS.
 * A colour packet with no exact alpha partner passes through alpha-less (mixed-alpha sources are legal).
 */
export function transcodeVpxAlphaPackets(
  packets: ReadableStream<Packet>,
  options: VpxAlphaPacketTranscodeOptions,
): ReadableStream<Packet> {
  const [colorPackets, alphaPackets] = packets.tee();
  const colorChunks = unwrapPackets(colorPackets)
    .pipeThrough(options.createDecoder(options.decodeConfig, options.decodeStage))
    .pipeThrough(options.createEncoder(options.encodeConfig, options.colorStage));
  const alphaInput = alphaChunkStream(alphaPackets);
  const alphaChunks =
    options.copyAlpha === true
      ? alphaInput
      : alphaInput
          .pipeThrough(options.createDecoder(options.decodeConfig, options.decodeStage))
          .pipeThrough(options.createEncoder(options.encodeConfig, options.alphaStage));
  const colorReader = colorChunks.getReader();
  const alphaReader = alphaChunks.getReader();
  const pairing = new AlphaPairingBuffer<EncodedChunk>(
    alphaReader,
    dropEncodedChunk,
    alphaPairingOverflow('encode', 'alpha packets'),
  );

  const cancelReaders = async (reason: unknown): Promise<void> => {
    await Promise.allSettled([
      colorReader.cancel(reason),
      alphaReader.cancel(reason),
      ...(pairing.pending === undefined ? [] : [pairing.pending]),
    ]);
  };

  return new ReadableStream<Packet>(
    {
      async pull(controller): Promise<void> {
        try {
          pairing.prefetch();
          const { done, value: color } = await colorReader.read();
          if (done) {
            await alphaReader.cancel('color stream ended');
            controller.close();
            return;
          }
          const alpha = await pairing.claim(color.timestamp);
          controller.enqueue(
            alpha === undefined
              ? { chunk: color }
              : { chunk: color, alpha: alpha as EncodedVideoChunk },
          );
        } catch (error) {
          await cancelReaders(error);
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        await cancelReaders(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Encode already-separated colour and alpha frames after an independent geometry transform. Both
 * streams are consumed under normal TransformStream backpressure and paired by exact PTS; a missing
 * alpha timestamp is a typed encode failure rather than a silent opaque output. The encoder stages own
 * and close every input `VideoFrame`, while this pairing layer owns only encoded chunks.
 */
export function encodeVpxAlphaFrameStreams(
  colorFrames: ReadableStream<VideoFrame>,
  alphaFrames: ReadableStream<VideoFrame>,
  options: VpxAlphaFrameTranscodeOptions,
): ReadableStream<Packet> {
  const colorChunks = colorFrames.pipeThrough(
    options.createEncoder(options.encodeConfig, options.colorStage),
  );
  const alphaChunks = alphaFrames.pipeThrough(
    options.createEncoder(options.encodeConfig, options.alphaStage),
  );
  const colorReader = colorChunks.getReader();
  const alphaReader = alphaChunks.getReader();
  const pairing = new AlphaPairingBuffer<EncodedChunk>(
    alphaReader,
    dropEncodedChunk,
    alphaPairingOverflow('encode', 'alpha packets'),
  );

  const cancelReaders = async (reason: unknown): Promise<void> => {
    await Promise.allSettled([
      colorReader.cancel(reason),
      alphaReader.cancel(reason),
      ...(pairing.pending === undefined ? [] : [pairing.pending]),
    ]);
  };

  return new ReadableStream<Packet>(
    {
      async pull(controller): Promise<void> {
        try {
          pairing.prefetch();
          const { done, value: color } = await colorReader.read();
          if (done) {
            await alphaReader.cancel('color stream ended');
            controller.close();
            return;
          }
          const alpha = await pairing.claim(color.timestamp);
          if (alpha === undefined) {
            throw new MediaError(
              'encode-error',
              `VPx alpha geometry encode produced no alpha packet for timestamp ${color.timestamp}`,
            );
          }
          controller.enqueue({ chunk: color, alpha: alpha as EncodedVideoChunk });
        } catch (error) {
          await cancelReaders(error);
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        await cancelReaders(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Drain a seam stream into a `Muxer`. A callable config is the encoder bridge: the track is allocated
 * lazily on the first item, after the encoder has published its `decoderConfig`/`onConfig` metadata. A
 * concrete {@link TrackInfo} is the packet-copy bridge: `addTrack()` validates it before the producer is
 * pulled, so an illegal codec/container pair cannot consume the caller's first packet. Serves BOTH seam
 * producers: an encoder's bare {@link EncodedChunk}s (PTS only — the muxer recovers DTS from arrival
 * order/durations) and a demuxer's {@link Packet}s (verbatim remux — carrying the source `dtsUs` so
 * B-frame composition survives losslessly); each item is normalized via {@link toPacket} before `write`.
 * Returns when the stream ends. An empty encoder stream allocates no track; a known packet track is
 * deliberately validated/allocated before its stream is inspected.
 *
 * Frame lifetime: packets are not closable; the encoder already closed every input `VideoFrame`/
 * `AudioData` (its contract). This drain owns its reader: write/config failure and operation abort cancel
 * the locked producer before releasing it, while a higher-level task group remains responsible for
 * aborting sibling drains.
 */
export async function drainEncoderToMuxer(
  chunks: ReadableStream<EncodedChunk | Packet>,
  muxer: MuxerSink,
  config: TrackInfo | (() => TrackInfo),
  signal?: AbortSignal,
): Promise<void> {
  const abortFailure = (): MediaError =>
    new MediaError('aborted', 'operation aborted', signal?.reason);
  const isAborted = (): boolean => signal?.aborted === true;
  if (isAborted()) {
    const error = abortFailure();
    await chunks.cancel(error).catch(() => {});
    throw error;
  }

  let lazyConfig: (() => TrackInfo) | undefined;
  let trackId: number | undefined;
  if (typeof config === 'function') {
    lazyConfig = config;
  } else {
    try {
      trackId = muxer.addTrack(config);
    } catch (error) {
      await chunks.cancel(error).catch(() => {});
      throw error;
    }
  }

  const reader = chunks.getReader();
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (reason: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {});
    return cancelPromise;
  };
  const onAbort = (): void => {
    void cancelReader(abortFailure());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (isAborted()) throw abortFailure();
      const { done, value } = await reader.read();
      if (isAborted()) throw abortFailure();
      if (done) break;
      if (trackId === undefined) {
        if (lazyConfig === undefined) {
          throw new MediaError('mux-error', 'known packet track was not allocated');
        }
        trackId = muxer.addTrack(lazyConfig());
      }
      await muxer.write(trackId, toPacket(value));
      if (isAborted()) throw abortFailure();
    }
  } catch (error) {
    await cancelReader(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancelPromise;
    reader.releaseLock();
  }
}

/**
 * Scan to the last keyframe at/before `targetUs`, then continue through the same reader. The bounded
 * buffer holds only the current GOP and cancellation propagates to the packet producer.
 */
export async function startAtSeekKeyframe(
  packets: ReadableStream<EncodedChunk>,
  targetUs: number,
): Promise<ReadableStream<EncodedChunk>> {
  const reader = packets.getReader();
  const head: EncodedChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'key' && value.timestamp <= targetUs) {
      head.length = 0;
      head.push(value);
    } else {
      head.push(value);
    }
    if (value.timestamp > targetUs) break;
  }
  return continueSeekStream(reader, head);
}

/** Packet-preserving variant of {@link startAtSeekKeyframe} for VPx alpha side data. */
export async function startAtSeekKeyframePackets(
  packets: ReadableStream<Packet>,
  targetUs: number,
): Promise<ReadableStream<Packet>> {
  const reader = packets.getReader();
  const head: Packet[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.chunk.type === 'key' && value.chunk.timestamp <= targetUs) {
      head.length = 0;
      head.push(value);
    } else {
      head.push(value);
    }
    if (value.chunk.timestamp > targetUs) break;
  }
  return continueSeekStream(reader, head);
}

function continueSeekStream<T>(
  reader: ReadableStreamDefaultReader<T>,
  head: readonly T[],
): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller): void {
      for (const value of head) controller.enqueue(value);
    },
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Run a seek: pull decoded `VideoFrame`s from `frames`, `close()` every frame whose timestamp precedes
 * `targetUs`, and resolve with the first frame at/after it (ownership transfers to the caller, who must
 * `close()` it). If the stream ends before reaching the target, the *last* decoded frame is returned (the
 * closest available, e.g. seeking past the final PTS); a stream with no frames at all rejects with a
 * typed {@link InputError}. The reader is cancelled once the target frame is found so the decoder tears
 * down and the remaining packets stop flowing. Every dropped frame is `close()`d exactly once (doc 06 §3).
 */
export async function seekFrame(
  frames: ReadableStream<VideoFrame>,
  targetUs: number,
): Promise<VideoFrame> {
  const reader = frames.getReader();
  let last: VideoFrame | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (frameSatisfiesSeek(value.timestamp, targetUs)) {
        // Found the target frame; close the previous candidate (if any) and hand this one to the caller.
        if (last !== undefined) closeFrame(last);
        last = undefined;
        await reader.cancel(); // stop the decoder before handing ownership back to the caller
        return value;
      }
      // This frame precedes the target: it is a drop. Keep it only as the running "closest" fallback.
      if (last !== undefined) closeFrame(last);
      last = value;
    }
  } catch (e) {
    if (last !== undefined) closeFrame(last);
    await reader.cancel(e).catch(() => {});
    throw e;
  }
  if (last !== undefined) return last; // sought past the last PTS → closest available frame
  throw new InputError('no seek frame');
}
