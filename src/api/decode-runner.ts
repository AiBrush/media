/**
 * Lightweight public decode dispatcher.
 *
 * Explicit WAV/AIFF/CAF hints take a narrow raw-PCM route, so a first audio pull does not evaluate the
 * image, HLS, generic demux, track-selection, codec-routing, and video-rotation orchestration needed by
 * arbitrary media. Ambiguous inputs and custom containers retain the complete general route.
 */

import type { ImageOps } from '../codecs/image/index.ts';
import type {
  CodecQuery,
  ContainerDriver,
  FilterDriver,
  FilterSpec,
  StageOptions,
} from '../contracts/driver.ts';
import type { CodecRoute } from '../kernel/router.ts';
import { isLiveMediaSource } from '../sources/live-source.ts';
import type { MediaInput, NormalizedSource, Source } from '../sources/source.ts';
import { memoizeAsync } from './frame-streams.ts';
import type { CallOptions, DecodeOptions } from './types.ts';

export interface DecodeRunnerContext {
  cacheSource(source: Source): Source;
  ensurePin(options: CallOptions): Promise<void>;
  stage(signal: AbortSignal, options: CallOptions): StageOptions;
  resolveHls(input: MediaInput, source: Source, signal: AbortSignal): Promise<Source>;
  imageOps(source: Source, signal: AbortSignal): Promise<ImageOps | undefined>;
  routeContainer(
    source: Source,
    signal: AbortSignal | undefined,
    pinDriver: string | undefined,
  ): Promise<ContainerDriver>;
  probeCodec(query: CodecQuery, options: CallOptions): Promise<CodecRoute>;
  routeFilter(spec: FilterSpec, options: CallOptions): Promise<FilterDriver>;
}

export interface DecodeRunner {
  video(): Promise<ReadableStream<VideoFrame> | undefined>;
  audio(): Promise<ReadableStream<AudioData> | undefined>;
}

interface DirectPcmRoute {
  readonly kind: 'direct-pcm';
  readonly container: ContainerDriver;
  readonly source: Source;
  readonly stage: StageOptions;
}

interface GeneralRoute {
  readonly kind: 'general';
  readonly runner: DecodeRunner;
}

type DecodeRoute = DirectPcmRoute | GeneralRoute;

type RawPcmFamily = 'wav' | 'aiff' | 'caf';

const RAW_PCM_MIME_FAMILIES: ReadonlyMap<string, RawPcmFamily> = new Map([
  ['audio/wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/vnd.wave', 'wav'],
  ['audio/aiff', 'aiff'],
  ['audio/x-aiff', 'aiff'],
  ['audio/aifc', 'aiff'],
  ['audio/x-aifc', 'aiff'],
  ['audio/x-caf', 'caf'],
  ['audio/caf', 'caf'],
]);
const RAW_PCM_EXTENSION_FAMILIES: readonly (readonly [string, RawPcmFamily])[] = [
  ['.wav', 'wav'],
  ['.wave', 'wav'],
  ['.aiff', 'aiff'],
  ['.aif', 'aiff'],
  ['.aifc', 'aiff'],
  ['.caf', 'caf'],
  ['.caff', 'caf'],
];

export function createDecodeRunner(
  context: DecodeRunnerContext,
  input: MediaInput,
  normalized: NormalizedSource,
  options: DecodeOptions,
  signal: AbortSignal,
): DecodeRunner {
  const general = memoizeAsync(async (): Promise<DecodeRunner> => {
    const { createGeneralDecodeRunner } = await import('./general-decode-runner.ts');
    return createGeneralDecodeRunner(context, input, normalized, options, signal);
  });

  if (!isDirectPcmCandidate(normalized, options)) return forward(general);
  const family = rawPcmFamily(normalized);
  if (family === undefined) return forward(general);

  const route = memoizeAsync(async (): Promise<DecodeRoute> => {
    if (options.strategy?.pinDriver !== undefined) await context.ensurePin(options);
    const source = context.cacheSource(normalized);
    const stage = context.stage(signal, options);
    const container = await context.routeContainer(source, stage.signal, stage.pinDriver);
    if (container.id !== family || !hasDirectPcmDecode(container)) {
      return { kind: 'general', runner: await general() };
    }
    return { kind: 'direct-pcm', container, source, stage };
  });

  return {
    // A raw-audio hint is not proof that arbitrary bytes contain no video. Keep video pulls on the
    // validating general route; re-readable raw-PCM sources can still take the narrow audio route.
    video: async () => (await general()).video(),
    audio: async () => {
      const [selected, bridges] = await Promise.all([
        route(),
        import('../dsp/audio-data.ts'),
        preloadBuiltInRawPcmDriver(family),
      ]);
      if (selected.kind === 'general') return selected.runner.audio();
      const {
        interleavedPcmChunksToAudioDataStream,
        pcmAudioChunksToAudioDataStream,
        pcmAudioToAudioDataStream,
      } = bridges;
      const { container, source, stage } = selected;
      if (container.decodePcmInterleavedStream !== undefined) {
        const chunks = await container.decodePcmInterleavedStream(source, stage);
        return interleavedPcmChunksToAudioDataStream(chunks, stage, container.id);
      }
      if (container.decodePcmAudioStream !== undefined) {
        const chunks = await container.decodePcmAudioStream(source, stage);
        return pcmAudioChunksToAudioDataStream(chunks, stage, container.id, 'f32');
      }
      const audio = await container.decodePcmAudio?.(source, stage);
      return audio === undefined
        ? (await general()).audio()
        : pcmAudioToAudioDataStream(audio, stage, container.id, 'f32');
    },
  };
}

function forward(load: () => Promise<DecodeRunner>): DecodeRunner {
  return {
    video: async () => (await load()).video(),
    audio: async () => (await load()).audio(),
  };
}

function hasDirectPcmDecode(container: ContainerDriver): boolean {
  return (
    container.decodePcmInterleavedStream !== undefined ||
    container.decodePcmAudioStream !== undefined ||
    container.decodePcmAudio !== undefined
  );
}

function isDirectPcmCandidate(source: NormalizedSource, options: DecodeOptions): source is Source {
  if (
    isLiveMediaSource(source) ||
    source.kind === 'stream' ||
    (options.trackSelect?.length ?? 0) > 0
  ) {
    return false;
  }
  return rawPcmFamily(source) !== undefined;
}

function rawPcmFamily(source: Source): RawPcmFamily | undefined {
  const mime = source.mimeHint?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== undefined) {
    const family = RAW_PCM_MIME_FAMILIES.get(mime);
    if (family !== undefined) return family;
  }
  const filename = source.filename?.toLowerCase();
  if (filename === undefined) return undefined;
  return RAW_PCM_EXTENSION_FAMILIES.find(([extension]) => filename.endsWith(extension))?.[1];
}

async function preloadBuiltInRawPcmDriver(family: RawPcmFamily): Promise<void> {
  switch (family) {
    case 'wav':
      await Promise.all([
        import('../drivers/wav/wav-lazy-driver.ts'),
        import('../drivers/wav/wav-driver.ts'),
      ]);
      return;
    case 'aiff':
      await import('../drivers/aiff/aiff-driver.ts');
      return;
    case 'caf':
      await import('../drivers/caf/caf-driver.ts');
  }
}
