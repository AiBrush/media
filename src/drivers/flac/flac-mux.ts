/**
 * Native-FLAC `Muxer` (ADR-024) — assembles a standards-valid `.flac` byte stream from one audio track's
 * native FLAC frames. FLAC is an elementary stream: the file is `fLaC` + metadata blocks (STREAMINFO
 * first) followed by the audio frames. This muxer writes the track's metadata prelude (the `description`
 * the demuxer/encoder published — `fLaC` + all metadata blocks, terminated by the last-metadata-block
 * flag) verbatim, then concatenates every chunk's native FLAC frame bytes. No re-encode happens here, so
 * a remux (FLAC → FLAC, or Ogg/MP4-FLAC → FLAC) is lossless and the FLAC **encoder** drives `media.encode`
 * by publishing its STREAMINFO as the track `description` and emitting frames as chunks.
 *
 * Single-shot, single-track (FLAC carries one audio stream): `addTrack`/`write` after `finalize`, a second
 * `finalize`, a second track, or a non-audio/non-FLAC track are typed misuse. Mirrors {@link OggMuxer}:
 * the only browser-only step is extracting bytes from a real WebCodecs `EncodedChunk` (`copyTo`) in
 * `write`; the pure `addChunkStruct` is the Node-validated ingest path.
 */

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { ChunkStruct } from '../ogg/ogg-write.ts';

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43] as const; // "fLaC"

interface FlacMuxTrack {
  readonly id: number;
  /** The `fLaC` + metadata-blocks prelude (STREAMINFO et al.), written verbatim before the frames. */
  readonly prelude: Uint8Array;
  readonly chunks: ChunkStruct[];
}

/** A read-only byte view over an `AllowSharedBufferSource` `description` (no copy). */
function descriptionBytes(
  description: AllowSharedBufferSource | undefined,
): Uint8Array | undefined {
  if (description === undefined) return undefined;
  if (description instanceof ArrayBuffer) return new Uint8Array(description);
  const view = description as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function hasFlacMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === FLAC_MAGIC[0] &&
    bytes[1] === FLAC_MAGIC[1] &&
    bytes[2] === FLAC_MAGIC[2] &&
    bytes[3] === FLAC_MAGIC[3]
  );
}

/** `Muxer` that serializes one native-FLAC track to a complete `.flac` stream on {@link finalize}. */
export class FlacMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: FlacMuxTrack | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'fragmented FLAC mux is not a thing', {
        op: { op: 'mux', fragmented: true },
        tried: ['flac'],
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
      throw new CapabilityError('capability-miss', 'the FLAC muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['flac'],
      });
    }
    if (info.mediaType !== 'audio' || info.codec !== 'flac') {
      throw new CapabilityError(
        'capability-miss',
        `FLAC container carries a single FLAC audio track, not ${info.mediaType}/${info.codec}`,
        { op: { op: 'mux' }, tried: ['flac'] },
      );
    }
    const prelude = descriptionBytes(info.config?.description);
    if (prelude === undefined || !hasFlacMagic(prelude)) {
      throw new MediaError(
        'mux-error',
        'FLAC mux needs the track description (fLaC + STREAMINFO metadata prelude)',
      );
    }
    const id = 0;
    this.#track = { id, prelude, chunks: [] };
    return id;
  }

  /**
   * Buffer one encoded packet. Extracting bytes from a real WebCodecs `EncodedChunk` (`copyTo`) is the
   * only browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}. FLAC audio
   * is never reordered, so the packet's `dtsUs` is irrelevant.
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

  /** Pure packet ingest (the path the Node tests drive directly): buffer one native FLAC frame. */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
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
      controller.enqueue(assembleFlac(track));
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

/** Concatenate the metadata prelude with every native FLAC frame into one `.flac` byte buffer. */
function assembleFlac(track: FlacMuxTrack): Uint8Array<ArrayBuffer> {
  let total = track.prelude.byteLength;
  for (const chunk of track.chunks) total += chunk.data.byteLength;
  const out = new Uint8Array(total);
  out.set(track.prelude, 0);
  let offset = track.prelude.byteLength;
  for (const chunk of track.chunks) {
    out.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return out;
}
