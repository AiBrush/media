import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';

const AVIF_HASINDEX = 0x00000010;
const AVIIF_KEYFRAME = 0x00000010;
const DEFAULT_VIDEO_FPS = 30;
const DEFAULT_OPEN_DML_SEGMENT_BYTES = 1024 * 1024 * 1024;
const MAX_RIFF_PAYLOAD_SIZE = 0xfffffff0;

type AviMediaType = 'video' | 'audio';

export interface AviMuxOptions extends MuxOptions {
  /** Test hook / advanced knob: split `movi` payloads once a segment reaches this many bytes. */
  readonly openDmlSegmentBytes?: number;
}

export interface AviChunkStruct {
  readonly data: Uint8Array;
  readonly keyframe?: boolean;
  readonly durationUs?: number;
}

interface VideoFormat {
  readonly fourcc: string;
  readonly width: number;
  readonly height: number;
  readonly suffix: 'dc' | 'db';
}

interface AudioFormat {
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
  readonly avgBytesPerSec: number;
  readonly sampleSize: number;
}

interface AviMuxTrack {
  readonly id: number;
  readonly mediaType: AviMediaType;
  readonly codec: string;
  readonly source: TrackInfo;
  readonly video?: VideoFormat;
  readonly audio?: AudioFormat;
  readonly chunks: AviStoredChunk[];
  totalBytes: number;
  maxChunkBytes: number;
}

interface AviStoredChunk {
  readonly trackId: number;
  readonly data: Uint8Array;
  readonly keyframe: boolean;
  readonly durationUs?: number;
}

interface StreamTiming {
  readonly scale: number;
  readonly rate: number;
  readonly length: number;
  readonly sampleSize: number;
  readonly suggestedBufferSize: number;
}

interface StreamHeaderPlan {
  readonly track: AviMuxTrack;
  readonly timing: StreamTiming;
}

interface MoviSegment {
  readonly chunks: AviStoredChunk[];
}

interface MoviWrite {
  readonly bytes: Uint8Array;
  readonly indexEntries: Idx1Entry[];
}

interface Idx1Entry {
  readonly chunkId: string;
  readonly flags: number;
  readonly offset: number;
  readonly size: number;
}

interface EncodedChunkMeta {
  readonly type?: unknown;
  readonly duration?: unknown;
}

function copyChunkBytes(packet: Packet): Uint8Array {
  const data = new Uint8Array(packet.chunk.byteLength);
  packet.chunk.copyTo(data);
  return data;
}

function packetKeyframe(packet: Packet, mediaType: AviMediaType): boolean {
  if (mediaType === 'audio') return true;
  return (packet.chunk as EncodedChunkMeta).type !== 'delta';
}

function packetDurationUs(packet: Packet): number | undefined {
  const duration = (packet.chunk as EncodedChunkMeta).duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : undefined;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function writeFourCC(view: DataView, offset: number, tag: string): void {
  if (tag.length !== 4) throw new MediaError('mux-error', `AVI FourCC '${tag}' is not 4 bytes`);
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i) & 0xff);
}

