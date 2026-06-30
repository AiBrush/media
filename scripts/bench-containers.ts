#!/usr/bin/env bun
/**
 * scripts/bench-containers.ts — fresh, multi-sample benchmark for the pure-TS container / parse ops
 * (BUILD_INSTRUCTIONS §6: "every op has a multi-sample benchmark … wall, throughput … measured across
 * several real §6.1 corpus files, not one"). Mirrors the `scripts/bench-dsp.ts` harness (median of N
 * timed iters after warmup; a separate RSS pass so memory sampling never perturbs the wall; a checksum
 * sink so the optimizer can't elide the work; a machine-readable baseline + a `--check` regression gate).
 *
 * The ops, each run across **≥ 5 real corpus files** (never one):
 *   - **probe**   — `media.probe`: header-only parse → `MediaInfo`, across a **diverse multi-container**
 *                   set (MP4/MOV, WebM, MP3, Ogg, WAV, FLAC, ADTS). A near-constant-cost header read, so
 *                   it is reported as probes/sec (+ file MB for context), not file-MB/s.
 *   - **demux**   — the pure-TS container→samples work the public `demux` does *before* the WebCodecs
 *                   `Encoded*Chunk` wrapping (which is browser-only and unavailable in Node): build the
 *                   full sample table and gather every sample's bytes (`muxTracksFromMovie`). Reported as
 *                   MB/s of the sample bytes gathered. (Labelled honestly — it is the parse+gather unit,
 *                   not the browser chunk emit.)
 *   - **remux**   — `media.remux(→mp4)`: lossless demux→mux stream-copy. MB/s of the output bytes.
 *   - **mkv remux** — pure MP4 packet-table → `WebmMuxer.addChunkStruct`, preserving PTS/DTS for B-frames
 *                   and edit-list-shifted starts. MB/s of the Matroska output bytes.
 *   - **trim**    — `media.trim(keyframe, 25%–75%)`: keyframe-aligned stream-copy. MB/s of the output.
 *                   Accurate trim's browser-only decode→trim→encode seam is represented here by its
 *                   pure frame-window core over real MP4 sample timestamp traces.
 *   - **ts remux/mux** — pure MP4 packet-table → `MpegTsMuxer.addChunkStruct` for H.264/AAC output,
 *                   public `media.mux({track,packets}, →ts)` over the same real packet data, plus
 *                   `media.remux(→ts)` / `media.trim(keyframe)` over MPEG-TS same-container packet-copy.
 *   - **ogg mux** — pure `OggMuxer` re-authoring real Opus/Vorbis/FLAC packets into Ogg pages,
 *                   including WebM-laced Vorbis packets whose duration is anchored by source metadata.
 *   - **decrypt** — `media.decrypt(cenc/cens/hls-sample-aes)`: CENC AES-CTR / patterned AES-CTR sample
 *                   decryption of freshly encrypted twins, plus HLS TS SAMPLE-AES H.264/AAC payload-block
 *                   decrypt on real VOD TS segments. MB/s of the decrypted output.
 *   - **fuzz robustness** — deterministic corrupt-input matrices over real fixture heads, asserting the
 *                   typed-error contract while reporting corrupt-input MB/s.
 *
 * `demux`/`remux`/`trim`/CENC `decrypt` run on the **MP4/MOV** corpus (the pure-TS container with a Node
 * stream-copy + decrypt path); MPEG-TS stream-copy runs on the committed local TS corpus; HLS SAMPLE-AES
 * decrypt runs on the five real HLS VOD TS segments; `probe` spans every container family. Each metric also
 * reports `throughputRealtime` (media seconds processed per wall second) where the op yields a timed file.
 *
 *   bun run bench-containers              # run + print + (re)write the baseline
 *   bun run bench-containers --check      # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMedia } from '../src/api/create-media.ts';
import { type TimedFrameForTrim, trimTimedFrameStream } from '../src/api/trim-streams.ts';
import type { MediaInfo, PacketStreams } from '../src/api/types.ts';
import type { EncodedChunk, Packet, TrackInfo } from '../src/contracts/driver.ts';
import { parseAiff } from '../src/drivers/aiff/aiff.ts';
import { parseAvi } from '../src/drivers/avi/avi-parse.ts';
import {
  enumerateFlacFrames,
  nativeFlacMetadata,
  parseFlac,
} from '../src/drivers/flac/flac-driver.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import type { ParsedTrack } from '../src/drivers/mp4/parse.ts';
import { buildSamples } from '../src/drivers/mp4/samples.ts';
import { parseTs } from '../src/drivers/mpegts/ts-parse.ts';
import { MpegTsMuxer } from '../src/drivers/mpegts/ts-write.ts';
import { OggDriver, oggAudioPackets, parseOgg } from '../src/drivers/ogg/ogg-driver.ts';
import { OggMuxer } from '../src/drivers/ogg/ogg-write.ts';
import { parseWav } from '../src/drivers/wav/wav-driver.ts';
import { WebmMuxer } from '../src/drivers/webm/ebml-write.ts';
import { demuxWebm, parseWebm } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';
import { encryptCenc, encryptCens } from '../src/test-support/cenc-encrypt.ts';
import {
  type CorruptCase,
  type Family,
  corruptMatrix,
  escapes,
  runMatrix,
} from '../src/test-support/fuzz/corrupt.ts';
import { encryptHlsSampleAesTs } from '../src/test-support/hls-sample-aes.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const HARNESS_MEDIA_DIR = new URL(
  '../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;
const DERIVED_DIR = `${ROOT}fixtures/media-derived`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/containers.json`;

const WARMUP = 3;
const ITERS = 21;
/** Beyond ±this fraction slower than the committed baseline MB/s, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

/** The CENC key/KID used to mint the decrypt op's encrypted twin (any 16-byte key works for a round-trip). */
const CENC_KEY = '000102030405060708090a0b0c0d0e0f';
const CENC_KID = '00112233445566778899aabbccddeeff';
const SAMPLE_AES_KEY = Uint8Array.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);
const SAMPLE_AES_IV = Uint8Array.from([
  0xf0, 0xe1, 0xd2, 0xc3, 0xb4, 0xa5, 0x96, 0x87, 0x78, 0x69, 0x5a, 0x4b, 0x3c, 0x2d, 0x1e, 0x0f,
]);

