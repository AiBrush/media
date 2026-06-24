/**
 * The MP4/MOV container driver (ISO-BMFF) — hand-written TS (ADR-002: containers are ours). Demuxes
 * to WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` with correct PTS/DTS and keyframe flags,
 * reading only the `moov` header for probe and the sample bytes on demand (bounded memory). The
 * byte-level muxer (`write.ts`) + lossless stream-copy ({@link muxTracksFromMovie}) are round-trip
 * validated; the contract `Muxer` (EncodedChunk seam) adapter lands with the browser codec layer.
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  DecryptParams,
  Demuxer,
  DriverModule,
  EncodedChunk,
  Muxer,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { hexToBytes } from '../../crypto/aes.ts';
import { CENC_SCHEME, decryptSamples, kidHex, parseSenc, parseTenc } from './cenc.ts';
import { type Movie, type ParsedTrack, parseMovie } from './parse.ts';
import { Reader } from './reader.ts';
import { type SampleData, buildSampleData, buildSamples } from './samples.ts';
import { type MuxSampleInput, type MuxTrackInput, writeMp4 } from './write.ts';

const MP4_MIMES = new Set(['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a']);
const MP4_EXTENSIONS = new Set(['mp4', 'mov', 'm4a', 'm4v', 'qt']);

/** A random-access view over a source: range reads when available, else a one-time buffer. */
interface RandomAccess {
  read(offset: number, length: number): Promise<Uint8Array>;
  size?: number;
}

async function randomAccess(src: ByteSource): Promise<RandomAccess> {
  const range = src.range;
  if (range) {
    return {
      read: (offset, length) => range.call(src, offset, offset + length),
      ...(src.size !== undefined ? { size: src.size } : {}),
    };
  }
  const buffered = await readAll(src.stream());
  return {
    read: (o, l) => Promise.resolve(buffered.subarray(o, o + l)),
    size: buffered.byteLength,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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

/** Walk the top-level boxes to find the `ftyp` brand and the `moov`, then parse it. */
export async function readMovie(ra: RandomAccess): Promise<Movie> {
  let offset = 0;
  let brand = 'mp42';
  const limit = ra.size ?? Number.MAX_SAFE_INTEGER;

  while (offset + 8 <= limit) {
    const header = await ra.read(offset, 16);
    if (header.byteLength < 8) break;
    const r = new Reader(header);
    let size = r.u32();
    const type = r.fourcc();
    let headerSize = 8;
    if (size === 1) {
      size = r.u64();
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || size <= 0) break;

    if (type === 'ftyp' && header.byteLength >= 12) {
      brand = r.fourcc();
    }
    if (type === 'moov') {
      const box = await ra.read(offset, size);
      return parseMovie(brand, box.subarray(headerSize));
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

function muxTrackMeta(track: ParsedTrack): Omit<MuxTrackInput, 'samples'> {
  return {
    mediaType: track.mediaType,
    sampleEntryType: track.sampleEntryType,
    timescale: track.timescale,
    ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}),
    ...(track.width !== undefined ? { width: track.width } : {}),
    ...(track.height !== undefined ? { height: track.height } : {}),
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.channels !== undefined ? { channels: track.channels } : {}),
  };
}

async function readSamples(
  ra: RandomAccess,
  samples: readonly SampleData[],
): Promise<MuxSampleInput[]> {
  const out: MuxSampleInput[] = [];
  for (const s of samples) {
    const data = (await ra.read(s.offset, s.size)).slice();
    out.push({
      data,
      durationTicks: s.durationTicks,
      cttsTicks: s.cttsTicks,
      keyframe: s.keyframe,
    });
  }
  return out;
}

/** Turn a parsed movie + its bytes into mux-ready tracks (lossless stream-copy), for `remux`. */
export async function muxTracksFromMovie(ra: RandomAccess, movie: Movie): Promise<MuxTrackInput[]> {
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    out.push({ ...muxTrackMeta(track), samples: await readSamples(ra, buildSampleData(track)) });
  }
  return out;
}

/**
 * Select a keyframe-aligned time range for a lossless trim: video starts at the keyframe at/before
 * `startSec` (the GOP head, so the cut decodes), audio at the first sample overlapping it; both end at
 * the last sample before `endSec`. The muxer re-bases DTS to 0, preserving each sample's `ctts`.
 */
function selectTrimmed(track: ParsedTrack, startSec: number, endSec: number): SampleData[] {
  const all = buildSampleData(track);
  if (all.length === 0) return all;
  const startTicks = startSec * track.timescale;
  const endTicks = endSec * track.timescale;

  let startIdx = 0;
  if (track.mediaType === 'video') {
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s?.keyframe && s.dtsTicks + s.cttsTicks <= startTicks) startIdx = i;
    }
  } else {
    const found = all.findIndex((s) => s.dtsTicks + s.durationTicks > startTicks);
    startIdx = found < 0 ? 0 : found;
  }

  let endIdx = all.length - 1;
  for (let i = startIdx; i < all.length; i++) {
    if ((all[i]?.dtsTicks ?? 0) >= endTicks) {
      endIdx = i - 1;
      break;
    }
  }
  return all.slice(startIdx, Math.max(startIdx, endIdx) + 1);
}

