import { describe, expect, it } from 'vitest';
import { decodeFlac, enumerateFlacFrameSpans, interleavedPcmBytes } from '../codecs/flac/decode.ts';
import type { ContainerDriver, Demuxer, Muxer, PcmTransform } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import { tryAuthorWavS16Flac } from '../drivers/wav/flac-s16.ts';
import { parseWavPcmData, writeWav } from '../drivers/wav/pcm.ts';
import type { PcmAudio } from '../dsp/pcm.ts';
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

function stereoPcmAudio(): PcmAudio {
  return {
    sampleRate: 48_000,
    channels: 2,
    frames: 4,
    planar: [Float64Array.from([0, 0.25, -0.25, 0.5]), Float64Array.from([0.5, -0.5, 0, 0.25])],
  };
}

function monoPcmAudio(frames: number): PcmAudio {
  const samples = new Float64Array(frames);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = ((index % 17) - 8) / 16;
  }
  return {
    sampleRate: 48_000,
    channels: 1,
    frames,
    planar: [samples],
  };
}

function patchU16LE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function patchU32LE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function appendOneDataByte(wav: Uint8Array): Uint8Array {
  const out = new Uint8Array(wav.byteLength + 1);
  out.set(wav);
  out[out.length - 1] = 0x7f;
  patchU32LE(out, 4, out.byteLength - 8);
  patchU32LE(out, 40, out.byteLength - 44);
  return out;
}

