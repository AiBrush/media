/**
 * The native FLAC container driver — hand-written TS. A FLAC stream is `fLaC` magic followed by
 * metadata blocks; the first is always `STREAMINFO`, which carries sample rate, channel count, bit
 * depth, and total sample count (→ duration). FLAC *decode* is implemented in **pure TS** (ADR-024,
 * `codecs/flac`) and exposed via `decodePcm` (FLAC → WAV) — both probe and decode are browser-free; only
 * the WebCodecs `EncodedChunk` packet seam stays browser-side.
 *
 * STREAMINFO packs `sampleRate:20 | channels-1:3 | bitsPerSample-1:5 | totalSamples:36` big-endian.
 */

import {
  type FlacFrameSpan,
  decodeFlac,
  interleavedPcmBytes as decodedInterleavedPcmBytes,
} from '../../codecs/flac/decode.ts';
import {
  type FlacEncodeOptions,
  encodeFlac,
  finalizeMd5,
  flacPcmFromPcmAudio,
  newMd5State,
  updateMd5,
} from '../../codecs/flac/encode.ts';
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
  type StreamCopyOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import type { PcmAudio, SampleFormat } from '../../dsp/index.ts';
import { OggMuxer } from '../ogg/ogg-write.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { writeWav } from '../wav/pcm.ts';
import {
  type FastFlacFrameSpan,
  type FlacStreamInfo,
  ascii,
  fastFlacFrames,
  flacMetadataLayout,
  flacOffset,
  flacPacketInfoTable,
  flacTrackInfo,
  matchesFlac,
  parseFlacStreamInfo,
} from './flac-sniff.ts';

export type FlacInfo = FlacStreamInfo;

export type FlacFrame = FlacFrameSpan;

/** Parse the `STREAMINFO` block into the audio layout + duration. Pure; big-endian. */
export function parseFlac(bytes: Uint8Array): FlacInfo {
  return parseFlacStreamInfo(bytes);
}

/** Return the native FLAC metadata prelude (`fLaC` + all metadata blocks), excluding audio frames. */
export function nativeFlacMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const start = flacOffset(bytes);
  if (bytes.byteLength < start + 8 || ascii(bytes, start, 4) !== 'fLaC') {
    throw new InputError('unsupported-input', 'not a native FLAC stream (no fLaC marker)');
  }
  let at = start + 4;
  for (;;) {
    if (at + 4 > bytes.byteLength)
      throw new MediaError('demux-error', 'FLAC: truncated metadata block');
    const last = ((bytes[at] as number) & 0x80) !== 0;
    const len =
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number);
    const next = at + 4 + len;
    if (next > bytes.byteLength)
      throw new MediaError('demux-error', 'FLAC: truncated metadata block');
    at = next;
    if (last) return bytes.slice(start, at);
  }
}

function writeFlacPacketCopy(
  bytes: Uint8Array,
  trim: StreamCopyOptions['trim'] | undefined,
): Uint8Array<ArrayBuffer> {
  const layout = flacMetadataLayout(bytes);
  if (trim !== undefined) {
    if (trim.startSec < 0) throw new InputError('unsupported-input', 'trim start < 0');
    if (trim.endSec <= trim.startSec) {
      throw new InputError(
        'unsupported-input',
        trim.endSec === trim.startSec ? 'empty trim range' : 'bad trim range',
      );
    }
    if (trim.startSec >= layout.info.durationSec) {
      throw new InputError('unsupported-input', 'trim start >= duration');
    }
    if (trim.endSec > layout.info.durationSec) {
      throw new InputError('unsupported-input', 'trim end > duration');
    }
  }
  const frames = fastFlacFrames(bytes, layout);
  const startSample =
    trim === undefined ? undefined : Math.round(trim.startSec * layout.info.sampleRate);
  const endSample =
    trim === undefined ? undefined : Math.round(trim.endSec * layout.info.sampleRate);
  const selected =
    trim === undefined
      ? frames
      : frames.filter((frame) => {
          const frameStart = frame.ptsSamples;
          const frameEnd = frameStart + frame.samples;
          return frameEnd > (startSample ?? 0) && frameStart < (endSample ?? 0);
        });
  if (selected.length === 0) {
    throw new InputError('unsupported-input', 'FLAC trim selected no audio frames');
  }
  const fullSelection =
    selected.length === frames.length &&
    selected[0]?.offset === frames[0]?.offset &&
    selected[selected.length - 1]?.offset === frames[frames.length - 1]?.offset;
  const streamInfo = streamInfoForPacketCopy(layout.streamInfoBody, selected, fullSelection);
  let outBytes = 4 + streamInfo.byteLength;
  for (const frame of selected) outBytes += frame.size;

  const out = new Uint8Array(outBytes) as Uint8Array<ArrayBuffer>;
  out.set(FLAC_MAGIC, 0);
  out.set(streamInfo, 4);
  let at = 4 + streamInfo.byteLength;
  for (const frame of selected) {
    out.set(bytes.subarray(frame.offset, frame.offset + frame.size), at);
    at += frame.size;
  }
  return out;
}

