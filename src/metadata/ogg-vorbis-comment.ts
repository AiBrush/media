import { InputError, MediaError } from '../contracts/errors.ts';
import type { MetadataTags } from './tag-map.ts';
import { buildVorbisCommentBody, readVorbisCommentBody } from './vorbis-comment.ts';

const OGG_CAPTURE = 'OggS';
const CRC_POLY = 0x04c11db7;
const HT_CONTINUED = 0x01;
const HT_BOS = 0x02;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n << 24;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ CRC_POLY : crc << 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

interface OggPage {
  readonly start: number;
  readonly end: number;
  readonly headerType: number;
  readonly granule: number;
  readonly serial: number;
  readonly sequence: number;
  readonly segments: readonly number[];
  readonly bodyStart: number;
}

interface OggPacket {
  readonly data: Uint8Array;
  readonly granule: number;
  readonly completedOnPage: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function readGranule(dv: DataView, offset: number): number {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  if (lo === 0xffffffff && hi === 0xffffffff) return -1;
  return hi * 2 ** 32 + lo;
}

function granuleBytes(value: number): number[] {
  if (value < 0) return [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return [...u32le(value >>> 0), ...u32le(Math.floor(value / 2 ** 32))];
}

function crc(bytes: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    const idx = ((value >>> 24) ^ (bytes[i] as number)) & 0xff;
    value = ((value << 8) ^ (CRC_TABLE[idx] as number)) >>> 0;
  }
  return value;
}

function writeCrc(page: Uint8Array): void {
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  dv.setUint32(22, 0, true);
  dv.setUint32(22, crc(page), true);
}

function parsePages(bytes: Uint8Array): readonly OggPage[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: OggPage[] = [];
  let offset = 0;
  while (offset + 27 <= bytes.byteLength) {
    if (ascii(bytes, offset, 4) !== OGG_CAPTURE) {
      offset++;
      continue;
    }
    if (dv.getUint8(offset + 4) !== 0) {
      offset++;
      continue;
    }
    const segCount = dv.getUint8(offset + 26);
    const segmentTableEnd = offset + 27 + segCount;
    if (segmentTableEnd > bytes.byteLength) break;
    const segments: number[] = [];
    let bodyLength = 0;
    for (let i = 0; i < segCount; i++) {
      const len = dv.getUint8(offset + 27 + i);
      segments.push(len);
      bodyLength += len;
    }
    const end = segmentTableEnd + bodyLength;
    if (end > bytes.byteLength) break;
    pages.push({
      start: offset,
      end,
      headerType: dv.getUint8(offset + 5),
      granule: readGranule(dv, offset + 6),
      serial: dv.getUint32(offset + 14, true),
      sequence: dv.getUint32(offset + 18, true),
      segments,
      bodyStart: segmentTableEnd,
    });
    offset = end;
  }
  if (pages.length === 0) throw new InputError('unsupported-input', 'not an Ogg stream');
  return pages;
}

function delace(
  bytes: Uint8Array,
  pages: readonly OggPage[],
  serial: number,
): readonly OggPacket[] {
  const packets: OggPacket[] = [];
  let pending: number[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined || page.serial !== serial) continue;
    let dataOffset = page.bodyStart;
    for (const segment of page.segments) {
      for (let i = 0; i < segment; i++) pending.push(bytes[dataOffset + i] as number);
      dataOffset += segment;
      if (segment < 255) {
        packets.push({
          data: Uint8Array.from(pending),
          granule: page.granule,
          completedOnPage: pageIndex,
        });
        pending = [];
      }
    }
  }
  return packets;
}

function lacingFor(length: number): number[] {
  const out: number[] = [];
  let remaining = length;
  while (remaining >= 255) {
    out.push(255);
    remaining -= 255;
  }
  out.push(remaining);
  return out;
}

function serializePage(opts: {
  readonly headerType: number;
  readonly granule: number;
  readonly serial: number;
  readonly sequence: number;
  readonly body: Uint8Array;
  readonly lacing: readonly number[];
}): Uint8Array {
  const header = Uint8Array.from([
    0x4f,
    0x67,
    0x67,
    0x53,
    0,
    opts.headerType,
    ...granuleBytes(opts.granule),
    ...u32le(opts.serial),
    ...u32le(opts.sequence),
    0,
    0,
    0,
    0,
    opts.lacing.length,
    ...opts.lacing,
  ]);
  const page = new Uint8Array(header.byteLength + opts.body.byteLength);
  page.set(header, 0);
  page.set(opts.body, header.byteLength);
  writeCrc(page);
  return page;
}

