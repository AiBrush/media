/**
 * The ADTS (raw AAC) container driver — hand-written TS. ADTS wraps each AAC frame in a 7- or 9-byte
 * header beginning with a 12-bit `0xFFF` syncword; the first header carries the audio object type,
 * sampling-frequency index, and channel configuration. Duration comes from walking the frames (each is
 * `frame_length` bytes and 1024 samples per raw block). AAC *decode* is a WebCodecs/WASM codec, so the
 * packet seam raises a typed {@link CapabilityError}; probe is pure TS.
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type Muxer,
  type Packet,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';

const ADTS_MIMES = new Set(['audio/aac', 'audio/aacp', 'audio/x-aac']);
const ADTS_EXTENSIONS = new Set(['aac', 'adts']);

// MPEG-4 sampling-frequency-index table (Hz); index 13–15 are reserved/explicit (unsupported here).
const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
// channel_configuration → channel count (0 = AOT-specific; 7 = 7.1 → 8 channels).
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

const SAMPLES_PER_BLOCK = 1024;

/**
 * One enumerated ADTS frame, as the pure framer sees it. `size` is the FULL frame length (header + CRC +
 * payload) — the same unit ffprobe reports for an ADTS packet, so the oracle can assert byte-exactness.
 * `headerBytes` (7 or 9) is the prefix to strip when emitting a RAW AAC access unit to WebCodecs:
 * `data = frame[offset + headerBytes : offset + size]`. `ptsUs`/`durationUs` come from cumulative samples.
 */
export interface AdtsPacket {
  /** Byte offset of the frame's first header byte (the 0xFF sync) within the input buffer. */
  readonly offset: number;
  /** Full frame length in bytes (header + optional 2-byte CRC + AAC payload) — matches ffprobe `size`. */
  readonly size: number;
  /** ADTS header length: 7 bytes, or 9 when CRC is present (protection_absent == 0). */
  readonly headerBytes: number;
  /** Presentation timestamp in microseconds (cumulative samples ÷ sampleRate). */
  readonly ptsUs: number;
  /** Frame duration in microseconds (rawBlocks · 1024 ÷ sampleRate). */
  readonly durationUs: number;
}

/**
 * PURE framer (Node-testable, no WebCodecs): walk EVERY ADTS frame across the whole buffer and return its
 * byte geometry + timing. This is the load-bearing logic the oracle validates; `packets()` only maps it to
 * `EncodedAudioChunk`s. Throws {@link InputError} when the head is not ADTS (so truncated/garbage rejects),
 * and {@link MediaError} on a reserved sampling-frequency index. A frame whose declared `frame_length`
 * overruns the buffer (a truncated tail) stops the walk cleanly — we never read past the bytes we have.
 */
export function enumerateAdtsFrames(bytes: Uint8Array): readonly AdtsPacket[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = adtsOffset(dv);
  if (bytes.byteLength < start + 7 || !isSync(dv.getUint8(start), dv.getUint8(start + 1))) {
    throw new InputError('unsupported-input', 'not an ADTS/AAC stream (no 0xFFF syncword)');
  }
  // Sampling rate is fixed by the FIRST header; ADTS keeps it constant across frames of one stream.
  const freqIndex = (dv.getUint8(start + 2) >> 2) & 0xf;
  const sampleRate = SAMPLE_RATES[freqIndex];
  if (sampleRate === undefined) {
    throw new MediaError('demux-error', `ADTS: reserved sampling-frequency index ${freqIndex}`);
  }

  const packets: AdtsPacket[] = [];
  let pos = start;
  let cumulativeSamples = 0;
  while (pos + 7 <= bytes.byteLength && isSync(dv.getUint8(pos), dv.getUint8(pos + 1))) {
    const frameLen =
      ((dv.getUint8(pos + 3) & 0x3) << 11) |
      (dv.getUint8(pos + 4) << 3) |
      (dv.getUint8(pos + 5) >> 5);
    // protection_absent == 0 ⇒ a 2-byte CRC follows the 7-byte fixed header (header = 9 bytes total).
    const headerBytes = (dv.getUint8(pos + 1) & 0x1) === 0 ? 9 : 7;
    if (frameLen < headerBytes || pos + frameLen > bytes.byteLength) break; // malformed / truncated tail
    const rawBlocks = (dv.getUint8(pos + 6) & 0x3) + 1;
    const samples = rawBlocks * SAMPLES_PER_BLOCK;
    packets.push({
      offset: pos,
      size: frameLen,
      headerBytes,
      // µs from the integer sample clock — rounding keeps us within ±1µs of ffprobe's pts_time.
      ptsUs: Math.round((cumulativeSamples * 1_000_000) / sampleRate),
      durationUs: Math.round((samples * 1_000_000) / sampleRate),
    });
    cumulativeSamples += samples;
    pos += frameLen;
  }
  if (packets.length === 0) {
    throw new InputError('unsupported-input', 'ADTS: no decodable frames');
  }
  return packets;
}