/** A diverse, multi-container probe set (one+ per family); every entry is a real downloaded fixture. */
const PROBE_FILES = [
  'test.mp4', // MP4, A/V, 6 s, 188 KB
  'movie_5.mp4', // MP4, A/V, 5 s
  'movie_5.webm', // WebM/EBML, A/V
  'recorder_headerless.webm', // headerless MediaRecorder WebM
  'sound_5.mp3', // MP3 (frame-sync + Xing)
  'sound_5.oga', // Ogg (Vorbis/Opus granule)
  'speech.wav', // WAV/RIFF PCM
  'flac-verbatim.flac', // FLAC (STREAMINFO)
  'sfx.adts', // ADTS/AAC
];

/** The MP4/MOV set for demux/remux/trim/decrypt (the pure-TS container with a Node stream-copy path). */
const MP4_FILES = [
  '2x2-green.mp4',
  'av1.mp4',
  'four-colors.mp4',
  'h264.mp4',
  'h265.mp4',
  'movie_5.mp4',
  'test.mp4',
];

/** H.264/AAC MP4 inputs that the MPEG-TS muxer can honestly author through the packet seam. */
const MP4_TO_TS_FILES = [
  'h264.mp4',
  'movie_5.mp4',
  'test.mp4',
  'bear-1280x720.mp4',
  'bear-rotate-90.mp4',
  'obs-remux-variable-aac.mp4',
] as const;

/** Local real transport streams for the MPEG-TS driver-native remux/trim packet-copy path. */
const TS_FILES = [
  { id: 'bear-1280x720.ts', path: `${MEDIA_DIR}/bear-1280x720.ts` },
  { id: 'h264_720p.head.ts', path: `${DERIVED_DIR}/h264_720p.head.ts` },
] as const;