function streamInfoForPacketCopy(
  sourceBody: Uint8Array,
  frames: readonly FastFlacFrameSpan[],
  preserveMd5: boolean,
): Uint8Array<ArrayBuffer> {
  const body = sourceBody.slice() as Uint8Array<ArrayBuffer>;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let minBlock = Number.POSITIVE_INFINITY;
  let maxBlock = 0;
  let minFrame = 0xffffff;
  let maxFrame = 0;
  let totalSamples = 0;
  for (const frame of frames) {
    const block = frame.samples;
    if (block < minBlock) minBlock = block;
    if (frame.blockSize > maxBlock) maxBlock = frame.blockSize;
    if (frame.size < minFrame) minFrame = frame.size;
    if (frame.size > maxFrame) maxFrame = frame.size;
    totalSamples += frame.samples;
  }
  if (Number.isFinite(minBlock) && minBlock > 0) dv.setUint16(0, minBlock, false);
  if (maxBlock > 0) dv.setUint16(2, maxBlock, false);
  writeU24(body, 4, minFrame === 0xffffff ? 0 : minFrame);
  writeU24(body, 7, Math.min(maxFrame, 0xffffff));
  writePackedTotalSamples(dv, totalSamples);
  if (!preserveMd5) body.fill(0, 18, 34);
  return wrapStreamInfo(body);
}

/** Enumerate native FLAC audio frames as byte-exact packet spans for container remuxing. */
export function enumerateFlacFrames(bytes: Uint8Array): FlacFrame[] {
  const layout = flacMetadataLayout(bytes);
  return fastFlacFrames(bytes, layout).map((frame) => ({
    offset: frame.offset,
    size: frame.size,
    samples: frame.samples,
    ptsSamples: frame.ptsSamples,
    ptsUs: frame.ptsUs,
    durationUs: frame.durationUs,
    data: bytes.slice(frame.offset, frame.offset + frame.size) as Uint8Array<ArrayBuffer>,
  }));
}

async function writeFlacOggPacketCopy(bytes: Uint8Array): Promise<ReadableStream<Uint8Array>> {
  const layout = flacMetadataLayout(bytes);
  const metadata = bytes.slice(layout.start, layout.audioStart) as Uint8Array<ArrayBuffer>;
  const track = flacTrackInfo(layout.info, metadata);
  const muxer = new OggMuxer();
  const trackId = muxer.addTrack(track);
  for (const frame of fastFlacFrames(bytes, layout)) {
    muxer.addChunkStruct(trackId, {
      timestampUs: frame.ptsUs,
      durationUs: frame.durationUs,
      key: true,
      data: bytes.subarray(frame.offset, frame.offset + frame.size),
    });
  }
  await muxer.finalize();
  return muxer.output;
}

/** Read the whole source — FLAC decode needs every frame (bounded by file size). */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function packetStream(
  frames: readonly FlacFrame[],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'FLAC packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
      { op: 'demux', tried: ['flac'] },
    );
  }
  /* v8 ignore start -- requires WebCodecs EncodedAudioChunk; validated under browser-mode (codec phase) */
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i++;
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: frame.ptsUs,
        duration: frame.durationUs,
        data: frame.data,
      });
      controller.enqueue({ chunk, data: frame.data, sizeBytes: frame.size });
    },
  });
  /* v8 ignore stop */
}

// FLAC bit depth → the WAV sample format that stores it (non-byte-aligned depths use the next wider).
const DEPTH_FORMAT: Record<number, SampleFormat> = {
  8: 'u8',
  12: 's16',
  16: 's16',
  20: 's24',
  24: 's24',
  32: 's32',
};
const FORMAT_DIVISOR: Record<string, number> = {
  u8: 128,
  s16: 32768,
  s24: 8388608,
  s32: 2147483648,
};