/**
 * Synthesize the 2-byte AudioSpecificConfig (Aac `config.description`) from an ADTS header's fields. Some
 * browsers' AAC decoders need the explicit ASC even though ADTS is self-describing; supplying it makes the
 * decode robust cross-browser. Layout: 5 bits AOT, 4 bits samplingFrequencyIndex, 4 bits channelConfig.
 */
function audioSpecificConfig(aot: number, freqIndex: number, channelConfig: number): Uint8Array {
  return new Uint8Array([
    (aot << 3) | (freqIndex >> 1),
    ((freqIndex & 1) << 7) | (channelConfig << 3),
  ]);
}

export interface AdtsInfo {
  codec: string; // RFC 6381, e.g. mp4a.40.2 (AAC-LC) — matches the mp4 driver
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number;
}

/** A valid ADTS sync: byte0 = 0xFF, byte1 top nibble = 0xF, layer bits (b1 & 6) == 0. */
function isSync(b0: number, b1: number): boolean {
  return b0 === 0xff && (b1 & 0xf0) === 0xf0 && (b1 & 0x06) === 0;
}

/** Byte offset of the first ADTS frame, skipping an optional ID3v2 prefix. */
function adtsOffset(dv: DataView): number {
  if (
    dv.byteLength >= 10 &&
    dv.getUint8(0) === 0x49 &&
    dv.getUint8(1) === 0x44 &&
    dv.getUint8(2) === 0x33
  ) {
    const size =
      ((dv.getUint8(6) & 0x7f) << 21) |
      ((dv.getUint8(7) & 0x7f) << 14) |
      ((dv.getUint8(8) & 0x7f) << 7) |
      (dv.getUint8(9) & 0x7f);
    return 10 + size;
  }
  return 0;
}

/** Parse ADTS headers into the audio layout + duration. `totalSize` (full file) refines a partial head. */
export function parseAdts(bytes: Uint8Array, totalSize?: number): AdtsInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = adtsOffset(dv);
  if (bytes.byteLength < start + 7 || !isSync(dv.getUint8(start), dv.getUint8(start + 1))) {
    throw new InputError('unsupported-input', 'not an ADTS/AAC stream (no 0xFFF syncword)');
  }
  const b2 = dv.getUint8(start + 2);
  const objectType = ((b2 >> 6) & 0x3) + 1; // profile + 1 = MPEG-4 audio object type (2 = AAC-LC)
  const freqIndex = (b2 >> 2) & 0xf;
  const sampleRate = SAMPLE_RATES[freqIndex];
  if (sampleRate === undefined) {
    throw new MediaError('demux-error', `ADTS: reserved sampling-frequency index ${freqIndex}`);
  }
  const channelConfig = ((b2 & 0x1) << 2) | ((dv.getUint8(start + 3) >> 6) & 0x3);
  const channels = CHANNELS[channelConfig] ?? 0;

  // Walk frames within the available bytes to count samples (each frame_length bytes, 1024/block).
  let pos = start;
  let frames = 0;
  let samples = 0;
  while (pos + 7 <= bytes.byteLength && isSync(dv.getUint8(pos), dv.getUint8(pos + 1))) {
    const frameLen =
      ((dv.getUint8(pos + 3) & 0x3) << 11) |
      (dv.getUint8(pos + 4) << 3) |
      (dv.getUint8(pos + 5) >> 5);
    if (frameLen < 7) break; // malformed header guard
    const rawBlocks = (dv.getUint8(pos + 6) & 0x3) + 1;
    frames++;
    samples += rawBlocks * SAMPLES_PER_BLOCK;
    pos += frameLen;
  }
  // If we only saw a head of a larger file, extrapolate by the bytes-per-sample density walked so far.
  const walked = pos - start;
  const scale =
    totalSize !== undefined && walked > 0 ? Math.max(1, (totalSize - start) / walked) : 1;
  return {
    codec: `mp4a.40.${objectType}`,
    sampleRate,
    channels,
    durationSec: (samples * scale) / sampleRate,
    frames,
  };
}

