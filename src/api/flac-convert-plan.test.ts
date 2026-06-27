import { describe, expect, it } from 'vitest';
import type { ContainerDriver, Demuxer, Muxer, PcmTransform } from '../contracts/driver.ts';
import type { PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { type FlacConvertDeps, convertToFlac } from './flac-convert-plan.ts';
import type { AudioTarget, CallOptions } from './types.ts';

const source = fromBytes(new Uint8Array([0x66, 0x4c, 0x61, 0x43]));

function emptyMuxer(): Muxer {
  return {
    output: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    addTrack: () => 1,
    write: () => Promise.resolve(),
    finalize: () => Promise.resolve(),
  };
}

function emptyDemuxer(codec = 'pcm-s24'): Demuxer {
  return {
    tracks: [{ id: 1, mediaType: 'audio', codec }],
    packets: () => new ReadableStream({ start: (controller) => controller.close() }),
    close: () => Promise.resolve(),
  };
}

function containerDriver(overrides: Partial<ContainerDriver>): ContainerDriver {
  return {
    id: 'test-container',
    apiVersion: 1,
    kind: 'container',
    formats: ['wav'],
    supports: () => true,
    demux: () => Promise.resolve(emptyDemuxer()),
    createMuxer: () => emptyMuxer(),
    ...overrides,
  };
}

function depsFor(container: ContainerDriver): FlacConvertDeps {
  return {
    routeContainer: () => Promise.resolve(container),
    stageOptions: (signal, o) => ({
      ...(o.onProgress !== undefined ? { onProgress: o.onProgress } : {}),
      signal,
    }),
    mimeOpts: (signal, containerName) => ({ signal, mime: `audio/${containerName}` }),
    pcmSampleFormat: (codec) => {
      switch (codec) {
        case 'pcm-u8':
          return 'u8';
        case 'pcm-s8':
          return 's8';
        case 'pcm-s16':
          return 's16';
        case 'pcm-s24':
        case 'pcm-s24be':
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
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

function pcmAudio(): PcmAudio {
  return {
    sampleRate: 48_000,
    channels: 1,
    frames: 4,
    planar: [Float64Array.from([0, 0.25, -0.25, 0.5])],
  };
}

async function convertRawPcm(
  container: ContainerDriver,
  audio: AudioTarget | undefined,
): Promise<Uint8Array> {
  const output = await convertToFlac(
    depsFor(container),
    source,
    { to: 'flac', sink: { kind: 'stream' } },
    audio,
    new AbortController().signal,
    {},
  );
  expect(output).toBeInstanceOf(ReadableStream);
  return collect(output as ReadableStream<Uint8Array>);
}

describe('convertToFlac — lazy FLAC authoring route planner', () => {
  it('routes native FLAC sources through their transformPcm path with audio DSP options preserved', async () => {
    const bytes = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
    const seen: PcmTransform[] = [];
    const signal = new AbortController().signal;
    const audio: AudioTarget = {
      channels: 2,
      sampleRate: 44_100,
      gainDb: -3,
      fade: { inSec: 0.1, outSec: 0.2, curve: 'linear' },
      dynamics: { limit: { ceilingDbfs: -1 } },
      biquad: { type: 'highpass', frequency: 80, q: Math.SQRT1_2 },
    };
    const container = containerDriver({
      formats: ['flac'],
      transformPcm: (_src: Source, opts?: PcmTransform) => {
        seen.push(opts ?? {});
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        );
      },
    });

    const output = await convertToFlac(
      depsFor(container),
      source,
      { to: 'flac', sink: { kind: 'stream' } },
      audio,
      signal,
      { onProgress: () => undefined },
    );

    expect(output).toBeInstanceOf(ReadableStream);
    expect(await collect(output as ReadableStream<Uint8Array>)).toEqual(bytes);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      signal,
      channels: 2,
      sampleRate: 44_100,
      gainDb: -3,
      fade: audio.fade,
      dynamics: audio.dynamics,
      biquad: audio.biquad,
    });
  });

  it('authors raw PCM to a real FLAC stream using an explicit requested PCM depth', async () => {
    const requestedFormats: SampleFormat[] = [];
    const container = containerDriver({
      decodePcmAudio: () => Promise.resolve(pcmAudio()),
    });
    const deps = depsFor(container);
    const output = await convertToFlac(
      {
        ...deps,
        pcmSampleFormat: (codec) => {
          const format = deps.pcmSampleFormat(codec);
          if (format !== undefined) requestedFormats.push(format);
          return format;
        },
      },
      source,
      { to: 'flac', sink: { kind: 'stream' } },
      { codec: 'pcm-s16' },
      new AbortController().signal,
      {},
    );

    expect(output).toBeInstanceOf(ReadableStream);
    const bytes = await collect(output as ReadableStream<Uint8Array>);
    expect([...bytes.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(requestedFormats).toEqual(['s16']);
  });

  it('derives raw PCM depth from demux metadata and closes the demuxer', async () => {
    let closed = false;
    const container = containerDriver({
      demux: () =>
        Promise.resolve({
          ...emptyDemuxer('pcm-s24be'),
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
      decodePcmAudio: () => Promise.resolve(pcmAudio()),
    });

    const bytes = await convertRawPcm(container, undefined);

    expect([...bytes.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(closed).toBe(true);
  });

  it('returns an honest miss when no FLAC or raw-PCM authoring path is available', async () => {
    const output = await convertToFlac(
      depsFor(containerDriver({ formats: ['ogg'] })),
      source,
      { to: 'flac', sink: { kind: 'stream' } },
      undefined,
      new AbortController().signal,
      {},
    );

    expect(output).toBeUndefined();
  });

  it('returns an honest miss when a raw-PCM source has no mappable audio track', async () => {
    let closed = false;
    const container = containerDriver({
      demux: () =>
        Promise.resolve({
          ...emptyDemuxer('opus'),
          tracks: [{ id: 1, mediaType: 'video', codec: 'h264' }],
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
      decodePcmAudio: () => Promise.resolve(pcmAudio()),
    });

    const output = await convertToFlac(
      depsFor(container),
      source,
      { to: 'flac', sink: { kind: 'stream' } },
      undefined,
      new AbortController().signal,
      {},
    );

    expect(output).toBeUndefined();
    expect(closed).toBe(true);
  });

  it('propagates materialization aborts for the native FLAC transform path', async () => {
    const controller = new AbortController();
    controller.abort();
    const container = containerDriver({
      formats: ['flac'],
      transformPcm: () =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            start: (streamController) => {
              streamController.enqueue(new Uint8Array([1]));
              streamController.close();
            },
          }),
        ),
    });

    await expect(
      convertToFlac(
        depsFor(container),
        source,
        { to: 'flac' },
        undefined,
        controller.signal,
        {} satisfies CallOptions,
      ),
    ).rejects.toThrow(/aborted/);
  });
});
