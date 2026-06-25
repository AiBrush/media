/**
 * The Ogg `Muxer` seam (docs/architecture/05 §2, 09 mux) — a hand-written Ogg **page** writer plus the
 * {@link OggMuxer} adapter over it, mirroring the MP4/WebM muxers' "Muxer-over-writer" shape
 * ({@link Mp4Muxer}/{@link WebmMuxer}). An Ogg stream is a sequence of pages; each page is
 * `OggS · version(0) · header_type · granule(64 LE) · serial(32 LE) · page_seq(32 LE) · CRC(32 LE) ·
 * page_segments · segment_table · body`, with packets split into ≤ 255-byte segments (lacing). This
 * writes a codec **identification** header (BOS), a **comment/setup** header page, then **audio** pages
 * whose `granule_position` is the cumulative sample position (48 kHz for Opus; sampleRate for Vorbis).
 *
 * Page CRC is the Ogg variant — polynomial **0x04C11DB7, MSB-first, init 0, no reflection, no final XOR**
 * — computed over the whole page with the CRC field zeroed (this is what the round-trip oracle's
 * independent page/CRC scan re-verifies). The packet→page lacing + granule timing is pure and
 * Node-testable ({@link buildPages}); only the `write()` extraction of a real `EncodedChunk` (`copyTo`)
 * is browser-only and guarded.
 */

import type { EncodedChunk, MuxOptions, Muxer, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';

const MAX_SEGMENT = 255; // a lacing value is one byte; 255 means "continues in the next segment"
const MAX_PAGE_SEGMENTS = 255; // a page's segment table holds at most 255 lacing values
const OPUS_GRANULE_RATE = 48_000; // Opus always granule-clocks at 48 kHz, whatever the input rate
const MICROS_PER_SECOND = 1_000_000;
const DEFAULT_SERIAL = 0x00000001;

// Header-type flag bits (byte 5 of a page header).
const HT_CONTINUED = 0x01;
const HT_BOS = 0x02;
const HT_EOS = 0x04;

// ============ Ogg CRC-32 (0x04C11DB7, MSB-first, no reflection, no final XOR) ============

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n << 24;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

/** Ogg page CRC over `bytes` (the whole page with its CRC field zeroed). */
function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    const idx = ((crc >>> 24) ^ (bytes[i] ?? 0)) & 0xff;
    crc = ((crc << 8) ^ (CRC_TABLE[idx] ?? 0)) >>> 0;
  }
  return crc >>> 0;
}