/** Decode FLAC bytes to canonical planar audio normalized for the chosen WAV output format. */
function flacToPcm(bytes: Uint8Array): { audio: PcmAudio; format: SampleFormat } {
  const decoded = decodeFlac(bytes);
  const format = DEPTH_FORMAT[decoded.bitsPerSample] ?? 's32';
  const divisor = FORMAT_DIVISOR[format] ?? 2147483648;
  const planar = decoded.samples.map((ch) => {
    const out = new Float64Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = (ch[i] ?? 0) / divisor;
    return out;
  });
  const audio: PcmAudio = {
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    frames: decoded.totalSamples,
    planar,
  };
  return { audio, format };
}

/**
 * Author a native FLAC byte stream from canonical planar PCM (ADR-024). The lossless authoring seam shared
 * by the FLAC driver's own `transformPcm` (FLAC → FLAC re-encode) and the engine's cross-container PCM
 * route (WAV/AIFF/CAF → FLAC): the source samples are quantized to signed integers at `format`'s bit depth
 * via {@link flacPcmFromPcmAudio} (integer formats round-trip exactly; float is quantized to 24-bit), then
 * verbatim-encoded. The result is a standards-valid lossless FLAC stream (STREAMINFO MD5 + frame CRCs),
 * so re-decoding it reproduces the quantized PCM bit-exactly. A zero-sample input raises a typed
 * {@link InputError} from {@link encodeFlac} (FLAC frames cannot be empty) rather than emitting a malformed
 * header. `blockSize` defaults to the encoder's 4096-sample frame.
 */
export function authorFlacFromPcm(
  audio: PcmAudio,
  format: SampleFormat,
  options: FlacEncodeOptions = {},
): Uint8Array<ArrayBuffer> {
  return encodeFlac(flacPcmFromPcmAudio(audio, format), options);
}

/**
 * The engine's cross-container FLAC authoring entry (ADR-024): apply the audio-dsp {@link PcmTransform}
 * (gain / remix / fade / dynamics / biquad; resample is a typed miss without the wasm/WebAudio tail) to the
 * source's decoded PCM, then author a native FLAC stream at the source's `format` depth. Lives here (not in
 * the engine) so the FLAC encoder + audio-dsp wiring stay in the lazily-loaded FLAC driver chunk — the
 * engine reaches it via a dynamic `import()` only when a FLAC convert actually runs, keeping the eager
 * kernel free of codec code (docs/architecture/08). Returns a one-chunk stream the engine materializes.
 */
export function authorFlacStream(
  audio: PcmAudio,
  format: SampleFormat,
  o?: PcmTransform,
): ReadableStream<Uint8Array> {
  if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  const result = applyPcmTransform(audio, o, { resample: 'reject', tried: ['flac'] });
  const out = authorFlacFromPcm(result, format);
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(out);
      c.close();
    },
  });
}

// ============ native FLAC muxer ============

/** One buffered native FLAC audio frame (already a complete coded frame from the codec encoder). */
interface ChunkStruct {
  timestampUs: number;
  durationUs: number | undefined;
  key: boolean;
  data: Uint8Array;
}

/** STREAMINFO byte offsets within its 34-byte body (after the 4-byte fLaC + 4-byte block header). */
const STREAMINFO_BODY = 8;
const STREAMINFO_LEN = 34;

/**
 * The native FLAC muxer: it lays down `fLaC` + a STREAMINFO metadata block + every coded audio frame, in
 * arrival (= presentation) order. FLAC audio is never reordered (no B-frames), so a packet's `dtsUs` is
 * ignored. The codec encoder (or a demuxer remux) supplies complete native frames via {@link write}/
 * {@link addChunkStruct} and the STREAMINFO prelude as the track's `config.description`; on {@link
 * finalize} the muxer backfills the frame-derived fields (total samples, min/max block + frame size) into
 * that STREAMINFO so the header is exact, then emits the whole stream as one materialized chunk. The MD5
 * carried in the supplied STREAMINFO is preserved verbatim (the encoder owns it; `0` is the spec's legal
 * "unknown"). `addTrack` is the codec-in-container legality arbiter: only a single FLAC audio track is
 * accepted (FLAC carries exactly one stream).
 */
