import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromURL } from '../../sources/source.ts';

export interface WavTrimFromUrlOptions {
  readonly startSec: number;
  readonly endSec: number;
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

const WAV_TRIM_URL_CACHE_TTL_MS = 60_000;
const WAV_TRIM_URL_CACHE_MAX_ENTRIES = 16;
const WAV_TRIM_URL_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
const OPERATION_ABORTED = 'operation aborted';

interface WavTrimUrlByteCacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const wavTrimUrlByteCache = new Map<string, WavTrimUrlByteCacheEntry>();

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

function wavTrimUrlCacheKey(url: string | URL, opts: WavTrimFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
}

function getCachedWavTrimBytes(key: string, nowMs: number): Uint8Array | undefined {
  const cached = wavTrimUrlByteCache.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAtMs <= nowMs) {
    wavTrimUrlByteCache.delete(key);
    return undefined;
  }
  wavTrimUrlByteCache.delete(key);
  wavTrimUrlByteCache.set(key, cached);
  return cached.bytes;
}

function rememberWavTrimBytes(key: string, bytes: Uint8Array, nowMs: number): void {
  if (bytes.byteLength > WAV_TRIM_URL_CACHE_MAX_ENTRY_BYTES) return;
  wavTrimUrlByteCache.set(key, {
    bytes,
    expiresAtMs: nowMs + WAV_TRIM_URL_CACHE_TTL_MS,
  });
  while (wavTrimUrlByteCache.size > WAV_TRIM_URL_CACHE_MAX_ENTRIES) {
    const oldest = wavTrimUrlByteCache.keys().next().value;
    if (oldest === undefined) break;
    wavTrimUrlByteCache.delete(oldest);
  }
}

async function writeWavPcmTrim(
  bytes: Uint8Array,
  opts: WavTrimFromUrlOptions,
): Promise<Uint8Array> {
  const { slice } = await import('./pcm-slice.ts');
  const out = slice(bytes, { startSec: opts.startSec, endSec: opts.endSec });
  if (out === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'WAV PCM byte-trim is not available for this layout',
      {
        op: { op: 'trim', container: 'wav' },
        tried: ['wav'],
      },
    );
  }
  return out;
}

export async function wavTrimFromUrl(
  url: string | URL,
  opts: WavTrimFromUrlOptions,
): Promise<Uint8Array> {
  throwIfAborted(opts.signal);
  const key = wavTrimUrlCacheKey(url, opts);
  const cached = getCachedWavTrimBytes(key, Date.now());
  if (cached !== undefined) {
    return writeWavPcmTrim(cached, opts);
  }
  const src = fromURL(url, {
    rangeRequests: true,
    mime: opts.mime ?? 'audio/wav',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  const bytes = await readAll(src);
  throwIfAborted(opts.signal);
  rememberWavTrimBytes(key, bytes, Date.now());
  return writeWavPcmTrim(bytes, opts);
}
