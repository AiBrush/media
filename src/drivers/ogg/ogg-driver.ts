/**
 * The Ogg container driver — hand-written TS. An Ogg file is a sequence of **pages** (little-endian);
 * each logical stream opens with a BOS page whose first packet is the codec identification header
 * (Vorbis and Opus now; FLAC/Theora join with their fixtures, §6.1). Probe reads the head (for the ID
 * header) and the tail (for the last page's `granule_position` → duration), mirroring the moov-at-tail
 * strategy (docs/architecture/09).
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type EncodedChunk,
  type MediaType,
  type Muxer,
  type Registry,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';

const OGG_MIMES = new Set(['audio/ogg', 'video/ogg', 'application/ogg', 'audio/opus']);
const OGG_EXTENSIONS = new Set(['ogg', 'oga', 'ogv', 'opus', 'spx']);

function asciiAt(dv: DataView, offset: number, length: number): string {
  if (offset + length > dv.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
}

interface PageHeader {
  headerType: number;
  granule: number; // -1 when no packet completes on the page
  serial: number;
  dataStart: number;
  pageEnd: number;
}

/** Read a 64-bit LE granule; the all-ones value means "no granule". */
function readGranule(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (lo === 0xffffffff && hi === 0xffffffff) return -1;
  return hi * 2 ** 32 + lo;
}

/** Parse the Ogg page header at `at` ('OggS' …), or undefined if it isn't a valid page. */
function parsePage(dv: DataView, at: number): PageHeader | undefined {
  if (asciiAt(dv, at, 4) !== 'OggS' || at + 27 > dv.byteLength) return undefined;
  if (dv.getUint8(at + 4) !== 0) return undefined; // stream structure version must be 0
  const segCount = dv.getUint8(at + 26);
  if (at + 27 + segCount > dv.byteLength) return undefined;
  let dataLen = 0;
  for (let i = 0; i < segCount; i++) dataLen += dv.getUint8(at + 27 + i);
  const dataStart = at + 27 + segCount;
  return {
    headerType: dv.getUint8(at + 5),
    granule: readGranule(dv, at + 6),
    serial: dv.getUint32(at + 14, true),
    dataStart,
    pageEnd: dataStart + dataLen,
  };
}

interface OggStream {
  codec: string;
  mediaType: MediaType;
  channels: number;
  sampleRate: number;
  /** Granule ticks per second (sampleRate for Vorbis/FLAC; 48000 for Opus). */
  granuleRate: number;
  serial: number;
}

/** Identify the first audio stream from its BOS page's identification packet. */
function identifyStream(dv: DataView, page: PageHeader): OggStream | undefined {
  const d = page.dataStart;
  if (dv.getUint8(d) === 0x01 && asciiAt(dv, d + 1, 6) === 'vorbis') {
    const channels = dv.getUint8(d + 11);
    const sampleRate = dv.getUint32(d + 12, true);
    return {
      codec: 'vorbis',
      mediaType: 'audio',
      channels,
      sampleRate,
      granuleRate: sampleRate,
      serial: page.serial,
    };
  }
  if (asciiAt(dv, d, 8) === 'OpusHead') {
    // OpusHead is a fixed, unambiguous layout: magic(8) + version(1) + channel_count(1) + … Opus
    // always decodes at 48 kHz, so the granule clock is 48 kHz regardless of the input rate field.
    return {
      codec: 'opus',
      mediaType: 'audio',
      channels: dv.getUint8(d + 9),
      sampleRate: 48000,
      granuleRate: 48000,
      serial: page.serial,
    };
  }
  // Ogg-FLAC and Theora are added with their fixtures (the corpus only grows, §6.1).
  return undefined;
}

/** Scan a buffer for pages of `serial`, returning the largest valid granule (total samples). */
function maxGranule(dv: DataView, serial: number): number {
  let best = 0;
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.serial === serial && page.granule > best) best = page.granule;
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  return best;
}

export interface OggInfo {
  codec: string;
  mediaType: MediaType;
  channels: number;
  sampleRate: number;
  durationSec: number;
}

/** Parse Ogg metadata: identify the first stream from `head`, derive duration from `head`+`tail`. */
export function parseOgg(head: Uint8Array, tail?: Uint8Array): OggInfo {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let stream: OggStream | undefined;
  let at = 0;
  while (at + 27 <= dv.byteLength && !stream) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.headerType & 0x02) stream = identifyStream(dv, page); // BOS page
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  if (!stream) throw new InputError('unsupported-input', 'no recognized Ogg codec stream found');

  let granule = maxGranule(dv, stream.serial);
  if (tail) {
    const td = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    granule = Math.max(granule, maxGranule(td, stream.serial));
  }
  return {
    codec: stream.codec,
    mediaType: stream.mediaType,
    channels: stream.channels,
    sampleRate: stream.sampleRate,
    durationSec: stream.granuleRate > 0 ? granule / stream.granuleRate : 0,
  };
}

const HEAD_BYTES = 1 << 16;

async function readHead(src: ByteSource): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(HEAD_BYTES, src.size ?? HEAD_BYTES));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

async function readTail(src: ByteSource): Promise<Uint8Array | undefined> {
  if (src.range && src.size !== undefined && src.size > HEAD_BYTES) {
    return src.range(src.size - HEAD_BYTES, src.size);
  }
  return undefined;
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && OGG_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && OGG_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 4) return false;
  return asciiAt(new DataView(head.buffer, head.byteOffset, head.byteLength), 0, 4) === 'OggS';
}

export const OggDriver: ContainerDriver = {
  id: 'ogg',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['ogg'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseOgg(await readHead(src), await readTail(src));
    const track: TrackInfo = {
      id: 0,
      mediaType: info.mediaType,
      codec: info.codec,
      durationSec: info.durationSec,
      config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<EncodedChunk> {
        throw new CapabilityError(
          'capability-miss',
          'Ogg packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
          { op: 'demux', tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(): Muxer {
    throw new MediaError('mux-error', 'ogg muxing lands in Phase 2');
  },
};

export const OggModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(OggDriver);
  },
};

export default OggModule;