function emptyDataWav(wav: Uint8Array): Uint8Array {
  const out = wav.slice(0, 44);
  patchU32LE(out, 4, 36);
  patchU32LE(out, 40, 0);
  return out;
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
      mixMatrix: [
        [1, 0],
        [0, -1],
      ],
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
      mixMatrix: audio.mixMatrix,
      dynamics: audio.dynamics,
      biquad: audio.biquad,
    });
  });

  it('authors raw PCM to a real FLAC stream using an explicit requested PCM depth', async () => {
    const container = containerDriver({
      decodePcmAudio: () => Promise.resolve(pcmAudio()),
    });
    const deps = depsFor(container);
    const output = await convertToFlac(
      deps,
      source,
      { to: 'flac', sink: { kind: 'stream' } },
      { codec: 'pcm-s16' },
      new AbortController().signal,
      {},
    );

    expect(output).toBeInstanceOf(ReadableStream);
    const bytes = await collect(output as ReadableStream<Uint8Array>);
    expect([...bytes.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(decodeFlac(bytes).bitsPerSample).toBe(16);
  });

  it('applies an explicit mix matrix before authoring raw PCM as FLAC', async () => {
    const container = containerDriver({
      decodePcmAudio: () => Promise.resolve(stereoPcmAudio()),
    });
    const bytes = await convertRawPcm(container, {
      codec: 'pcm-s16',
      channels: 1,
      mixMatrix: [[0.5, 0.5]],
    });
    const decoded = decodeFlac(bytes);

    expect(decoded.channels).toBe(1);
    expect(decoded.bitsPerSample).toBe(16);
    expect(interleavedPcmBytes(decoded)).toEqual(
      Uint8Array.of(0x00, 0x20, 0x00, 0xf0, 0x00, 0xf0, 0x00, 0x30),
    );
  });

  it('resamples raw PCM before authoring a native FLAC stream', async () => {
    const container = containerDriver({
      decodePcmAudio: () => Promise.resolve(pcmAudio()),
    });
    const bytes = await convertRawPcm(container, {
      codec: 'pcm-s16',
      sampleRate: 24_000,
    });
    const decoded = decodeFlac(bytes);

    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.totalSamples).toBe(2);
  });

  it('authors no-DSP WAV s16 sources directly to verbatim FLAC without demuxing or Float64 decode', async () => {
    const wav = writeWav(stereoPcmAudio(), 's16');
    const wavPayload = parseWavPcmData(wav).data;
    let demuxed = false;
    let decoded = false;
    const container = containerDriver({
      id: 'wav',
      formats: ['wav'],
      demux: () => {
        demuxed = true;
        return Promise.resolve(emptyDemuxer('pcm-s16'));
      },
      decodePcmAudio: () => {
        decoded = true;
        return Promise.resolve(stereoPcmAudio());
      },
    });

    const output = await convertToFlac(
      depsFor(container),
      fromBytes(wav, { mime: 'audio/wav' }),
      { to: 'flac', sink: { kind: 'stream' } },
      { codec: 'flac' },
      new AbortController().signal,
      {},
    );

    expect(output).toBeInstanceOf(ReadableStream);
    const flac = await collect(output as ReadableStream<Uint8Array>);
    const decodedFlac = decodeFlac(flac);
    expect(decodedFlac.sampleRate).toBe(48_000);
    expect(decodedFlac.channels).toBe(2);
    expect(decodedFlac.bitsPerSample).toBe(16);
    expect(interleavedPcmBytes(decodedFlac)).toEqual(wavPayload);
    expect(demuxed).toBe(false);
    expect(decoded).toBe(false);
  });

  it('keeps DSP-shaped WAV s16 FLAC requests on the canonical PCM route', async () => {
    const wav = writeWav(pcmAudio(), 's16');
    let demuxed = false;
    let decoded = false;
    const container = containerDriver({
      id: 'wav',
      formats: ['wav'],
      demux: () => {
        demuxed = true;
        return Promise.resolve(emptyDemuxer('pcm-s16'));
      },
      decodePcmAudio: () => {
        decoded = true;
        return Promise.resolve(pcmAudio());
      },
    });

    const output = await convertToFlac(
      depsFor(container),
      fromBytes(wav, { mime: 'audio/wav' }),
      { to: 'flac', sink: { kind: 'stream' } },
      { codec: 'flac', channels: 1 },
      new AbortController().signal,
      {},
    );

    expect(output).toBeInstanceOf(ReadableStream);
    const flac = await collect(output as ReadableStream<Uint8Array>);
    expect([...flac.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(demuxed).toBe(true);
    expect(decoded).toBe(true);
  });

  it('keeps unsupported or malformed direct WAV s16 FLAC inputs honest', () => {
    const wav = writeWav(pcmAudio(), 's16');
    expect(tryAuthorWavS16Flac(writeWav(pcmAudio(), 'f32'))).toBeUndefined();

    const badChannels = wav.slice();
    patchU16LE(badChannels, 22, 0);
    expect(() => tryAuthorWavS16Flac(badChannels)).toThrowError(InputError);

    const badRate = wav.slice();
    patchU32LE(badRate, 24, 0);
    expect(() => tryAuthorWavS16Flac(badRate)).toThrowError(InputError);

    expect(() => tryAuthorWavS16Flac(appendOneDataByte(wav))).toThrowError(InputError);
    expect(() => tryAuthorWavS16Flac(emptyDataWav(wav))).toThrowError(InputError);
  });

  it('authors direct FLAC frames for standard and explicit block-size branches', () => {
    const standardBlockSizes = [192, 256, 512, 576, 1024, 1152, 2048, 2304, 4096] as const;
    for (const frames of [300, 4097, ...standardBlockSizes] as const) {
      const wav = writeWav(monoPcmAudio(frames), 's16');
      const flac = tryAuthorWavS16Flac(wav);
      expect(flac).toBeDefined();
      if (flac === undefined) throw new Error('expected direct FLAC output');
      const decoded = decodeFlac(flac);
      expect(decoded.totalSamples).toBe(frames);
      expect(decoded.bitsPerSample).toBe(16);
      expect(decoded.sampleRate).toBe(48_000);
      const firstFrame = enumerateFlacFrameSpans(flac)[0]?.data;
      expect((firstFrame?.[2] ?? 0) & 0x0f).toBe(10); // explicit 48 kHz header code
      expect(((firstFrame?.[3] ?? 0) >>> 1) & 0x07).toBe(4); // explicit 16-bit header code
    }
  });

  it('authors direct FLAC streams once fixed-block frame numbers require multibyte UTF-8 coding', () => {
    const frames = 4096 * 130 + 17;
    const wav = writeWav(monoPcmAudio(frames), 's16');
    const flac = tryAuthorWavS16Flac(wav);
    expect(flac).toBeDefined();
    if (flac === undefined) throw new Error('expected direct FLAC output');
    const decoded = decodeFlac(flac);
    expect(decoded.totalSamples).toBe(frames);
    expect(decoded.bitsPerSample).toBe(16);
    expect(interleavedPcmBytes(decoded)).toEqual(parseWavPcmData(wav).data);
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
