/**
 * MP3 elementary-stream `Muxer` (mirrors {@link FlacMuxer}) — assembles a standards-valid `.mp3` byte
 * stream from one audio track's MPEG-1/2 Layer III frames. MP3 is the simplest elementary stream there is:
 * a bare concatenation of self-describing MPEG audio frames (each 4-byte frame header carries version,
 * bitrate, sample rate, channel mode — there is NO container index, no out-of-band `description`, no global
 * header). So this muxer writes nothing but the track's frames back-to-back, verbatim. No re-encode happens
 * here: a remux (MP3-in-MP4/ADTS/Matroska → `.mp3`) is byte-lossless, and the MP3 **encoder** drives
 * `media.encode` by emitting frames as chunks that flow straight through.
 *
 * Single-shot, single-track (MP3 carries one audio stream). Each written chunk MUST be a valid MPEG Layer
 * III audio frame (validated by reusing the driver's {@link parseFrameHeader}); a non-frame, a second
 * track, a non-audio/non-`mp3` track, writes/`addTrack` after `finalize`, or a double `finalize` are typed
 * misuse — never a silently-corrupt `.mp3`. Mirrors {@link FlacMuxer}: the only browser-only step is
 * `copyTo` on a real WebCodecs `EncodedChunk` in {@link write}; the pure {@link addChunkStruct} is the
 * Node-validated ingest path.
 */

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { ChunkStruct } from '../ogg/ogg-write.ts';
import { isMpegLayer3Frame } from './mp3-driver.ts';

interface Mp3MuxTrack {
  readonly id: number;
  readonly chunks: ChunkStruct[];
}

/** `Muxer` that serializes one MP3 track to a complete `.mp3` elementary stream on {@link finalize}. */
export class Mp3Muxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: Mp3MuxTrack | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'MP3 has no fragmented/segmented mux form', {
        op: { op: 'mux', fragmented: true },
        tried: ['mp3'],
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
      throw new CapabilityError('capability-miss', 'the MP3 muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['mp3'],
      });
    }
    if (info.mediaType !== 'audio' || info.codec !== 'mp3') {
      throw new CapabilityError(
        'capability-miss',
        `MP3 container carries a single MP3 audio track, not ${info.mediaType}/${info.codec}`,
        { op: { op: 'mux' }, tried: ['mp3'] },
      );
    }
    const id = 0;
    this.#track = { id, chunks: [] };
    return id;
  }

  /**
   * Buffer one encoded packet. Extracting bytes from a real WebCodecs `EncodedChunk` (`copyTo`) is the
   * only browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}. MP3 audio
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

  /**
   * Pure packet ingest (the path the Node tests drive directly): validate + buffer one MPEG Layer III
   * audio frame. The frame must start with a real MP3 sync header, or it is rejected — the muxer never
   * concatenates non-frame bytes into the `.mp3` (which would desync every downstream parser).
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    if (!isMpegLayer3Frame(chunk.data)) {
      throw new MediaError('mux-error', 'MP3 mux: chunk is not a valid MPEG Layer III audio frame');
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
      controller.enqueue(assembleMp3(track));
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

/** Concatenate every MPEG Layer III frame into one `.mp3` elementary-stream byte buffer. */
function assembleMp3(track: Mp3MuxTrack): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of track.chunks) total += chunk.data.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of track.chunks) {
    out.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return out;
}
