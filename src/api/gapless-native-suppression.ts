import type { EncodedChunk, Packet, RawFrame } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';

/** AAC edit priming is normally one or two access units; keep runtime detection strictly bounded. */
export const MP4_GAPLESS_PREFLIGHT_MAX_PACKETS = 8 as const;

export interface GaplessNativeSuppressionProbe {
  readonly packets: ReadableStream<Packet>;
  readonly createDecoder: () => TransformStream<EncodedChunk, RawFrame>;
  readonly signal?: AbortSignal | undefined;
}

export interface GaplessNativeSuppressionOptions {
  /**
   * Probe the first coded packets even when their container timestamps are non-negative. Ogg Opus
   * permits a positive initial granule offset while OpusHead pre-skip still consumes decoder output.
   */
  readonly probeFromFirstPacket?: boolean;
}

interface GaplessPrefix {
  readonly chunks: readonly EncodedChunk[];
  readonly expectedSamples: number;
}

function durationSamples(chunk: EncodedChunk, sampleRate: number): number {
  const durationUs = chunk.duration;
  if (durationUs === null || !Number.isFinite(durationUs) || durationUs <= 0) return 0;
  return Math.max(0, Math.round((durationUs * sampleRate) / 1_000_000));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

async function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<T>> {
  throwIfAborted(signal);
  if (signal === undefined) return reader.read() as Promise<ReadableStreamReadResult<T>>;
  return new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new MediaError('aborted', 'operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result as ReadableStreamReadResult<T>);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function collectPrimingPrefix(
  packets: ReadableStream<Packet>,
  leadingSamples: number,
  sampleRate: number,
  signal: AbortSignal | undefined,
  probeFromFirstPacket: boolean,
): Promise<GaplessPrefix> {
  const reader = packets.getReader();
  const chunks: EncodedChunk[] = [];
  let expectedSamples = 0;
  let exhausted = false;
  try {
    while (chunks.length < MP4_GAPLESS_PREFLIGHT_MAX_PACKETS && expectedSamples < leadingSamples) {
      const next = await readWithAbort(reader, signal);
      if (next.done) {
        exhausted = true;
        break;
      }
      if (!probeFromFirstPacket && next.value.chunk.timestamp >= 0) break;
      chunks.push(next.value.chunk);
      expectedSamples += durationSamples(next.value.chunk, sampleRate);
    }
  } finally {
    if (!exhausted) await reader.cancel();
    reader.releaseLock();
  }
  return { chunks, expectedSamples };
}

function prefixChunkStream(chunks: readonly EncodedChunk[]): ReadableStream<EncodedChunk> {
  let index = 0;
  return new ReadableStream<EncodedChunk>(
    {
      pull(controller): void {
        const chunk = chunks[index];
        index++;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

async function decodedPrefixSamples(
  chunks: readonly EncodedChunk[],
  createDecoder: () => TransformStream<EncodedChunk, RawFrame>,
  signal: AbortSignal | undefined,
): Promise<number> {
  const decoded = prefixChunkStream(chunks).pipeThrough(createDecoder());
  const reader = decoded.getReader();
  let samples = 0;
  let exhausted = false;
  try {
    for (;;) {
      const next = await readWithAbort(reader, signal);
      if (next.done) {
        exhausted = true;
        return samples;
      }
      const frame = next.value;
      try {
        if (!('numberOfFrames' in frame)) throw new TypeError('audio preflight emitted video');
        samples += frame.numberOfFrames;
      } finally {
        frame.close();
      }
    }
  } finally {
    if (!exhausted) await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Measure how many container-declared priming samples the selected decoder already consumed. Packet
 * timestamps alone cannot answer this: Chromium may consume MP4 edit-list AAC priming, and an Ogg-mode
 * Opus decoder consumes OpusHead pre-skip, while a raw/WASM decoder can expose those samples. Decode only
 * a bounded priming prefix through an independent decoder instance, close every probe frame, and compare
 * its exact decoded sample count with the packet-duration expectation. If a prefix-only decode is
 * unsupported, preserve the conservative historical behavior (zero native suppression) and let the full
 * decoder remain authoritative.
 */
export async function nativeSuppressedGaplessSamples(
  probe: GaplessNativeSuppressionProbe,
  leadingSamples: number,
  sampleRate: number,
  options: GaplessNativeSuppressionOptions = {},
): Promise<number> {
  if (
    !Number.isSafeInteger(leadingSamples) ||
    leadingSamples <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return 0;
  }
  throwIfAborted(probe.signal);
  const prefix = await collectPrimingPrefix(
    probe.packets,
    leadingSamples,
    sampleRate,
    probe.signal,
    options.probeFromFirstPacket === true,
  );
  if (prefix.chunks.length === 0 || prefix.expectedSamples === 0) return 0;
  let observedSamples: number;
  try {
    observedSamples = await decodedPrefixSamples(prefix.chunks, probe.createDecoder, probe.signal);
  } catch (error: unknown) {
    if (error instanceof MediaError && error.code === 'aborted') throw error;
    return 0;
  }
  throwIfAborted(probe.signal);
  const missingSamples = Math.max(0, prefix.expectedSamples - observedSamples);
  // One independently-rounded packet duration can differ by at most one sample. Never interpret that
  // representational drift as native priming suppression.
  if (missingSamples <= prefix.chunks.length) return 0;
  return Math.min(leadingSamples, missingSamples);
}

/** Backward-compatible name for the original MP4-only caller/tests. */
export const nativeSuppressedMp4EditSamples = nativeSuppressedGaplessSamples;