/** The five real HLS VOD TS segments for key-provided SAMPLE-AES decrypt benchmarking. */
const HLS_SAMPLE_AES_FILES = [
  { id: 'hls_vod_000.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_000.ts` },
  { id: 'hls_vod_001.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_001.ts` },
  { id: 'hls_vod_002.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_002.ts` },
  { id: 'hls_vod_003.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_003.ts` },
  { id: 'hls_vod_004.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_004.ts` },
] as const;

/** Real audio packet sources for the pure Ogg page writer: Opus/Vorbis already in Ogg, plus FLAC frames. */
const OGG_MUX_FILES = [
  { id: 'sfx-opus.ogg', kind: 'ogg' },
  { id: 'sound_5.oga', kind: 'ogg' },
  { id: 'bear-multitrack.webm', kind: 'webm-vorbis' },
  { id: 'sfx.flac', kind: 'flac' },
  { id: 'flac-08bit.flac', kind: 'flac' },
  { id: 'flac-12bit.flac', kind: 'flac' },
  { id: 'flac-5_1ch.flac', kind: 'flac' },
  { id: 'flac-wasted-bits.flac', kind: 'flac' },
] as const;

interface RobustnessFile {
  readonly id: string;
  readonly path: string;
  readonly family: Family;
  readonly parse: (bytes: Uint8Array) => unknown;
  readonly container: string;
}

/**
 * A bounded fuzz-benchmark matrix over real fixture heads. The full oracle lives in
 * `src/test-support/fuzz/parser-robustness.test.ts`; this benchmark tracks cost across representative
 * families without replaying the entire large matrix for every timed sample.
 */
const ROBUSTNESS_FILES = [
  {
    id: 'h264.mp4',
    path: `${MEDIA_DIR}/h264.mp4`,
    family: 'isobmff',
    container: 'mp4',
    parse: (bytes: Uint8Array) => readMovie(ra(bytes)),
  },
  {
    id: 'speech.wav',
    path: `${MEDIA_DIR}/speech.wav`,
    family: 'riff',
    container: 'wav',
    parse: (bytes: Uint8Array) => parseWav(bytes, bytes.byteLength),
  },
  {
    id: 'sfx-opus.ogg',
    path: `${MEDIA_DIR}/sfx-opus.ogg`,
    family: 'ogg',
    container: 'ogg',
    parse: (bytes: Uint8Array) => parseOgg(bytes),
  },
  {
    id: 'sfx.flac',
    path: `${MEDIA_DIR}/sfx.flac`,
    family: 'framed',
    container: 'flac',
    parse: (bytes: Uint8Array) => parseFlac(bytes),
  },
  {
    id: 'movie_5.webm',
    path: `${MEDIA_DIR}/movie_5.webm`,
    family: 'ebml',
    container: 'webm',
    parse: (bytes: Uint8Array) => parseWebm(bytes),
  },
  {
    id: 'aiff-caf/sfx.aiff',
    path: `${DERIVED_DIR}/aiff-caf/sfx.aiff`,
    family: 'iff',
    container: 'aiff',
    parse: (bytes: Uint8Array) => parseAiff(bytes),
  },
  {
    id: 'mjpeg_pcm_160p.avi',
    path: `${DERIVED_DIR}/mjpeg_pcm_160p.avi`,
    family: 'riff',
    container: 'avi',
    parse: (bytes: Uint8Array) => parseAvi(bytes),
  },
] as const satisfies readonly RobustnessFile[];

const ROBUSTNESS_MATRIX_OPTIONS = {
  seedCap: 8 * 1024,
  truncateStride: 257,
  randomCount: 6,
  bitflipCount: 24,
} as const;

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  adts: 'audio/aac',
  ts: 'video/mp2t',
};

let sink = 0; // accumulate a byte from each result to defeat dead-code elimination

// ============ stats / timing (async) ============

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Time async `fn` over {@link ITERS} runs (after {@link WARMUP}); return the median nanoseconds per run. */
async function timeNs(fn: () => Promise<number>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) sink = (sink + (await fn())) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + (await fn())) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

/**
 * Peak resident-set growth (bytes) while running async `fn` {@link ITERS} times, versus a forced-gc
 * baseline. A separate pass from {@link timeNs} so RSS sampling never perturbs the wall measurement.
 */
async function peakRssBytes(fn: () => Promise<number>): Promise<number> {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < ITERS; i++) {
    sink = (sink + (await fn())) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

// ============ measured op record ============

interface OpResult {
  op: string;
  /** Bytes processed per op invocation (the work unit: header / sample bytes / output bytes). */
  bytes: number;
  /** Seconds of media the file represents (0 when not meaningful, e.g. a header-only probe metric). */
  mediaSeconds: number;
  wallMs: number;
  mbPerSec: number;
  /** Media seconds processed per wall second (× realtime); 0 when `mediaSeconds` is 0. */
  throughputRealtime: number;
  peakMemoryMb: number;
}

/** Measure one async op (wall pass + memory pass) and fold both into an {@link OpResult}. */
async function measure(
  op: string,
  bytes: number,
  mediaSeconds: number,
  fn: () => Promise<number>,
): Promise<OpResult> {
  const ns = await timeNs(fn);
  const peakBytes = await peakRssBytes(fn);
  const wallSeconds = ns / 1e9;
  return {
    op,
    bytes,
    mediaSeconds,
    wallMs: ns / 1e6,
    mbPerSec: bytes / (1024 * 1024) / wallSeconds,
    throughputRealtime: mediaSeconds > 0 ? mediaSeconds / wallSeconds : 0,
    peakMemoryMb: peakBytes / (1024 * 1024),
  };
}

interface FileResult {
  id: string;
  container: string;
  sizeBytes: number;
  durationSec: number;
  ops: OpResult[];
}

type BenchChunkInit = {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly data: Uint8Array;
};

class BenchEncodedChunk {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: BenchChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = init.data;
    this.byteLength = init.data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

interface BenchTimedFrameInit {
  readonly timestamp: number;
  readonly duration: number | null;
}

class BenchTimedFrame implements TimedFrameForTrim {
  readonly timestamp: number;
  readonly duration: number | null;
  closed = false;

  constructor(init: BenchTimedFrameInit) {
    this.timestamp = init.timestamp;
    this.duration = init.duration;
  }

  close(): void {
    this.closed = true;
  }
}

interface AccurateTrimTrace {
  readonly bounds: { readonly startUs: number; readonly endUs: number };
  readonly tracks: readonly (readonly BenchTimedFrameInit[])[];
  readonly recordBytes: number;
}

// ============ per-file op builders ============

const engine = createMedia();

function source(id: string, bytes: Uint8Array) {
  const ext = id.slice(id.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME[ext];
  return fromBytes(bytes, mime ? { mime } : {});
}

async function blobBytes(out: unknown): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A `RandomAccess` over an in-memory buffer (mirrors the driver's buffered path). */
const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** Total sample bytes the demux gather touches (sum over tracks of every sample's size). */
async function sampleByteCount(bytes: Uint8Array): Promise<number> {
  const tracks = await muxTracksFromMovie(ra(bytes), await readMovie(ra(bytes)));
  let total = 0;
  for (const t of tracks) for (const s of t.samples) total += s.data.byteLength;
  return total;
}

async function accurateTrimTrace(
  bytes: Uint8Array,
  startSec: number,
  endSec: number,
): Promise<AccurateTrimTrace> {
  const movie = await readMovie(ra(bytes));
  const tracks = movie.tracks
    .map((track) =>
      buildSamples(track).map((sample) => ({
        timestamp: sample.ptsUs,
        duration: sample.durationUs,
      })),
    )
    .filter((track) => track.length > 0);
  const recordCount = tracks.reduce((count, track) => count + track.length, 0);
  return {
    bounds: {
      startUs: Math.round(startSec * 1_000_000),
      endUs: Math.round(endSec * 1_000_000),
    },
    tracks,
    recordBytes: recordCount * 16,
  };
}

function benchFrameStream(frames: readonly BenchTimedFrameInit[]): ReadableStream<BenchTimedFrame> {
  let index = 0;
  return new ReadableStream<BenchTimedFrame>({
    pull(controller): void {
      const frame = frames[index];
      index++;
      if (frame === undefined) controller.close();
      else controller.enqueue(new BenchTimedFrame(frame));
    },
  });
}

function restampBenchFrame(
  frame: BenchTimedFrame,
  timestamp: number,
  duration: number | null,
): BenchTimedFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  return new BenchTimedFrame({ timestamp, duration });
}

async function runAccurateTrimTrace(trace: AccurateTrimTrace): Promise<number> {
  let kept = 0;
  let checksum = 0;
  for (const frames of trace.tracks) {
    const reader = trimTimedFrameStream(
      benchFrameStream(frames),
      trace.bounds,
      restampBenchFrame,
    ).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kept++;
      checksum = (checksum + value.timestamp + (value.duration ?? 0)) | 0;
      value.close();
    }
  }
  return kept + (checksum & 0xff);
}

function trackInfoFromMp4Track(track: ParsedTrack): TrackInfo {
  return {
    id: track.id,
    mediaType: track.mediaType,
    codec: track.codec,
    durationSec: track.durationSec,
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
    ...(track.encryption !== undefined ? { encrypted: true } : {}),
    config: track.config,
  };
}

function benchChunk(init: BenchChunkInit): EncodedChunk {
  return new BenchEncodedChunk(init) as unknown as EncodedChunk;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function packetStreamFromMp4Track(
  track: ParsedTrack,
  muxTrack: { samples: readonly { data: Uint8Array }[] },
): ReadableStream<Packet> {
  const timeline = buildSamples(track);
  if (timeline.length !== muxTrack.samples.length) {
    throw new Error(
      `public mux benchmark sample mismatch on track ${track.id}: timeline=${timeline.length}, bytes=${muxTrack.samples.length}`,
    );
  }
  return new ReadableStream<Packet>({
    start(controller): void {
      for (let i = 0; i < timeline.length; i++) {
        const sample = timeline[i];
        const muxSample = muxTrack.samples[i];
        if (sample === undefined || muxSample === undefined) {
          throw new Error(`public mux benchmark lost sample ${i} on track ${track.id}`);
        }
        controller.enqueue({
          chunk: benchChunk({
            type: sample.keyframe ? 'key' : 'delta',
            timestamp: sample.ptsUs,
            duration: sample.durationUs,
            data: muxSample.data,
          }),
          dtsUs: sample.dtsUs,
        });
      }
      controller.close();
    },
  });
}

async function muxMp4ToMkv(bytes: Uint8Array): Promise<Uint8Array> {
  const access = ra(bytes);
  const movie = await readMovie(access);
  const muxTracks = await muxTracksFromMovie(access, movie);
  const muxer = new WebmMuxer({ container: 'mkv' }, 'matroska');

  for (let i = 0; i < movie.tracks.length; i++) {
    const track = movie.tracks[i];
    const muxTrack = muxTracks[i];
    if (track === undefined || muxTrack === undefined) {
      throw new Error(`MP4→MKV benchmark lost track ${i}`);
    }

    const samples = buildSamples(track);
    if (samples.length !== muxTrack.samples.length) {
      throw new Error(
        `MP4→MKV benchmark sample mismatch on track ${track.id}: timeline=${samples.length}, bytes=${muxTrack.samples.length}`,
      );
    }

    const trackId = muxer.addTrack(trackInfoFromMp4Track(track));
    for (let j = 0; j < samples.length; j++) {
      const sample = samples[j];
      const muxSample = muxTrack.samples[j];
      if (sample === undefined || muxSample === undefined) {
        throw new Error(`MP4→MKV benchmark lost sample ${j} on track ${track.id}`);
      }
      muxer.addChunkStruct(trackId, {
        timestampUs: sample.ptsUs,
        durationUs: sample.durationUs,
        key: sample.keyframe,
        data: muxSample.data,
        dtsUs: sample.dtsUs,
      });
    }
  }

  await muxer.finalize();
  return streamBytes(muxer.output);
}

async function muxMp4ToTs(bytes: Uint8Array): Promise<Uint8Array> {
  const access = ra(bytes);
  const movie = await readMovie(access);
  const muxTracks = await muxTracksFromMovie(access, movie);
  const muxer = new MpegTsMuxer();

  for (let i = 0; i < movie.tracks.length; i++) {
    const track = movie.tracks[i];
    const muxTrack = muxTracks[i];
    if (track === undefined || muxTrack === undefined) {
      throw new Error(`MP4→TS benchmark lost track ${i}`);
    }

    const samples = buildSamples(track);
    if (samples.length !== muxTrack.samples.length) {
      throw new Error(
        `MP4→TS benchmark sample mismatch on track ${track.id}: timeline=${samples.length}, bytes=${muxTrack.samples.length}`,
      );
    }

    const trackId = muxer.addTrack(trackInfoFromMp4Track(track));
    for (let j = 0; j < samples.length; j++) {
      const sample = samples[j];
      const muxSample = muxTrack.samples[j];
      if (sample === undefined || muxSample === undefined) {
        throw new Error(`MP4→TS benchmark lost sample ${j} on track ${track.id}`);
      }
      muxer.addChunkStruct(trackId, {
        timestampUs: sample.ptsUs,
        durationUs: sample.durationUs,
        key: sample.keyframe,
        data: muxSample.data,
        dtsUs: sample.dtsUs,
      });
    }
  }

  await muxer.finalize();
  return streamBytes(muxer.output);
}

async function publicMuxMp4ToTs(id: string, bytes: Uint8Array): Promise<Uint8Array> {
  const access = ra(bytes);
  const movie = await readMovie(access);
  const muxTracks = await muxTracksFromMovie(access, movie);
  const streams: PacketStreams = {};
  let hasAudio = false;
  for (let i = 0; i < movie.tracks.length; i++) {
    const track = movie.tracks[i];
    const muxTrack = muxTracks[i];
    if (track === undefined || muxTrack === undefined) {
      throw new Error(`public mux benchmark lost track ${i} for ${id}`);
    }
    if (track.mediaType === 'video' && streams.video === undefined) {
      streams.video = {
        track: trackInfoFromMp4Track(track),
        packets: packetStreamFromMp4Track(track, muxTrack),
      };
    } else if (track.mediaType === 'audio' && streams.audio === undefined) {
      hasAudio = true;
      streams.audio = {
        track: trackInfoFromMp4Track(track),
        packets: packetStreamFromMp4Track(track, muxTrack),
      };
    }
  }
  const out = await blobBytes(await engine.mux(streams, { container: 'ts' }));
  const parsed = parseTs(out);
  if (!parsed.tracks.some((track) => track.stream.codec === 'h264')) {
    throw new Error(`public mux ${id} did not write a H.264 transport stream`);
  }
  if (hasAudio && !parsed.tracks.some((track) => track.stream.codec === 'aac')) {
    throw new Error(`public mux ${id} did not write an AAC transport stream`);
  }
  return out;
}

/** Probe each file once for its real container/size/duration (used to label + scale the metrics). */
async function probeInfo(id: string, bytes: Uint8Array): Promise<MediaInfo> {
  return engine.probe(source(id, bytes));
}

// ============ benches ============

async function benchProbe(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const id of PROBE_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const info = await probeInfo(id, bytes);
    // Work unit for a header parse is the file's MB (a probe-rate proxy); mediaSeconds=0 (not a timed copy).
    const op = await measure('probe', bytes.byteLength, 0, async () => {
      const i = await engine.probe(source(id, bytes));
      return i.tracks.length + (i.durationSec | 0);
    });
    out.push({
      id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: info.durationSec,
      ops: [op],
    });
  }
  return out;
}

async function benchMp4Ops(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const id of MP4_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const info = await probeInfo(id, bytes);
    const dur = info.durationSec;
    const ops: OpResult[] = [];

    // demux: build the sample table + gather every sample's bytes (the pure-TS container→samples work).
    const gathered = await sampleByteCount(bytes);
    ops.push(
      await measure('demux (table+gather)', gathered, dur, async () => {
        const tracks = await muxTracksFromMovie(ra(bytes), await readMovie(ra(bytes)));
        return (tracks[0]?.samples[0]?.data[0] ?? 0) + tracks.length;
      }),
    );

    // remux: lossless demux→mux stream-copy; the work unit is the produced byte count.
    const remuxOut = await blobBytes(await engine.remux(source(id, bytes), { to: 'mp4' }));
    ops.push(
      await measure(
        'remux (→mp4)',
        remuxOut.byteLength,
        dur,
        async () =>
          (await blobBytes(await engine.remux(source(id, bytes), { to: 'mp4' }))).byteLength % 251,
      ),
    );

    const mkvOut = await muxMp4ToMkv(bytes);
    ops.push(
      await measure('remux (→mkv)', mkvOut.byteLength, dur, async () => {
        const fresh = await muxMp4ToMkv(bytes);
        return fresh.byteLength % 251;
      }),
    );

    // trim: keyframe-aligned stream-copy of the middle half (25%–75%). Skip when the file is too short
    // to carve a non-empty inner range (a degenerate 0-length trim is not representative work).
    const start = dur * 0.25;
    const end = dur * 0.75;
    if (end - start > 0.001) {
      const trimOut = await blobBytes(
        await engine.trim(source(id, bytes), { mode: 'keyframe', start, end }),
      );
      const trimSeconds = end - start;
      ops.push(
        await measure(
          'trim (keyframe 25–75%)',
          trimOut.byteLength,
          trimSeconds,
          async () =>
            (
              await blobBytes(
                await engine.trim(source(id, bytes), { mode: 'keyframe', start, end }),
              )
            ).byteLength % 251,
        ),
      );
      const trace = await accurateTrimTrace(bytes, start, end);
      ops.push(
        await measure('trim accurate frame-window', trace.recordBytes, trimSeconds, async () =>
          runAccurateTrimTrace(trace),
        ),
      );
    }

    // decrypt: mint a CENC twin (encrypt the first present track type), then time the AES-CTR decrypt.
    const target: 'audio' | 'video' = info.tracks.some((t) => t.type === 'audio')
      ? 'audio'
      : 'video';
    const enc = await encryptCenc(bytes, { keyHex: CENC_KEY, kidHex: CENC_KID, mediaType: target });
    const decOut = await blobBytes(
      await engine.decrypt(source('enc.mp4', enc), {
        scheme: 'cenc',
        keys: { [CENC_KID]: CENC_KEY },
      }),
    );
    ops.push(
      await measure(
        'decrypt (cenc)',
        decOut.byteLength,
        dur,
        async () =>
          (
            await blobBytes(
              await engine.decrypt(source('enc.mp4', enc), {
                scheme: 'cenc',
                keys: { [CENC_KID]: CENC_KEY },
              }),
            )
          ).byteLength % 251,
      ),
    );

    const cens = await encryptCens(bytes, {
      keyHex: CENC_KEY,
      kidHex: CENC_KID,
      mediaType: target,
      pattern: { cryptByteBlock: 1, skipByteBlock: 9 },
    });
    const censDecOut = await blobBytes(
      await engine.decrypt(source('cens.mp4', cens), {
        scheme: 'cens',
        keys: { [CENC_KID]: CENC_KEY },
      }),
    );
    ops.push(
      await measure(
        'decrypt (cens)',
        censDecOut.byteLength,
        dur,
        async () =>
          (
            await blobBytes(
              await engine.decrypt(source('cens.mp4', cens), {
                scheme: 'cens',
                keys: { [CENC_KID]: CENC_KEY },
              }),
            )
          ).byteLength % 251,
      ),
    );

    out.push({ id, container: info.container, sizeBytes: bytes.byteLength, durationSec: dur, ops });
  }
  return out;
}

async function benchHlsSampleAesOps(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  const keyHex = hex(SAMPLE_AES_KEY);
  const ivHex = hex(SAMPLE_AES_IV);
  for (const file of HLS_SAMPLE_AES_FILES) {
    const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer());
    const info = await probeInfo(file.id, bytes);
    const cipher = encryptHlsSampleAesTs(bytes, SAMPLE_AES_KEY, SAMPLE_AES_IV);
    if (bytesEqual(cipher, bytes)) {
      throw new Error(
        `${file.id} SAMPLE-AES benchmark encrypted twin did not alter the clear segment`,
      );
    }
    const decOut = await blobBytes(
      await engine.decrypt(source(file.id, cipher), {
        scheme: 'hls-sample-aes',
        keys: { key: keyHex, iv: ivHex },
      }),
    );
    if (!bytesEqual(decOut, bytes)) {
      throw new Error(`${file.id} SAMPLE-AES benchmark decrypt did not recover the clear segment`);
    }
    const op = await measure(
      'decrypt (hls-sample-aes)',
      decOut.byteLength,
      info.durationSec,
      async () => {
        const fresh = await blobBytes(
          await engine.decrypt(source(file.id, cipher), {
            scheme: 'hls-sample-aes',
            keys: { key: keyHex, iv: ivHex },
          }),
        );
        return fresh.byteLength % 251;
      },
    );
    out.push({
      id: file.id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: info.durationSec,
      ops: [op],
    });
  }
  return out;
}

async function benchMpegTsOps(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const file of TS_FILES) {
    const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer());
    const info = await probeInfo(file.id, bytes);
    const dur = info.durationSec;
    const ops: OpResult[] = [];

    const remuxOut = await blobBytes(await engine.remux(source(file.id, bytes), { to: 'ts' }));
    ops.push(
      await measure(
        'remux (ts→ts)',
        remuxOut.byteLength,
        dur,
        async () =>
          (await blobBytes(await engine.remux(source(file.id, bytes), { to: 'ts' }))).byteLength %
          251,
      ),
    );

    const start = dur * 0.25;
    const end = dur * 0.75;
    if (end - start > 0.001) {
      const trimOut = await blobBytes(
        await engine.trim(source(file.id, bytes), { mode: 'keyframe', start, end }),
      );
      ops.push(
        await measure(
          'trim (ts keyframe 25–75%)',
          trimOut.byteLength,
          end - start,
          async () =>
            (
              await blobBytes(
                await engine.trim(source(file.id, bytes), { mode: 'keyframe', start, end }),
              )
            ).byteLength % 251,
        ),
      );
    }

    out.push({
      id: file.id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: dur,
      ops,
    });
  }
  return out;
}

async function benchMp4ToTsOps(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const id of MP4_TO_TS_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const info = await probeInfo(id, bytes);
    const remuxOut = await muxMp4ToTs(bytes);
    const ops: OpResult[] = [
      await measure('remux (→ts)', remuxOut.byteLength, info.durationSec, async () => {
        const fresh = await muxMp4ToTs(bytes);
        return fresh.byteLength % 251;
      }),
    ];
    const publicMuxOut = await publicMuxMp4ToTs(id, bytes);
    ops.push(
      await measure('mux (public →ts)', publicMuxOut.byteLength, info.durationSec, async () => {
        const fresh = await publicMuxMp4ToTs(id, bytes);
        return fresh.byteLength % 251;
      }),
    );
    out.push({
      id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: info.durationSec,
      ops,
    });
  }
  return out;
}

async function muxOggSource(id: string, bytes: Uint8Array): Promise<Uint8Array> {
  const demuxed = await OggDriver.demux(source(id, bytes));
  try {
    const track = demuxed.tracks[0];
    if (track === undefined) throw new Error(`Ogg fixture ${id} has no audio track`);
    const packets = oggAudioPackets(bytes);
    const muxer = new OggMuxer();
    const trackId = muxer.addTrack(track);
    for (const packet of packets) {
      muxer.addChunkStruct(trackId, {
        timestampUs: packet.ptsUs,
        durationUs: packet.durationUs,
        key: true,
        data: bytes.slice(packet.offset, packet.offset + packet.size),
      });
    }
    await muxer.finalize();
    return streamBytes(muxer.output);
  } finally {
    await demuxed.close();
  }
}

async function muxFlacSource(bytes: Uint8Array): Promise<Uint8Array> {
  const info = parseFlac(bytes);
  const frames = enumerateFlacFrames(bytes);
  const muxer = new OggMuxer();
  const trackId = muxer.addTrack({
    id: 0,
    mediaType: 'audio',
    codec: 'flac',
    durationSec: info.durationSec,
    config: {
      codec: 'flac',
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      description: nativeFlacMetadata(bytes),
    },
  });
  for (const frame of frames) {
    muxer.addChunkStruct(trackId, {
      timestampUs: frame.ptsUs,
      durationUs: frame.durationUs,
      key: true,
      data: frame.data,
    });
  }
  await muxer.finalize();
  return streamBytes(muxer.output);
}

async function muxWebmVorbisSource(bytes: Uint8Array): Promise<Uint8Array> {
  const { info, framesByIndex } = demuxWebm(bytes);
  const trackIndex = info.tracks.findIndex((track) => track.codec === 'vorbis');
  const track = info.tracks[trackIndex];
  const frames = framesByIndex[trackIndex];
  if (track === undefined || frames === undefined) {
    throw new Error('WebM→Ogg benchmark needs a real Vorbis track');
  }
  const muxer = new OggMuxer();
  const trackId = muxer.addTrack({
    id: 0,
    mediaType: track.mediaType,
    codec: track.codec,
    durationSec: info.durationSec,
    config: {
      codec: track.codec,
      sampleRate: track.sampleRate ?? 0,
      numberOfChannels: track.channels ?? 0,
      ...(track.description !== undefined ? { description: track.description } : {}),
    },
  });
  for (const frame of frames) {
    muxer.addChunkStruct(trackId, {
      timestampUs: frame.timestampUs,
      durationUs: undefined,
      key: true,
      data: frame.data,
    });
  }
  await muxer.finalize();
  const out = await streamBytes(muxer.output);
  const parsed = parseOgg(out);
  if (parsed.codec !== 'vorbis' || Math.abs(parsed.durationSec - info.durationSec) > 1 / 44_100) {
    throw new Error('WebM→Ogg benchmark lost declared Vorbis duration');
  }
  return out;
}

async function muxToOgg(
  file: (typeof OGG_MUX_FILES)[number],
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (file.kind === 'ogg') return muxOggSource(file.id, bytes);
  if (file.kind === 'webm-vorbis') return muxWebmVorbisSource(bytes);
  return muxFlacSource(bytes);
}

async function benchOggMuxOps(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const file of OGG_MUX_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${file.id}`).arrayBuffer());
    const info = await probeInfo(file.id, bytes);
    const muxOut = await muxToOgg(file, bytes);
    const op = await measure('mux (→ogg)', muxOut.byteLength, info.durationSec, async () => {
      const fresh = await muxToOgg(file, bytes);
      return fresh.byteLength % 251;
    });
    out.push({
      id: file.id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: info.durationSec,
      ops: [op],
    });
  }
  return out;
}

function matrixBytes(cases: readonly CorruptCase[]): number {
  return cases.reduce((sum, item) => sum + item.bytes.byteLength, 0);
}

async function runRobustnessCases(
  file: RobustnessFile,
  cases: readonly CorruptCase[],
): Promise<number> {
  const results = await runMatrix(cases, file.parse);
  const failures = escapes(results);
  if (failures.length > 0) {
    const first = failures[0];
    throw new Error(
      `${file.id} fuzz robustness leaked ${first?.errorName ?? first?.outcome ?? 'unknown'} at ${first?.label ?? 'unknown case'}`,
    );
  }
  return results.length;
}

async function benchRobustnessOps(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const file of ROBUSTNESS_FILES) {
    const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer());
    const cases = corruptMatrix(bytes, { family: file.family, ...ROBUSTNESS_MATRIX_OPTIONS });
    const bytesParsed = matrixBytes(cases);
    const op = await measure('fuzz robustness', bytesParsed, 0, async () => {
      const count = await runRobustnessCases(file, cases);
      return count + (bytesParsed % 251);
    });
    out.push({
      id: file.id,
      container: file.container,
      sizeBytes: bytesParsed,
      durationSec: 0,
      ops: [op],
    });
  }
  return out;
}

// ============ reporting ============

/** `probe` is a bounded header read, not a whole-file scan — its honest throughput is probes/sec, not
 *  file-MB/s. Byte ops (demux/remux/trim/decrypt) genuinely process every reported byte → MB/s. */
function isProbe(op: string): boolean {
  return op === 'probe';
}

/** The throughput cell for an op: `probes/s` for probe (rate), else `MB/s` (true byte throughput). */
function throughputCell(o: OpResult): string {
  return isProbe(o.op) ? `${(1000 / o.wallMs).toFixed(0)} /s` : `${o.mbPerSec.toFixed(1)} MB/s`;
}

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${r.container}, ${(r.sizeBytes / 1024).toFixed(1)} KB, ${r.durationSec.toFixed(3)} s`,
  );
  console.info(
    `  ${'op'.padEnd(24)} ${'wall(ms)'.padStart(9)} ${'throughput'.padStart(12)} ${'×realtime'.padStart(11)} ${'peakMem(MB)'.padStart(12)}`,
  );
  for (const o of r.ops) {
    const rt = o.throughputRealtime > 0 ? `${o.throughputRealtime.toFixed(0)}×` : '—';
    console.info(
      `  ${o.op.padEnd(24)} ${o.wallMs.toFixed(3).padStart(9)} ${throughputCell(o).padStart(12)} ${rt.padStart(11)} ${o.peakMemoryMb.toFixed(2).padStart(12)}`,
    );
  }
}

