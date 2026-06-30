/**
 * The MPEG-TS (ISO/IEC 13818-1) container driver — hand-written TS on top of {@link parseTs} (ADR-002:
 * containers are ours; pure parsing in any environment). `probe` returns the program's elementary tracks
 * (codec + dims/sample params + PES-span duration); `demux` reassembles each PID's access units and emits
 * them as WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` in decode order, browser-gated exactly
 * like {@link import('../mp4/mp4-driver.ts')} `packetStream` (the `Encoded*Chunk` constructors only exist
 * in a browser/worker). `streamCopy` remuxes/trims the parsed H.264/AAC access units directly through the
 * TS writer, so same-container remux stays pure TS and preserves PES PTS/DTS while trim emits a clip-local
 * timeline. A transport stream has no front index, so the whole (bounded) segment is read.
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
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { type TsAccessUnit, type TsParse, type TsTrack, parseTs } from './ts-parse.ts';
import { MpegTsMuxer } from './ts-write.ts';

const TS_MIMES = new Set([
  'video/mp2t',
  'video/MP2T',
  'video/mpeg',
  'application/x-mpegts',
  'audio/mp2t',
]);
const TS_EXTENSIONS = new Set(['ts', 'm2ts', 'mts', 'm2t']);
const MICROSECONDS_PER_SECOND = 1_000_000;

interface NormalizedTrimRange {
  readonly startUs: number;
  readonly endUs: number;
}

interface SelectedTrack {
  readonly track: TsTrack;
  readonly units: readonly TsAccessUnit[];
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

/** Read the entire source into one buffer (a TS has no header/index — duration needs the full PES span). */
async function readAll(src: ByteSource, signal: AbortSignal | undefined): Promise<Uint8Array> {
  assertNotAborted(signal);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    assertNotAborted(signal);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    assertNotAborted(signal);
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
  assertNotAborted(signal);
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

function capabilityDetail(extra: Record<string, unknown>): Record<string, unknown> {
  return { op: 'stream-copy:mpegts', tried: ['mpegts'], ...extra };
}

function assertStreamCopyOptions(options: StreamCopyOptions | undefined): void {
  const target = options?.container?.toLowerCase();
  if (target !== undefined && !TS_EXTENSIONS.has(target)) {
    throw new CapabilityError(
      'capability-miss',
      `MPEG-TS stream-copy cannot write '${options?.container}' output.`,
      capabilityDetail({ container: options?.container }),
    );
  }
  if (options?.fragmented === true) {
    throw new CapabilityError(
      'capability-miss',
      'MPEG-TS stream-copy does not support fragmented output.',
      capabilityDetail({ container: target ?? 'ts', fragmented: true }),
    );
  }
}

function normalizeTrimRange(trim: StreamCopyOptions['trim']): NormalizedTrimRange | undefined {
  if (trim === undefined) return undefined;
  const { startSec, endSec } = trim;
  const range = `[${startSec}s, ${endSec}s]`;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('unsupported-input', `trim range ${range} is not a finite interval`);
  }
  if (startSec < 0) {
    throw new InputError('unsupported-input', `trim start ${startSec}s is negative`);
  }
  if (endSec <= startSec) {
    throw new InputError(
      'unsupported-input',
      `trim range ${range} is empty or inverted (end must be greater than start)`,
    );
  }
  return {
    startUs: Math.round(startSec * MICROSECONDS_PER_SECOND),
    endUs: Math.round(endSec * MICROSECONDS_PER_SECOND),
  };
}

function firstPresentationUs(parsed: TsParse): number {
  let first = Number.POSITIVE_INFINITY;
  for (const track of parsed.tracks) {
    for (const unit of track.units) {
      first = Math.min(first, unit.ptsUs);
    }
  }
  if (!Number.isFinite(first)) {
    throw new MediaError(
      'demux-error',
      'MPEG-TS stream-copy requires at least one timed access unit.',
    );
  }
  return first;
}

function estimateDurationUs(units: readonly TsAccessUnit[], index: number): number {
  const current = units[index];
  if (current === undefined) return 0;
  const next = units[index + 1];
  if (next !== undefined && next.ptsUs > current.ptsUs) return next.ptsUs - current.ptsUs;
  const previous = units[index - 1];
  if (previous !== undefined && current.ptsUs > previous.ptsUs) {
    return current.ptsUs - previous.ptsUs;
  }
  return 0;
}