/** Read the ENTIRE source — `packets()` must enumerate every frame, not just the probed head. */
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

/**
 * Stream every ADTS frame of `bytes` as WebCodecs `EncodedAudioChunk`s. Browser-only: the `EncodedAudioChunk`
 * constructor exists only in a browser/worker, so we raise a typed {@link CapabilityError} in Node (mirroring
 * the mpegts/mp4 drivers) and istanbul-ignore the emission body (validated under browser-mode in the codec
 * phase). Audio has NO reordering — DTS == PTS — so each {@link Packet} omits `dtsUs`. Each frame is a sync
 * sample (`type:'key'`) and we emit the RAW AAC access unit (ADTS header + optional CRC stripped) so the
 * decoder consumes a bare access unit matched by the synthesized `config.description` ASC.
 */
function packetStream(bytes: Uint8Array, signal: AbortSignal | undefined): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebCodecs EncodedAudioChunk is unavailable in this environment',
      { op: 'demux', tried: ['adts'] },
    );
  }
  /* v8 ignore start -- requires WebCodecs EncodedAudioChunk; validated under browser-mode (codec phase) */
  const frames = enumerateAdtsFrames(bytes);
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const f = frames[i];
      if (f === undefined) {
        controller.close();
        return;
      }
      i++;
      const data = bytes.subarray(f.offset + f.headerBytes, f.offset + f.size);
      const chunk = new EncodedAudioChunk({
        type: 'key', // every AAC frame is independently decodable (a sync sample)
        timestamp: f.ptsUs,
        duration: f.durationUs,
        data,
      });
      controller.enqueue({ chunk }); // no dtsUs: audio never reorders (DTS == PTS)
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && ADTS_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && ADTS_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 7) return false;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const off = adtsOffset(dv);
  return off + 2 <= head.byteLength && isSync(dv.getUint8(off), dv.getUint8(off + 1));
}

export const AdtsDriver: ContainerDriver = {
  id: 'adts',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['adts'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    // A raw ADTS stream has no front index — every frame's geometry lives inline, so `packets()` needs the
    // whole file. We read it once here and parse the head from it (the existing probe path is unchanged).
    const bytes = await readAll(src);
    const info = parseAdts(bytes, bytes.byteLength);
    const signal = o?.signal;
    // Re-derive the header fields the synthesized ASC needs (parseAdts validated the syncword already).
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = adtsOffset(dv);
    const b2 = dv.getUint8(start + 2);
    const aot = ((b2 >> 6) & 0x3) + 1;
    const freqIndex = (b2 >> 2) & 0xf;
    const channelConfig = ((b2 & 0x1) << 2) | ((dv.getUint8(start + 3) >> 6) & 0x3);
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: info.codec,
      durationSec: info.durationSec,
      config: {
        codec: info.codec,
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels,
        // The explicit ASC makes AAC decode robust on browsers that don't sniff it from the raw AU.
        description: audioSpecificConfig(aot, freqIndex, channelConfig),
      },
    };
    return {
      tracks: [track],
      packets(trackId: number): ReadableStream<Packet> {
        if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(bytes, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(): Muxer {
    throw new MediaError('mux-error', 'AAC encode requires the WebCodecs/WASM codec layer');
  },
};

export const AdtsModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AdtsDriver);
  },
};

export default AdtsModule;
