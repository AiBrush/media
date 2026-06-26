import type { CodecQuery, ContainerQuery, FilterSpec } from '../contracts/driver.ts';
import type { LogEvent, PreloadSpec } from './types.ts';

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};

type PreloadLevel = 'chunks' | 'compile' | 'ready';
type PreloadCodecDirection = 'decode' | 'encode';

interface NormalizedPreloadSpec {
  readonly op: string;
  readonly video?: string;
  readonly audio?: string;
  readonly container?: string;
  readonly level: PreloadLevel;
}

interface PreloadSpecRecord {
  readonly op?: unknown;
  readonly video?: unknown;
  readonly audio?: unknown;
  readonly container?: unknown;
  readonly level?: unknown;
}

export interface PreloadHost {
  readonly tasks: Map<string, Promise<void>>;
  ensureDefaultDrivers(): Promise<void>;
  pickContainer(q: ContainerQuery): void;
  pickCodec(q: CodecQuery): Promise<void>;
  pickFilter(spec: FilterSpec): void;
  onLog?: (event: LogEvent) => void;
}

const DEFAULT_PRELOAD_SPEC: NormalizedPreloadSpec = { op: 'probe', level: 'compile' };
const COMMON_PRELOAD_CONTAINERS = [
  'mp4',
  'mov',
  'webm',
  'mkv',
  'ogg',
  'wav',
  'mp3',
  'flac',
  'adts',
  'aiff',
  'caf',
  'avi',
  'ts',
] as const;

export async function runPreload(host: PreloadHost, specs: readonly PreloadSpec[]): Promise<void> {
  const normalized = normalizePreloadSpecs(specs);
  const work = normalized.length === 0 ? [DEFAULT_PRELOAD_SPEC] : normalized;
  await Promise.all(work.map((spec) => preloadOnce(host, spec)));
}

async function preloadOnce(host: PreloadHost, spec: NormalizedPreloadSpec): Promise<void> {
  const key = preloadKey(spec);
  let task = host.tasks.get(key);
  if (task === undefined) {
    task = runPreloadTask(host, spec).catch((e) => {
      host.onLog?.({
        level: 'warn',
        message: `preload warmup failed for ${spec.op}`,
        detail: { spec, error: unknownMessage(e) },
      });
    });
    host.tasks.set(key, task);
  }
  await task;
}

async function runPreloadTask(host: PreloadHost, spec: NormalizedPreloadSpec): Promise<void> {
  await host.ensureDefaultDrivers();
  await Promise.allSettled([
    warmContainerPreload(host, spec),
    warmCodecPreload(host, spec),
    warmFilterPreload(host, spec),
    warmWasmPreload(spec),
  ]);
}

async function warmContainerPreload(host: PreloadHost, spec: NormalizedPreloadSpec): Promise<void> {
  await Promise.allSettled(
    preloadContainerQueries(spec).map((q) => Promise.resolve().then(() => host.pickContainer(q))),
  );
}

async function warmCodecPreload(host: PreloadHost, spec: NormalizedPreloadSpec): Promise<void> {
  await Promise.allSettled(preloadCodecQueries(spec).map((q) => host.pickCodec(q)));
}

async function warmFilterPreload(host: PreloadHost, spec: NormalizedPreloadSpec): Promise<void> {
  await Promise.allSettled(
    preloadFilterSpecs(spec).map((filter) => Promise.resolve().then(() => host.pickFilter(filter))),
  );
}

async function warmWasmPreload(spec: NormalizedPreloadSpec): Promise<void> {
  await Promise.allSettled(
    preloadWasmCodecs(spec).map((codec) => warmWasmCodec(codec, spec.level !== 'chunks')),
  );
}

function normalizePreloadSpecs(specs: readonly unknown[]): NormalizedPreloadSpec[] {
  const out: NormalizedPreloadSpec[] = [];
  for (const spec of specs) {
    const normalized = normalizePreloadSpec(spec);
    if (normalized !== undefined) out.push(normalized);
  }
  return out;
}

function normalizePreloadSpec(spec: unknown): NormalizedPreloadSpec | undefined {
  if (typeof spec === 'string') {
    const op = spec.trim().toLowerCase();
    return op === '' ? undefined : { op, level: 'compile' };
  }
  if (!isObject(spec)) return undefined;
  const record = spec as PreloadSpecRecord;
  if (typeof record.op !== 'string') return undefined;
  const op = record.op.trim().toLowerCase();
  if (op === '') return undefined;
  return {
    op,
    ...(typeof record.video === 'string' && record.video.trim() !== ''
      ? { video: record.video.trim().toLowerCase() }
      : {}),
    ...(typeof record.audio === 'string' && record.audio.trim() !== ''
      ? { audio: record.audio.trim().toLowerCase() }
      : {}),
    ...(typeof record.container === 'string' && record.container.trim() !== ''
      ? { container: record.container.trim().toLowerCase() }
      : {}),
    level: normalizePreloadLevel(record.level),
  };
}

function normalizePreloadLevel(level: unknown): PreloadLevel {
  return level === 'chunks' || level === 'ready' || level === 'compile' ? level : 'compile';
}

function preloadKey(spec: NormalizedPreloadSpec): string {
  return [spec.op, spec.video ?? '', spec.audio ?? '', spec.container ?? '', spec.level].join('|');
}

