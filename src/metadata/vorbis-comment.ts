import { InputError, MediaError } from '../contracts/errors.ts';
import { ascii, flacOffset } from '../drivers/flac/flac-sniff.ts';
import {
  type MetadataTags,
  concatBytes,
  mergeStringTags,
  publicKeyFromVorbis,
  readU32le,
  u32le,
  utf8Bytes,
  utf8String,
} from './tag-map.ts';

const FLAC_MAGIC = 'fLaC';
const STREAMINFO = 0;
const VORBIS_COMMENT = 4;
const DEFAULT_VENDOR = 'aibrush-media';

interface FlacBlock {
  readonly type: number;
  readonly body: Uint8Array;
}

interface ParsedVorbisComment {
  readonly vendor: string;
  readonly comments: readonly string[];
}

function readU24be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 3 > bytes.byteLength) return undefined;
  return (
    ((bytes[offset] as number) << 16) |
    ((bytes[offset + 1] as number) << 8) |
    (bytes[offset + 2] as number)
  );
}

function parseFlacBlocks(
  bytes: Uint8Array,
  start: number,
): { blocks: readonly FlacBlock[]; end: number } {
  if (bytes.byteLength < start + 4 || ascii(bytes, start, 4) !== FLAC_MAGIC) {
    throw new InputError('unsupported-input', 'not a native FLAC stream');
  }
  const blocks: FlacBlock[] = [];
  let offset = start + 4;
  for (;;) {
    if (offset + 4 > bytes.byteLength) {
      throw new MediaError('demux-error', 'FLAC metadata block header is truncated');
    }
    const header = bytes[offset] as number;
    const type = header & 0x7f;
    const length = readU24be(bytes, offset + 1);
    if (length === undefined || offset + 4 + length > bytes.byteLength) {
      throw new MediaError('demux-error', 'FLAC metadata block body is truncated');
    }
    blocks.push({ type, body: bytes.slice(offset + 4, offset + 4 + length) });
    offset += 4 + length;
    if ((header & 0x80) !== 0) break;
  }
  if (blocks[0]?.type !== STREAMINFO) {
    throw new MediaError('demux-error', 'FLAC first metadata block is not STREAMINFO');
  }
  return { blocks, end: offset };
}

function encodeBlock(block: FlacBlock, last: boolean): Uint8Array {
  if (block.body.byteLength > 0xffffff) {
    throw new MediaError('mux-error', 'FLAC metadata block exceeds 24-bit length limit');
  }
  return Uint8Array.from([
    block.type | (last ? 0x80 : 0x00),
    (block.body.byteLength >>> 16) & 0xff,
    (block.body.byteLength >>> 8) & 0xff,
    block.body.byteLength & 0xff,
    ...block.body,
  ]);
}

function parseVorbisCommentBody(body: Uint8Array): ParsedVorbisComment {
  const vendorLength = readU32le(body, 0);
  if (vendorLength === undefined || 4 + vendorLength + 4 > body.byteLength) {
    throw new MediaError('demux-error', 'VorbisComment vendor is truncated');
  }
  const vendor = utf8String(body.subarray(4, 4 + vendorLength));
  const countOffset = 4 + vendorLength;
  const count = readU32le(body, countOffset);
  if (count === undefined) throw new MediaError('demux-error', 'VorbisComment count is truncated');
  const comments: string[] = [];
  let offset = countOffset + 4;
  for (let i = 0; i < count; i++) {
    const length = readU32le(body, offset);
    if (length === undefined || offset + 4 + length > body.byteLength) {
      throw new MediaError('demux-error', 'VorbisComment entry is truncated');
    }
    comments.push(utf8String(body.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  return { vendor, comments };
}

function safeParseVorbisCommentBody(body: Uint8Array | undefined): ParsedVorbisComment {
  if (body === undefined) return { vendor: DEFAULT_VENDOR, comments: [] };
  try {
    return parseVorbisCommentBody(body);
  } catch {
    return { vendor: DEFAULT_VENDOR, comments: [] };
  }
}

export function buildVorbisCommentBody(tags: MetadataTags, existingBody?: Uint8Array): Uint8Array {
  const existing = safeParseVorbisCommentBody(existingBody);
  const vendor = existing.vendor.length > 0 ? existing.vendor : DEFAULT_VENDOR;
  const comments = mergeStringTags(existing.comments, tags);
  const parts: Uint8Array[] = [
    Uint8Array.from(u32le(utf8Bytes(vendor).byteLength)),
    utf8Bytes(vendor),
  ];
  parts.push(Uint8Array.from(u32le(comments.length)));
  for (const comment of comments) {
    const bytes = utf8Bytes(comment);
    parts.push(Uint8Array.from(u32le(bytes.byteLength)), bytes);
  }
  return concatBytes(parts);
}

export function readVorbisCommentBody(body: Uint8Array): Record<string, string> {
  const parsed = parseVorbisCommentBody(body);
  const out: Record<string, string> = {};
  for (const entry of parsed.comments) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out[publicKeyFromVorbis(entry.slice(0, eq))] = entry.slice(eq + 1);
  }
  return out;
}

export function writeFlacVorbisComment(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const start = flacOffset(bytes);
  const { blocks, end } = parseFlacBlocks(bytes, start);
  const oldComment = blocks.find((block) => block.type === VORBIS_COMMENT);
  const nextBlocks: FlacBlock[] = [];
  let inserted = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (block.type === VORBIS_COMMENT) {
      if (!inserted) {
        nextBlocks.push({
          type: VORBIS_COMMENT,
          body: buildVorbisCommentBody(tags, oldComment?.body),
        });
        inserted = true;
      }
      continue;
    }
    nextBlocks.push(block);
    if (!inserted && block.type === STREAMINFO) {
      nextBlocks.push({
        type: VORBIS_COMMENT,
        body: buildVorbisCommentBody(tags, oldComment?.body),
      });
      inserted = true;
    }
  }
  const encodedBlocks = nextBlocks.map((block, i) =>
    encodeBlock(block, i === nextBlocks.length - 1),
  );
  return concatBytes([bytes.slice(0, start + 4), ...encodedBlocks, bytes.slice(end)]);
}

export function readFlacVorbisComment(bytes: Uint8Array): Record<string, string> {
  const start = flacOffset(bytes);
  const { blocks } = parseFlacBlocks(bytes, start);
  const comment = blocks.find((block) => block.type === VORBIS_COMMENT);
  return comment === undefined ? {} : readVorbisCommentBody(comment.body);
}
