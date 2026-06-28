import { MediaError } from '../contracts/errors.ts';

export type MetadataTags = Readonly<Record<string, string>>;

export interface NormalizedTag {
  readonly key: string;
  readonly value: string;
}

const STANDARD_KEYS = new Map<string, string>([
  ['album', 'album'],
  ['albumartist', 'albumArtist'],
  ['album_artist', 'albumArtist'],
  ['artist', 'artist'],
  ['comment', 'comment'],
  ['comments', 'comment'],
  ['date', 'date'],
  ['description', 'description'],
  ['genre', 'genre'],
  ['title', 'title'],
  ['track', 'trackNumber'],
  ['tracknumber', 'trackNumber'],
  ['track_number', 'trackNumber'],
]);

const VORBIS_KEYS = new Map<string, string>([
  ['album', 'ALBUM'],
  ['albumArtist', 'ALBUMARTIST'],
  ['artist', 'ARTIST'],
  ['comment', 'COMMENT'],
  ['date', 'DATE'],
  ['description', 'DESCRIPTION'],
  ['genre', 'GENRE'],
  ['title', 'TITLE'],
  ['trackNumber', 'TRACKNUMBER'],
]);

const PUBLIC_KEYS = new Map<string, string>([
  ['ALBUM', 'album'],
  ['ALBUMARTIST', 'albumArtist'],
  ['ARTIST', 'artist'],
  ['COMMENT', 'comment'],
  ['DATE', 'date'],
  ['DESCRIPTION', 'description'],
  ['GENRE', 'genre'],
  ['TITLE', 'title'],
  ['TRACKNUMBER', 'trackNumber'],
]);

export const UTF8 = new TextEncoder();
export const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

export function utf8Bytes(value: string): Uint8Array {
  return UTF8.encode(value);
}

export function utf8String(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

export function normalizePublicKey(key: string): string {
  const compact = key.trim().replace(/[\s-]+/g, '_');
  const folded = compact.toLowerCase();
  return STANDARD_KEYS.get(folded) ?? compact;
}

export function normalizeTags(tags: MetadataTags): NormalizedTag[] {
  const out: NormalizedTag[] = [];
  for (const [rawKey, rawValue] of Object.entries(tags)) {
    const key = normalizePublicKey(rawKey);
    if (key.length === 0) continue;
    if (key.includes('\0')) {
      throw new MediaError('mux-error', `metadata tag key '${rawKey}' contains a NUL byte`);
    }
    const value = String(rawValue);
    if (value.includes('\0')) {
      throw new MediaError('mux-error', `metadata tag '${rawKey}' contains a NUL byte`);
    }
    out.push({ key, value });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

export function vorbisKeyFor(publicKey: string): string {
  const known = VORBIS_KEYS.get(normalizePublicKey(publicKey));
  if (known !== undefined) return known;
  const cleaned = publicKey
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
  return cleaned.length > 0 ? cleaned : 'TAG';
}

export function publicKeyFromVorbis(key: string): string {
  const upper = key.trim().toUpperCase();
  return PUBLIC_KEYS.get(upper) ?? upper.toLowerCase();
}

export function mergeStringTags(
  existing: readonly string[],
  tags: MetadataTags,
): readonly string[] {
  const normalized = normalizeTags(tags);
  const replacing = new Set(normalized.map((tag) => vorbisKeyFor(tag.key)));
  const kept = existing.filter((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0) return false;
    return !replacing.has(entry.slice(0, eq).toUpperCase());
  });
  return [...kept, ...normalized.map((tag) => `${vorbisKeyFor(tag.key)}=${tag.value}`)];
}

export function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function readU32le(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