function preloadContainerQueries(spec: NormalizedPreloadSpec): ContainerQuery[] {
  const containers =
    spec.container === undefined ? commonPreloadContainers(spec) : [spec.container];
  const directions = preloadContainerDirections(spec.op);
  const out: ContainerQuery[] = [];
  for (const container of containers) {
    for (const direction of directions) {
      out.push({
        direction,
        extension: container,
        ...(CONTAINER_MIME[container] !== undefined ? { mime: CONTAINER_MIME[container] } : {}),
      });
    }
  }
  return out;
}

function commonPreloadContainers(spec: NormalizedPreloadSpec): readonly string[] {
  if (spec.op === 'probe' || spec.op === 'demux') return COMMON_PRELOAD_CONTAINERS;
  return [];
}

function preloadContainerDirections(op: string): readonly ('demux' | 'mux')[] {
  switch (op) {
    case 'mux':
    case 'encode':
      return ['mux'];
    case 'convert':
    case 'transcode':
    case 'remux':
      return ['demux', 'mux'];
    case 'probe':
    case 'demux':
    case 'decode':
    case 'seek':
    case 'trim':
    case 'decrypt':
      return ['demux'];
    default:
      return ['demux', 'mux'];
  }
}

function preloadCodecQueries(spec: NormalizedPreloadSpec): CodecQuery[] {
  const out: CodecQuery[] = [];
  const directions = preloadCodecDirections(spec.op);
  if (spec.video !== undefined) {
    for (const direction of directions) {
      out.push({
        mediaType: 'video',
        direction,
        config: preloadVideoConfig(spec.video, direction),
      });
    }
  }
  if (spec.audio !== undefined) {
    for (const direction of directions) {
      out.push({
        mediaType: 'audio',
        direction,
        config: preloadAudioConfig(spec.audio, direction),
      });
    }
  }
  return out;
}

function preloadCodecDirections(op: string): readonly PreloadCodecDirection[] {
  switch (op) {
    case 'decode':
    case 'seek':
      return ['decode'];
    case 'encode':
      return ['encode'];
    case 'trim':
    case 'convert':
    case 'transcode':
      return ['decode', 'encode'];
    default:
      return ['decode', 'encode'];
  }
}

function preloadVideoConfig(
  codec: string,
  direction: PreloadCodecDirection,
): VideoDecoderConfig | VideoEncoderConfig {
  const codecString = preloadVideoCodecString(codec);
  if (direction === 'encode') {
    return { codec: codecString, width: 16, height: 16, bitrate: 100_000, framerate: 30 };
  }
  return { codec: codecString, codedWidth: 16, codedHeight: 16 };
}

function preloadAudioConfig(
  codec: string,
  _direction: PreloadCodecDirection,
): AudioDecoderConfig | AudioEncoderConfig {
  return { codec: preloadAudioCodecString(codec), sampleRate: 48_000, numberOfChannels: 2 };
}

function preloadVideoCodecString(codec: string): string {
  switch (codec) {
    case 'h264':
      return 'avc1.42E01E';
    case 'hevc':
    case 'h265':
      return 'hev1.1.6.L93.B0';
    case 'vp9':
      return 'vp09.00.10.08';
    case 'av1':
      return 'av01.0.04M.08';
    default:
      return codec;
  }
}

function preloadAudioCodecString(codec: string): string {
  switch (codec) {
    case 'aac':
      return 'mp4a.40.2';
    default:
      return codec;
  }
}

function preloadFilterSpecs(spec: NormalizedPreloadSpec): FilterSpec[] {
  const out: FilterSpec[] = [];
  if ((spec.op === 'convert' || spec.op === 'transcode') && spec.video !== undefined) {
    out.push({ mediaType: 'video', type: 'resize', width: 16, height: 16, fit: 'contain' });
  }
  if ((spec.op === 'convert' || spec.op === 'transcode') && spec.audio !== undefined) {
    out.push({ mediaType: 'audio', type: 'gain', db: 0 });
  }
  return out;
}

function preloadWasmCodecs(spec: NormalizedPreloadSpec): readonly string[] {
  const codecs = new Set<string>();
  if (spec.audio !== undefined) codecs.add(spec.audio);
  if (spec.video !== undefined) codecs.add(spec.video);
  return [...codecs];
}

async function warmWasmCodec(codec: string, compile: boolean): Promise<void> {
  switch (codec) {
    case 'aac': {
      const mod = await import('../codecs/wasm-aac/wasm-aac-driver.ts');
      if (compile) await mod.loadAacCore();
      return;
    }
    case 'mp3': {
      const mod = await import('../codecs/wasm-mp3/wasm-mp3-driver.ts');
      if (compile) await mod.loadMp3Core();
      return;
    }
    case 'vorbis': {
      const mod = await import('../codecs/wasm-vorbis/wasm-vorbis-driver.ts');
      if (compile) await mod.loadVorbisCore();
      return;
    }
    case 'opus': {
      const mod = await import('../codecs/wasm-opus/wasm-opus-driver.ts');
      if (compile) await mod.loadOpusCore();
      return;
    }
    case 'av1': {
      const mod = await import('../codecs/wasm-av1/wasm-av1-driver.ts');
      if (compile) await mod.loadAv1Core();
      return;
    }
    case 'vp8':
    case 'vp9': {
      const mod = await import('../codecs/wasm-vpx/wasm-vpx-driver.ts');
      if (compile) await mod.loadVpxCore();
      return;
    }
    default:
      return;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function unknownMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
