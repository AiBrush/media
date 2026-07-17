/**
 * Per-op option/result projection helpers shared by the engine's op methods and the lazily-imported
 * runners (moved out of the `engine.ts` god-file, R-S05.1): mux-option projection, source geometry,
 * PCM-family token gates, probe-info materialization, and the intent-preserving input guards.
 */

import type {
  ContainerDriver,
  Determinism,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';
import type { MaterializeOptions, Sink } from '../sinks/sink.ts';
import { isLiveMediaSource } from '../sources/live-source.ts';
import { type MediaInput, type Source, from as normalizeInput } from '../sources/source.ts';
import type {
  CallOptions,
  ConvertOptions,
  EncodeOptions,
  MediaInfo,
  MediaInfoTrack,
  MuxSpec,
  Output,
  RemuxOptions,
} from './types.ts';

export const MICROS_PER_SECOND = 1_000_000;

/** Normalize a byte-capable input, refusing a raw live `MediaStream` with a typed capability miss. */
export function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op: { kind: 'route', id: op }, tried: ['media-stream/raw-frames'] },
  );
}

export async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  const { materialize } = await import('../sinks/materialize.ts');
  return materialize(sink, stream, opts);
}

export function forceSoftware(o: CallOptions): CallOptions {
  return {
    ...o,
    strategy: {
      ...o.strategy,
      determinism: 'force-software',
    },
  };
}

/** Re-expose a {@link StageOptions} as a {@link CallOptions.strategy} so a sub-route inherits determinism. */
export function stageStrategy(stage: StageOptions): { determinism: Determinism; pinDriver?: string } {
  return {
    determinism: stage.determinism ?? 'auto',
    ...(stage.pinDriver !== undefined ? { pinDriver: stage.pinDriver } : {}),
  };
}

export function isPinnedDriverMiss(
  error: CapabilityError,
  pinDriver: string | undefined,
): boolean {
  if (pinDriver === undefined || !error.message.startsWith('pinned ')) return false;
  const detail = error.detail;
  if (typeof detail !== 'object' || detail === null || !('tried' in detail)) return false;
  const tried = (detail as { readonly tried?: unknown }).tried;
  return Array.isArray(tried) && tried.length === 1 && tried[0] === pinDriver;
}

/** True for raw PCM codec tokens (`pcm`, `pcm-s16`, `pcm-s16be`, `pcm-f32`, …). */
export function isRawPcmTrack(track: TrackInfo): boolean {
  return track.codec === 'pcm' || track.codec.startsWith('pcm-');
}

/**
 * Project the optional public mux flags (`faststart`/`fragmented`) — present on `ConvertOptions`/
 * `MuxSpec`, absent on `EncodeOptions` — onto `MuxOptions`, copying only the ones actually set
 * (exactOptionalPropertyTypes). The parameter accepts each concrete option object so every caller fits
 * (a bare `{faststart?,fragmented?}` would be a weak type and reject `EncodeOptions`, which has neither).
 */
export function muxOptionsFrom(
  opts: ConvertOptions | MuxSpec | EncodeOptions | RemuxOptions,
  container?: string,
): {
  faststart?: boolean;
  fragmented?: boolean;
  container?: string;
} {
  const faststart = 'faststart' in opts ? opts.faststart : undefined;
  const fragmented = 'fragmented' in opts ? opts.fragmented : undefined;
  return {
    ...(faststart !== undefined ? { faststart } : {}),
    ...(fragmented !== undefined ? { fragmented } : {}),
    ...(container !== undefined ? { container } : {}),
  };
}

export function openRenditionOptions(opts: ConvertOptions): {
  readonly sink?: unknown;
  readonly [key: string]: unknown;
} {
  const { sink, ...rest } = opts;
  return sink === undefined ? { ...rest } : { ...rest, sink };
}