export class FlacMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: { id: number; info: TrackInfo; chunks: ChunkStruct[] } | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor() {
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    if (this.#track !== undefined) {
      throw new MediaError('mux-error', 'the FLAC muxer writes a single audio stream');
    }
    if (info.mediaType !== 'audio' || info.codec !== 'flac') {
      throw new MediaError(
        'mux-error',
        `FLAC container holds one FLAC audio track, not ${info.mediaType}/${info.codec}`,
      );
    }
    const id = 0;
    this.#track = { id, info, chunks: [] };
    return id;
  }

  /**
   * Buffer one encoded packet. Reading bytes/timing from a real WebCodecs `EncodedAudioChunk` (`copyTo`)
   * is the only browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs EncodedAudioChunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /** Pure packet ingest (the path the Node tests drive directly): append a coded frame to the track. */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    this.#track.chunks.push(chunk);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready;
    const controller = this.#controller;
    if (controller === undefined) {
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    try {
      if (this.#track === undefined) {
        throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
      }
      if (this.#track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${this.#track.id} received no packets`);
      }
      controller.enqueue(this.#serialize(this.#track.info, this.#track.chunks));
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  /** Assemble `fLaC` + a frame-accurate STREAMINFO + the coded frames into one native FLAC byte stream. */
  #serialize(info: TrackInfo, chunks: readonly ChunkStruct[]): Uint8Array<ArrayBuffer> {
    const streamInfo = buildMuxStreamInfo(info, chunks);
    let total = streamInfo.byteLength;
    for (const c of chunks) total += c.data.byteLength;
    const out = new Uint8Array(4 + total);
    out.set(FLAC_MAGIC, 0);
    out.set(streamInfo, 4);
    let off = 4 + streamInfo.byteLength;
    for (const c of chunks) {
      out.set(c.data, off);
      off += c.data.byteLength;
    }
    backfillStreamInfoMd5(out);
    return out;
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}

const FLAC_MAGIC = Uint8Array.from([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'
const FLAC_BLOCK_SIZE_TABLE = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
] as const;

/** Out-stream offset of STREAMINFO's MD5 field: 4 (fLaC) + 4 (block header) + 18 (body offset). */
const STREAMINFO_MD5_OFFSET = 4 + 4 + 18;

/**
 * Backfill the STREAMINFO MD5 in place when the supplied prelude left it as the "unknown" all-zero (the
 * streaming codec-encoder path, which can't know the digest before the first frame). The muxer is the
 * single-shot authority: it decodes the just-assembled stream with the pure-TS decoder and writes the
 * digest of the unencoded interleaved PCM — so the output is self-validating (`flac --test` passes). A
 * non-zero supplied MD5 (a demuxer remux, or a caller that already hashed the PCM) is preserved untouched.
 */
function backfillStreamInfoMd5(out: Uint8Array): void {
  let zero = true;
  for (let i = 0; i < 16; i++) {
    if ((out[STREAMINFO_MD5_OFFSET + i] ?? 0) !== 0) {
      zero = false;
      break;
    }
  }
  if (!zero) return; // a real MD5 was supplied — keep it
  const decoded = decodeFlac(out);
  const state = newMd5State();
  updateMd5(state, decodedInterleavedPcmBytes(decoded));
  out.set(finalizeMd5(state), STREAMINFO_MD5_OFFSET);
}

/**
 * Build the STREAMINFO metadata block the muxer writes: start from the track's supplied STREAMINFO
 * (`config.description` — the codec encoder's prelude, preserving its MD5), then backfill the fields the
 * muxer can derive exactly from the buffered frames: total samples (Σ frame durations, when the supplied
 * value is the "unknown" 0), min/max frame size (smallest/largest coded frame), and min/max block size
 * (largest = the nominal fixed block size; min equals it for a fixed-blocksize stream). When no
 * description was supplied, a minimal STREAMINFO is synthesized from the track's audio config.
 */
function buildMuxStreamInfo(
  info: TrackInfo,
  chunks: readonly ChunkStruct[],
): Uint8Array<ArrayBuffer> {
  const body = streamInfoBodyFrom(info);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

  const totalFromChunks = totalSamplesFromChunks(chunks);

  // min/max frame size (24-bit each) from the buffered frame byte lengths.
  let minFrame = 0xffffff;
  let maxFrame = 0;
  for (const c of chunks) {
    const len = c.data.byteLength;
    if (len < minFrame) minFrame = len;
    if (len > maxFrame) maxFrame = len;
  }
  writeU24(body, 4, minFrame === 0xffffff ? 0 : minFrame);
  writeU24(body, 7, Math.min(maxFrame, 0xffffff));

  // Block size: declare a single nominal (max) block size (min == max ⇒ fixed-blocksize stream). The
  // nominal is the largest decoded frame's sample count; a shorter final frame must not lower it.
  const nominalBlock = nominalBlockSize(chunks);
  if (nominalBlock > 0) {
    dv.setUint16(0, nominalBlock, false);
    dv.setUint16(2, nominalBlock, false);
  }

  // Total samples: keep the supplied value unless it is the "unknown" 0, then backfill from frames. The
  // 36-bit field is `packed[35:32]` (low nibble of the big-endian u32 at +10) | u32 at +14.
  const suppliedTotal = packedTotalSamples(dv);
  if (suppliedTotal === 0 && totalFromChunks > 0) writePackedTotalSamples(dv, totalFromChunks);

  return wrapStreamInfo(body);
}

/** The 34-byte STREAMINFO body from the track description, or a fresh one from the audio config. */
function streamInfoBodyFrom(info: TrackInfo): Uint8Array<ArrayBuffer> {
  const config = info.config as AudioDecoderConfig | undefined;
  const description = config?.description;
  if (description !== undefined) {
    const bytes = bufferSourceToBytes(description);
    const body = streamInfoBodyOf(bytes);
    if (body !== undefined) return body;
  }
  // No usable description: synthesize a minimal STREAMINFO from the audio config (MD5 left 0 = unknown).
  const sampleRate = config?.sampleRate ?? 0;
  const channels = config?.numberOfChannels ?? 1;
  if (sampleRate <= 0) {
    throw new MediaError('mux-error', 'FLAC muxer needs a STREAMINFO description or a sample rate');
  }
  const body = new Uint8Array(STREAMINFO_LEN) as Uint8Array<ArrayBuffer>;
  const dv = new DataView(body.buffer);
  const bits = 16; // a description-less synth defaults to 16-bit; the encoder normally supplies the real depth
  dv.setUint32(10, sampleRate * 2 ** 12 + (channels - 1) * 2 ** 9 + (bits - 1) * 2 ** 4, false);
  return body;
}

/** Extract the 34-byte STREAMINFO body from a native-FLAC metadata prelude (`fLaC` + blocks). */
function streamInfoBodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  // A bare 34-byte body (some callers pass just the body) or a full prelude beginning with `fLaC`.
  if (bytes.byteLength === STREAMINFO_LEN) return bytes.slice() as Uint8Array<ArrayBuffer>;
  if (bytes.byteLength >= STREAMINFO_BODY + STREAMINFO_LEN && ascii(bytes, 0, 4) === 'fLaC') {
    return bytes.slice(
      STREAMINFO_BODY,
      STREAMINFO_BODY + STREAMINFO_LEN,
    ) as Uint8Array<ArrayBuffer>;
  }
  return undefined;
}

/** Wrap a 34-byte STREAMINFO body in its metadata block header (last block, type 0, length 34). */
function wrapStreamInfo(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + body.byteLength);
  out[0] = 0x80; // last-metadata-block flag | STREAMINFO type (0)
  out[1] = 0x00;
  out[2] = 0x00;
  out[3] = body.byteLength;
  out.set(body, 4);
  return out;
}

function packedTotalSamples(dv: DataView): number {
  const hi = dv.getUint32(10, false) & 0xf;
  const lo = dv.getUint32(14, false);
  return hi * 2 ** 32 + lo;
}

function writePackedTotalSamples(dv: DataView, total: number): void {
  const high = dv.getUint32(10, false);
  const packed = (high & 0xfffffff0) | (Math.floor(total / 2 ** 32) & 0xf);
  dv.setUint32(10, packed >>> 0, false);
  dv.setUint32(14, total >>> 0, false);
}

/**
 * Total decoded samples = Σ of each frame's EXACT block size, read from its native header (every FLAC
 * frame header encodes its own block size). This is exact — unlike summing rounded per-frame µs
 * durations — so the STREAMINFO total-samples the decoder loops on matches the coded frames byte-for-byte
 * (a mismatch would truncate/over-read the MD5 backfill decode). A frame with an unreadable block-size
 * code (reserved 0) contributes nothing and is excluded.
 */
function totalSamplesFromChunks(chunks: readonly ChunkStruct[]): number {
  let total = 0;
  for (const c of chunks) total += frameBlockSize(c.data);
  return total;
}

/** The nominal (largest) per-frame sample count, decoded from each buffered native frame's header. */
function nominalBlockSize(chunks: readonly ChunkStruct[]): number {
  let max = 0;
  for (const c of chunks) {
    const n = frameBlockSize(c.data);
    if (n > max) max = n;
  }
  return max;
}

/** Decode a native FLAC frame header's block size (RFC 9639 §9.1.1 block-size codes). */
function frameBlockSize(frame: Uint8Array): number {
  // Bytes: [0..1]=sync+flags, [2] high nibble = block-size code; explicit sizes trail the frame number.
  const code = ((frame[2] ?? 0) >> 4) & 0xf;
  const tabled = FLAC_BLOCK_SIZE_TABLE[code] ?? 0;
  if (tabled > 0) return tabled;
  // Codes 6/7 carry the size explicitly after the UTF-8 frame number; codes 0/6/7 fall back to a scan.
  const utf8Len = frameNumberLen(frame[4] ?? 0);
  const at = 4 + utf8Len;
  if (code === 6) return (frame[at] ?? 0) + 1; // 8-bit explicit
  if (code === 7) return (((frame[at] ?? 0) << 8) | (frame[at + 1] ?? 0)) + 1; // 16-bit explicit
  return 0; // reserved code 0 — unknown; excluded from the nominal max
}

/** Byte length of a native FLAC frame's UTF-8-coded frame number (leading-1s count, like UTF-8). */
function frameNumberLen(first: number): number {
  if ((first & 0x80) === 0) return 1;
  let ones = 0;
  for (let mask = 0x80; (first & mask) !== 0; mask >>= 1) ones++;
  return ones;
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 16) & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = value & 0xff;
}