/** Per-op aggregate across all files: median wall, geomean MB/s, worst (min) MB/s + peak memory. */
interface OpAggregate {
  op: string;
  files: number;
  medianWallMs: number;
  geomeanMbPerSec: number;
  minMbPerSec: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly FileResult[]): OpAggregate[] {
  const byOp = new Map<string, OpResult[]>();
  for (const r of results) {
    for (const o of r.ops) {
      const list = byOp.get(o.op) ?? [];
      list.push(o);
      byOp.set(o.op, list);
    }
  }
  const out: OpAggregate[] = [];
  for (const [op, list] of byOp) {
    const logSum = list.reduce((s, o) => s + Math.log(o.mbPerSec), 0);
    out.push({
      op,
      files: list.length,
      medianWallMs: median(list.map((o) => o.wallMs)),
      geomeanMbPerSec: Math.exp(logSum / list.length),
      minMbPerSec: list.reduce((m, o) => Math.min(m, o.mbPerSec), Number.POSITIVE_INFINITY),
      maxPeakMemoryMb: list.reduce((m, o) => Math.max(m, o.peakMemoryMb), 0),
    });
  }
  return out;
}

function printAggregates(aggs: readonly OpAggregate[]): void {
  console.info('\n=== per-op aggregate across all corpus files ===');
  console.info('(probe throughput is probes/sec — a bounded header read; byte ops are MB/s)');
  console.info(
    `  ${'op'.padEnd(24)} ${'files'.padStart(5)} ${'medWall(ms)'.padStart(12)} ${'geoThru'.padStart(12)} ${'worst'.padStart(11)} ${'maxMem(MB)'.padStart(11)}`,
  );
  for (const a of aggs) {
    const geo = isProbe(a.op)
      ? `${(1000 / a.medianWallMs).toFixed(0)} /s`
      : `${a.geomeanMbPerSec.toFixed(1)} MB/s`;
    const worst = isProbe(a.op) ? '—' : `${a.minMbPerSec.toFixed(1)} MB/s`;
    console.info(
      `  ${a.op.padEnd(24)} ${String(a.files).padStart(5)} ${a.medianWallMs.toFixed(3).padStart(12)} ${geo.padStart(12)} ${worst.padStart(11)} ${a.maxPeakMemoryMb.toFixed(2).padStart(11)}`,
    );
  }
}

