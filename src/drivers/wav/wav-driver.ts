/**
 * The WAV (RIFF/WAVE) container driver — hand-written TS. WAV is **little-endian** (unlike MP4) and
 * carries raw PCM (or IEEE float), so demux is a chunk walk: parse `fmt ` for the layout and the
 * `data` chunk header for duration. PCM is not a WebCodecs codec — it flows to the TS audio-dsp path —
 * so the codec token is `pcm-u8` / `pcm-s16` / `pcm-s24` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MuxOptions,
  type Muxer,
  type Packet,
  type PacketInfoMetadata,
  type PacketInfoTable,
  type PcmTransform,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import type { PcmAudio } from '../../dsp/pcm.ts';
import { fromURL } from '../../sources/source.ts';
import { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { tryRewriteWavPcmToAiffBe } from './aiff-rewrite.ts';
import { tryGainWavF32ToF32Wav } from './f32-gain.ts';
import { tryConvertWavPcmFormatToWav } from './format-convert.ts';
import { readWavPcm, rewriteWavPcmCopy } from './pcm.ts';
import { WavMuxer } from './wav-mux.ts';

const WAV_MIMES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave']);
const WAV_EXTENSIONS = new Set(['wav', 'wave']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface WavInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface WavPacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface ParsedWavHeader {
  info: WavInfo;
  dataOffset: number;
  dataBytes: number;
  bytesPerFrame: number;
  dataFound: boolean;
}

const WAV_PROBE_HEAD_BYTES = 4096;
const WAV_DEMUX_HEAD_BYTES = 65536;
const WAV_PACKET_FRAMES = 4096;
const WAV_PACKET_INFO_PREFIX_TTL_MS = 60_000;
const WAV_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES = 64;
const OPERATION_ABORTED = 'operation aborted';

interface WavPacketInfoPrefixCacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const wavPacketInfoPrefixCache = new Map<string, WavPacketInfoPrefixCacheEntry>();

/** PCM/float codec token per WebCodecs/harness vocabulary (LE; WAV BE variants are out of scope). */
function pcmCodec(fmt: WavFormat): string {
  if (fmt.formatTag === 3) return fmt.bitsPerSample === 64 ? 'pcm-f64' : 'pcm-f32';
  if (fmt.bitsPerSample === 8) return 'pcm-u8'; // 8-bit WAV PCM is unsigned (offset binary)
  return `pcm-s${fmt.bitsPerSample}`;
}

function parseFormat(dv: DataView, body: number, size: number): WavFormat {
  let formatTag = dv.getUint16(body, true);
  // WAVE_FORMAT_EXTENSIBLE: the effective tag is the first 2 bytes of the SubFormat GUID (+24), so
  // float-extensible (tag 3) is not mislabeled as PCM. Fall back to PCM if the chunk is too short.
  if (formatTag === 0xfffe) formatTag = size >= 40 ? dv.getUint16(body + 24, true) : 1;
  return {
    formatTag,
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    byteRate: dv.getUint32(body + 8, true),
    blockAlign: dv.getUint16(body + 12, true),
    bitsPerSample: dv.getUint16(body + 14, true),
  };
}

function parseWavHeader(bytes: Uint8Array, totalSize?: number): ParsedWavHeader {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let dataSize = 0;
  let dataFound = false;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      if (body + 16 > bytes.byteLength) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      format = parseFormat(dv, body, size);
    } else if (id === 'data') {
      // Trust the declared size for duration, but never exceed the real file length.
      dataSize = totalSize !== undefined ? Math.min(size, Math.max(0, totalSize - body)) : size;
      dataFound = true;
      break;
    }
    pos = body + size + (size & 1); // chunks are padded to an even size
  }
  if (!format) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');

  const bytesPerFrame =
    format.blockAlign > 0 ? format.blockAlign : (format.bitsPerSample >> 3) * format.channels;
  const byteRate = format.byteRate > 0 ? format.byteRate : bytesPerFrame * format.sampleRate;

  return {
    info: {
      codec: pcmCodec(format),
      sampleRate: format.sampleRate,
      channels: format.channels,
      durationSec: byteRate > 0 ? dataSize / byteRate : 0,
    },
    dataOffset: dataFound ? pos + 8 : 0,
    dataBytes: dataSize,
    bytesPerFrame,
    dataFound,
  };
}