/** Source geometry (coded dims) for a video track, read from its WebCodecs decoder config. */
export function sourceGeometryOf(track: TrackInfo): {
  width: number | undefined;
  height: number | undefined;
  fps?: number;
  durationSec?: number;
  bitrate?: number;
} {
  const config = track.config;
  const fps = track.fps;
  const durationSec =
    track.durationSec !== undefined && Number.isFinite(track.durationSec) && track.durationSec > 0
      ? track.durationSec
      : undefined;
  if (config && 'codedWidth' in config) {
    return {
      width: config.codedWidth,
      height: config.codedHeight,
      ...(fps !== undefined ? { fps } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
    };
  }
  return {
    width: undefined,
    height: undefined,
    ...(fps !== undefined ? { fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
  };
}

/**
 * Source audio params (sample rate / channels) for an audio track, read from its decoder config. A
 * populated source track only reaches here on the live `convert` audio re-encode (browser); the
 * `undefined`-track path is exercised by the `encode` audio route (Node).
 */
export function audioGeometryOf(track: TrackInfo | undefined): {
  sampleRate: number | undefined;
  channels: number | undefined;
} {
  const config = track?.config;
  /* v8 ignore next 3 -- populated only via live convert (browser); Node encode passes no source track. */
  if (config && 'sampleRate' in config) {
    return { sampleRate: config.sampleRate, channels: config.numberOfChannels };
  }
  return { sampleRate: undefined, channels: undefined };
}

/**
 * PCM-family audio target — the codecs the WAV/`transformPcm` path produces (ADR-022). Accepts the
 * generic public `pcm` token AND the canonical sample-format variants a caller may pass
 * (`pcm-s16`/`pcm-s24`/`pcm-f32`/`pcm-s16be`/…), so a `convert(..., {to:'wav', audio:{codec:'pcm-s16'}})`
 * still routes through the audio-dsp PCM path instead of falling through to the (wav-less) codec seam.
 * `undefined` (no explicit audio codec) also means "keep PCM" for a wav target.
 */
export function isPcmCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'pcm' || codec.startsWith('pcm-');
}

/**
 * Audio codec tokens that select the lossless FLAC authoring path (ADR-024) for a `to:'flac'` convert:
 * no codec / the bare `flac` token (author FLAC at the source's native depth), or a `pcm-*` token (author
 * at that requested integer depth). A lossy token (e.g. `aac`/`opus`) is NOT FLAC and is left to the codec
 * seam (an honest miss in this build), so this gate never hijacks a real cross-codec request.
 */
export function isFlacAuthorCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'flac' || codec === 'pcm' || codec.startsWith('pcm-');
}

export function pcmSampleFormat(codec: string | undefined): SampleFormat | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  const normalized = codec.endsWith('be') ? codec.slice(0, -2) : codec;
  switch (normalized) {
    case 'pcm-u8':
      return 'u8';
    case 'pcm-s8':
      return 's8';
    case 'pcm-s16':
      return 's16';
    case 'pcm-s24':
      return 's24';
    case 'pcm-s32':
      return 's32';
    case 'pcm-f32':
      return 'f32';
    case 'pcm-f64':
      return 'f64';
    default:
      return undefined;
  }
}

export function pcmEndian(codec: string | undefined): Endianness | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  return codec.endsWith('be') ? 'be' : 'le';
}

export function toMediaInfo(
  container: ContainerDriver,
  tracks: readonly TrackInfo[],
  src: Source,
): MediaInfo {
  const infoTracks = tracks.map(toInfoTrack);
  const durationSec = infoTracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
  return {
    container: container.formats[0] ?? 'unknown',
    durationSec,
    ...(src.size !== undefined ? { sizeBytes: src.size } : {}),
    tracks: infoTracks,
  };
}

function toInfoTrack(t: TrackInfo): MediaInfoTrack {
  const base: MediaInfoTrack = {
    id: t.id,
    type: t.nonMedia ? 'other' : t.mediaType,
    codec: t.codec,
  };
  if (t.durationSec !== undefined) base.durationSec = t.durationSec;
  if (t.fps !== undefined) base.fps = t.fps;
  if (t.rotation !== undefined) base.rotation = t.rotation;
  const config = t.config;
  if (config && 'codedWidth' in config) {
    if (config.codedWidth !== undefined) base.width = config.codedWidth;
    if (config.codedHeight !== undefined) base.height = config.codedHeight;
  }
  if (config && 'sampleRate' in config) {
    base.sampleRate = config.sampleRate;
    base.channels = config.numberOfChannels;
  }
  return base;
}
