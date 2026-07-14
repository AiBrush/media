/**
 * The AIFF / AIFF-C container driver — hand-written TS. AIFF is **big-endian** IFF (`FORM…AIFF`/`AIFC`)
 * carrying raw PCM (or, in AIFF-C, big-endian float or byte-swapped `sowt` little-endian PCM), so demux
 * is a chunk walk: `COMM` for the layout, `SSND` for the samples. PCM is not a WebCodecs codec — it flows
 * to the TS audio-dsp path — so the packet seam raises a typed {@link CapabilityError} and the codec
 * token is `pcm-s8` / `pcm-s16be` / `pcm-s24be` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type Muxer,
  type Packet,
  type PacketInfoMetadata,
  type PacketInfoTable,
  type PcmTransform,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type PcmAudio, bytesPerSample } from '../../dsp/pcm.ts';
import { fromURL } from '../../sources/source.ts';
import { rejectRawPcmChunkMux } from '../audio-container-mux-validation.ts';
import { matchesAiff } from '../audio-container-sniff.ts';
import { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { trySliceAiffPcm } from './aiff-slice.ts';
import { locate, parseAiff, readAiffPcm } from './aiff.ts';

const AIFF_PROBE_HEAD_BYTES = 64;
const AIFF_PACKET_INFO_HEAD_BYTES = 65536;
const AIFF_PACKET_TARGET_BYTES = 4096;
const AIFF_PACKET_INFO_PREFIX_TTL_MS = 60_000;
const AIFF_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES = 64;
const OPERATION_ABORTED = 'operation aborted';

export interface AiffPacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface AiffPacketInfoPrefixCacheEntry {
  readonly bytes: Uint8Array;
  readonly totalSize?: number;
  readonly expiresAtMs: number;
}

const aiffPacketInfoPrefixCache = new Map<string, AiffPacketInfoPrefixCacheEntry>();

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(n, src.size ?? n));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** Read the whole source — PCM transforms need every sample (bounded by file size). */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function aiffTrackInfo(info: ReturnType<typeof parseAiff>): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

function aiffPacketInfoFromLocatedBytes(
  bytes: Uint8Array,
  totalSize = bytes.byteLength,
): PacketInfoTable {
  const { layout, ssndSampleOffset, ssndSampleBytes } = locate(bytes, totalSize);
  const codec =
    layout.format === 'f32'
      ? 'pcm-f32'
      : layout.format === 'f64'
        ? 'pcm-f64'
        : layout.format === 's8'
          ? 'pcm-s8'
          : layout.endian === 'be'
            ? `pcm-${layout.format}be`
            : `pcm-${layout.format}`;
  const sampleRate = Math.round(layout.sampleRate);
  const track: TrackInfo = {
    id: 0,
    mediaType: 'audio',
    codec,
    durationSec: layout.sampleRate > 0 ? layout.frames / layout.sampleRate : 0,
    config: { codec, sampleRate, numberOfChannels: layout.channels },
  };
  const packets: PacketInfoMetadata[] = [];
  const bytesPerFrame = bytesPerSample(layout.format) * layout.channels;
  if (ssndSampleOffset >= 0 && bytesPerFrame > 0 && sampleRate > 0 && ssndSampleBytes > 0) {
    const totalFrames = Math.floor(ssndSampleBytes / bytesPerFrame);
    // FFmpeg's PCM demuxers target a 4 KiB packet payload, rounded down to a complete interleaved
    // sample frame. Keeping the policy byte-oriented is important: mono s16 is 2,048 frames/packet,
    // stereo s16 is 1,024, and mono s24 is 1,365 (4,095 bytes). A frame-oriented constant gives the
    // wrong packet table for every layout except stereo s16.
    const packetFrames = Math.max(1, Math.floor(AIFF_PACKET_TARGET_BYTES / bytesPerFrame));
    for (let frame = 0; frame < totalFrames; frame += packetFrames) {
      const frames = Math.min(packetFrames, totalFrames - frame);
      const ptsUs = Math.round((frame / sampleRate) * 1_000_000);
      packets.push({
        trackIndex: 0,
        offset: ssndSampleOffset + frame * bytesPerFrame,
        size: frames * bytesPerFrame,
        ptsUs,
        dtsUs: ptsUs,
        durationUs: Math.round((frames / sampleRate) * 1_000_000),
        keyframe: true,
      });
    }
  }
  return { tracks: [track], packets };
}

export function aiffPacketInfoFromBytes(bytes: Uint8Array): PacketInfoTable {
  return aiffPacketInfoFromLocatedBytes(bytes);
}

function aiffPacketInfoUrlCacheKey(url: string | URL, opts: AiffPacketInfoFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function cachedAiffPacketInfoPrefix(
  key: string,
  totalSize: number | undefined,
): PacketInfoTable | undefined {
  const entry = aiffPacketInfoPrefixCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    aiffPacketInfoPrefixCache.delete(key);
    return undefined;
  }
  const table = aiffPacketInfoFromLocatedBytes(
    entry.bytes,
    totalSize ?? entry.totalSize ?? entry.bytes.byteLength,
  );
  return table.packets.length > 0 ? table : undefined;
}

