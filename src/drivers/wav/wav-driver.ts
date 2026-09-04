/**
 * The WAV (RIFF/WAVE) container driver — hand-written TS. WAV is **little-endian** (unlike MP4) and
 * carries raw PCM (or IEEE float), so demux is a chunk walk: parse `fmt ` for the layout and the
 * `data` chunk header for duration. PCM is not a WebCodecs codec — it flows to the TS audio-dsp path —
 * so the codec token is `pcm-u8` / `pcm-s16` / `pcm-s24` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MuxOptions,
  type Muxer,
  type Packet,
  type PacketInfoTable,
  type PcmTransform,
  type Registry,
  type StageOptions,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type InterleavedPcmF32,
  type PcmAudio,
  type SampleFormat,
  decodePcm,
  decodePcmToInterleavedF32,
} from '../../dsp/pcm.ts';
import { matchesWav } from '../audio-container-sniff.ts';
import { planWavPcmCopy } from './pcm.ts';
import { streamWavPcmCopy } from './wav-copy-stream.ts';
import { WavMuxer } from './wav-mux.ts';
import { WAV_PACKET_FRAMES, wavPacketInfoFromSource } from './wav-packet-info.ts';
import {
  type ParsedWavHeader,
  WAV_DEMUX_HEAD_BYTES,
  type WavFormat,
  ascii,
  parseFormat,
  parseWav,
  parseWavHeader,
  parsedWavHeader,
  probeWav,
  readWavHead,
  wavTrackInfo,
} from './wav-probe.ts';
import { wavMuxTrackConfig } from '../audio-container-mux-validation.ts';
import type { TrackInfo } from '../../contracts/driver.ts';

export { wavPacketInfoFromBytes, wavPacketInfoFromUrl } from './wav-packet-info.ts';
export type { WavPacketInfoFromUrlOptions } from './wav-packet-info.ts';
export { parseWav } from './wav-probe.ts';
export type { WavInfo } from './wav-probe.ts';

interface SequentialWavDecode {
  readonly parsed: ParsedWavHeader;
  readonly chunks: PcmChunkReader;
}

const WAV_DECODE_RANGE_BYTES = 1024 * 1024;
const WAV_RANGE_RESAMPLE_MIN_SOURCE_BYTES = 8 * 1024 * 1024;
const OPERATION_ABORTED = 'operation aborted';

function pcmSampleFormat(fmt: WavFormat): SampleFormat {
  if (fmt.formatTag === 1) {
    if (fmt.bitsPerSample === 8) return 'u8';
    if (fmt.bitsPerSample === 16) return 's16';
    if (fmt.bitsPerSample === 24) return 's24';
    if (fmt.bitsPerSample === 32) return 's32';
  } else if (fmt.formatTag === 3) {
    if (fmt.bitsPerSample === 32) return 'f32';
    if (fmt.bitsPerSample === 64) return 'f64';
  }
  throw new InputError(
    `unsupported WAV PCM layout (tag ${fmt.formatTag}, ${fmt.bitsPerSample}-bit)`,
  );
}

/** Read the whole source into one buffer — PCM transforms need every sample (bounded by file size). */
async function readAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      if (done) {
        completed = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return out;
  } catch (error) {
    if (!completed && signal?.aborted !== true) await reader.cancel(error).catch(() => {});
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

interface PcmChunkReader {
  read(start: number, end: number): Promise<Uint8Array>;
  release(reason?: unknown): void | Promise<void>;
}

const EMPTY_BYTES = new Uint8Array(0);

function rangeBackedPcmChunkReader(
  source: ByteSource,
  sourceRange: NonNullable<ByteSource['range']>,
  prefix: Uint8Array,
  dataEnd: number,
  signal?: AbortSignal,
): PcmChunkReader {
  let windowStart = 0;
  let window = prefix;
  let activeSource: ByteSource | undefined = source;
  let activeRange: NonNullable<ByteSource['range']> | undefined = sourceRange;
  return {
    async read(start, end): Promise<Uint8Array> {
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const readSource = activeSource;
      const readRange = activeRange;
      if (readSource === undefined || readRange === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      const windowEnd = windowStart + window.byteLength;
      if (start >= windowStart && end <= windowEnd) {
        return window.subarray(start - windowStart, end - windowStart);
      }
      const overlapBytes = start >= windowStart && start < windowEnd ? windowEnd - start : 0;
      const requestStart = overlapBytes > 0 ? windowEnd : start;
      const requestEnd = Math.min(dataEnd, Math.max(end, requestStart + WAV_DECODE_RANGE_BYTES));
      const previousWindow = window;
      const previousWindowStart = windowStart;
      const nextWindow = await readRange.call(readSource, requestStart, requestEnd);
      if (signal?.aborted || activeSource === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      window = nextWindow;
      windowStart = requestStart;
      if (overlapBytes > 0) {
        const suffixBytes = Math.min(end - requestStart, window.byteLength);
        const bytes = new Uint8Array(overlapBytes + suffixBytes);
        bytes.set(
          previousWindow.subarray(
            start - previousWindowStart,
            start - previousWindowStart + overlapBytes,
          ),
        );
        bytes.set(window.subarray(0, suffixBytes), overlapBytes);
        return bytes;
      }
      return window.subarray(0, Math.min(end - start, window.byteLength));
    },
    release(): void {
      activeSource = undefined;
      activeRange = undefined;
      window = EMPTY_BYTES;
      windowStart = 0;
    },
  };
}

interface SequentialByteCursor {
  readonly position: number;
  read(length: number): Promise<Uint8Array>;
  skip(length: number): Promise<boolean>;
  release(reason?: unknown): Promise<void>;
}

function sequentialByteCursor(src: ByteSource, signal?: AbortSignal): SequentialByteCursor {
  const reader = src.stream().getReader();
  let chunk: Uint8Array = EMPTY_BYTES;
  let chunkOffset = 0;
  let position = 0;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const abortReader = (): void => {
    void release(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });

  const release = (reason?: unknown): Promise<void> => {
    releasePromise ??= (async () => {
      released = true;
      chunk = EMPTY_BYTES;
      chunkOffset = 0;
      signal?.removeEventListener('abort', abortReader);
      try {
        await reader.cancel(reason).catch(() => {});
      } finally {
        reader.releaseLock();
      }
    })();
    return releasePromise;
  };

  const nextChunk = async (): Promise<boolean> => {
    for (;;) {
      if (released || signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const next = await reader.read().catch((error: unknown): never => {
        if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
        if (error instanceof MediaError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new MediaError('demux-error', `WAV source read failed: ${message}`, error);
      });
      if (released || signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      if (next.done) return false;
      if (next.value.byteLength === 0) continue;
      chunk = next.value;
      chunkOffset = 0;
      return true;
    }
  };

  const read = async (length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MediaError('demux-error', `invalid WAV sequential read length ${length}`);
    }
    if (length === 0) return EMPTY_BYTES;
    let available = chunk.byteLength - chunkOffset;
    if (available === 0 && !(await nextChunk())) return EMPTY_BYTES;
    available = chunk.byteLength - chunkOffset;
    if (available >= length) {
      const bytes = chunk.subarray(chunkOffset, chunkOffset + length);
      chunkOffset += length;
      position += length;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
      return bytes;
    }

    const bytes = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      available = chunk.byteLength - chunkOffset;
      if (available === 0) {
        if (!(await nextChunk())) break;
        continue;
      }
      const count = Math.min(available, length - written);
      bytes.set(chunk.subarray(chunkOffset, chunkOffset + count), written);
      chunkOffset += count;
      written += count;
      position += count;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
    }
    return written === length ? bytes : bytes.subarray(0, written);
  };

  const skip = async (length: number): Promise<boolean> => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MediaError('demux-error', `invalid WAV sequential skip length ${length}`);
    }
    let remaining = length;
    while (remaining > 0) {
      let available = chunk.byteLength - chunkOffset;
      if (available === 0) {
        if (!(await nextChunk())) return false;
        available = chunk.byteLength - chunkOffset;
      }
      const count = Math.min(available, remaining);
      chunkOffset += count;
      position += count;
      remaining -= count;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
    }
    return true;
  };

  return {
    get position(): number {
      return position;
    },
    read,
    skip,
    release,
  };
}

async function sequentialWavDecode(
  src: ByteSource,
  signal?: AbortSignal,
): Promise<SequentialWavDecode> {
  const cursor = sequentialByteCursor(src, signal);
  try {
    const riff = await cursor.read(12);
    if (riff.byteLength < 12 || ascii(riff, 0, 4) !== 'RIFF' || ascii(riff, 8, 4) !== 'WAVE') {
      throw new InputError('not a RIFF/WAVE file');
    }
    let format: WavFormat | undefined;
    let chunks = 0;
    for (;;) {
      if (++chunks > 2048) {
        throw new MediaError(
          'demux-error',
          `WAV file has >2048 chunks (budget exceeded) at ${cursor.position}`,
        );
      }
      const header = await cursor.read(8);
      if (header.byteLength === 0) {
        if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
        const parsed = parsedWavHeader(format, 0, 0, false);
        return { parsed, chunks: sequentialPcmChunkReader(cursor, 0) };
      }
      if (header.byteLength < 8)
        throw new MediaError('demux-error', 'WAVE: truncated chunk header');
      const size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
        4,
        true,
      );
      const id = ascii(header, 0, 4);
      if (id === 'data') {
        if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
        const dataOffset = cursor.position;
        const dataBytes =
          src.size === undefined ? size : Math.min(size, Math.max(0, src.size - dataOffset));
        const parsed = parsedWavHeader(format, dataOffset, dataBytes, true);
        return { parsed, chunks: sequentialPcmChunkReader(cursor, dataOffset) };
      }

      const inspected = Math.min(size, id === 'fmt ' && size >= 16 ? 40 : 0);
      if (inspected > 0) {
        const body = await cursor.read(inspected);
        if (body.byteLength < inspected)
          throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
        format = parseFormat(new DataView(body.buffer, body.byteOffset, body.byteLength), 0, size);
      }
      const remaining = size - inspected + (size & 1);
      if (!(await cursor.skip(remaining))) {
        throw new MediaError('demux-error', `WAVE: truncated ${id || 'unknown'} chunk`);
      }
    }
  } catch (error) {
    await cursor.release(error);
    throw error;
  }
}

function sequentialPcmChunkReader(
  cursor: SequentialByteCursor,
  dataOffset: number,
): PcmChunkReader {
  let position = dataOffset;
  let active: SequentialByteCursor | undefined = cursor;
  return {
    async read(start, end): Promise<Uint8Array> {
      const current = active;
      if (current === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
      if (start !== position || end < start) {
        throw new MediaError(
          'demux-error',
          'WAV sequential PCM read moved outside its ordered payload',
        );
      }
      const bytes = await current.read(end - start);
      position += bytes.byteLength;
      return bytes;
    },
    release(reason): Promise<void> {
      const current = active;
      active = undefined;
      return current?.release(reason) ?? Promise.resolve();
    },
  };
}

function prefersSequentialPcmDecode(src: ByteSource): boolean {
  return src.range === undefined;
}

function wavDecodedChunkStream<T extends { readonly frames: number }>(
  parsed: ParsedWavHeader,
  readChunk: PcmChunkReader,
  decodeChunk: (bytes: Uint8Array) => T,
  signal?: AbortSignal,
): ReadableStream<T> {
  const totalFrames =
    parsed.bytesPerFrame > 0 ? Math.floor(parsed.dataBytes / parsed.bytesPerFrame) : 0;
  const rangeBoundFrames =
    parsed.bytesPerFrame > 0
      ? Math.max(1, Math.floor(WAV_DECODE_RANGE_BYTES / parsed.bytesPerFrame))
      : 1;
  const framesPerChunk = Math.min(WAV_PACKET_FRAMES, rangeBoundFrames);
  let frame = 0;
  let chunkReader: PcmChunkReader | undefined = readChunk;
  const releaseChunkReader = async (reason?: unknown): Promise<void> => {
    const active = chunkReader;
    chunkReader = undefined;
    await active?.release(reason);
  };
  return new ReadableStream<T>(
    {
      async pull(controller): Promise<void> {
        try {
          if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
          if (frame >= totalFrames) {
            await releaseChunkReader('WAV PCM data complete');
            controller.close();
            return;
          }
          const active = chunkReader;
          if (active === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
          const frameCount = Math.min(framesPerChunk, totalFrames - frame);
          const start = parsed.dataOffset + frame * parsed.bytesPerFrame;
          const end = start + frameCount * parsed.bytesPerFrame;
          const bytes = await active.read(start, end);
          if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
          const audio = decodeChunk(bytes);
          if (audio.frames !== frameCount) {
            throw new MediaError(
              'demux-error',
              'WAV PCM range ended before the declared data payload',
            );
          }
          controller.enqueue(audio);
          frame += frameCount;
          if (frame >= totalFrames) {
            await releaseChunkReader('WAV PCM data complete');
            controller.close();
          }
        } catch (error) {
          await releaseChunkReader(error);
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        frame = totalFrames;
        await releaseChunkReader(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function wavPcmChunkStream(
  parsed: ParsedWavHeader,
  format: SampleFormat,
  readChunk: PcmChunkReader,
  signal?: AbortSignal,
): ReadableStream<PcmAudio> {
  return wavDecodedChunkStream(
    parsed,
    readChunk,
    (bytes) => decodePcm(bytes, format, parsed.format.channels, parsed.format.sampleRate),
    signal,
  );
}

function wavInterleavedPcmChunkStream(
  parsed: ParsedWavHeader,
  format: SampleFormat,
  readChunk: PcmChunkReader,
  signal?: AbortSignal,
): ReadableStream<InterleavedPcmF32> {
  return wavDecodedChunkStream(
    parsed,
    readChunk,
    (bytes) =>
      decodePcmToInterleavedF32(bytes, format, parsed.format.channels, parsed.format.sampleRate),
    signal,
  );
}

export const WavDriver: ContainerDriver = {
  id: 'wav',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['wav'],
  supports: matchesWav,
  validatesPcmTrim: true,
  probe: probeWav,
  async demux(src: ByteSource): Promise<Demuxer> {
    const head = await readWavHead(src, WAV_DEMUX_HEAD_BYTES);
    const info = parseWav(head, src.size);
    const track = wavTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'WAV PCM packets flow through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: { kind: 'route', id: 'demux' }, tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    return wavPacketInfoFromSource(src, o);
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const opts: PcmTransform = o ?? {};
    const container = opts.container ?? 'wav';
    let bytes: Uint8Array | undefined;
    let transformDependencies: Promise<typeof import('./transform-dependencies.ts')> | undefined;
    const loadTransformDependencies = (): Promise<typeof import('./transform-dependencies.ts')> => {
      transformDependencies ??= import('./transform-dependencies.ts');
      return transformDependencies;
    };
    let sampleTransformDependencies: Promise<typeof import('./sample-transform.ts')> | undefined;
    const loadSampleTransformDependencies = (): Promise<typeof import('./sample-transform.ts')> => {
      sampleTransformDependencies ??= import('./sample-transform.ts');
      return sampleTransformDependencies;
    };
    let s16ResampleDependencies: Promise<typeof import('./s16-resample.ts')> | undefined;
    const loadS16ResampleDependencies = (): Promise<typeof import('./s16-resample.ts')> => {
      s16ResampleDependencies ??= import('./s16-resample.ts');
      return s16ResampleDependencies;
    };
    let f32GainDependencies: Promise<typeof import('./f32-gain.ts')> | undefined;
    const loadF32GainDependencies = (): Promise<typeof import('./f32-gain.ts')> => {
      f32GainDependencies ??= import('./f32-gain.ts');
      return f32GainDependencies;
    };
    if (
      container === 'wav' &&
      opts.gainDb === undefined &&
      opts.fade === undefined &&
      opts.mixMatrix === undefined &&
      opts.dynamics === undefined &&
      opts.biquad === undefined
    ) {
      if (opts.timeBounds !== undefined) {
        const { tryTimeSlice } = await import('./pcm-range-slice.ts');
        const sliced = await tryTimeSlice(src, opts);
        if (sliced !== undefined) return sliced;
      } else {
        if (
          opts.sampleRate !== undefined &&
          src.range !== undefined &&
          src.size !== undefined &&
          src.size >= WAV_RANGE_RESAMPLE_MIN_SOURCE_BYTES
        ) {
          const loadedResampler = await loadS16ResampleDependencies();
          const streamed = await loadedResampler.tryStreamResampleWavS16ToS16Wav(src, opts);
          if (streamed !== undefined) return streamed;
        }
        bytes = await readAll(src, opts.signal);
        if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
        const copyPlan = planWavPcmCopy(
          bytes,
          opts.sampleFormat,
          opts.endian,
          opts.channels,
          opts.sampleRate,
        );
        if (copyPlan !== undefined) {
          return streamWavPcmCopy(copyPlan, opts.signal);
        }
        if (opts.sampleRate !== undefined) {
          const loadedResampler = await loadS16ResampleDependencies();
          const resampled = loadedResampler.tryResampleWavS16ToS16Wav(bytes, opts);
          if (resampled !== undefined) {
            return byteStream(resampled);
          }
        }
        if (opts.channels !== undefined || opts.mixMatrix !== undefined) {
          const loadedDirect = await loadSampleTransformDependencies();
          const transformed = loadedDirect.tryTransformWavSamplesToWav(bytes, opts);
          if (transformed !== undefined) return byteStream(transformed);
        }
        const loaded = await loadTransformDependencies();
        const converted = loaded.tryConvertWavPcmFormatToWav(bytes, opts);
        if (converted !== undefined) {
          return byteStream(converted);
        }
      }
    }
    if (
      container === 'wav' &&
      opts.dynamics === undefined &&
      opts.biquad === undefined &&
      opts.timeBounds === undefined
    ) {
      bytes ??= await readAll(src, opts.signal);
      if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      if (opts.gainDb !== undefined) {
        const loadedGain = await loadF32GainDependencies();
        const gained = loadedGain.tryGainWavF32ToF32Wav(bytes, opts);
        if (gained !== undefined) return byteStream(gained);
      }
      const loadedDirect = await loadSampleTransformDependencies();
      const transformed = loadedDirect.tryTransformWavSamplesToWav(bytes, opts);
      if (transformed !== undefined) return byteStream(transformed);
    }
    let loaded: typeof import('./transform-dependencies.ts');
    if (bytes === undefined) {
      [bytes, loaded] = await Promise.all([readAll(src, opts.signal), loadTransformDependencies()]);
    } else {
      loaded = await loadTransformDependencies();
    }
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const aiff = loaded.tryRewriteWavPcmToAiffBe(bytes, opts);
    if (aiff !== undefined) {
      return byteStream(aiff);
    }
    const wav = loaded.readWavPcm(bytes);
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const audio = loaded.applyPcmTransform(wav, opts);
    const out = loaded.writePcmContainer(
      audio,
      container,
      loaded.resolvePcmSampleFormat(container, wav.format, opts.sampleFormat),
      opts.endian ?? 'le',
    );
    return byteStream(out);
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const [{ readWavPcm }, bytes] = await Promise.all([
      import('./pcm.ts'),
      readAll(src, o?.signal),
    ]);
    const wav = readWavPcm(bytes);
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return wav;
  },
  async decodePcmAudioStream(src: ByteSource, o?: StageOptions): Promise<ReadableStream<PcmAudio>> {
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    if (prefersSequentialPcmDecode(src)) {
      const { parsed, chunks } = await sequentialWavDecode(src, o?.signal);
      if (o?.signal?.aborted) {
        await chunks.release(o.signal.reason);
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      return wavPcmChunkStream(parsed, pcmSampleFormat(parsed.format), chunks, o?.signal);
    }
    if (src.range !== undefined) {
      const maxHead = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
      const prefix = await src.range(0, maxHead);
      if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const parsed = parseWavHeader(prefix, src.size);
      if (parsed.dataFound) {
        const format = pcmSampleFormat(parsed.format);
        const range = src.range;
        return wavPcmChunkStream(
          parsed,
          format,
          rangeBackedPcmChunkReader(
            src,
            range,
            prefix,
            parsed.dataOffset + parsed.dataBytes,
            o?.signal,
          ),
          o?.signal,
        );
      }
    }
    throw new MediaError('demux-error', 'WAV PCM source has no readable byte path');
  },
  async decodePcmInterleavedStream(
    src: ByteSource,
    o?: StageOptions,
  ): Promise<ReadableStream<InterleavedPcmF32>> {
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    if (prefersSequentialPcmDecode(src)) {
      const { parsed, chunks } = await sequentialWavDecode(src, o?.signal);
      if (o?.signal?.aborted) {
        await chunks.release(o.signal.reason);
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      return wavInterleavedPcmChunkStream(
        parsed,
        pcmSampleFormat(parsed.format),
        chunks,
        o?.signal,
      );
    }
    if (src.range !== undefined) {
      const maxHead = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
      const prefix = await src.range(0, maxHead);
      if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const parsed = parseWavHeader(prefix, src.size);
      if (parsed.dataFound) {
        const format = pcmSampleFormat(parsed.format);
        const range = src.range;
        return wavInterleavedPcmChunkStream(
          parsed,
          format,
          rangeBackedPcmChunkReader(
            src,
            range,
            prefix,
            parsed.dataOffset + parsed.dataBytes,
            o?.signal,
          ),
          o?.signal,
        );
      }
    }
    throw new MediaError('demux-error', 'WAV PCM source has no readable byte path');
  },
  validateMuxTrack(track: TrackInfo, index: number): void {
    wavMuxTrackConfig(track, index);
  },
  createMuxer(o?: MuxOptions): Muxer {
    return new WavMuxer(o);
  },
};

export const WavModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(WavDriver);
  },
};

export default WavModule;
