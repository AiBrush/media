import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
  type EncodedChunk,
  type RawFrame,
  type StageOptions,
} from '../contracts/driver.ts';
import { type CapabilityError, InputError } from '../contracts/errors.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { createMedia } from './create-media.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function observingModule(
  stages: StageOptions[],
  ids: readonly [string, string] = ['first-container', 'pinned-container'],
): DriverModule {
  const container = (id: string): ContainerDriver => ({
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: [id],
    supports: (q) => q.mime === 'video/x-runtime-controls',
    probe: (_src, o) => {
      if (o !== undefined) stages.push(o);
      return Promise.resolve([]);
    },
    demux: () => Promise.reject(new Error('probe() should be used')),
    createMuxer: () => {
      throw new Error('unused');
    },
  });
  const codec: CodecDriver = {
    id: 'codec-only',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: () => Promise.resolve({ supported: true, hardwareAccelerated: false }),
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(registry): void {
      registry.addContainer(container(ids[0]));
      registry.addContainer(container(ids[1]));
      registry.addCodec(codec);
    },
  };
}

const input = (): Source =>
  fromBytes(new Uint8Array([1, 2, 3]), { mime: 'video/x-runtime-controls' });

function emptyPcmWav(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  return bytes;
}

describe('createMedia public runtime controls', () => {
  it('threads the explicit threads-off baseline profile and normalized asset root through a stage', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('location', new URL('https://app.example/player/index.html'));
    const stages: StageOptions[] = [];
    const media = createMedia({ enableThreads: false, assetBaseUrl: '/media/cores' }).use(
      observingModule(stages),
    );

    await media.probe(input(), { strategy: { pinDriver: 'pinned-container' } });

    expect(stages).toHaveLength(1);
    expect(stages[0]?.wasmRuntime).toMatchObject({
      kind: 'baseline',
      threads: false,
      sharedArrayBuffer: false,
      reason: expect.stringContaining('disabled'),
    });
    expect(stages[0]?.wasmAssetBaseUrl).toBe('https://app.example/media/cores/');
  });

  it('keeps a codec-only pin scoped away from container routing in a compound call context', async () => {
    const stages: StageOptions[] = [];
    const info = await createMedia()
      .use(observingModule(stages))
      .probe(input(), {
        strategy: { pinDriver: 'codec-only' },
      });

    expect(info.container).toBe('first-container');
  });

  it('honestly falls back to baseline when threads are requested without isolation', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    const stages: StageOptions[] = [];

    await createMedia({ enableThreads: true }).use(observingModule(stages)).probe(input());

    expect(stages[0]?.wasmRuntime).toMatchObject({
      kind: 'baseline',
      threads: false,
      sharedArrayBuffer: false,
      reason: expect.stringContaining('crossOriginIsolated'),
    });
    expect(stages[0]?.wasmAssetBaseUrl).toBeUndefined();
  });

  it('rejects an unknown pin before opening or cancelling the source, after the defaults retry', async () => {
    let opens = 0;
    let cancels = 0;
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      mimeHint: 'video/x-runtime-controls',
      stream: () => {
        opens++;
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
          cancel(): void {
            cancels++;
          },
        });
      },
    };

    await expect(
      createMedia()
        .use(observingModule([]))
        .probe(source, {
          strategy: { pinDriver: 'missing-driver' },
        }),
    ).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'capability-miss',
      message: expect.stringContaining('missing-driver'),
      detail: {
        op: { kind: 'route', id: 'missing-driver' },
        tried: ['missing-driver'],
      },
    } satisfies Partial<CapabilityError>);
    expect(opens).toBe(0);
    expect(cancels).toBe(0);
  });

  it('rejects cross-origin asset roots synchronously at engine creation', () => {
    vi.stubGlobal('location', new URL('https://app.example/player/index.html'));
    expect(() => createMedia({ assetBaseUrl: 'https://cdn.example/cores/' })).toThrow(InputError);
  });

  it('shares one in-flight default registration across concurrent pinned calls', async () => {
    const media = createMedia();
    const bytes = emptyPcmWav();
    const options = { strategy: { pinDriver: 'wav' } } as const;

    const results = await Promise.all([
      media.probe(fromBytes(bytes, { mime: 'audio/wav' }), options),
      media.probe(fromBytes(bytes, { mime: 'audio/wav' }), options),
    ]);

    expect(results.map((result) => result.container)).toEqual(['wav', 'wav']);
  });
});
