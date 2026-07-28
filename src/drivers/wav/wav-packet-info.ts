/**
 * Lightweight WAV packet-table helpers.
 *
 * Packet rows derive entirely from RIFF header geometry, so this path shares the probe parser and
 * remains independent of the full DSP/decode/transform/mux driver graph.
 */

import type {
  ByteSource,
  PacketInfoMetadata,
  PacketInfoTable,
  StageOptions,
} from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { fromURL } from '../../sources/source.ts';
import {
  type ParsedWavHeader,
  WAV_DEMUX_HEAD_BYTES,
  WAV_PROBE_HEAD_BYTES,
  parseWavHeader,
  readWavHead,
  wavTrackInfo,
} from './wav-probe.ts';

export const WAV_PACKET_FRAMES = 4096;
const WAV_PACKET_INFO_PREFIX_TTL_MS = 60_000;
const WAV_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES = 64;
const OPERATION_ABORTED = 'operation aborted';

export interface WavPacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface WavPacketInfoPrefixCacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const wavPacketInfoPrefixCache = new Map<string, WavPacketInfoPrefixCacheEntry>();

export function wavPacketInfoFromHeader(parsed: ParsedWavHeader): PacketInfoTable {
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

async function readAllWavSource(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
  if (src.range !== undefined && src.size !== undefined) {
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
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return bytes;
  } catch (error) {
    if (!completed && signal?.aborted !== true) await reader.cancel(error).catch(() => {});
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

/** Build WAV packet metadata from a byte source without loading the full WAV driver. */
export async function wavPacketInfoFromSource(
  src: ByteSource,
  o?: StageOptions,
): Promise<PacketInfoTable> {
  let head = await readWavHead(src, WAV_PROBE_HEAD_BYTES);
  let parsed = parseWavHeader(head, src.size);
  const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
  if (!parsed.dataFound && head.byteLength < maxFallback) {
    head = await readWavHead(src, WAV_DEMUX_HEAD_BYTES);
    parsed = parseWavHeader(head, src.size);
  }
  if (!parsed.dataFound && src.size !== undefined) {
    head = await readAllWavSource(src, o?.signal);
    parsed = parseWavHeader(head, src.size);
  }
  if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
  return wavPacketInfoFromHeader(parsed);
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
  return wavPacketInfoFromSource(
    src,
    opts.signal !== undefined ? { signal: opts.signal } : undefined,
  );
}