// ============ byte helpers ============

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** 64-bit little-endian granule (split into low/high 32-bit halves; -1 ⇒ all 0xFF). */
function granule64le(granule: number): number[] {
  if (granule < 0) return [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return [...u32le(granule >>> 0), ...u32le(Math.floor(granule / 2 ** 32))];
}

function concatBytes(parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ============ page emission ============

/** A page's pre-CRC inputs: header type, granule, body, and the lacing (segment-table) values. */
interface PageDraft {
  headerType: number;
  granule: number;
  lacing: number[];
  body: Uint8Array;
}

/** Serialize one page (computing its CRC over the assembled bytes with the CRC field zeroed). */
function serializePage(draft: PageDraft, serial: number, seq: number): Uint8Array {
  const header = [
    0x4f,
    0x67,
    0x67,
    0x53, // 'OggS'
    0x00, // stream_structure_version
    draft.headerType,
    ...granule64le(draft.granule),
    ...u32le(serial),
    ...u32le(seq),
    ...u32le(0), // CRC placeholder (zeroed for the CRC computation)
    draft.lacing.length,
    ...draft.lacing,
  ];
  const page = concatBytes([header, draft.body]);
  const crc = oggCrc(page);
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  dv.setUint32(22, crc, true); // write the real CRC into bytes [22..26)
  return page;
}

/** The lacing values that encode one packet's length (255 runs + a terminating value < 255). */
function lacingForLength(length: number): number[] {
  const out: number[] = [];
  let rem = length;
  while (rem >= MAX_SEGMENT) {
    out.push(MAX_SEGMENT);
    rem -= MAX_SEGMENT;
  }
  out.push(rem); // 0..254 — the terminator (a length that's a 255-multiple ends with a 0)
  return out;
}

/** One encoded packet plus the granule position to stamp on the page it completes on. */
export interface OggPacket {
  data: Uint8Array;
  /** Cumulative sample position after this packet (the page granule when this packet completes). */
  granule: number;
}

/**
 * Lace packets into pages. Packets are accumulated onto a page until adding the next packet's segments
 * would exceed the 255-entry segment table, then the page is flushed; a packet larger than a page's
 * remaining room is split across pages with the continuation flag. Each completed page is stamped with
 * the granule of the **last packet that finished on it** (a page that ends mid-packet carries granule
 * -1, per the Ogg spec). `firstHeaderType`/`lastHeaderType` set BOS on the first page and EOS on the
 * last. Pure — the byte-exact unit of the round-trip oracle.
 */
export function buildPages(
  packets: readonly OggPacket[],
  firstHeaderType: number,
  lastHeaderType: number,
): PageDraft[] {
  const pages: PageDraft[] = [];
  let lacing: number[] = [];
  let body: number[] = [];
  let pageGranule = -1; // -1 until a packet *completes* on this page
  let continued = false; // does this page begin with a continued packet?

  const flush = (): void => {
    pages.push({
      headerType: continued ? HT_CONTINUED : 0,
      granule: pageGranule,
      lacing,
      body: Uint8Array.from(body),
    });
    lacing = [];
    body = [];
    pageGranule = -1;
    continued = false;
  };

  for (const packet of packets) {
    const segs = lacingForLength(packet.data.byteLength);
    let segOffset = 0; // which lacing/segment of this packet we're placing next
    let byteOffset = 0;
    while (segOffset < segs.length) {
      if (lacing.length === MAX_PAGE_SEGMENTS) {
        flush();
        continued = true; // the remainder of this packet continues on the new page
      }
      const room = MAX_PAGE_SEGMENTS - lacing.length;
      const take = Math.min(room, segs.length - segOffset);
      for (let i = 0; i < take; i++) {
        const lv = segs[segOffset + i] ?? 0;
        lacing.push(lv);
        for (let b = 0; b < lv; b++) body.push(packet.data[byteOffset++] ?? 0);
      }
      segOffset += take;
      if (segOffset === segs.length) {
        // The packet completed on this page → its granule becomes the page's granule.
        pageGranule = packet.granule;
      } else {
        // The packet did not finish (segment table full mid-packet) → flush; remainder continues.
        flush();
        continued = true;
      }
    }
  }
  if (lacing.length > 0 || body.length > 0 || pages.length === 0) flush();

  // Apply BOS to the first page and EOS to the last.
  const first = pages[0];
  if (first) first.headerType |= firstHeaderType;
  const last = pages[pages.length - 1];
  if (last) last.headerType |= lastHeaderType;
  return pages;
}

// ============ codec header construction ============

/** Convert a WebCodecs `description` (ArrayBuffer / SharedArrayBuffer / view) to an owned `Uint8Array`. */
function toBytes(src: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  }
  return new Uint8Array(src).slice();
}

/** Synthesize a minimal valid OpusHead (v1, mapping family 0) from channels/pre-skip/input rate. */
function synthOpusHead(channels: number, inputRate: number): Uint8Array {
  const preSkip = 3840; // 80 ms @ 48 kHz — a conventional Opus pre-skip
  return Uint8Array.from([
    0x4f,
    0x70,
    0x75,
    0x73,
    0x48,
    0x65,
    0x61,
    0x64, // 'OpusHead'
    1, // version
    channels & 0xff,
    preSkip & 0xff,
    (preSkip >> 8) & 0xff,
    ...u32le(inputRate >>> 0),
    0,
    0, // output gain (Q7.8) = 0
    0, // channel mapping family 0 (mono/stereo)
  ]);
}

/** A minimal OpusTags (empty vendor + zero user comments) comment header. */
function opusTags(): Uint8Array {
  return concatBytes([
    [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], // 'OpusTags'
    u32le(0), // vendor string length 0
    u32le(0), // user comment list length 0
  ]);
}

/**
 * Split a Vorbis WebCodecs `description` into its 3 setup packets (identification, comment, setup). The
 * standard codec-private layout is Xiph-laced: `[packet_count-1 = 2][len0 as 255-runs][len1 as 255-runs]
 * [packet0][packet1][packet2]` (the last packet's length is the remainder). The identification packet
 * must start with `0x01 'vorbis'`. A malformed/short description is a typed miss (we cannot honestly mux
 * Vorbis without its real headers).
 */
function splitVorbisHeaders(description: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const fail = (): never => {
    throw new CapabilityError(
      'capability-miss',
      'the ogg muxer needs the 3 Vorbis setup headers (Xiph-laced) in the track description',
      { op: { op: 'mux', codec: 'vorbis' }, tried: ['ogg'] },
    );
  };
  if (description.byteLength < 3 || description[0] !== 2) fail();
  let pos = 1;
  const readLen = (): number => {
    let len = 0;
    for (;;) {
      const b = description[pos];
      if (b === undefined) return fail();
      pos++;
      len += b;
      if (b < 255) return len;
    }
  };
  const len0 = readLen();
  const len1 = readLen();
  const id = description.slice(pos, pos + len0);
  const comment = description.slice(pos + len0, pos + len0 + len1);
  const setup = description.slice(pos + len0 + len1);
  if (id.byteLength !== len0 || comment.byteLength !== len1 || setup.byteLength === 0) fail();
  if (id[0] !== 0x01 || String.fromCharCode(...id.slice(1, 7)) !== 'vorbis') fail();
  return [id, comment, setup];
}

// ============ track state + assembly ============

/** A decoded view of one `EncodedChunk` in container-neutral terms (owns its byte copy). */
export interface ChunkStruct {
  timestampUs: number;
  durationUs: number | undefined;
  key: boolean;
  data: Uint8Array;
}

interface TrackState {
  readonly codec: 'opus' | 'vorbis';
  readonly channels: number;
  readonly sampleRate: number;
  readonly granuleRate: number;
  readonly description: Uint8Array | undefined;
  readonly chunks: ChunkStruct[];
}

/** Resolve the codec + audio geometry from a track's {@link TrackInfo}; reject non-Ogg codecs. */
function trackStateFrom(info: TrackInfo): TrackState {
  if (info.mediaType !== 'audio') {
    throw new CapabilityError('capability-miss', 'the ogg muxer writes audio only', {
      op: { op: 'mux', mediaType: info.mediaType },
      tried: ['ogg'],
    });
  }
  const c = info.codec.toLowerCase();
  const codec: 'opus' | 'vorbis' | undefined = c.startsWith('opus')
    ? 'opus'
    : c.startsWith('vorbis')
      ? 'vorbis'
      : undefined;
  if (codec === undefined) {
    throw new CapabilityError(
      'capability-miss',
      `the ogg muxer cannot write audio codec '${info.codec}' (Opus/Vorbis only)`,
      { op: { op: 'mux', codec: info.codec }, tried: ['ogg'] },
    );
  }
  const ac = info.config as AudioDecoderConfig | undefined;
  const sampleRate = ac?.sampleRate && ac.sampleRate > 0 ? ac.sampleRate : 48_000;
  return {
    codec,
    channels: ac?.numberOfChannels && ac.numberOfChannels > 0 ? ac.numberOfChannels : 2,
    sampleRate,
    granuleRate: codec === 'opus' ? OPUS_GRANULE_RATE : sampleRate,
    description: ac?.description !== undefined ? toBytes(ac.description) : undefined,
    chunks: [],
  };
}

/** The number of granule samples one chunk represents (from its duration, or a recovered gap). */
function samplesFor(chunk: ChunkStruct, fallbackUs: number, granuleRate: number): number {
  const durUs = chunk.durationUs ?? fallbackUs;
  return Math.max(0, Math.round((durUs * granuleRate) / MICROS_PER_SECOND));
}

/** The median inter-chunk PTS gap (µs), a per-chunk duration estimate when the encoder omitted it. */
function fallbackGapUs(chunks: readonly ChunkStruct[]): number {
  if (chunks.length < 2) return 0;
  const sorted = [...chunks].sort((a, b) => a.timestampUs - b.timestampUs);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i]?.timestampUs ?? 0) - (sorted[i - 1]?.timestampUs ?? 0));
  }
  gaps.sort((a, b) => a - b);
  return Math.max(0, gaps[gaps.length >> 1] ?? 0);
}