/** Parse a RIFF/WAVE header into the audio layout + duration. Pure; little-endian. */
export function parseWav(bytes: Uint8Array, totalSize?: number): WavInfo {
  return parseWavHeader(bytes, totalSize).info;
}

function wavTrackInfo(info: WavInfo): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

function wavPacketInfoFromHeader(parsed: ParsedWavHeader): PacketInfoTable {
  const track = wavTrackInfo(parsed.info);
  const packets: PacketInfoMetadata[] = [];
  const { bytesPerFrame, dataBytes } = parsed;
  if (parsed.dataFound && bytesPerFrame > 0 && parsed.info.sampleRate > 0 && dataBytes > 0) {
    const totalFrames = Math.floor(dataBytes / bytesPerFrame);
    for (let frame = 0; frame < totalFrames; frame += WAV_PACKET_FRAMES) {
      const frames = Math.min(WAV_PACKET_FRAMES, totalFrames - frame);
      const ptsUs = Math.round((frame / parsed.info.sampleRate) * 1_000_000);
      packets.push({
        trackIndex: 0,
        offset: parsed.dataOffset + frame * bytesPerFrame,
        size: frames * bytesPerFrame,
        ptsUs,
        dtsUs: ptsUs,
        durationUs: Math.round((frames / parsed.info.sampleRate) * 1_000_000),
        keyframe: true,
      });
    }
  }
  return { tracks: [track], packets };
}

export function wavPacketInfoFromBytes(bytes: Uint8Array): PacketInfoTable {
  return wavPacketInfoFromHeader(parseWavHeader(bytes, bytes.byteLength));
}

function wavPacketInfoUrlCacheKey(url: string | URL, opts: WavPacketInfoFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function cachedWavPacketInfoPrefix(
  key: string,
  totalSize: number | undefined,
): PacketInfoTable | undefined {
  const entry = wavPacketInfoPrefixCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    wavPacketInfoPrefixCache.delete(key);
    return undefined;
  }
  try {
    const parsed = parseWavHeader(entry.bytes, totalSize);
    return parsed.dataFound ? wavPacketInfoFromHeader(parsed) : undefined;
  } catch {
    wavPacketInfoPrefixCache.delete(key);
    return undefined;
  }
}

function storeWavPacketInfoPrefix(key: string, bytes: Uint8Array): void {
  const now = Date.now();
  for (const [entryKey, entry] of wavPacketInfoPrefixCache) {
    if (entry.expiresAtMs <= now) wavPacketInfoPrefixCache.delete(entryKey);
  }
  while (wavPacketInfoPrefixCache.size >= WAV_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES) {
    const oldest = wavPacketInfoPrefixCache.keys().next().value;
    if (oldest === undefined) break;
    wavPacketInfoPrefixCache.delete(oldest);
  }
  wavPacketInfoPrefixCache.set(key, {
    bytes: bytes.slice(),
    expiresAtMs: now + WAV_PACKET_INFO_PREFIX_TTL_MS,
  });
}