function pagesForHeaderPackets(
  packets: readonly Uint8Array[],
  serial: number,
  firstSequence: number,
): readonly Uint8Array[] {
  const out: Uint8Array[] = [];
  let sequence = firstSequence;
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    const packet = packets[packetIndex];
    if (packet === undefined) continue;
    const lacing = lacingFor(packet.byteLength);
    let lacingOffset = 0;
    let byteOffset = 0;
    let continued = false;
    while (lacingOffset < lacing.length) {
      const take = Math.min(255, lacing.length - lacingOffset);
      const pageLacing = lacing.slice(lacingOffset, lacingOffset + take);
      let bodyLen = 0;
      for (const value of pageLacing) bodyLen += value;
      const body = packet.slice(byteOffset, byteOffset + bodyLen);
      let headerType = continued ? HT_CONTINUED : 0;
      if (packetIndex === 0 && !continued) headerType |= HT_BOS;
      out.push(
        serializePage({ headerType, granule: 0, serial, sequence, body, lacing: pageLacing }),
      );
      sequence++;
      lacingOffset += take;
      byteOffset += bodyLen;
      continued = true;
    }
  }
  return out;
}

function rewriteSequence(pageBytes: Uint8Array, sequence: number): Uint8Array {
  const out = pageBytes.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(18, sequence, true);
  writeCrc(out);
  return out;
}

function codecHeaderPackets(
  first: Uint8Array,
  second: Uint8Array | undefined,
): {
  readonly kind: 'opus' | 'vorbis';
  readonly headerCount: number;
  readonly existingCommentBody: Uint8Array | undefined;
} {
  if (ascii(first, 0, 8) === 'OpusHead') {
    const body =
      second !== undefined && ascii(second, 0, 8) === 'OpusTags' ? second.subarray(8) : undefined;
    return { kind: 'opus', headerCount: 2, existingCommentBody: body };
  }
  if (first[0] === 0x01 && ascii(first, 1, 6) === 'vorbis') {
    const body =
      second !== undefined && second[0] === 0x03 && ascii(second, 1, 6) === 'vorbis'
        ? second.subarray(7, Math.max(7, second.byteLength - 1))
        : undefined;
    return { kind: 'vorbis', headerCount: 3, existingCommentBody: body };
  }
  throw new MediaError('mux-error', 'Ogg metadata writer supports OpusTags and Vorbis comments');
}

function buildCommentPacket(kind: 'opus' | 'vorbis', body: Uint8Array): Uint8Array {
  if (kind === 'opus') {
    return Uint8Array.from([[...'OpusTags'].map((c) => c.charCodeAt(0)), [...body]].flat());
  }
  return Uint8Array.from([0x03, ...[...'vorbis'].map((c) => c.charCodeAt(0)), ...body, 0x01]);
}

export function writeOggVorbisComment(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const pages = parsePages(bytes);
  const bos = pages.find((page) => (page.headerType & HT_BOS) !== 0);
  if (bos === undefined) throw new InputError('unsupported-input', 'Ogg stream has no BOS page');
  const packets = delace(bytes, pages, bos.serial);
  const first = packets[0]?.data;
  if (first === undefined)
    throw new InputError('unsupported-input', 'Ogg stream has no header packet');
  const second = packets[1]?.data;
  const header = codecHeaderPackets(first, second);
  const headerEnd = packets[header.headerCount - 1]?.completedOnPage;
  if (headerEnd === undefined) {
    throw new MediaError('demux-error', 'Ogg header packet set is incomplete');
  }
  const newComment = buildCommentPacket(
    header.kind,
    buildVorbisCommentBody(tags, header.existingCommentBody),
  );
  const headerPackets = [
    first,
    newComment,
    ...packets.slice(2, header.headerCount).map((p) => p.data),
  ];
  const rewrittenHeaders = pagesForHeaderPackets(headerPackets, bos.serial, 0);
  const parts: Uint8Array[] = [...rewrittenHeaders];
  let sequence = rewrittenHeaders.length;
  for (let i = headerEnd + 1; i < pages.length; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    parts.push(rewriteSequence(bytes.slice(page.start, page.end), sequence));
    sequence++;
  }
  return concatLocal(parts);
}

export function readOggVorbisComment(bytes: Uint8Array): Record<string, string> {
  const pages = parsePages(bytes);
  const bos = pages.find((page) => (page.headerType & HT_BOS) !== 0);
  if (bos === undefined) return {};
  const packets = delace(bytes, pages, bos.serial);
  const first = packets[0]?.data;
  const second = packets[1]?.data;
  if (first === undefined || second === undefined) return {};
  const header = codecHeaderPackets(first, second);
  if (header.existingCommentBody === undefined) return {};
  return readVorbisCommentBody(header.existingCommentBody);
}

function concatLocal(parts: readonly Uint8Array[]): Uint8Array {
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
