/**
 * The AVI (RIFF `AVI `) container driver — hand-written TS on top of {@link parseAvi} (ADR-002:
 * containers are ours; pure parsing in any environment). `probe` returns the stream table (codec +
 * dims/sample params + duration); `demux` reads each stream's `movi` data chunks and emits them as
 * WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` with per-chunk PTS, browser-gated exactly
 * like {@link import('../mpegts/mpegts-driver.ts')} / {@link import('../mp4/mp4-driver.ts')}
 * `packetStream` (the `Encoded*Chunk` constructors only exist in a browser/worker). AVI has no front
 * index requirement, so the whole (bounded) file is read and `movi` is walked directly.
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  DriverModule,
  EncodedChunk,
  MuxOptions,
  Muxer,
  Registry,
  StageOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type AviChunk, type AviParse, type AviTrack, parseAvi } from './avi-parse.ts';

const AVI_MIMES = new Set(['video/avi', 'video/x-msvideo', 'video/msvideo', 'video/vnd.avi']);
const AVI_EXTENSIONS = new Set(['avi']);

/** Read the entire source into one buffer (AVI's `movi` offsets are byte positions; duration needs it). */
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

/** Map a parsed AVI track to the contract {@link TrackInfo} (dims/sample params ride in `config`). */
function toTrackInfo(track: AviTrack, id: number): TrackInfo {
  return {
    id,
    mediaType: track.stream.mediaType,
    codec: track.stream.codec,
    durationSec: track.durationSec,
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    config: track.config,
  };
}

/**
 * Stream a track's `movi` data chunks as WebCodecs encoded chunks. Browser-only: the `Encoded*Chunk`
 * constructors are unavailable in Node, so we raise a typed `CapabilityError` (mirroring the mp4/mpegts
 * drivers); the emission body is istanbul-ignored and validated under browser-mode (codec phase).
 */
function packetStream(
  chunks: readonly AviChunk[],
  mediaType: AviTrack['stream']['mediaType'],
  signal: AbortSignal | undefined,
): ReadableStream<EncodedChunk> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebCodecs EncodedVideoChunk/EncodedAudioChunk are unavailable in this environment',
      { op: 'demux', tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (codec phase) */
  const isVideo = mediaType === 'video';
  let i = 0;
  return new ReadableStream<EncodedChunk>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      // Skip empty chunks (AVI drop-frames are zero-length placeholders, not real access units).
      let chunk = chunks[i];
      while (chunk !== undefined && chunk.data.byteLength === 0) {
        i++;
        chunk = chunks[i];
      }
      if (chunk === undefined) {
        controller.close();
        return;
      }
      i++;
      const init = {
        type: (chunk.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
        timestamp: chunk.ptsUs,
        data: chunk.data,
      };
      controller.enqueue(isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init));
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && AVI_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && AVI_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head && head.byteLength >= 12) {
    // 'RIFF' .... 'AVI ' is the unambiguous AVI magic (distinguishes it from RIFF/WAVE).
    const riff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
    const avi = head[8] === 0x41 && head[9] === 0x56 && head[10] === 0x49 && head[11] === 0x20;
    if (riff && avi) return true;
  }
  return false;
}

/** Parse the source into the track table + per-stream chunks (shared by `probe` and `demux`). */
async function parse(src: ByteSource): Promise<AviParse> {
  return parseAvi(await readAll(src));
}

export const AviDriver: ContainerDriver = {
  id: 'avi',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['avi'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const parsed = await parse(src);
    const signal = o?.signal;
    const tracks = parsed.tracks.map((t, i) => toTrackInfo(t, i));
    return {
      tracks,
      packets(trackId: number): ReadableStream<EncodedChunk> {
        const track = parsed.tracks[trackId];
        if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(track.chunks, track.stream.mediaType, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(_o?: MuxOptions): Muxer {
    // AVI muxing (idx1/OpenDML index construction, interleaving) lands with the streaming-output family;
    // until then it is an honest typed gap rather than a half-working muxer.
    throw new MediaError('mux-error', 'AVI muxing is not yet implemented');
  },
};

/** The AVI driver module (registered by the parent's defaults, not here). */
export const AviModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AviDriver);
  },
};

export default AviModule;