// ============ baseline record ============

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  files: FileResult[];
  aggregates: OpAggregate[];
}

function buildBaseline(files: FileResult[], aggregates: OpAggregate[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    files,
    aggregates,
  };
}

/** Compare fresh aggregates against the committed baseline; return the regressed op labels (if any). */
function regressions(fresh: readonly OpAggregate[], base: Baseline): string[] {
  const baseByOp = new Map(base.aggregates.map((a) => [a.op, a]));
  const regressed: string[] = [];
  for (const a of fresh) {
    const b = baseByOp.get(a.op);
    if (b === undefined) continue;
    if (a.geomeanMbPerSec < b.geomeanMbPerSec * (1 - REGRESSION_TOLERANCE)) {
      regressed.push(
        `${a.op}: ${a.geomeanMbPerSec.toFixed(1)} MB/s vs baseline ${b.geomeanMbPerSec.toFixed(1)} MB/s`,
      );
    }
  }
  return regressed;
}

// ============ main ============

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  if (
    PROBE_FILES.length < 5 ||
    MP4_FILES.length < 5 ||
    MP4_TO_TS_FILES.length < 5 ||
    TS_FILES.length < 2 ||
    HLS_SAMPLE_AES_FILES.length < 5 ||
    OGG_MUX_FILES.length < 5 ||
    ROBUSTNESS_FILES.length < 5
  ) {
    throw new Error(
      `container benchmark needs real multi-file corpora (BUILD_INSTRUCTIONS §6.1); have probe=${PROBE_FILES.length}, mp4=${MP4_FILES.length}, mp4ToTs=${MP4_TO_TS_FILES.length}, ts=${TS_FILES.length}, hlsSampleAes=${HLS_SAMPLE_AES_FILES.length}, oggMux=${OGG_MUX_FILES.length}, robustness=${ROBUSTNESS_FILES.length}.`,
    );
  }
  console.info(
    `container/parse benchmark — pure TS, single-thread, median of ${ITERS} iters (warmup ${WARMUP}); probe×${PROBE_FILES.length} files, MP4 demux/remux/remux-to-mkv/trim/CENC-decrypt×${MP4_FILES.length} files, MP4-to-TS remux×${MP4_TO_TS_FILES.length} files, remux/trim×${TS_FILES.length} TS files, HLS SAMPLE-AES decrypt×${HLS_SAMPLE_AES_FILES.length} TS files, Ogg mux×${OGG_MUX_FILES.length} audio files, fuzz robustness×${ROBUSTNESS_FILES.length} files:`,
  );

  const probeResults = await benchProbe();
  const mp4Results = await benchMp4Ops();
  const mp4ToTsResults = await benchMp4ToTsOps();
  const mpegTsResults = await benchMpegTsOps();
  const hlsSampleAesResults = await benchHlsSampleAesOps();
  const oggMuxResults = await benchOggMuxOps();
  const robustnessResults = await benchRobustnessOps();
  for (const r of probeResults) printFile(r);
  for (const r of mp4Results) printFile(r);
  for (const r of mp4ToTsResults) printFile(r);
  for (const r of mpegTsResults) printFile(r);
  for (const r of hlsSampleAesResults) printFile(r);
  for (const r of oggMuxResults) printFile(r);
  for (const r of robustnessResults) printFile(r);

  const allResults = [
    ...probeResults,
    ...mp4Results,
    ...mp4ToTsResults,
    ...mpegTsResults,
    ...hlsSampleAesResults,
    ...oggMuxResults,
    ...robustnessResults,
  ];
  const aggs = aggregate(allResults);
  printAggregates(aggs);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(aggs, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const r of regressed) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(buildBaseline(allResults, aggs), null, 2)}\n`);
  console.info(`\nbaseline written → ${BASELINE_PATH}`);
}

await main();