/** The codec's header packets (BOS-page packet + the comment/setup-page packets). */
function headerPackets(track: TrackState): { idHeader: Uint8Array; setupHeaders: Uint8Array[] } {
  if (track.codec === 'opus') {
    const idHeader =
      track.description && track.description.byteLength >= 8
        ? track.description
        : synthOpusHead(track.channels, track.sampleRate);
    return { idHeader, setupHeaders: [opusTags()] };
  }
  if (track.description === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'the ogg muxer needs the Vorbis setup headers in the track description',
      { op: { op: 'mux', codec: 'vorbis' }, tried: ['ogg'] },
    );
  }
  const [id, comment, setup] = splitVorbisHeaders(track.description);
  return { idHeader: id, setupHeaders: [comment, setup] };
}

/** Assemble the full Ogg byte stream for one audio track. */
export function writeOgg(track: TrackState, serial = DEFAULT_SERIAL): Uint8Array {
  const { idHeader, setupHeaders } = headerPackets(track);

  // Audio packets in presentation order with cumulative granule positions.
  const ordered = [...track.chunks].sort((a, b) => a.timestampUs - b.timestampUs);
  const fallbackUs = fallbackGapUs(ordered);
  const audio: OggPacket[] = [];
  let granule = 0;
  for (const chunk of ordered) {
    granule += samplesFor(chunk, fallbackUs, track.granuleRate);
    audio.push({ data: chunk.data, granule });
  }

  // Page layout: the identification header alone on the BOS page; the comment/setup header(s) on the
  // next page(s) (granule 0); then the audio pages (EOS on the last).
  const idPages = buildPages([{ data: idHeader, granule: 0 }], HT_BOS, 0);
  const setupPages = buildPages(
    setupHeaders.map((data) => ({ data, granule: 0 })),
    0,
    0,
  );
  const audioPages = buildPages(audio, 0, HT_EOS);

  const all = [...idPages, ...setupPages, ...audioPages];
  let seq = 0;
  const out: Uint8Array[] = [];
  for (const page of all) out.push(serializePage(page, serial, seq++));
  return concatBytes(out);
}

