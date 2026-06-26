/**
 * ADTS (raw AAC) `Muxer` (mirrors {@link FlacMuxer}/{@link Mp3Muxer}) — wraps one audio track's raw AAC
 * access units in 7-byte ADTS headers to author a `.adts`/`.aac` elementary stream. ADTS is the simplest
 * AAC framing: each frame is `[12-bit 0xFFF sync | fixed header | AAC payload]` with the audio object type,
 * sampling-frequency index, and channel configuration repeated in every frame's header (recovered here from
 * the track's `AudioSpecificConfig`, the `config.description` the demuxer/encoder published). No re-encode
 * happens — this is a REMUX (AAC-in-MP4/MKV/… → `.adts`): the AAC access units flow through verbatim, only
 * gaining their ADTS headers. (Encoding AAC is the WebCodecs/wasm-aac codec seam's job, not this muxer's.)
 *
 * Single-shot, single-track (one AAC stream). The track MUST be `mp4a.40.*` (AAC) and carry a 2-byte ASC
 * `description`, or it is a typed capability-miss; writes/`addTrack` after `finalize`, a second track, and a
 * double `finalize` are typed misuse. Mirrors the sibling muxers: the only browser-only step is `copyTo`
 * on a real WebCodecs `EncodedChunk` in {@link write}; the pure {@link addChunkStruct} is the Node path.
 */

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { ChunkStruct } from '../ogg/ogg-write.ts';

interface AdtsMuxTrack {
  readonly id: number;
  /** Audio object type (e.g. 2 = AAC-LC), from the ASC's top 5 bits. */
  readonly aot: number;
  /** Sampling-frequency index (0–12), from the ASC. */
  readonly freqIndex: number;
  /** Channel configuration (1–7), from the ASC. */
  readonly channelConfig: number;
  readonly chunks: ChunkStruct[];
}

/** A read-only byte view over an ASC `description` `BufferSource` (no copy). */
function descriptionBytes(
  description: AllowSharedBufferSource | undefined,
): Uint8Array | undefined {
  if (description === undefined) return undefined;
  if (description instanceof ArrayBuffer) return new Uint8Array(description);
  const view = description as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Decode the 2-byte AudioSpecificConfig into the ADTS header fields. Layout (ISO 14496-3): 5 bits AOT,
 * 4 bits samplingFrequencyIndex, 4 bits channelConfiguration. A too-short or out-of-range ASC is rejected
 * (the muxer never emits an ADTS header it can't fill faithfully).
 */
function parseAsc(asc: Uint8Array): { aot: number; freqIndex: number; channelConfig: number } {
  if (asc.byteLength < 2) {
    throw new MediaError('mux-error', 'ADTS mux: AAC track description (ASC) must be ≥ 2 bytes');
  }
  const b0 = asc[0] ?? 0;
  const b1 = asc[1] ?? 0;
  const aot = (b0 >> 3) & 0x1f;
  const freqIndex = ((b0 & 0x7) << 1) | (b1 >> 7);
  const channelConfig = (b1 >> 3) & 0xf;
  if (aot < 1 || aot > 31 || freqIndex > 12 || channelConfig < 1 || channelConfig > 7) {
    throw new MediaError(
      'mux-error',
      `ADTS mux: unsupported ASC (aot=${aot} freqIndex=${freqIndex} channels=${channelConfig})`,
    );
  }
  return { aot, freqIndex, channelConfig };
}

/**
 * Build the 7-byte ADTS fixed header for one AAC access unit of `aacLength` bytes (no CRC →
 * `protection_absent=1`, header=7). `frame_length` = header + payload (13 bits). The `profile` field is
 * `aot - 1` (ADTS predates MPEG-4's AOT numbering by one).
 */
function adtsHeader(
  aot: number,
  freqIndex: number,
  channelConfig: number,
  aacLength: number,
): Uint8Array {
  const frameLength = 7 + aacLength;
  if (frameLength > 0x1fff) {
    throw new MediaError(
      'mux-error',
      `ADTS mux: AAC frame too large (${frameLength} bytes > 8191)`,
    );
  }
  const profile = aot - 1; // ADTS profile = MPEG-4 AOT − 1 (AAC-LC AOT 2 → profile 1)
  const h = new Uint8Array(7);
  h[0] = 0xff; // syncword high
  h[1] = 0xf1; // syncword low (0xF) | MPEG-4 (0) | layer 00 | protection_absent 1
  h[2] = (profile << 6) | (freqIndex << 2) | ((channelConfig >> 2) & 0x1);
  h[3] = ((channelConfig & 0x3) << 6) | ((frameLength >> 11) & 0x3);
  h[4] = (frameLength >> 3) & 0xff;
  h[5] = ((frameLength & 0x7) << 5) | 0x1f; // frame_length low | buffer_fullness high (0x7FF VBR)
  h[6] = 0xfc; // buffer_fullness low | number_of_raw_data_blocks_in_frame − 1 = 0
  return h;
}

/** `Muxer` that serializes one AAC track to a complete `.adts` elementary stream on {@link finalize}. */
export class AdtsMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: AdtsMuxTrack | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'ADTS has no fragmented/segmented mux form', {
        op: { op: 'mux', fragmented: true },
        tried: ['adts'],
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
      throw new CapabilityError('capability-miss', 'the ADTS muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['adts'],
      });
    }
    if (info.mediaType !== 'audio' || !info.codec.toLowerCase().startsWith('mp4a.40.')) {
      throw new CapabilityError(
        'capability-miss',
        `ADTS container carries a single AAC audio track, not ${info.mediaType}/${info.codec}`,
        { op: { op: 'mux' }, tried: ['adts'] },
      );
    }
    const asc = descriptionBytes(info.config?.description);
    if (asc === undefined) {
      throw new MediaError(
        'mux-error',
        'ADTS mux needs the AAC track description (the 2-byte ASC)',
      );
    }
    const { aot, freqIndex, channelConfig } = parseAsc(asc);
    const id = 0;
    this.#track = { id, aot, freqIndex, channelConfig, chunks: [] };
    return id;
  }

  /**
   * Buffer one encoded packet. Extracting bytes from a real WebCodecs `EncodedChunk` (`copyTo`) is the only
   * browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}. AAC is never
   * reordered, so the packet's `dtsUs` is irrelevant.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
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

  /**
   * Pure packet ingest (the path the Node tests drive directly): buffer one RAW AAC access unit. The bytes
   * are the bare access unit (no ADTS header yet); {@link finalize} prepends each frame's synthesized ADTS
   * header. An empty access unit is rejected (it cannot form a valid ADTS frame).
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    if (chunk.data.byteLength === 0) {
      throw new MediaError('mux-error', 'ADTS mux: empty AAC access unit');
    }
    this.#track.chunks.push(chunk);
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
      const track = this.#track;
      if (track === undefined) {
        throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
      }
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${track.id} received no packets`);
      }
      controller.enqueue(assembleAdts(track));
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

/** Prepend each AAC access unit with its ADTS header and concatenate into one `.adts` byte buffer. */
function assembleAdts(track: AdtsMuxTrack): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of track.chunks) total += 7 + chunk.data.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of track.chunks) {
    out.set(
      adtsHeader(track.aot, track.freqIndex, track.channelConfig, chunk.data.byteLength),
      offset,
    );
    offset += 7;
    out.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return out;
}