function selectTrimmedUnits(
  track: TsTrack,
  trim: NormalizedTrimRange | undefined,
  originUs: number,
): readonly TsAccessUnit[] {
  const units = track.units;
  if (trim === undefined || units.length === 0) return units;

  let startIndex = 0;
  if (track.stream.mediaType === 'video') {
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      if (unit?.keyframe === true && unit.ptsUs - originUs <= trim.startUs) {
        startIndex = index;
      }
    }
  } else {
    const found = units.findIndex(
      (unit, index) => unit.ptsUs - originUs + estimateDurationUs(units, index) > trim.startUs,
    );
    if (found < 0) return [];
    startIndex = found;
  }

  let endExclusive = units.length;
  for (let index = startIndex; index < units.length; index += 1) {
    const unit = units[index];
    if (
      unit !== undefined &&
      unit.ptsUs - originUs + estimateDurationUs(units, index) > trim.endUs
    ) {
      endExclusive = index;
      break;
    }
  }
  if (endExclusive <= startIndex && units[startIndex] !== undefined) {
    endExclusive = startIndex + 1;
  }
  return units.slice(startIndex, endExclusive);
}

function selectedTracks(parsed: TsParse, trim: NormalizedTrimRange | undefined): SelectedTrack[] {
  const originUs = trim === undefined ? 0 : firstPresentationUs(parsed);
  return parsed.tracks.map((track) => ({
    track,
    units: selectTrimmedUnits(track, trim, originUs),
  }));
}

function selectedTimestampBaseUs(selections: readonly SelectedTrack[]): number {
  let timestampBaseUs = Number.POSITIVE_INFINITY;
  for (const selection of selections) {
    for (const unit of selection.units) {
      timestampBaseUs = Math.min(timestampBaseUs, unit.ptsUs, unit.dtsUs);
    }
  }
  if (!Number.isFinite(timestampBaseUs)) {
    throw new MediaError('mux-error', 'MPEG-TS stream-copy selected no timed access units.');
  }
  return timestampBaseUs;
}

async function streamCopyParsed(
  parsed: TsParse,
  options: StreamCopyOptions | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const muxer = new MpegTsMuxer();
  const trim = normalizeTrimRange(options?.trim);
  const selections = selectedTracks(parsed, trim);
  const selectedUnitCount = selections.reduce(
    (total, selection) => total + selection.units.length,
    0,
  );
  if (selectedUnitCount === 0) {
    throw new MediaError('mux-error', 'MPEG-TS stream-copy selected no access units.', {
      trim: options?.trim,
    });
  }
  const timestampBaseUs = trim === undefined ? 0 : selectedTimestampBaseUs(selections);

  const muxTrackIds = selections.map((selection, index) =>
    muxer.addTrack(toTrackInfo(selection.track, index)),
  );
  for (let trackIndex = 0; trackIndex < selections.length; trackIndex += 1) {
    assertNotAborted(options?.signal);
    const muxTrackId = muxTrackIds[trackIndex];
    const selection = selections[trackIndex];
    if (muxTrackId === undefined || selection === undefined) {
      throw new MediaError('mux-error', 'Internal MPEG-TS stream-copy track mismatch.', {
        trackIndex,
      });
    }
    for (const unit of selection.units) {
      assertNotAborted(options?.signal);
      muxer.addChunkStruct(muxTrackId, {
        data: unit.data,
        timestampUs: unit.ptsUs - timestampBaseUs,
        dtsUs: unit.dtsUs - timestampBaseUs,
        key: unit.keyframe,
      });
    }
  }
  await muxer.finalize();
  return muxer.output;
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
async function parse(src: ByteSource, signal: AbortSignal | undefined): Promise<TsParse> {
  return parseTs(await readAll(src, signal));
}

export const MpegTsDriver: ContainerDriver = {
  id: 'mpegts',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['ts', 'm2ts', 'mts'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const signal = o?.signal;
    const parsed = await parse(src, signal);
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
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    assertStreamCopyOptions(o);
    const parsed = await parse(src, o?.signal);
    assertNotAborted(o?.signal);
    return streamCopyParsed(parsed, o);
  },
  async decrypt(src: ByteSource, o): Promise<ReadableStream<Uint8Array>> {
    const { decryptMpegTsSampleAes } = await import('./mpegts-decrypt.ts');
    return decryptMpegTsSampleAes(src, o);
  },
  createMuxer(o?: MuxOptions): Muxer {
    return new MpegTsMuxer(o);
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
