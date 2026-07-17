import { describe, expect, it, vi } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import { toBlob, toStream } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import { runMediaJob } from './job-runner.ts';
import type { JobEngine, MediaJob } from './job.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  DecryptOptions,
  Output,
  RemuxOptions,
  TrimOptions,
} from './types.ts';

type RecordedCall =
  | {
      readonly op: 'convert';
      readonly input: MediaInput;
      readonly opts: ConvertOptions;
      readonly call: CallOptions;
    }
  | {
      readonly op: 'trim';
      readonly input: MediaInput;
      readonly opts: TrimOptions;
      readonly call: CallOptions;
    }
  | {
      readonly op: 'remux';
      readonly input: MediaInput;
      readonly opts: RemuxOptions;
      readonly call: CallOptions;
    }
  | {
      readonly op: 'decrypt';
      readonly input: MediaInput;
      readonly opts: DecryptOptions;
      readonly call: CallOptions;
    };

function cancellable<T>(promise: Promise<T>, cancel: () => void = () => undefined): Cancellable<T> {
  const result = promise as Cancellable<T>;
  result.cancel = cancel;
  return result;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function host(outputs: readonly Output[]): {
  readonly engine: JobEngine;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const next = (): Cancellable<Output> => cancellable(Promise.resolve(outputs[index++]));
  return {
    calls,
    engine: {
      convert(input, opts, call = {}) {
        calls.push({ op: 'convert', input, opts, call });
        return next();
      },
      trim(input, opts, call = {}) {
        calls.push({ op: 'trim', input, opts, call });
        return next();
      },
      remux(input, opts, call = {}) {
        calls.push({ op: 'remux', input, opts, call });
        return next();
      },
      decrypt(input, opts, call = {}) {
        calls.push({ op: 'decrypt', input, opts, call });
        return next();
      },
    },
  };
}

function baseJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    input: new Uint8Array([1, 2, 3]),
    ops: [],
    output: { container: 'mp4' },
    ...overrides,
  };
}

