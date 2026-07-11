import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { WavMuxer } from '../drivers/wav/wav-mux.ts';
import type { PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';

const REAL_WAV_CORPUS = [
  { id: 'sfx-pcm-u8.wav', format: 'u8' },
  { id: 'sfx-pcm-s16.wav', format: 's16' },
  { id: 'sfx-pcm-s24.wav', format: 's24' },
  { id: 'sfx-pcm-s32.wav', format: 's32' },
  { id: 'sfx-pcm-f32.wav', format: 'f32' },
] as const satisfies readonly { readonly id: string; readonly format: SampleFormat }[];

class PcmAudioDataFrame {
  readonly format = 'f32-planar' as const;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly duration: number;
  closeCount = 0;

  readonly #planes: readonly Float64Array[];
  readonly #copyError: Error | undefined;
  readonly #onClose: (() => void) | undefined;

  constructor(
    audio: PcmAudio,
    start: number,
    frames: number,
    overrides: {
      readonly sampleRate?: number;
      readonly channels?: number;
      readonly timestamp?: number;
      readonly copyError?: Error;
      readonly onClose?: () => void;
    } = {},
  ) {
    this.sampleRate = overrides.sampleRate ?? audio.sampleRate;
    this.numberOfChannels = overrides.channels ?? audio.channels;
    this.numberOfFrames = frames;
    this.timestamp = overrides.timestamp ?? Math.round((start / audio.sampleRate) * 1_000_000);
    this.duration = Math.round((frames / this.sampleRate) * 1_000_000);
    this.#planes = audio.planar.map((plane) => plane.slice(start, start + frames));
    this.#copyError = overrides.copyError;
    this.#onClose = overrides.onClose;
  }

  allocationSize(options: AudioDataCopyToOptions): number {
    return (this.#planes[options.planeIndex]?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT;
  }

  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
    if (this.#copyError !== undefined) throw this.#copyError;
    if (options.format !== undefined && options.format !== 'f32-planar') {
      throw new Error(`test frame only exposes f32-planar, got ${options.format}`);
    }
    const source = this.#planes[options.planeIndex];
    if (source === undefined) throw new Error(`missing test plane ${options.planeIndex}`);
    const view = destination as ArrayBufferView;
    const output = new Float32Array(view.buffer, view.byteOffset, source.length);
    for (let i = 0; i < source.length; i++) output[i] = source[i] ?? 0;
  }

  clone(): AudioData {
    throw new Error('test frame clone is not used');
  }

  close(): void {
    this.closeCount++;
    this.#onClose?.();
  }
}

function unevenFrameStream(audio: PcmAudio): {
  readonly stream: ReadableStream<AudioData>;
  readonly frames: readonly PcmAudioDataFrame[];
} {
  const chunkSizes = [1, 7, 257, 1021, 4096] as const;
  const frames: PcmAudioDataFrame[] = [];
  let cursor = 0;
  let chunkIndex = 0;
  return {
    frames,
    stream: new ReadableStream<AudioData>(
      {
        pull(controller): void {
          if (cursor >= audio.frames) {
            controller.close();
            return;
          }
          const count = Math.min(
            chunkSizes[chunkIndex % chunkSizes.length] ?? 1,
            audio.frames - cursor,
          );
          const frame = new PcmAudioDataFrame(audio, cursor, count);
          frames.push(frame);
          controller.enqueue(frame as unknown as AudioData);
          cursor += count;
          chunkIndex++;
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

async function outputBytes(
  output: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('expected encode() to return a Blob');
  return new Uint8Array(await output.arrayBuffer());
}

function expectedAfterAudioDataSeam(value: number, format: SampleFormat): number {
  const copied = Math.fround(value);
  switch (format) {
    case 'u8':
      return (Math.max(0, Math.min(255, Math.round(copied * 128) + 128)) - 128) / 128;
    case 's8':
      return Math.max(-128, Math.min(127, Math.round(copied * 128))) / 128;
    case 's16':
      return Math.max(-32_768, Math.min(32_767, Math.round(copied * 32_768))) / 32_768;
    case 's24':
      return Math.max(-8_388_608, Math.min(8_388_607, Math.round(copied * 8_388_608))) / 8_388_608;
    case 's32':
      return (
        Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(copied * 2_147_483_648))) /
        2_147_483_648
      );
    case 'f32':
    case 'f64':
      return copied;
  }
}

function streamFromFrames(items: readonly PcmAudioDataFrame[]): {
  readonly stream: ReadableStream<AudioData>;
  readonly counts: { pulls: number; cancels: number };
} {
  const counts = { pulls: 0, cancels: 0 };
  let index = 0;
  return {
    counts,
    stream: new ReadableStream<AudioData>(
      {
        pull(controller): void {
          counts.pulls++;
          const frame = items[index++];
          if (frame === undefined) controller.close();
          else controller.enqueue(frame as unknown as AudioData);
        },
        cancel(): void {
          counts.cancels++;
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

function cancellableEmptyStream(): {
  readonly stream: ReadableStream<AudioData>;
  readonly counts: { pulls: number; cancels: number };
} {
  const counts = { pulls: 0, cancels: 0 };
  return {
    counts,
    stream: new ReadableStream<AudioData>(
      {
        pull(): void {
          counts.pulls++;
        },
        cancel(): void {
          counts.cancels++;
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

describe('media.encode — raw AudioData to PCM WAV (ADR-243)', () => {
  it.each(REAL_WAV_CORPUS)(
    'authors real $format corpus samples across arbitrary frame boundaries ($id)',
    async ({ id, format }) => {
      const source = readWavPcm(await loadFixture(id));
      const framed = unevenFrameStream(source);

      const output = await outputBytes(
        await createMedia().encode(
          { audio: framed.stream },
          {
            to: 'wav',
            audio: {
              codec: `pcm-${format}`,
              sampleRate: source.sampleRate,
              channels: source.channels,
            },
          },
        ),
      );
      const actual = readWavPcm(output);

      expect(actual).toMatchObject({
        format,
        sampleRate: source.sampleRate,
        channels: source.channels,
        frames: source.frames,
      });
      for (let channel = 0; channel < source.channels; channel++) {
        const expectedPlane = source.planar[channel];
        const actualPlane = actual.planar[channel];
        if (expectedPlane === undefined || actualPlane === undefined) {
          throw new Error(`missing channel ${channel}`);
        }
        expect(actualPlane.length).toBe(expectedPlane.length);
        expect(actualPlane).toEqual(
          Float64Array.from(expectedPlane, (value) => expectedAfterAudioDataSeam(value, format)),
        );
      }
      expect(framed.frames.length).toBeGreaterThan(5);
      expect(framed.frames.every((frame) => frame.closeCount === 1)).toBe(true);
    },
  );

  it('infers generic PCM geometry, rebases a non-zero clock, and defaults to f32 WAV', async () => {
    const source = readWavPcm(await loadFixture('stereo-48000.wav'));
    const firstFrames = Math.min(137, source.frames);
    const baseTimestamp = 7_000_000;
    const first = new PcmAudioDataFrame(source, 0, firstFrames, { timestamp: baseTimestamp });
    const second = new PcmAudioDataFrame(source, firstFrames, source.frames - firstFrames, {
      timestamp: baseTimestamp + Math.round((firstFrames / source.sampleRate) * 1_000_000),
    });
    const framed = streamFromFrames([first, second]);
    const progress: number[] = [];

    const output = readWavPcm(
      await outputBytes(
        await createMedia().encode(
          { audio: framed.stream },
          { to: 'wav', audio: { codec: 'pcm' } },
          { onProgress: ({ done }) => progress.push(done) },
        ),
      ),
    );

    expect(output).toMatchObject({
      format: 'f32',
      sampleRate: source.sampleRate,
      channels: source.channels,
      frames: source.frames,
    });
    expect(progress).toEqual([firstFrames, source.frames, source.frames]);
    expect([first.closeCount, second.closeCount]).toEqual([1, 1]);
  });

  it('round-trips a big-endian PCM request through the legal little-endian WAV layout', async () => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    const framed = unevenFrameStream(source);
    const output = readWavPcm(
      await outputBytes(
        await createMedia().encode(
          { audio: framed.stream },
          { to: 'wav', audio: { codec: 'pcm-s16be' } },
        ),
      ),
    );

    expect(output.format).toBe('s16');
    expect(output.planar).toEqual(source.planar);
    expect(framed.frames.every((frame) => frame.closeCount === 1)).toBe(true);
  });

  it.each([
    { codec: 'pcm-u8be', wire: 'u8', output: 'u8' },
    { codec: 'pcm-s8', wire: 's8', output: 'u8' },
    { codec: 'pcm-s8be', wire: 's8', output: 'u8' },
    { codec: 'pcm-s24be', wire: 's24', output: 's24' },
    { codec: 'pcm-s32be', wire: 's32', output: 's32' },
    { codec: 'pcm-f32be', wire: 'f32', output: 'f32' },
    { codec: 'pcm-f64', wire: 'f64', output: 'f64' },
    { codec: 'pcm-f64be', wire: 'f64', output: 'f64' },
  ] as const)(
    'authors the $codec target through its exact legal WAV $output representation',
    async ({ codec, wire, output }) => {
      const complete = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
      const frameCount = Math.min(257, complete.frames);
      const source: PcmAudio = {
        sampleRate: complete.sampleRate,
        channels: complete.channels,
        frames: frameCount,
        planar: complete.planar.map((plane) => plane.slice(0, frameCount)),
      };
      const frame = new PcmAudioDataFrame(source, 0, frameCount);
      const framed = streamFromFrames([frame]);
      const actual = readWavPcm(
        await outputBytes(
          await createMedia().encode({ audio: framed.stream }, { to: 'wav', audio: { codec } }),
        ),
      );

      expect(actual.format).toBe(output);
      expect(actual.planar).toEqual(
        source.planar.map((plane) =>
          Float64Array.from(plane, (value) => expectedAfterAudioDataSeam(value, wire)),
        ),
      );
      expect(frame.closeCount).toBe(1);
    },
  );

  it('keeps the optional raw-PCM mux seam frame-aligned and byte-owning', () => {
    const muxer = new WavMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-s16',
      config: { codec: 'pcm-s16', sampleRate: 48_000, numberOfChannels: 2 },
    });
    expect(() => muxer.writePcm(trackId, new Uint8Array([0, 1]))).toThrowError(MediaError);
  });

  it.each([
    {
      label: 'sample rate',
      target: { codec: 'pcm-s16' as const, sampleRate: 44_100 },
    },
    {
      label: 'channel count',
      target: { codec: 'pcm-s16' as const, channels: 2 },
    },
  ])('closes and rejects a first-frame $label mismatch', async ({ target }) => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    const frame = new PcmAudioDataFrame(source, 0, Math.min(64, source.frames));
    const framed = streamFromFrames([frame]);

    await expect(
      createMedia().encode({ audio: framed.stream }, { to: 'wav', audio: target }),
    ).rejects.toBeInstanceOf(InputError);
    expect(frame.closeCount).toBe(1);
    expect(framed.counts.cancels).toBe(1);
  });

  it('rejects a mid-stream layout change and timestamp gap after closing every pulled frame', async () => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    const first = new PcmAudioDataFrame(source, 0, 32);
    const changedRate = new PcmAudioDataFrame(source, 32, 32, { sampleRate: 44_100 });
    const rateStream = streamFromFrames([first, changedRate]);
    await expect(
      createMedia().encode(
        { audio: rateStream.stream },
        { to: 'wav', audio: { codec: 'pcm-s16' } },
      ),
    ).rejects.toBeInstanceOf(InputError);
    expect([first.closeCount, changedRate.closeCount]).toEqual([1, 1]);

    const clockA = new PcmAudioDataFrame(source, 0, 32);
    const expected = Math.round((32 / source.sampleRate) * 1_000_000);
    const clockB = new PcmAudioDataFrame(source, 32, 32, { timestamp: expected + 100 });
    const clockStream = streamFromFrames([clockA, clockB]);
    await expect(
      createMedia().encode(
        { audio: clockStream.stream },
        { to: 'wav', audio: { codec: 'pcm-s16' } },
      ),
    ).rejects.toBeInstanceOf(InputError);
    expect([clockA.closeCount, clockB.closeCount]).toEqual([1, 1]);
  });

  it('maps copy failures to a typed encode error and closes the owned frame once', async () => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    const frame = new PcmAudioDataFrame(source, 0, 32, { copyError: new Error('copy failed') });
    const framed = streamFromFrames([frame]);

    await expect(
      createMedia().encode({ audio: framed.stream }, { to: 'wav', audio: { codec: 'pcm-s16' } }),
    ).rejects.toMatchObject({ code: 'encode-error' });
    expect(frame.closeCount).toBe(1);
    expect(framed.counts.cancels).toBe(1);
  });

  it('maps an upstream reader failure and preserves close-once ownership', async () => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    const frame = new PcmAudioDataFrame(source, 0, 32);
    let pulls = 0;
    const stream = new ReadableStream<AudioData>(
      {
        pull(controller): void {
          pulls++;
          if (pulls === 1) controller.enqueue(frame as unknown as AudioData);
          else controller.error(new Error('upstream failed'));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      createMedia().encode({ audio: stream }, { to: 'wav', audio: { codec: 'pcm-s16' } }),
    ).rejects.toMatchObject({ code: 'encode-error' });
    expect(frame.closeCount).toBe(1);
  });

  it('aborts a pending pull without prefetching and closes the last transferred frame once', async () => {
    const source = readWavPcm(await loadFixture('sfx-pcm-s16.wav'));
    let activeFrames = 0;
    let maxActiveFrames = 0;
    const frame = new PcmAudioDataFrame(source, 0, 32, {
      onClose: () => {
        activeFrames--;
      },
    });
    let pulls = 0;
    let cancels = 0;
    let secondPullStarted: (() => void) | undefined;
    const pendingPull = new Promise<void>((resolve) => {
      secondPullStarted = resolve;
    });
    const stream = new ReadableStream<AudioData>(
      {
        pull(controller): void | Promise<void> {
          pulls++;
          if (pulls === 1) {
            activeFrames++;
            maxActiveFrames = Math.max(maxActiveFrames, activeFrames);
            controller.enqueue(frame as unknown as AudioData);
            return;
          }
          secondPullStarted?.();
          return new Promise<void>(() => undefined);
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const handle = createMedia().encode(
      { audio: stream },
      { to: 'wav', audio: { codec: 'pcm-s16' } },
    );
    await pendingPull;
    handle.cancel();

    await expect(handle).rejects.toMatchObject({ code: 'aborted' });
    expect(frame.closeCount).toBe(1);
    expect(activeFrames).toBe(0);
    expect(maxActiveFrames).toBe(1);
    expect(pulls).toBe(2);
    expect(cancels).toBe(1);
  });

  it('declines compressed audio and video before pulling either stream', async () => {
    const compressed = cancellableEmptyStream();
    await expect(
      createMedia().encode({ audio: compressed.stream }, { to: 'wav', audio: { codec: 'opus' } }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(compressed.counts).toEqual({ pulls: 0, cancels: 1 });

    const videoCounts = { pulls: 0, cancels: 0 };
    const video = new ReadableStream<VideoFrame>(
      {
        pull(): void {
          videoCounts.pulls++;
        },
        cancel(): void {
          videoCounts.cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      createMedia().encode({ video }, { to: 'wav', video: { codec: 'h264' } }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(videoCounts).toEqual({ pulls: 0, cancels: 1 });
  });

  it('rejects an empty PCM frame stream with a typed input error', async () => {
    const stream = new ReadableStream<AudioData>({ start: (controller) => controller.close() });
    await expect(
      createMedia().encode({ audio: stream }, { to: 'wav', audio: { codec: 'pcm-f32' } }),
    ).rejects.toBeInstanceOf(InputError);
  });
});
