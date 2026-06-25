/**
 * The MPEG-TS (ISO/IEC 13818-1) container driver — hand-written TS on top of {@link parseTs} (ADR-002:
 * containers are ours; pure parsing in any environment). `probe` returns the program's elementary tracks
 * (codec + dims/sample params + PES-span duration); `demux` reassembles each PID's access units and emits
 * them as WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` in decode order, browser-gated exactly
 * like {@link import('../mp4/mp4-driver.ts')} `packetStream` (the `Encoded*Chunk` constructors only exist
 * in a browser/worker). A transport stream has no front index, so the whole (bounded) segment is read.
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  DriverModule,
  MuxOptions,
  Muxer,
  Packet,
  Registry,
  StageOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type TsAccessUnit, type TsParse, type TsTrack, parseTs } from './ts-parse.ts';

const TS_MIMES = new Set([
  'video/mp2t',
  'video/MP2T',
  'video/mpeg',
  'application/x-mpegts',
  'audio/mp2t',
]);
const TS_EXTENSIONS = new Set(['ts', 'm2ts', 'mts', 'm2t']);

/** Read the entire source into one buffer (a TS has no header/index — duration needs the full PES span). */
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

/** Map a parsed TS track to the contract {@link TrackInfo} (the dims/sample params ride in `config`). */
function toTrackInfo(track: TsTrack, id: number): TrackInfo {
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
 * Stream a track's reassembled access units as WebCodecs encoded chunks. Browser-only: the
 * `Encoded*Chunk` constructors are unavailable in Node, so we raise a typed `CapabilityError` (mirroring
 * the mp4 driver); the emission body is istanbul-ignored and validated under browser-mode (codec phase).
 */
function packetStream(
  units: readonly TsAccessUnit[],
  mediaType: TsTrack['stream']['mediaType'],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
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
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const unit = units[i];
      if (unit === undefined) {
        controller.close();
        return;
      }
      i++;
      const init = {
        type: (unit.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
        timestamp: unit.ptsUs,
        data: unit.data,
      };
      // The PES carries a real DTS (B-frame H.264 streams keep PTS ≠ DTS); ts-parse already resolved it
      // (== ptsUs when the PES had no separate DTS), so carry it through for lossless decode-order remux.
      const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
      controller.enqueue({ chunk, dtsUs: unit.dtsUs });
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && TS_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && TS_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head && head.byteLength >= 189) {
    // Two sync bytes one 188-packet apart is a strong, cheap TS signal (the magic byte alone is common).
    if (head[0] === 0x47 && head[188] === 0x47) return true;
  }
  return false;
}

/** Parse the source into the track table + per-PID access units (shared by `probe` and `demux`). */
async function parse(src: ByteSource): Promise<TsParse> {
  return parseTs(await readAll(src));
}

export const MpegTsDriver: ContainerDriver = {
  id: 'mpegts',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['ts', 'm2ts', 'mts'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const parsed = await parse(src);
    const signal = o?.signal;
    // The public track id is the array index (stable: video-first, then by PID — see parseTs sort).
    const tracks = parsed.tracks.map((t, i) => toTrackInfo(t, i));
    return {
      tracks,
      packets(trackId: number): ReadableStream<Packet> {
        const track = parsed.tracks[trackId];
        if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(track.units, track.stream.mediaType, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(_o?: MuxOptions): Muxer {
    // TS muxing (continuity counters, PCR insertion, PSI tables) lands with the streaming-output family;
    // until then it is an honest typed gap rather than a half-working muxer.
    throw new MediaError('mux-error', 'MPEG-TS muxing is not yet implemented');
  },
};

/** The MPEG-TS driver module (registered by the parent's defaults, not here). */
export const MpegTsModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(MpegTsDriver);
  },
};

export default MpegTsModule;