describe('declarative job runner', () => {
  it('executes documented trim → resize → output as one linked two-stage pipe', async () => {
    const clipped = new Blob([new Uint8Array([4, 5])]);
    const finished = new Blob([new Uint8Array([6, 7, 8])], { type: 'video/mp4' });
    const { engine, calls } = host([clipped, finished]);

    const result = await runMediaJob(
      engine,
      baseJob({
        ops: [
          { op: 'trim', start: 0, end: 5 },
          { op: 'resize', width: 1280, height: 720 },
        ],
        output: {
          container: 'mp4',
          video: { codec: 'h264', bitrate: 2_000_000 },
          audio: { codec: 'aac' },
          faststart: true,
        },
      }),
    );

    expect(result).toBe(finished);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      op: 'trim',
      opts: { start: 0, end: 5, sink: toStream() },
    });
    expect(calls[1]).toMatchObject({
      op: 'convert',
      input: clipped,
      opts: {
        to: 'mp4',
        video: { codec: 'h264', bitrate: 2_000_000, width: 1280, height: 720 },
        audio: { codec: 'aac' },
        faststart: true,
      },
    });
    expect(calls[1]?.opts).not.toHaveProperty('sink');
  });

  it('runs trim → resize → mp4 as one pipe: source opened once, decode/encode once, bytes exact', async () => {
    const source = new Uint8Array([10, 20, 30, 40, 50]);
    let sourceOpens = 0;
    let decodes = 0;
    let encodes = 0;
    let trimPulls = 0;
    let trimPullsWhenConvertStarted = -1;
    let intermediate: ReadableStream<Uint8Array> | undefined;
    let convertInput: unknown;

    const engine: JobEngine = {
      trim(input, opts, call = {}) {
        void call;
        if (input === source) sourceOpens++;
        expect(opts.sink).toEqual(toStream());
        // Simulated packet copy of the trim window [1, 4): lazy, pull-driven, chunked — no decode.
        const window = source.subarray(1, 4);
        let offset = 0;
        intermediate = new ReadableStream<Uint8Array>(
          {
            pull(controller): void {
              trimPulls++;
              if (offset >= window.byteLength) {
                controller.close();
                return;
              }
              const next = Math.min(offset + 2, window.byteLength);
              controller.enqueue(window.subarray(offset, next));
              offset = next;
            },
          },
          { highWaterMark: 0 },
        );
        return cancellable(Promise.resolve(intermediate));
      },
      convert(input, opts, call = {}) {
        void call;
        if (input === source) sourceOpens++;
        convertInput = input;
        trimPullsWhenConvertStarted = trimPulls;
        expect(opts).not.toHaveProperty('sink');
        decodes++;
        const run = (async (): Promise<Blob> => {
          const reader = (input as ReadableStream<Uint8Array>).getReader();
          const bytes: number[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const byte of value) bytes.push(byte + 1); // the single simulated re-encode
          }
          encodes++;
          return new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
        })();
        return cancellable(run);
      },
      remux: vi.fn(),
      decrypt: vi.fn(),
    };

    const result = await runMediaJob(
      engine,
      baseJob({
        input: source,
        ops: [
          { op: 'trim', start: 1, end: 4 },
          { op: 'resize', width: 640, height: 360 },
        ],
        output: { container: 'mp4', video: { codec: 'h264' } },
      }),
    );

    expect(sourceOpens).toBe(1);
    expect(decodes).toBe(1);
    expect(encodes).toBe(1);
    // The exact lazily-produced stream is what convert consumed — no hidden rematerialization…
    expect(convertInput).toBe(intermediate);
    // …and nothing had drained it before the downstream op pulled (true pipe, not a buffered copy).
    expect(trimPullsWhenConvertStarted).toBe(0);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([21, 31, 41]));
  });

  it('validates and snapshots the complete serializable video/audio target schema', async () => {
    const output = new Blob(['done']);
    const { engine, calls } = host([output]);
    await runMediaJob(
      engine,
      baseJob({
        output: {
          container: 'mp4',
          video: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            fit: 'contain',
            fps: 29.97,
            bitrate: 4_000_000,
            bitrateMode: 'constant',
            twoPass: true,
            bitDepth: 8,
            alpha: 'discard',
            rotate: 180,
            flip: 'v',
            crop: { x: 2, y: 4, width: 1280, height: 720 },
            pad: { width: 2048, height: 1152, x: 10, y: 12 },
            colorspace: { to: 'bt2020' },
            tonemap: { to: 'sdr' },
          },
          audio: {
            codec: 'pcm-f64be',
            sampleRate: 48_000,
            channels: 2,
            bitrate: 256_000,
            gainDb: -3,
            fade: { inSec: 0.1, outSec: 0.2, curve: 'equal-power' },
            dynamics: {
              normalize: { mode: 'rms', targetDbfs: -18 },
              limit: { ceilingDbfs: -1, mode: 'soft', knee: 2 },
            },
            biquad: [
              { type: 'lowpass', frequency: 12_000, q: Math.SQRT1_2 },
              { type: 'peaking', frequency: 1_000, q: 2, gainDb: 4 },
            ],
          },
          faststart: false,
          fragmented: true,
        },
      }),
    );

    expect(calls[0]).toMatchObject({
      op: 'convert',
      opts: {
        to: 'mp4',
        video: {
          pad: { width: 2048, height: 1152, x: 10, y: 12 },
          colorspace: { to: 'bt2020' },
          tonemap: { to: 'sdr' },
        },
        audio: {
          dynamics: {
            normalize: { mode: 'rms', targetDbfs: -18 },
            limit: { ceilingDbfs: -1, mode: 'soft', knee: 2 },
          },
          biquad: [
            { type: 'lowpass', frequency: 12_000, q: Math.SQRT1_2 },
            { type: 'peaking', frequency: 1_000, q: 2, gainDb: 4 },
          ],
        },
        faststart: false,
        fragmented: true,
      },
    });

    const crfOutput = new Blob(['crf']);
    const crfHost = host([crfOutput]);
    await runMediaJob(
      crfHost.engine,
      baseJob({
        output: {
          container: 'webm',
          video: { codec: 'vp9', crf: 32, bitDepth: 10 },
          audio: { biquad: { type: 'notch', frequency: 1_000, q: 1 } },
        },
      }),
    );
    expect(crfHost.calls[0]).toMatchObject({
      opts: {
        to: 'webm',
        video: { codec: 'vp9', crf: 32, bitDepth: 10 },
        audio: { biquad: { type: 'notch', frequency: 1_000, q: 1 } },
      },
    });
  });

  it('accepts every declared output container token', async () => {
    const containers = [
      'mp4',
      'mov',
      'webm',
      'mkv',
      'ogg',
      'wav',
      'mp3',
      'aac',
      'adts',
      'flac',
      'aiff',
      'caf',
      'avi',
      'ts',
      'm2ts',
      'mts',
      'mpegts',
    ] as const;
    for (const container of containers) {
      const { engine, calls } = host([new Blob([container])]);
      await runMediaJob(engine, baseJob({ output: { container } }));
      expect(calls[0]).toMatchObject({ opts: { to: container } });
    }
  });

  it('fuses canonical transforms and flushes when fusion would reorder or repeat them', async () => {
    const first = new Blob(['first']);
    const final = new Blob(['final']);
    const { engine, calls } = host([first, final]);

    await runMediaJob(
      engine,
      baseJob({
        ops: [
          { op: 'resize', width: 640, height: 360, fit: 'cover' },
          { op: 'crop', x: 10, y: 12, width: 300, height: 200 },
          { op: 'pad', width: 400, height: 240, x: 2, y: 3 },
          { op: 'rotate', degrees: 90 },
          { op: 'flip', axis: 'h' },
          { op: 'colorspace', to: 'bt2020' },
          { op: 'tonemap' },
        ],
        output: { container: 'webm', video: { codec: 'vp9' }, audio: false },
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      op: 'convert',
      opts: { video: { width: 640, height: 360, fit: 'cover' }, sink: toStream() },
    });
    expect(calls[1]).toMatchObject({
      op: 'convert',
      input: first,
      opts: {
        to: 'webm',
        video: {
          codec: 'vp9',
          crop: { x: 10, y: 12, width: 300, height: 200 },
          pad: { width: 400, height: 240, x: 2, y: 3 },
          rotate: 90,
          flip: 'h',
          colorspace: { to: 'bt2020' },
          tonemap: { to: 'sdr' },
        },
        audio: false,
      },
    });
  });

  it('fuses into explicit/final targets only when their own transforms preserve declared order', async () => {
    const safeIntermediate = new Blob(['safe']);
    const safeFinal = new Blob(['safe-final']);
    const safe = host([safeIntermediate, safeFinal]);
    await runMediaJob(
      safe.engine,
      baseJob({
        ops: [
          { op: 'crop', x: 1, y: 2, width: 640, height: 360 },
          { op: 'convert', to: 'webm', video: { codec: 'vp9', width: 320, height: 180 } },
        ],
      }),
    );
    expect(safe.calls).toHaveLength(2);
    expect(safe.calls[0]).toMatchObject({
      op: 'convert',
      opts: {
        to: 'webm',
        video: {
          codec: 'vp9',
          crop: { x: 1, y: 2, width: 640, height: 360 },
          width: 320,
          height: 180,
        },
        sink: toStream(),
      },
    });

    const resized = new Blob(['resized']);
    const cropped = new Blob(['cropped']);
    const unsafeFinal = new Blob(['unsafe-final']);
    const unsafe = host([resized, cropped, unsafeFinal]);
    await runMediaJob(
      unsafe.engine,
      baseJob({
        ops: [
          { op: 'resize', width: 640, height: 360 },
          {
            op: 'convert',
            to: 'webm',
            video: { codec: 'vp9', crop: { x: 1, y: 2, width: 320, height: 180 } },
          },
        ],
      }),
    );
    expect(unsafe.calls).toHaveLength(3);
    expect(unsafe.calls[0]).toMatchObject({
      opts: { video: { width: 640, height: 360 }, sink: toStream() },
    });
    expect(unsafe.calls[1]).toMatchObject({
      input: resized,
      opts: {
        to: 'webm',
        video: { codec: 'vp9', crop: { x: 1, y: 2, width: 320, height: 180 } },
        sink: toStream(),
      },
    });

    const outputUnsafe = host([new Blob(['resize']), new Blob(['final'])]);
    await runMediaJob(
      outputUnsafe.engine,
      baseJob({
        ops: [{ op: 'resize', width: 640, height: 360 }],
        output: {
          container: 'mp4',
          video: { crop: { x: 0, y: 0, width: 320, height: 180 } },
        },
      }),
    );
    expect(outputUnsafe.calls).toHaveLength(2);
    expect(outputUnsafe.calls[0]).toMatchObject({ opts: { video: { width: 640, height: 360 } } });
    expect(outputUnsafe.calls[1]).toMatchObject({
      opts: { to: 'mp4', video: { crop: { x: 0, y: 0, width: 320, height: 180 } } },
    });
  });

  it('dispatches explicit convert, remux, and decrypt through lazy stream boundaries', async () => {
    const converted = new Blob(['converted']);
    const remuxed = new Blob(['remuxed']);
    const clear = new Blob(['clear']);
    const final = new Blob(['final']);
    const { engine, calls } = host([converted, remuxed, clear, final]);

    await runMediaJob(
      engine,
      baseJob({
        ops: [
          { op: 'convert', to: 'webm', video: { codec: 'vp9' }, audio: false },
          {
            op: 'remux',
            to: 'mkv',
            faststart: false,
            fragmented: true,
            tags: { title: 'clear' },
            trackSelect: ['video:0', 'audio:0'],
          },
          { op: 'decrypt', scheme: 'cenc', keys: { abc: '0011' } },
        ],
        output: { container: 'mp4', video: { codec: 'h264' } },
      }),
    );

    expect(calls.map((call) => call.op)).toEqual(['convert', 'remux', 'decrypt', 'convert']);
    expect(calls[0]).toMatchObject({
      opts: { to: 'webm', video: { codec: 'vp9' }, audio: false, sink: toStream() },
    });
    expect(calls[1]).toMatchObject({
      input: converted,
      opts: {
        to: 'mkv',
        faststart: false,
        fragmented: true,
        tags: { title: 'clear' },
        trackSelect: ['video:0', 'audio:0'],
        sink: toStream(),
      },
    });
    expect(calls[2]).toMatchObject({
      input: remuxed,
      opts: { scheme: 'cenc', keys: { abc: '0011' }, sink: toStream() },
    });
    expect(calls[3]).toMatchObject({ input: clear, opts: { to: 'mp4', video: { codec: 'h264' } } });
  });

  it.each([
    baseJob({ ops: [{ op: 'trim', start: 2, end: 1 }] }),
    baseJob({ ops: [{ op: 'trim', start: 0, end: 1, mode: 'nearest' as 'accurate' }] }),
    baseJob({ ops: [{ op: 'resize', width: 0, height: 720 }] }),
    baseJob({ ops: [{ op: 'resize', width: 1.5, height: 720 }] }),
    baseJob({ ops: [{ op: 'resize', width: 1, height: 1, fit: 'inside' as 'contain' }] }),
    baseJob({ ops: [{ op: 'rotate', degrees: 45 as 90 }] }),
    baseJob({ ops: [{ op: 'flip', axis: 'x' as 'h' }] }),
    baseJob({ ops: [{ op: 'colorspace', to: '   ' }] }),
    baseJob({ ops: [{ op: 'tonemap', to: 'hdr' as 'sdr' }] }),
    baseJob({ ops: [{ op: 'mystery' } as never] }),
    baseJob({ ops: [{ op: 7 } as never] }),
    baseJob({ ops: {} as never }),
    baseJob({ ops: [{ op: 'decrypt', scheme: 'ctr' as 'cenc', keys: {} }] }),
    baseJob({ ops: [{ op: 'decrypt', scheme: 'cenc', keys: { bad: 7 } as never }] }),
    baseJob({ ops: [{ op: 'remux', to: 'mp4', trackSelect: [''] }] }),
    baseJob({
      ops: [
        { op: 'resize', width: 1, height: 1 },
        { op: 'convert', video: false },
      ],
    }),
    baseJob({
      ops: [{ op: 'resize', width: 1, height: 1 }],
      output: { container: 'mp4', video: false },
    }),
    baseJob({ output: { container: 'unknown' as 'mp4' } }),
    baseJob({ output: { container: 'mp4', video: { width: Number.NaN } } }),
    baseJob({ output: { container: 'mp4', video: { bitrate: 1.5 } } }),
    baseJob({ output: { container: 'mp4', video: { codec: 'h264', crf: 52 } } }),
    baseJob({ output: { container: 'mp4', video: { bitrate: 1_000, crf: 20 } } }),
    baseJob({ output: { container: 'mp4', video: { twoPass: true } } }),
    baseJob({ output: { container: 'mp4', video: { codec: 'mpeg2' as 'h264' } } }),
    baseJob({ output: { container: 'mp4', video: { alpha: 'premultiply' as 'keep' } } }),
    baseJob({
      output: { container: 'mp4', video: { crop: { x: -1, y: 0, width: 1, height: 1 } } },
    }),
    baseJob({ output: { container: 'mp4', video: { pad: { width: 0, height: 1 } } } }),
    baseJob({ output: { container: 'mp4', video: { colorspace: { to: '' } } } }),
    baseJob({ output: { container: 'mp4', video: { tonemap: { to: 'hdr' as 'sdr' } } } }),
    baseJob({ output: { container: 'mp4', audio: { fade: { inSec: -1 } } } }),
    baseJob({ output: { container: 'mp4', audio: { bitrate: 0 } } }),
    baseJob({ output: { container: 'mp4', audio: { fade: { curve: 'log' as 'linear' } } } }),
    baseJob({ output: { container: 'mp4', audio: { dynamics: {} } } }),
    baseJob({
      output: {
        container: 'mp4',
        audio: { dynamics: { normalize: { mode: 'ebu' as 'peak', targetDbfs: -18 } } },
      },
    }),
    baseJob({
      output: {
        container: 'mp4',
        audio: { dynamics: { limit: { mode: 'brickwall' as 'hard' } } },
      },
    }),
    baseJob({
      output: {
        container: 'mp4',
        audio: { biquad: { type: 'peaking', frequency: 1_000, q: 1 } },
      },
    }),
    baseJob({
      output: {
        container: 'mp4',
        audio: { biquad: { type: 'unknown' as 'lowpass', frequency: 1_000, q: 1 } },
      },
    }),
    baseJob({ output: { container: 'mp4', faststart: 'yes' as never } }),
    baseJob({ output: { container: 'mp4', sink: toBlob() } as never }),
    baseJob({ ops: [{ op: 'convert', to: 'mp4', sink: toBlob() } as never] }),
    baseJob({ input: 42 as never }),
    baseJob({ input: undefined as never }),
    baseJob({ input: new URL('https://example.invalid/media.mp4') as never }),
    baseJob({
      input: { __media: 'source', kind: 'bytes', stream: () => new ReadableStream() } as never,
    }),
  ])('preflights the complete malformed job before invoking the engine', async (job) => {
    const { engine, calls } = host([new Blob()]);
    await expect(runMediaJob(engine, job)).rejects.toBeInstanceOf(InputError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed later operation before consuming a one-shot input', async () => {
    let pulls = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { engine, calls } = host([new Blob()]);

    await expect(
      runMediaJob(
        engine,
        baseJob({
          input,
          ops: [
            { op: 'trim', start: 0, end: 1 },
            { op: 'resize', width: Number.NaN, height: 1 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InputError);
    expect(calls).toHaveLength(0);
    expect(pulls).toBe(0);
  });

  it.each([
    new ArrayBuffer(4),
    new Uint16Array([1, 2]),
    new Blob(['media']),
    'https://example.invalid/media.mp4',
    new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
  ])('accepts structured-clone/transfer-safe job input %#', async (input) => {
    const output = new Blob(['done']);
    const { engine, calls } = host([output]);
    await expect(runMediaJob(engine, baseJob({ input }))).resolves.toBe(output);
    expect(calls[0]?.input).toBe(input);
  });

  it('rejects a locked transferable stream before invoking the engine', async () => {
    const input = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const reader = input.getReader();
    const { engine, calls } = host([new Blob()]);
    try {
      await expect(runMediaJob(engine, baseJob({ input }))).rejects.toBeInstanceOf(InputError);
      expect(calls).toHaveLength(0);
    } finally {
      reader.releaseLock();
    }
  });

  it('rejects accessor-backed objects and arrays without invoking their getters', async () => {
    let reads = 0;
    const accessorOperation: Record<string, unknown> = {};
    Object.defineProperty(accessorOperation, 'op', {
      enumerable: true,
      get() {
        reads++;
        return 'trim';
      },
    });
    const accessorOps: unknown[] = [];
    Object.defineProperty(accessorOps, '0', {
      enumerable: true,
      get() {
        reads++;
        return { op: 'trim', start: 0, end: 1 };
      },
    });
    const first = host([new Blob()]);
    const second = host([new Blob()]);

    await expect(
      runMediaJob(first.engine, baseJob({ ops: [accessorOperation as never] })),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      runMediaJob(second.engine, baseJob({ ops: accessorOps as never })),
    ).rejects.toBeInstanceOf(InputError);
    expect(reads).toBe(0);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it('rejects named array properties instead of silently dropping non-schema job data', async () => {
    const ops = [{ op: 'trim', start: 0, end: 1 }];
    Object.defineProperty(ops, 'hiddenIntent', {
      enumerable: true,
      value: { op: 'resize', width: 1, height: 1 },
    });
    const { engine, calls } = host([new Blob()]);

    await expect(
      runMediaJob(engine, baseJob({ ops: ops as MediaJob['ops'] })),
    ).rejects.toBeInstanceOf(InputError);
    expect(calls).toHaveLength(0);
  });

  it('rejects non-pipeable intermediate and non-Blob final results', async () => {
    const badIntermediate = host([undefined, new Blob()]);
    await expect(
      runMediaJob(badIntermediate.engine, baseJob({ ops: [{ op: 'trim', start: 0, end: 1 }] })),
    ).rejects.toBeInstanceOf(InputError);
    expect(badIntermediate.calls).toHaveLength(1);

    const badFinal = host([undefined]);
    await expect(runMediaJob(badFinal.engine, baseJob())).rejects.toBeInstanceOf(InputError);

    // The final default sink is a materialized Blob — a raw stream terminal result is a defect.
    const streamFinal = host([new ReadableStream<Uint8Array>()]);
    await expect(runMediaJob(streamFinal.engine, baseJob())).rejects.toBeInstanceOf(InputError);
  });

  it('snapshots validated targets before awaiting an intermediate stage', async () => {
    const firstStage = deferred<Output>();
    const calls: RecordedCall[] = [];
    const engine: JobEngine = {
      trim(input, opts, call = {}) {
        calls.push({ op: 'trim', input, opts, call });
        return cancellable(firstStage.promise);
      },
      convert(input, opts, call = {}) {
        calls.push({ op: 'convert', input, opts, call });
        return cancellable(Promise.resolve(new Blob(['done'])));
      },
      remux: vi.fn(),
      decrypt: vi.fn(),
    };
    const video: { codec: 'h264' | 'vp9'; bitrate: number } = {
      codec: 'h264',
      bitrate: 2_000_000,
    };
    const result = runMediaJob(
      engine,
      baseJob({
        ops: [{ op: 'trim', start: 0, end: 1 }],
        output: { container: 'mp4', video },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    video.codec = 'vp9';
    video.bitrate = 1;
    firstStage.resolve(new Blob(['trimmed']));
    await result;

    expect(calls[1]).toMatchObject({
      opts: { to: 'mp4', video: { codec: 'h264', bitrate: 2_000_000 } },
    });
  });

  it('normalizes every flat operation onto one monotonic progress timeline', async () => {
    const progress: Array<{ done: number; total?: number; stage: string }> = [];
    const first = new Blob(['first']);
    const final = new Blob(['final']);
    const firstStage = deferred<Output>();
    const finalStage = deferred<Output>();
    const calls: RecordedCall[] = [];
    const engine: JobEngine = {
      trim(input, opts, call = {}) {
        calls.push({ op: 'trim', input, opts, call });
        return cancellable(firstStage.promise);
      },
      convert(input, opts, call = {}) {
        calls.push({ op: 'convert', input, opts, call });
        return cancellable(finalStage.promise);
      },
      remux: vi.fn(),
      decrypt: vi.fn(),
    };
    const promise = runMediaJob(engine, baseJob({ ops: [{ op: 'trim', start: 0, end: 1 }] }), {
      onProgress: (event) => progress.push(event),
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]?.call.onProgress?.({ done: 0, total: 10, stage: 'demux' });
    calls[0]?.call.onProgress?.({ done: 5, total: 10, stage: 'trim' });
    firstStage.resolve(first);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0]?.call.onProgress?.({ done: 10, total: 10, stage: 'late-after-resolve' });
    calls[1]?.call.onProgress?.({ done: 2, total: 8, stage: 'encode' });
    finalStage.resolve(final);
    await promise;

    expect(progress.map(({ done }) => done)).toEqual([0, 0.5, 1, 1.25, 2]);
    expect(progress.every(({ total }) => total === 2)).toBe(true);
    expect(progress.map(({ stage }) => stage)).toEqual([
      'job:1/2:trim:demux',
      'job:1/2:trim:trim',
      'job:1/2:trim',
      'job:2/2:convert:encode',
      'job:2/2:convert',
    ]);
  });

  it('rejects an already-aborted job before invoking the engine', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, calls } = host([new Blob()]);

    const error = await runMediaJob(engine, baseJob(), { signal: controller.signal }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('removes the caller abort listener after successful completion', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { engine } = host([new Blob(['done'])]);

    await runMediaJob(engine, baseJob(), { signal: controller.signal });

    const registered = add.mock.calls.find(([type]) => type === 'abort');
    expect(registered).toBeDefined();
    expect(remove).toHaveBeenCalledWith('abort', registered?.[1]);
  });

  it('closes a synchronous abort race while the active handle is being returned', async () => {
    const parent = new AbortController();
    const active = deferred<Output>();
    const cancel = vi.fn(() => active.reject(new Error('cancelled')));
    const engine: JobEngine = {
      convert() {
        parent.abort();
        return cancellable(active.promise, cancel);
      },
      trim: vi.fn(),
      remux: vi.fn(),
      decrypt: vi.fn(),
    };

    const error = await runMediaJob(engine, baseJob(), { signal: parent.signal }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['handle', 'signal'] as const)(
    'cancels the active operation exactly once via %s',
    async (mode) => {
      let rejectActive: (reason: unknown) => void = () => undefined;
      const active = new Promise<Output>((_resolve, reject) => {
        rejectActive = reject;
      });
      const cancel = vi.fn(() => rejectActive(new Error('flat operation cancelled')));
      const seenSignals: AbortSignal[] = [];
      const engine: JobEngine = {
        convert(_input, _opts, call = {}) {
          if (call.signal !== undefined) seenSignals.push(call.signal);
          return cancellable(active, cancel);
        },
        trim: vi.fn(),
        remux: vi.fn(),
        decrypt: vi.fn(),
      };
      const controller = new AbortController();
      const result = runMediaJob(engine, baseJob(), { signal: controller.signal });
      await vi.waitFor(() => expect(seenSignals).toHaveLength(1));

      if (mode === 'handle') result.cancel();
      else controller.abort();

      const error = await result.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(MediaError);
      expect((error as MediaError).code).toBe('aborted');
      expect(seenSignals[0]?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});
