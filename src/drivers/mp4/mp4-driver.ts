/**
 * The MP4/MOV container driver (ISO-BMFF) — hand-written TS (ADR-002: containers are ours). Demuxes
 * to WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` with correct PTS/DTS and keyframe flags,
 * reading only the `moov` header for probe and the sample bytes on demand (bounded memory). The
 * byte-level muxer (`write.ts`) + lossless stream-copy ({@link muxTracksFromMovie}) are round-trip
 * validated; the contract `Muxer` (EncodedChunk seam) adapter is {@link Mp4Muxer} (`mux.ts`).
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  DecryptParams,
  Demuxer,
  DriverModule,
  MuxOptions,
  Muxer,
  Packet,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { aesCbcPkcs7, hexToBytes } from '../../crypto/aes.ts';
import {
  CBCS_SCHEME,
  CENC_SCHEME,
  type CencScheme,
  decryptSamples,
  decryptSamplesCbcs,
  kidHex,
  parseSenc,
  parseTenc,
} from './cenc.ts';
import { fragmentMp4 } from './fragment.ts';
import { Mp4Muxer } from './mux.ts';
import { type Movie, type ParsedTrack, applyFragmentTiming, parseMovie } from './parse.ts';
import { Reader } from './reader.ts';
import { type SampleData, buildSampleData, buildSamples } from './samples.ts';
import { type ContainerBrand, type MuxSampleInput, type MuxTrackInput, writeMp4 } from './write.ts';

const MP4_MIMES = new Set(['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a']);
const MP4_EXTENSIONS = new Set(['mp4', 'mov', 'm4a', 'm4v', 'qt']);

/** Target container token → the `ftyp` brand writeMp4 emits ('mov'/'qt' ⇒ QuickTime; else ISO mp4). */
function brandFor(container: string | undefined): ContainerBrand {
  return container === 'mov' || container === 'qt' ? 'mov' : 'mp4';
}

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
      const movie = parseMovie(brand, box.subarray(headerSize));
      // Fragmented/CMAF: the `moov` sample tables are empty and the real timing lives in `moof`/`sidx`
      // (top-level siblings of `moov`). Recover per-track duration + sample count from the fragments so
      // probe reports a correct `durationSec`/`fps` instead of 0.
      if (movie.tracks.some((t) => t.samples.sampleSizes.length === 0)) {
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** The full source bytes (fragments can follow `moov`); the size is known once we have reached `moov`. */
async function readWholeFile(ra: RandomAccess, limit: number): Promise<Uint8Array> {
  const size = ra.size ?? limit;
  if (!Number.isFinite(size))
    throw new MediaError('demux-error', 'fragmented MP4 needs a known size');
  return ra.read(0, size);
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
    // A sample whose byte range escapes the source (truncated/corrupt mdat, or a bit-flipped
    // stsz/stco/co64 entry) would otherwise be read as a silently clamped short buffer and copied as
    // garbage. Reject it as corrupt input rather than emit a wrong file (graceful-failure, doc 11 §6.3).
    if (s.offset < 0 || s.size < 0 || (ra.size !== undefined && s.offset + s.size > ra.size)) {
      const sizeNote = ra.size !== undefined ? ` size ${ra.size}` : '';
      throw new MediaError(
        'demux-error',
        `sample ${s.index} byte range [${s.offset}, ${s.offset + s.size}) is outside the source${sizeNote} (truncated or corrupt MP4)`,
      );
    }
    const data = (await ra.read(s.offset, s.size)).slice();
    if (data.byteLength !== s.size) {
      throw new MediaError(
        'demux-error',
        `sample ${s.index} short read: got ${data.byteLength} of ${s.size} bytes (truncated MP4)`,
      );
    }
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

/**
 * Stream a track's samples as seam {@link Packet}s (browser: requires `Encoded*Chunk`). The chunk's
 * `timestamp` is the PTS (DTS + composition offset); the packet's `dtsUs` carries the true **decode**
 * timestamp from the `stts` table, so a B-frame/open-GOP track enumerates and remuxes in decode order
 * losslessly (ADR-045). For a non-reordered track `dtsUs === ptsUs`, which is the documented no-op.
 */
function packetStream(
  ra: RandomAccess,
  track: ParsedTrack,
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
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
  return new ReadableStream<Packet>({
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
      const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
      controller.enqueue({ chunk, dtsUs: sample.dtsUs });
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

/**
 * Decrypt one CENC-protected track (`cenc` AES-CTR or `cbcs` AES-CBC-pattern) into a cleartext
 * {@link MuxTrackInput}. The scheme is the container's own (`enc.schemeType` from `schm`); the caller's
 * declared `scheme` must match it (a mismatch is corrupt/contradictory input). A protected track with no
 * `senc` or an empty sample table (e.g. fragmented/CMAF metadata in `moof/traf`, which this `moov` path
 * does not read) cannot be honestly decrypted here, so it rejects rather than emit a sample-less blob.
 */
async function decryptCencTrack(
  parsed: ParsedTrack,
  track: MuxTrackInput,
  enc: NonNullable<ParsedTrack['encryption']>,
  keys: Record<string, string>,
  declaredScheme: CencScheme,
  sourceSize: number | undefined,
): Promise<MuxTrackInput> {
  const containerScheme: CencScheme = enc.schemeType === CBCS_SCHEME ? CBCS_SCHEME : CENC_SCHEME;
  if (containerScheme !== declaredScheme) {
    throw new MediaError(
      'demux-error',
      `track ${parsed.id} is '${containerScheme}'-protected but decrypt was asked for '${declaredScheme}' (scheme mismatch)`,
    );
  }
  if (!enc.senc || parsed.samples.sampleSizes.length === 0) {
    throw new MediaError(
      'demux-error',
      `${containerScheme}-protected track ${parsed.id} is not decryptable by this path: ${
        enc.senc ? 'the sample table is empty' : 'per-sample encryption data (senc) is absent'
      } (malformed or fragmented protection metadata)`,
    );
  }
  const tenc = parseTenc(enc.tenc, containerScheme);
  const key = resolveKey(keys, tenc.kid);
  const senc = parseSenc(enc.senc, tenc.perSampleIvSize, containerScheme);
  // A protected track's ciphertext must lie entirely within the file; a truncated mdat (sample bytes
  // promised by the index but missing) is rejected rather than decrypted from a clamped short buffer.
  if (sourceSize !== undefined) assertSampleRangesInBounds(parsed, sourceSize);
  if (senc.length !== track.samples.length) {
    throw new MediaError(
      'demux-error',
      `senc describes ${senc.length} samples but the track has ${track.samples.length} (corrupt sample-encryption metadata)`,
    );
  }
  const cipher = track.samples.map((s) => s.data);
  const clear =
    containerScheme === CBCS_SCHEME
      ? await decryptSamplesCbcs(
          key,
          cipher,
          senc,
          tenc.pattern ?? { cryptByteBlock: 1, skipByteBlock: 0 }, // version-0 cbcs ⇒ full CBC, no pattern
          tenc.constantIv,
        )
      : await decryptSamples(key, cipher, senc);
  return { ...track, samples: track.samples.map((s, j) => ({ ...s, data: clear[j] ?? s.data })) };
}

/** Hex (16-byte) value from the HLS key map, or a typed error naming the missing/short field. */
function hlsKeyField(keys: Record<string, string>, field: 'key' | 'iv'): Uint8Array<ArrayBuffer> {
  const hex = keys[field];
  if (hex === undefined) {
    throw new CapabilityError(
      'capability-miss',
      `HLS AES-128 needs '${field}' (hex) in keys; none provided`,
      { op: 'decrypt', tried: ['mp4'] },
    );
  }
  return hexToBytes(hex);
}

/**
 * Decrypt a full-segment HLS `AES-128` (AES-128-CBC + PKCS#7) **MP4** segment: the whole byte stream is
 * the ciphertext of a clear MP4. The key/IV come from the caller's `keys` (`key`/`iv` hex). The recovered
 * bytes must re-parse as an MP4 (a sanity gate that we produced a real container, not garbage). A raw
 * MPEG-TS HLS segment is not an MP4 and is out of this driver's scope — use `decryptHlsAes128` directly.
 */
async function decryptHlsSegmentMp4(
  ra: RandomAccess,
  keys: Record<string, string>,
): Promise<Uint8Array> {
  if (ra.size === undefined) {
    throw new MediaError(
      'demux-error',
      'HLS AES-128 needs the full segment size (non-seekable source)',
    );
  }
  const cipher = await ra.read(0, ra.size);
  if (cipher.byteLength === 0 || cipher.byteLength % 16 !== 0) {
    throw new MediaError(
      'demux-error',
      `HLS AES-128 segment must be a positive multiple of 16 bytes (CBC), got ${cipher.byteLength}`,
    );
  }
  const key = hlsKeyField(keys, 'key');
  const iv = hlsKeyField(keys, 'iv');
  if (key.byteLength !== 16 || iv.byteLength !== 16) {
    throw new MediaError(
      'demux-error',
      `HLS AES-128 key and IV must be 16 bytes (got key=${key.byteLength}, iv=${iv.byteLength})`,
    );
  }
  // A wrong key/IV trips PKCS#7 validation (SubtleCrypto throws a DOMException `OperationError`) or
  // yields bytes that are not a valid MP4 (`readMovie` throws). Either way the segment did not decrypt;
  // surface a typed MediaError, never a leaked DOMException (the typed-error model, ADR-017).
  try {
    const clear = await aesCbcPkcs7(key, iv, cipher.slice(), 'decrypt');
    await readMovie({
      read: (off, len) => Promise.resolve(clear.subarray(off, off + len)),
      size: clear.byteLength,
    });
    return clear;
  } catch (e) {
    if (e instanceof MediaError) throw e; // already typed (CapabilityError/InputError/MediaError)
    throw new MediaError(
      'demux-error',
      'HLS AES-128 segment did not decrypt to a valid MP4 (wrong key/IV, or not an AES-128 MP4 segment)',
      e,
    );
  }
}

/** A single-chunk byte stream (the whole output is already materialized in memory). */
function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/**
 * Stream a fragmented/CMAF MP4 (ADR-034): drive the {@link fragmentMp4} generator one segment at a time
 * (init segment, then one `moof`+`mdat` media segment per pull) so a `StreamTarget` writes each segment as
 * it is produced and peak memory stays bounded to a single fragment — never buffering the whole movie.
 */
function fragmentedStream(tracks: readonly MuxTrackInput[]): ReadableStream<Uint8Array> {
  const segments = fragmentMp4(tracks);
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const { done, value } = segments.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
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
      packets(trackId: number): ReadableStream<Packet> {
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
    // Fragmented/CMAF output (ADR-034): a sequence of self-describing `moof`+`mdat` segments after the
    // init segment, streamed one at a time so a StreamTarget never buffers the whole movie. The lossless
    // sample copy (DTS/ctts/codec-private preserved) is identical; only the on-disk box layout differs.
    if (o?.fragmented === true) return fragmentedStream(tracks);
    const bytes = writeMp4(tracks, {
      faststart: o?.faststart ?? true,
      brand: brandFor(o?.container),
    });
    return oneShot(bytes);
  },
  async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src);

    // HLS AES-128: the whole MP4 segment is one AES-128-CBC (PKCS#7) ciphertext — decrypt it as a unit.
    if (o.scheme === 'hls-aes128') {
      const clear = await decryptHlsSegmentMp4(ra, o.keys);
      return oneShot(clear);
    }

    // CENC sample decryption: 'cenc' (AES-CTR) or 'cbcs' (AES-CBC pattern). Anything else is unsupported.
    if (o.scheme !== CENC_SCHEME && o.scheme !== CBCS_SCHEME) {
      throw new CapabilityError(
        'capability-miss',
        `the mp4 driver decrypts CENC ('cenc'/'cbcs') and HLS ('hls-aes128'); '${o.scheme}' is not supported`,
        { op: 'decrypt', tried: ['mp4'] },
      );
    }
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
      // if it were clear (ADR-023). The scheme-specific decrypt rejects undecryptable protected input
      // (absent senc / empty sample table / scheme mismatch) rather than emitting a sample-less file.
      out.push(await decryptCencTrack(parsed, track, enc, o.keys, o.scheme, sourceSize));
    }
    return oneShot(writeMp4(out, { faststart: true }));
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over writeMp4 ({@link Mp4Muxer}): its packet→sample timing
    // (DTS/ctts, B-frames) is pure + Node-validated; only the per-chunk `copyTo` is browser-only.
    return new Mp4Muxer(o);
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