export async function wavPacketInfoFromUrl(
  url: string | URL,
  opts: WavPacketInfoFromUrlOptions = {},
): Promise<PacketInfoTable> {
  const packetInfo = WavDriver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'WAV packet-info is not available', {
      op: { op: 'demux', container: 'wav' },
      tried: ['wav'],
    });
  }
  const key = wavPacketInfoUrlCacheKey(url, opts);
  const cached = cachedWavPacketInfoPrefix(key, opts.size);
  if (cached !== undefined) return cached;
  const src = fromURL(url, {
    mime: opts.mime ?? 'audio/wav',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  if (src.range !== undefined) {
    const prefix = await src.range(
      0,
      opts.size !== undefined ? Math.min(opts.size, WAV_PROBE_HEAD_BYTES) : WAV_PROBE_HEAD_BYTES,
    );
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const parsed = parseWavHeader(prefix, opts.size);
    if (parsed.dataFound) {
      storeWavPacketInfoPrefix(key, prefix);
      return wavPacketInfoFromHeader(parsed);
    }
  }
  return packetInfo.call(
    WavDriver,
    src,
    opts.signal !== undefined ? { signal: opts.signal } : undefined,
  );
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** Read the whole source into one buffer — PCM transforms need every sample (bounded by file size). */
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

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && WAV_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && WAV_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  return (
    head !== undefined &&
    head.byteLength >= 12 &&
    ascii(head, 0, 4) === 'RIFF' &&
    ascii(head, 8, 4) === 'WAVE'
  );
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export const WavDriver: ContainerDriver = {
  id: 'wav',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['wav'],
  supports: matches,
  validatesPcmTrim: true,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    let head = await readHead(src, WAV_PROBE_HEAD_BYTES);
    let parsed = parseWavHeader(head, src.size);
    const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
    if (!parsed.dataFound && head.byteLength < maxFallback) {
      head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
      parsed = parseWavHeader(head, src.size);
    }
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return [wavTrackInfo(parsed.info)];
  },
  async demux(src: ByteSource): Promise<Demuxer> {
    const head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
    const info = parseWav(head, src.size);
    const track = wavTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'capability-miss',
          'WAV PCM packets flow through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    let head = await readHead(src, WAV_PROBE_HEAD_BYTES);
    let parsed = parseWavHeader(head, src.size);
    const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
    if (!parsed.dataFound && head.byteLength < maxFallback) {
      head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
      parsed = parseWavHeader(head, src.size);
    }
    if (!parsed.dataFound && src.size !== undefined) {
      head = await readAll(src);
      parsed = parseWavHeader(head, src.size);
    }
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return wavPacketInfoFromHeader(parsed);
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const opts: PcmTransform = o ?? {};
    const container = opts.container ?? 'wav';
    let bytes: Uint8Array | undefined;
    if (
      container === 'wav' &&
      opts.gainDb === undefined &&
      opts.fade === undefined &&
      opts.dynamics === undefined &&
      opts.biquad === undefined
    ) {
      if (opts.timeBounds !== undefined) {
        const { tryTimeSlice } = await import('./pcm-range-slice.ts');
        const sliced = await tryTimeSlice(src, opts);
        if (sliced !== undefined) return sliced;
      } else {
        bytes = await readAll(src);
        if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
        const copied = rewriteWavPcmCopy(
          bytes,
          opts.sampleFormat,
          opts.endian,
          opts.channels,
          opts.sampleRate,
        );
        if (copied !== undefined) {
          return byteStream(copied);
        }
        const { tryResampleWavS16ToS16Wav } = await import('./s16-resample.ts');
        const resampled = tryResampleWavS16ToS16Wav(bytes, opts);
        if (resampled !== undefined) {
          return byteStream(resampled);
        }
        const converted = tryConvertWavPcmFormatToWav(bytes, opts);
        if (converted !== undefined) {
          return byteStream(converted);
        }
      }
    }
    bytes ??= await readAll(src);
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const aiff = tryRewriteWavPcmToAiffBe(bytes, opts);
    if (aiff !== undefined) {
      return byteStream(aiff);
    }
    const gained = tryGainWavF32ToF32Wav(bytes, opts);
    if (gained !== undefined) {
      return byteStream(gained);
    }
    const wav = readWavPcm(bytes);
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const audio = applyPcmTransform(wav, opts);
    const out = writePcmContainer(
      audio,
      container,
      resolvePcmSampleFormat(container, wav.format, opts.sampleFormat),
      opts.endian ?? 'le',
    );
    return byteStream(out);
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const wav = readWavPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return wav;
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