/** A read-only byte view over an `ArrayBuffer`/typed-array `BufferSource` (no copy). */
function bufferSourceToBytes(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  const view = src as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export const FlacDriver: ContainerDriver = {
  id: 'flac',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['flac'],
  streamCopyTargets: ['ogg'],
  supports: matchesFlac,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const info = parseFlac(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return [flacTrackInfo(info)];
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const table = flacPacketInfoTable(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return table;
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const bytes = await readAll(src);
    const info = parseFlac(bytes);
    const metadata = nativeFlacMetadata(bytes);
    const frames = enumerateFlacFrames(bytes);
    const track = flacTrackInfo(info, metadata);
    const signal = o?.signal;
    return {
      tracks: [track],
      packets(trackId: number): ReadableStream<Packet> {
        if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(frames, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    const bytes = await readAll(src);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    if (o?.container === 'ogg') {
      if (o.trim !== undefined) {
        throw new CapabilityError(
          'capability-miss',
          'FLAC to Ogg packet-copy trim is not declared',
          {
            op: { op: 'streamCopy', container: 'ogg', trim: true },
            tried: ['flac', 'ogg'],
          },
        );
      }
      return await writeFlacOggPacketCopy(bytes);
    }
    const out = writeFlacPacketCopy(bytes, o?.trim);
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const { audio, format } = flacToPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const result = applyPcmTransform(audio, o, { resample: 'reject', tried: ['flac'] });
    const out = writeWav(result, format);
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const { audio } = flacToPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return audio;
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    // FLAC authoring + FLAC → WAV decode share this PCM-native seam (ADR-022/024): decode the source FLAC
    // to canonical PCM, apply the audio-dsp transform (gain/remix/fade/dynamics/biquad; resample is a
    // typed miss without the wasm/WebAudio tail), then serialize per the requested `container`. A `flac`
    // (or unspecified) target re-encodes a fresh lossless native FLAC via the verbatim-correct pure-TS
    // encoder; a `wav` target writes RIFF/WAVE PCM (the FLAC → WAV bridge). The engine's cross-container
    // route (WAV/AIFF/CAF → FLAC) instead reuses {@link authorFlacStream} with the source's decoded PCM.
    const { audio, format } = flacToPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const result = applyPcmTransform(audio, o, { resample: 'reject', tried: ['flac'] });
    const out =
      o?.container === 'wav' ? writeWav(result, format) : authorFlacFromPcm(result, format);
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  createMuxer(o?: MuxOptions): Muxer {
    if (o?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'FLAC has no fragmented/segmented mux form', {
        op: { op: 'mux', fragmented: true },
        tried: ['flac'],
      });
    }
    return new FlacMuxer();
  },
};

export const FlacModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(FlacDriver);
  },
};

export default FlacModule;