async function trimMuxTracks(
  ra: RandomAccess,
  movie: Movie,
  startSec: number,
  endSec: number,
): Promise<MuxTrackInput[]> {
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    out.push({
      ...muxTrackMeta(track),
      samples: await readSamples(ra, selectTrimmed(track, startSec, endSec)),
    });
  }
  return out;
}

function toTrackInfo(t: ParsedTrack): TrackInfo {
  return {
    id: t.id,
    mediaType: t.mediaType,
    codec: t.codec,
    durationSec: t.durationSec,
    ...(t.fps !== undefined ? { fps: t.fps } : {}),
    ...(t.rotation !== undefined ? { rotation: t.rotation } : {}),
    config: t.config,
  };
}

/** Stream a track's samples as WebCodecs encoded chunks (browser: requires `Encoded*Chunk`). */
function packetStream(
  ra: RandomAccess,
  track: ParsedTrack,
  signal: AbortSignal | undefined,
): ReadableStream<EncodedChunk> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebCodecs EncodedVideoChunk/EncodedAudioChunk are unavailable in this environment',
      { op: 'demux', tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
  const samples = buildSamples(track);
  const isVideo = track.mediaType === 'video';
  let i = 0;
  return new ReadableStream<EncodedChunk>({
    async pull(controller): Promise<void> {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const sample = samples[i];
      if (sample === undefined) {
        controller.close();
        return;
      }
      i++;
      const data = await ra.read(sample.offset, sample.size);
      const init = {
        type: (sample.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
        timestamp: sample.ptsUs,
        duration: sample.durationUs,
        data,
      };
      controller.enqueue(isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init));
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && MP4_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && MP4_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head && head.byteLength >= 8) {
    const magic = String.fromCharCode(head[4] ?? 0, head[5] ?? 0, head[6] ?? 0, head[7] ?? 0);
    if (magic === 'ftyp' || magic === 'styp' || magic === 'moov') return true;
  }
  return false;
}

/**
 * Verify every sample's byte range `[offset, offset+size)` lies within the source before it is read for
 * decryption. A truncated `mdat` (sample bytes promised by the index but missing from the file) would
 * otherwise be read as a silently-clamped short buffer and "decrypted" into garbage; instead reject it as
 * corrupt input ({@link MediaError} `demux-error`). `sourceSize` is omitted only when the source is a
 * non-seekable stream — which {@link randomAccess} fully buffers, so a size is always available here.
 */
function assertSampleRangesInBounds(track: ParsedTrack, sourceSize: number): void {
  for (const s of buildSampleData(track)) {
    if (s.offset < 0 || s.size < 0 || s.offset + s.size > sourceSize) {
      throw new MediaError(
        'demux-error',
        `protected sample ${s.index} range [${s.offset}, ${s.offset + s.size}) exceeds source size ${sourceSize} (truncated/corrupt mdat)`,
      );
    }
  }
}

/** Look up the AES key (bytes) for a track's KID, or raise a typed miss if the caller didn't supply it. */
function resolveKey(keys: Record<string, string>, kid: Uint8Array): Uint8Array<ArrayBuffer> {
  const hexKey = keys[kidHex(kid)];
  if (hexKey === undefined) {
    throw new CapabilityError('capability-miss', `no key provided for KID ${kidHex(kid)}`, {
      op: 'decrypt',
      tried: ['mp4'],
    });
  }
  return hexToBytes(hexKey);
}

export const Mp4Driver: ContainerDriver = {
  id: 'mp4',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['mp4', 'mov'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const ra = await randomAccess(src);
    const movie = await readMovie(ra);
    const byId = new Map(movie.tracks.map((t) => [t.id, t]));
    const signal = o?.signal;
    return {
      tracks: movie.tracks.map(toTrackInfo),
      packets(trackId: number): ReadableStream<EncodedChunk> {
        const track = byId.get(trackId);
        if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(ra, track, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src);
    const movie = await readMovie(ra);
    const trim = o?.trim;
    const tracks = trim
      ? await trimMuxTracks(ra, movie, trim.startSec, trim.endSec)
      : await muxTracksFromMovie(ra, movie);
    const bytes = writeMp4(tracks, { faststart: o?.faststart ?? true });
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(bytes);
        c.close();
      },
    });
  },
  async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
    if (o.scheme !== CENC_SCHEME) {
      throw new CapabilityError(
        'capability-miss',
        `the mp4 driver decrypts CENC ('cenc'); '${o.scheme}' is not supported in this build`,
        { op: 'decrypt', tried: ['mp4'] },
      );
    }
    const ra = await randomAccess(src);
    const movie = await readMovie(ra);
    const sourceSize = ra.size;
    const tracks = await muxTracksFromMovie(ra, movie); // clear-structured (mp4a), ciphertext samples
    const out: MuxTrackInput[] = [];
    for (const [i, parsed] of movie.tracks.entries()) {
      const track = tracks[i];
      if (!track) continue;
      const enc = parsed.encryption;
      if (!enc) {
        out.push(track); // genuinely unprotected track passes through unchanged
        continue;
      }
      // The track IS CENC-protected (enca/encv + tenc), so it MUST be decrypted — never passed through as
      // if it were clear. This `moov`-based path needs the per-sample IVs (`senc`) and a non-empty sample
      // table; when they are absent (e.g. a fragmented/CMAF file whose senc/saiz/saio + sample sizes live
      // in `moof/traf`, which this path does not read) we cannot honestly produce a decrypted track, so we
      // reject as corrupt/unsupported protected input rather than emit a sample-less file (ADR-023).
      if (!enc.senc || parsed.samples.sampleSizes.length === 0) {
        throw new MediaError(
          'demux-error',
          `CENC-protected track ${parsed.id} is not decryptable by this path: ${
            enc.senc ? 'the sample table is empty' : 'per-sample encryption data (senc) is absent'
          } (malformed or fragmented protection metadata)`,
        );
      }
      const tenc = parseTenc(enc.tenc);
      const key = resolveKey(o.keys, tenc.kid);
      const senc = parseSenc(enc.senc, tenc.perSampleIvSize);
      // A protected track's ciphertext must lie entirely within the file; a truncated mdat (sample bytes
      // promised by the index but missing) is rejected rather than decrypted from a clamped short buffer.
      if (sourceSize !== undefined) assertSampleRangesInBounds(parsed, sourceSize);
      if (senc.length !== track.samples.length) {
        throw new MediaError(
          'demux-error',
          `senc describes ${senc.length} samples but the track has ${track.samples.length} (corrupt sample-encryption metadata)`,
        );
      }
      const clear = await decryptSamples(
        key,
        track.samples.map((s) => s.data),
        senc,
      );
      out.push({
        ...track,
        samples: track.samples.map((s, j) => ({ ...s, data: clear[j] ?? s.data })),
      });
    }
    const bytes = writeMp4(out, { faststart: true });
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(bytes);
        c.close();
      },
    });
  },
  createMuxer(): Muxer {
    // The byte-level muxer (writeMp4) + stream-copy remux are implemented and round-trip-validated;
    // the EncodedChunk-seam Muxer adapter lands with the browser codec layer (it needs WebCodecs).
    throw new MediaError(
      'mux-error',
      'the mp4 EncodedChunk-seam muxer requires the browser codec layer',
    );
  },
};

/** The MP4 driver module (registered via `media.use(...)` or the first-party defaults). */
export const Mp4Module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(Mp4Driver);
  },
};

export default Mp4Module;