function checkedU32(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new MediaError('mux-error', `AVI ${label} does not fit in uint32`);
  }
  return Math.floor(value);
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function riffChunk(id: string, body: Uint8Array): Uint8Array {
  checkedU32(body.byteLength, `${id} chunk size`);
  const pad = body.byteLength & 1;
  const out = new Uint8Array(8 + body.byteLength + pad);
  const dv = new DataView(out.buffer);
  writeFourCC(dv, 0, id);
  dv.setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

function listChunk(type: string, children: readonly Uint8Array[]): Uint8Array {
  return riffChunk('LIST', concatParts([asciiBytes(type), ...children]));
}

function riffFile(type: 'AVI ' | 'AVIX', children: readonly Uint8Array[]): Uint8Array {
  const body = concatParts([asciiBytes(type), ...children]);
  checkedU32(body.byteLength, `${type.trim()} RIFF size`);
  const out = new Uint8Array(8 + body.byteLength);
  const dv = new DataView(out.buffer);
  writeFourCC(dv, 0, 'RIFF');
  dv.setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

function normalizeCodec(codec: string): string {
  return codec.toLowerCase();
}

function videoFourCC(codec: string): string | undefined {
  const c = normalizeCodec(codec);
  if (c === 'mjpeg' || c === 'jpeg') return 'MJPG';
  if (c === 'mpeg4' || c === 'xvid' || c === 'divx' || c === 'mp4v') return 'XVID';
  if (c === 'h264' || c.startsWith('avc1') || c.startsWith('avc3')) return 'H264';
  if (c === 'hevc' || c.startsWith('hvc1') || c.startsWith('hev1')) return 'HEVC';
  if (c === 'vp8' || c === 'vp80') return 'VP80';
  if (c === 'vp9' || c === 'vp90') return 'VP90';
  if (c === 'av1' || c.startsWith('av01')) return 'AV01';
  if (c === 'rawvideo' || c === 'dib ') return 'DIB ';
  return /^[a-z0-9 ]{4}$/.test(c) ? c.toUpperCase() : undefined;
}

function videoConfig(info: TrackInfo): VideoFormat | undefined {
  const config = info.config;
  if (config === undefined || !('codedWidth' in config) || !('codedHeight' in config)) {
    return undefined;
  }
  const width = config.codedWidth;
  const height = config.codedHeight;
  const fourcc = videoFourCC(info.codec);
  if (
    fourcc === undefined ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { fourcc, width, height, suffix: fourcc === 'DIB ' ? 'db' : 'dc' };
}

function audioConfig(info: TrackInfo): { sampleRate: number; channels: number } | undefined {
  const config = info.config;
  if (
    config !== undefined &&
    'sampleRate' in config &&
    'numberOfChannels' in config &&
    typeof config.sampleRate === 'number' &&
    typeof config.numberOfChannels === 'number' &&
    Number.isFinite(config.sampleRate) &&
    Number.isInteger(config.numberOfChannels) &&
    config.sampleRate > 0 &&
    config.numberOfChannels > 0
  ) {
    return { sampleRate: config.sampleRate, channels: config.numberOfChannels };
  }
  return undefined;
}

function pcmBits(codec: string): number | undefined {
  switch (normalizeCodec(codec)) {
    case 'pcm':
    case 'pcm-s16':
      return 16;
    case 'pcm-u8':
      return 8;
    case 'pcm-s24':
      return 24;
    case 'pcm-s32':
      return 32;
    case 'pcm-f32':
      return 32;
    case 'pcm-f64':
      return 64;
    default:
      return undefined;
  }
}

function audioFormat(info: TrackInfo): AudioFormat | undefined {
  const config = audioConfig(info);
  if (config === undefined) return undefined;
  const c = normalizeCodec(info.codec);
  const pcm = pcmBits(c);
  if (pcm !== undefined) {
    if (c === 'pcm-f64') {
      throw new CapabilityError('capability-miss', 'AVI muxing does not author 64-bit float PCM', {
        op: { op: 'mux', codec: info.codec },
        tried: ['avi'],
      });
    }
    const blockAlign = config.channels * (pcm >> 3);
    return {
      formatTag: c === 'pcm-f32' ? 0x0003 : 0x0001,
      channels: config.channels,
      sampleRate: config.sampleRate,
      bitsPerSample: pcm,
      blockAlign,
      avgBytesPerSec: config.sampleRate * blockAlign,
      sampleSize: blockAlign,
    };
  }
  if (c === 'mp3' || c === 'mp4a.6b' || c === 'mp4a.69') {
    return compressedAudioFormat(0x0055, config);
  }
  if (c === 'aac' || c === 'mp4a.40.2') {
    return compressedAudioFormat(0x00ff, config);
  }
  if (c === 'ac-3' || c === 'ac3') {
    return compressedAudioFormat(0x2000, config);
  }
  return undefined;
}

function compressedAudioFormat(
  formatTag: number,
  config: { readonly sampleRate: number; readonly channels: number },
): AudioFormat {
  return {
    formatTag,
    channels: config.channels,
    sampleRate: config.sampleRate,
    bitsPerSample: 0,
    blockAlign: 1,
    avgBytesPerSec: 0,
    sampleSize: 0,
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x || 1;
}

function reduce(scale: number, rate: number): { scale: number; rate: number } {
  const g = gcd(scale, rate);
  return {
    scale: checkedU32(scale / g, 'stream scale'),
    rate: checkedU32(rate / g, 'stream rate'),
  };
}

function videoTiming(track: AviMuxTrack): StreamTiming {
  const config = track.source.config;
  const configFps =
    config !== undefined && 'framerate' in config && typeof config.framerate === 'number'
      ? config.framerate
      : undefined;
  const fps =
    track.source.fps && track.source.fps > 0
      ? track.source.fps
      : configFps && configFps > 0
        ? configFps
        : track.source.durationSec && track.source.durationSec > 0 && track.chunks.length > 0
          ? track.chunks.length / track.source.durationSec
          : DEFAULT_VIDEO_FPS;
  const timing = Number.isInteger(fps)
    ? { scale: 1, rate: fps }
    : reduce(Math.max(1, Math.round(1_000_000 / fps)), 1_000_000);
  return {
    ...timing,
    length: track.chunks.length,
    sampleSize: 0,
    suggestedBufferSize: track.maxChunkBytes,
  };
}

function compressedAudioTiming(track: AviMuxTrack): StreamTiming {
  const sampleRate = track.audio?.sampleRate ?? 48_000;
  const durationFromPackets = track.chunks.reduce((sum, chunk) => sum + (chunk.durationUs ?? 0), 0);
  const durationSec =
    durationFromPackets > 0
      ? durationFromPackets / 1_000_000
      : track.source.durationSec && track.source.durationSec > 0
        ? track.source.durationSec
        : track.codec === 'mp3'
          ? (track.chunks.length * (sampleRate <= 24_000 ? 576 : 1152)) / sampleRate
          : track.chunks.length / sampleRate;
  const periodUs =
    track.chunks.length > 0
      ? Math.max(1, Math.round((durationSec * 1_000_000) / track.chunks.length))
      : 1;
  const timing = reduce(periodUs, 1_000_000);
  return {
    ...timing,
    length: track.chunks.length,
    sampleSize: 0,
    suggestedBufferSize: track.maxChunkBytes,
  };
}

function audioTiming(track: AviMuxTrack): StreamTiming {
  const audio = track.audio;
  if (audio === undefined)
    throw new MediaError('mux-error', 'AVI audio track missing format metadata');
  if (audio.sampleSize > 0) {
    if (track.totalBytes % audio.blockAlign !== 0) {
      throw new MediaError('mux-error', 'AVI PCM audio bytes are not block-aligned');
    }
    return {
      scale: 1,
      rate: audio.sampleRate,
      length: track.totalBytes / audio.blockAlign,
      sampleSize: audio.sampleSize,
      suggestedBufferSize: track.maxChunkBytes,
    };
  }
  return compressedAudioTiming(track);
}

function streamTiming(track: AviMuxTrack): StreamTiming {
  return track.mediaType === 'video' ? videoTiming(track) : audioTiming(track);
}

function streamChunkId(track: AviMuxTrack): string {
  const prefix = track.id.toString().padStart(2, '0');
  if (track.mediaType === 'audio') return `${prefix}wb`;
  return `${prefix}${track.video?.suffix ?? 'dc'}`;
}

function buildAvih(plans: readonly StreamHeaderPlan[], totalPayloadBytes: number): Uint8Array {
  const firstVideo = plans.find((plan) => plan.track.mediaType === 'video');
  const width = firstVideo?.track.video?.width ?? 0;
  const height = firstVideo?.track.video?.height ?? 0;
  const fps =
    firstVideo !== undefined && firstVideo.timing.scale > 0
      ? firstVideo.timing.rate / firstVideo.timing.scale
      : 0;
  const durationSec =
    firstVideo !== undefined && fps > 0 ? firstVideo.timing.length / fps : maxTrackDuration(plans);
  const out = new Uint8Array(56);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, fps > 0 ? Math.round(1_000_000 / fps) : 0, true);
  dv.setUint32(
    4,
    durationSec > 0 ? checkedU32(Math.ceil(totalPayloadBytes / durationSec), 'max bytes/sec') : 0,
    true,
  );
  dv.setUint32(8, 0, true);
  dv.setUint32(12, AVIF_HASINDEX, true);
  dv.setUint32(16, checkedU32(firstVideo?.timing.length ?? 0, 'total frames'), true);
  dv.setUint32(20, 0, true);
  dv.setUint32(24, plans.length, true);
  dv.setUint32(28, maxSuggestedBuffer(plans), true);
  dv.setUint32(32, width, true);
  dv.setUint32(36, height, true);
  return riffChunk('avih', out);
}

function maxTrackDuration(plans: readonly StreamHeaderPlan[]): number {
  let out = 0;
  for (const plan of plans) {
    const duration =
      plan.timing.rate > 0 ? (plan.timing.length * plan.timing.scale) / plan.timing.rate : 0;
    out = Math.max(out, duration);
  }
  return out;
}

function maxSuggestedBuffer(plans: readonly StreamHeaderPlan[]): number {
  let out = 0;
  for (const plan of plans) out = Math.max(out, plan.timing.suggestedBufferSize);
  return out;
}

function buildStrh(plan: StreamHeaderPlan): Uint8Array {
  const out = new Uint8Array(56);
  const dv = new DataView(out.buffer);
  const { track, timing } = plan;
  writeFourCC(dv, 0, track.mediaType === 'video' ? 'vids' : 'auds');
  writeFourCC(dv, 4, track.mediaType === 'video' ? (track.video?.fourcc ?? 'DIB ') : '\0\0\0\0');
  dv.setUint32(8, 0, true);
  dv.setUint16(12, 0, true);
  dv.setUint16(14, 0, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, timing.scale, true);
  dv.setUint32(24, timing.rate, true);
  dv.setUint32(28, 0, true);
  dv.setUint32(32, checkedU32(timing.length, 'stream length'), true);
  dv.setUint32(36, timing.suggestedBufferSize, true);
  dv.setUint32(40, 0xffffffff, true);
  dv.setUint32(44, timing.sampleSize, true);
  if (track.video !== undefined) {
    dv.setInt16(48, 0, true);
    dv.setInt16(50, 0, true);
    dv.setInt16(52, Math.min(track.video.width, 0x7fff), true);
    dv.setInt16(54, Math.min(track.video.height, 0x7fff), true);
  }
  return riffChunk('strh', out);
}

function buildVideoStrf(track: AviMuxTrack): Uint8Array {
  const video = track.video;
  if (video === undefined)
    throw new MediaError('mux-error', 'AVI video track missing format metadata');
  const out = new Uint8Array(40);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, video.width, true);
  dv.setInt32(8, video.height, true);
  dv.setUint16(12, 1, true);
  dv.setUint16(14, video.fourcc === 'DIB ' ? 24 : 0, true);
  writeFourCC(dv, 16, video.fourcc);
  dv.setUint32(20, track.maxChunkBytes, true);
  return riffChunk('strf', out);
}

function buildAudioStrf(track: AviMuxTrack): Uint8Array {
  const audio = track.audio;
  if (audio === undefined)
    throw new MediaError('mux-error', 'AVI audio track missing format metadata');
  const needsCbSize = audio.sampleSize === 0;
  const out = new Uint8Array(needsCbSize ? 18 : 16);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, audio.formatTag, true);
  dv.setUint16(2, audio.channels, true);
  dv.setUint32(4, audio.sampleRate, true);
  dv.setUint32(8, checkedU32(audio.avgBytesPerSec, 'audio average bytes/sec'), true);
  dv.setUint16(12, audio.blockAlign, true);
  dv.setUint16(14, audio.bitsPerSample, true);
  if (needsCbSize) dv.setUint16(16, 0, true);
  return riffChunk('strf', out);
}

function buildStrl(plan: StreamHeaderPlan): Uint8Array {
  return listChunk('strl', [
    buildStrh(plan),
    plan.track.mediaType === 'video' ? buildVideoStrf(plan.track) : buildAudioStrf(plan.track),
  ]);
}

function buildDmlh(totalFrames: number): Uint8Array {
  const body = new Uint8Array(248);
  new DataView(body.buffer).setUint32(0, checkedU32(totalFrames, 'OpenDML frame count'), true);
  return listChunk('odml', [riffChunk('dmlh', body)]);
}

function buildHdrl(plans: readonly StreamHeaderPlan[], totalPayloadBytes: number): Uint8Array {
  const totalFrames =
    plans.find((plan) => plan.track.mediaType === 'video')?.timing.length ??
    Math.max(0, ...plans.map((plan) => plan.timing.length));
  return listChunk('hdrl', [
    buildAvih(plans, totalPayloadBytes),
    ...plans.map((plan) => buildStrl(plan)),
    buildDmlh(totalFrames),
  ]);
}

function chunkWireBytes(sample: AviStoredChunk): number {
  return 8 + sample.data.byteLength + (sample.data.byteLength & 1);
}

function splitSegments(samples: readonly AviStoredChunk[], limit: number): MoviSegment[] {
  const segments: MoviSegment[] = [];
  let current: AviStoredChunk[] = [];
  let currentBytes = 4; // the `movi` list type is part of the LIST body.
  for (const sample of samples) {
    const bytes = chunkWireBytes(sample);
    if (bytes > limit) {
      throw new CapabilityError('capability-miss', 'AVI packet exceeds one RIFF segment', {
        op: { op: 'mux', bytes },
        tried: ['avi'],
      });
    }
    if (current.length > 0 && currentBytes + bytes > limit) {
      segments.push({ chunks: current });
      current = [];
      currentBytes = 4;
    }
    current.push(sample);
    currentBytes += bytes;
  }
  if (current.length > 0) segments.push({ chunks: current });
  return segments;
}

function buildMovi(segment: MoviSegment, trackById: ReadonlyMap<number, AviMuxTrack>): MoviWrite {
  const parts: Uint8Array[] = [asciiBytes('movi')];
  const indexEntries: Idx1Entry[] = [];
  let offsetFromMoviType = 4;
  for (const sample of segment.chunks) {
    const track = trackById.get(sample.trackId);
    if (track === undefined)
      throw new MediaError('mux-error', `missing AVI track ${sample.trackId}`);
    const chunkId = streamChunkId(track);
    indexEntries.push({
      chunkId,
      flags: sample.keyframe ? AVIIF_KEYFRAME : 0,
      offset: offsetFromMoviType,
      size: sample.data.byteLength,
    });
    const chunk = riffChunk(chunkId, sample.data);
    parts.push(chunk);
    offsetFromMoviType += chunk.byteLength;
  }
  return { bytes: riffChunk('LIST', concatParts(parts)), indexEntries };
}

function buildIdx1(entries: readonly Idx1Entry[]): Uint8Array {
  const out = new Uint8Array(entries.length * 16);
  const dv = new DataView(out.buffer);
  for (const [i, entry] of entries.entries()) {
    const offset = i * 16;
    writeFourCC(dv, offset, entry.chunkId);
    dv.setUint32(offset + 4, entry.flags, true);
    dv.setUint32(offset + 8, checkedU32(entry.offset, 'idx1 offset'), true);
    dv.setUint32(offset + 12, checkedU32(entry.size, 'idx1 size'), true);
  }
  return riffChunk('idx1', out);
}

function segmentLimit(options: AviMuxOptions | undefined): number {
  const raw = options?.openDmlSegmentBytes;
  if (raw === undefined) return DEFAULT_OPEN_DML_SEGMENT_BYTES;
  if (!Number.isFinite(raw) || raw < 16 || raw > MAX_RIFF_PAYLOAD_SIZE) {
    throw new MediaError('mux-error', 'invalid AVI OpenDML segment byte limit');
  }
  return Math.floor(raw);
}

export function writeAviFromTracks(
  tracks: readonly AviMuxTrack[],
  samples: readonly AviStoredChunk[],
  options?: AviMuxOptions,
): Uint8Array {
  if (tracks.length === 0)
    throw new MediaError('mux-error', 'cannot finalize an AVI muxer with no tracks');
  if (samples.length === 0)
    throw new MediaError('mux-error', 'cannot finalize an AVI muxer with no packets');
  const plans = tracks.map((track) => ({ track, timing: streamTiming(track) }));
  const totalPayloadBytes = samples.reduce((sum, sample) => sum + sample.data.byteLength, 0);
  const hdrl = buildHdrl(plans, totalPayloadBytes);
  const segments = splitSegments(samples, segmentLimit(options));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const first = segments[0];
  if (first === undefined) throw new MediaError('mux-error', 'AVI muxer has no movi segment');
  const firstMovi = buildMovi(first, trackById);
  const main = riffFile('AVI ', [hdrl, firstMovi.bytes, buildIdx1(firstMovi.indexEntries)]);
  const tail = segments
    .slice(1)
    .map((segment) => riffFile('AVIX', [buildMovi(segment, trackById).bytes]));
  return concatParts([main, ...tail]);
}

/** Single-shot AVI muxer over the contract packet seam. */
export class AviMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #options: AviMuxOptions | undefined;
  readonly #tracks: AviMuxTrack[] = [];
  readonly #samples: AviStoredChunk[] = [];
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: AviMuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError(
        'capability-miss',
        'AVI muxing does not support fragmented output',
        {
          op: { op: 'mux', fragmented: true },
          tried: ['avi'],
        },
      );
    }
    this.#options = options;
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
    if (this.#tracks.length >= 100) {
      throw new CapabilityError('capability-miss', 'AVI muxing supports at most 100 streams', {
        op: { op: 'mux', tracks: this.#tracks.length + 1 },
        tried: ['avi'],
      });
    }
    if (info.mediaType === 'video') {
      const video = videoConfig(info);
      if (video === undefined) {
        throw new CapabilityError('capability-miss', `AVI cannot mux video codec '${info.codec}'`, {
          op: { op: 'mux', codec: info.codec },
          tried: ['avi'],
        });
      }
      return this.#addTrack({
        id: this.#tracks.length,
        mediaType: 'video',
        codec: info.codec,
        source: info,
        video,
        chunks: [],
        totalBytes: 0,
        maxChunkBytes: 0,
      });
    }
    if (info.mediaType === 'audio') {
      const audio = audioFormat(info);
      if (audio === undefined) {
        throw new CapabilityError('capability-miss', `AVI cannot mux audio codec '${info.codec}'`, {
          op: { op: 'mux', codec: info.codec },
          tried: ['avi'],
        });
      }
      return this.#addTrack({
        id: this.#tracks.length,
        mediaType: 'audio',
        codec: info.codec,
        source: info,
        audio,
        chunks: [],
        totalBytes: 0,
        maxChunkBytes: 0,
      });
    }
    throw new CapabilityError('capability-miss', `AVI cannot mux media type '${info.mediaType}'`, {
      op: { op: 'mux', mediaType: info.mediaType },
      tried: ['avi'],
    });
  }

  #addTrack(track: AviMuxTrack): number {
    this.#tracks.push(track);
    return track.id;
  }

  write(trackId: number, packet: Packet): Promise<void> {
    const track = this.#track(trackId);
    const durationUs = packetDurationUs(packet);
    this.addChunkStruct(trackId, {
      data: copyChunkBytes(packet),
      keyframe: packetKeyframe(packet, track.mediaType),
      ...(durationUs !== undefined ? { durationUs } : {}),
    });
    return Promise.resolve();
  }

  addChunkStruct(trackId: number, chunk: AviChunkStruct): void {
    this.#assertOpen();
    const track = this.#track(trackId);
    if (track.audio?.sampleSize && chunk.data.byteLength % track.audio.sampleSize !== 0) {
      throw new MediaError('mux-error', 'AVI PCM packet is not block-aligned');
    }
    const stored: AviStoredChunk = {
      trackId,
      data: chunk.data.slice(),
      keyframe: track.mediaType === 'audio' ? true : chunk.keyframe !== false,
      ...(chunk.durationUs !== undefined ? { durationUs: chunk.durationUs } : {}),
    };
    track.chunks.push(stored);
    track.totalBytes += stored.data.byteLength;
    track.maxChunkBytes = Math.max(track.maxChunkBytes, stored.data.byteLength);
    this.#samples.push(stored);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready;
    const controller = this.#controller;
    if (controller === undefined)
      throw new MediaError('mux-error', 'AVI output stream is not ready');
    try {
      const out = writeAviFromTracks(this.#tracks, this.#samples, this.#options);
      controller.enqueue(out);
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  #track(trackId: number): AviMuxTrack {
    const track = this.#tracks[trackId];
    if (track === undefined) throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    return track;
  }

  #assertOpen(): void {
    if (this.#finalized) throw new MediaError('mux-error', 'muxer already finalized');
  }
}