function storeAiffPacketInfoPrefix(
  key: string,
  bytes: Uint8Array,
  totalSize: number | undefined,
): void {
  const now = Date.now();
  for (const [entryKey, entry] of aiffPacketInfoPrefixCache) {
    if (entry.expiresAtMs <= now) aiffPacketInfoPrefixCache.delete(entryKey);
  }
  while (aiffPacketInfoPrefixCache.size >= AIFF_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES) {
    const oldest = aiffPacketInfoPrefixCache.keys().next().value as string;
    aiffPacketInfoPrefixCache.delete(oldest);
  }
  aiffPacketInfoPrefixCache.set(key, {
    bytes: bytes.slice(),
    ...(totalSize !== undefined ? { totalSize } : {}),
    expiresAtMs: now + AIFF_PACKET_INFO_PREFIX_TTL_MS,
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
}

export async function aiffPacketInfoFromUrl(
  url: string | URL,
  opts: AiffPacketInfoFromUrlOptions = {},
): Promise<PacketInfoTable> {
  assertNotAborted(opts.signal);
  const packetInfo = AiffDriver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'AIFF packet-info is not available', {
      op: { op: 'demux', container: 'aiff' },
      tried: ['aiff'],
    });
  }
  const key = aiffPacketInfoUrlCacheKey(url, opts);
  const cached = cachedAiffPacketInfoPrefix(key, opts.size);
  if (cached !== undefined) return cached;
  const src = fromURL(url, {
    mime: opts.mime ?? 'audio/aiff',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  if (src.range !== undefined) {
    const prefix = await src.range(
      0,
      opts.size !== undefined
        ? Math.min(opts.size, AIFF_PACKET_INFO_HEAD_BYTES)
        : AIFF_PACKET_INFO_HEAD_BYTES,
    );
    assertNotAborted(opts.signal);
    const totalSize = src.size ?? opts.size;
    const table = aiffPacketInfoFromLocatedBytes(prefix, totalSize ?? prefix.byteLength);
    if (table.packets.length > 0 && totalSize !== undefined) {
      storeAiffPacketInfoPrefix(key, prefix, totalSize);
      return table;
    }
  }
  return packetInfo.call(
    AiffDriver,
    src,
    opts.signal !== undefined ? { signal: opts.signal } : undefined,
  );
}

export const AiffDriver: ContainerDriver = {
  id: 'aiff',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['aiff'],
  supports: matchesAiff,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    assertNotAborted(o?.signal);
    let head = await readHead(src, AIFF_PROBE_HEAD_BYTES);
    assertNotAborted(o?.signal);
    try {
      return [aiffTrackInfo(parseAiff(head))];
    } catch (error) {
      const maxFallback = Math.min(
        src.size ?? AIFF_PACKET_INFO_HEAD_BYTES,
        AIFF_PACKET_INFO_HEAD_BYTES,
      );
      if (src.range === undefined || head.byteLength >= maxFallback) throw error;
      head = await readHead(src, AIFF_PACKET_INFO_HEAD_BYTES);
      assertNotAborted(o?.signal);
      return [aiffTrackInfo(parseAiff(head))];
    }
  },
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseAiff(await readHead(src, 65536));
    const track = aiffTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'capability-miss',
          'AIFF PCM flows through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: ['aiff'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const head = await readHead(src, 65536);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    try {
      const table = aiffPacketInfoFromLocatedBytes(head, src.size ?? head.byteLength);
      if (table.packets.length > 0 || src.size !== undefined) return table;
    } catch (error) {
      if (src.size !== undefined) throw error;
    }
    const bytes = await readAll(src);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return aiffPacketInfoFromLocatedBytes(bytes);
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const bytes = await readAll(src);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const container = o?.container ?? 'aiff';
    const sliced = trySliceAiffPcm(bytes, o ?? {});
    if (sliced !== undefined) {
      return new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(sliced);
          c.close();
        },
      });
    }
    const aiff = readAiffPcm(bytes);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const audio = applyPcmTransform(aiff, o);
    const out = writePcmContainer(
      audio,
      container,
      resolvePcmSampleFormat(container, aiff.format, o?.sampleFormat),
      o?.endian ?? aiff.endian,
      aiff.kind,
    );
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const aiff = readAiffPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return aiff;
  },
  createMuxer(): Muxer {
    // AIFF carries raw PCM, not WebCodecs EncodedChunks, so the seam Muxer doesn't map; PCM output is
    // produced by `transformPcm` (writeAiff) — the audio-dsp path (ADR-022), exactly like WAV.
    return rejectRawPcmChunkMux('aiff');
  },
};

export const AiffModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AiffDriver);
  },
};

export default AiffModule;