// ============ the Muxer adapter ============

/**
 * `Muxer` over {@link writeOgg}: buffers one audio track's packets and serializes the whole Ogg stream
 * on {@link finalize}, emitting it on {@link output}. Single-shot — `addTrack`/`write` after `finalize`,
 * and a second `finalize`, are typed misuse (`mux-error`). Ogg here is single-logical-stream (one audio
 * track); a second track is a typed {@link CapabilityError}. Mirrors {@link Mp4Muxer}/{@link WebmMuxer}.
 */
export class OggMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: { id: number; state: TrackState } | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'fragmented ogg mux is not a thing', {
        op: { op: 'mux', fragmented: true },
        tried: ['ogg'],
      });
    }
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    if (this.#track !== undefined) {
      throw new CapabilityError('capability-miss', 'the ogg muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['ogg'],
      });
    }
    const id = 0;
    this.#track = { id, state: trackStateFrom(info) };
    return id;
  }

  /**
   * Buffer one encoded packet. Extracting bytes/timing from a real WebCodecs `Encoded*Chunk` (`copyTo`)
   * is the only browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}.
   */
  write(trackId: number, chunk: EncodedChunk): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /** Pure packet ingest (the path the Node tests drive directly). */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    this.#track.state.chunks.push(chunk);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready;
    const controller = this.#controller;
    if (controller === undefined) {
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    try {
      if (this.#track === undefined) {
        throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
      }
      if (this.#track.state.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${this.#track.id} received no packets`);
      }
      controller.enqueue(writeOgg(this.#track.state));
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}
