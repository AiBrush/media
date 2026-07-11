/** Cheap, exact support predicates for lazily-registered long-tail audio containers. */

import type { ContainerQuery } from '../contracts/driver.ts';

const WAV_MIMES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave']);
const WAV_EXTENSIONS = new Set(['wav', 'wave']);
const MP3_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3']);
const MP3_EXTENSIONS = new Set(['mp3']);
const OGG_MIMES = new Set(['audio/ogg', 'video/ogg', 'application/ogg', 'audio/opus']);
const OGG_EXTENSIONS = new Set(['ogg', 'oga', 'ogv', 'opus', 'spx']);
const ADTS_MIMES = new Set(['audio/aac', 'audio/aacp', 'audio/x-aac']);
const ADTS_EXTENSIONS = new Set(['aac', 'adts']);
const AIFF_MIMES = new Set(['audio/aiff', 'audio/x-aiff', 'audio/aifc', 'audio/x-aifc']);
const AIFF_EXTENSIONS = new Set(['aiff', 'aif', 'aifc']);
const CAF_MIMES = new Set(['audio/x-caf', 'audio/caf']);
const CAF_EXTENSIONS = new Set(['caf', 'caff']);

function matchesHint(
  q: ContainerQuery,
  mimes: ReadonlySet<string>,
  extensions: ReadonlySet<string>,
): boolean {
  return (
    (q.mime !== undefined && mimes.has(q.mime)) ||
    (q.extension !== undefined && extensions.has(q.extension.toLowerCase()))
  );
}

function tag(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

export function matchesWav(q: ContainerQuery): boolean {
  if (matchesHint(q, WAV_MIMES, WAV_EXTENSIONS)) return true;
  const head = q.head;
  return head !== undefined && tag(head, 0, 'RIFF') && tag(head, 8, 'WAVE');
}

export function matchesMp3(q: ContainerQuery): boolean {
  if (matchesHint(q, MP3_MIMES, MP3_EXTENSIONS)) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 3) return false;
  if (tag(head, 0, 'ID3')) return true;
  const b1 = head[1] ?? 0;
  return head[0] === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0;
}

export function matchesOgg(q: ContainerQuery): boolean {
  if (matchesHint(q, OGG_MIMES, OGG_EXTENSIONS)) return true;
  return q.head !== undefined && tag(q.head, 0, 'OggS');
}

export function matchesAdts(q: ContainerQuery): boolean {
  if (matchesHint(q, ADTS_MIMES, ADTS_EXTENSIONS)) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 7) return false;
  const offset = adtsHeadOffset(head);
  const b0 = offset === undefined ? undefined : head[offset];
  const b1 = offset === undefined ? undefined : head[offset + 1];
  return b0 !== undefined && b1 !== undefined && isAdtsSync(b0, b1);
}

export function matchesAiff(q: ContainerQuery): boolean {
  if (matchesHint(q, AIFF_MIMES, AIFF_EXTENSIONS)) return true;
  const head = q.head;
  return (
    head !== undefined && tag(head, 0, 'FORM') && (tag(head, 8, 'AIFF') || tag(head, 8, 'AIFC'))
  );
}

export function matchesCaf(q: ContainerQuery): boolean {
  if (matchesHint(q, CAF_MIMES, CAF_EXTENSIONS)) return true;
  return q.head !== undefined && tag(q.head, 0, 'caff');
}

function isAdtsSync(b0: number, b1: number): boolean {
  return b0 === 0xff && (b1 & 0xf0) === 0xf0 && (b1 & 0x06) === 0;
}

/** Skip fully-visible stacked ID3v2 tags, including optional footers, before checking ADTS sync. */
function adtsHeadOffset(head: Uint8Array): number | undefined {
  const bytes = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 0;
  while (offset + 10 <= head.byteLength && tag(head, offset, 'ID3')) {
    const size =
      ((bytes.getUint8(offset + 6) & 0x7f) << 21) |
      ((bytes.getUint8(offset + 7) & 0x7f) << 14) |
      ((bytes.getUint8(offset + 8) & 0x7f) << 7) |
      (bytes.getUint8(offset + 9) & 0x7f);
    const footer = (bytes.getUint8(offset + 5) & 0x10) !== 0 ? 10 : 0;
    offset += 10 + size + footer;
  }
  return offset <= head.byteLength ? offset : undefined;
}
