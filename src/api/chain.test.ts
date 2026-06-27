import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import type { Sink } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import { createMediaChain } from './chain.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  DecryptOptions,
  MediaChain,
  Output,
  RemuxOptions,
  TrimOptions,
} from './types.ts';

type RecordedCall =
  | {
      readonly kind: 'convert';
      readonly input: MediaInput;
      readonly opts: ConvertOptions;
      readonly callOptions: CallOptions | undefined;
    }
  | {
      readonly kind: 'trim';
      readonly input: MediaInput;
      readonly opts: TrimOptions;
      readonly callOptions: CallOptions | undefined;
    }
  | {
      readonly kind: 'remux';
      readonly input: MediaInput;
      readonly opts: RemuxOptions;
      readonly callOptions: CallOptions | undefined;
    }
  | {
      readonly kind: 'decrypt';
      readonly input: MediaInput;
      readonly opts: DecryptOptions;
      readonly callOptions: CallOptions | undefined;
    };

interface FakeEngine {
  readonly calls: RecordedCall[];
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
}

type OutputResolver = (sink: Sink | undefined, label: string) => Output;

function fakeEngine(): FakeEngine {
  return fakeEngineWithResolver(outputForSink);
}

function constantEngine(output: Output): FakeEngine {
  return fakeEngineWithResolver(() => output);
}

function fakeEngineWithResolver(resolveOutput: OutputResolver): FakeEngine {
  const calls: RecordedCall[] = [];
  return {
    calls,
    convert(input, opts, o): Cancellable<Output> {
      calls.push({ kind: 'convert', input, opts, callOptions: o });
      return resolved(resolveOutput(opts.sink, 'convert'));
    },
    trim(input, opts, o): Cancellable<Output> {
      calls.push({ kind: 'trim', input, opts, callOptions: o });
      return resolved(resolveOutput(opts.sink, 'trim'));
    },
    remux(input, opts, o): Cancellable<Output> {
      calls.push({ kind: 'remux', input, opts, callOptions: o });
      return resolved(resolveOutput(opts.sink, 'remux'));
    },
    decrypt(input, opts, o): Cancellable<Output> {
      calls.push({ kind: 'decrypt', input, opts, callOptions: o });
      return resolved(resolveOutput(opts.sink, 'decrypt'));
    },
  };
}

function resolved<T>(value: T): Cancellable<T> {
  const promise = Promise.resolve(value) as Cancellable<T>;
  promise.cancel = (): void => {};
  return promise;
}

function outputForSink(sink: Sink | undefined, label: string): Output {
  switch (sink?.kind ?? 'blob') {
    case 'blob':
      return new Blob([label]);
    case 'file':
      return sink?.kind === 'file' ? new File([label], sink.name) : undefined;
    case 'stream':
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(label));
          controller.close();
        },
      });
    default:
      return undefined;
  }
}

describe('MediaChain', () => {
  it('runs ordered flat ops and materializes intermediate steps as blobs', async () => {
    const engine = fakeEngine();
    const input = new Uint8Array([1, 2, 3]);

    const out = await createMediaChain(engine, input)
      .trim({ start: 1, end: 2, mode: 'accurate' })
      .resize(320, 180, 'contain')
      .convert({ to: 'mp4', audio: { codec: 'aac' } })
      .blob();

    expect(out).toBeInstanceOf(Blob);
    expect(engine.calls.map((c) => c.kind)).toEqual(['trim', 'convert']);
    expect(engine.calls[0]?.input).toBe(input);
    expect(engine.calls[0]?.opts).toMatchObject({
      start: 1,
      end: 2,
      mode: 'accurate',
      sink: { kind: 'blob' },
    });
    expect(engine.calls[1]?.input).toBeInstanceOf(Blob);
    expect(engine.calls[1]?.opts).toMatchObject({
      to: 'mp4',
      video: { width: 320, height: 180, fit: 'contain' },
      audio: { codec: 'aac' },
      sink: { kind: 'blob' },
    });
  });

  it('folds fluent video sugar into one convert operation when no earlier op forces a boundary', async () => {
    const engine = fakeEngine();

    await createMediaChain(engine, new Uint8Array([4]))
      .resize(64, 64, 'cover')
      .crop({ x: 1, y: 2, width: 32, height: 24 })
      .rotate(90)
      .flip('h')
      .colorspace('bt2020')
      .tonemap()
      .to('webm')
      .blob();

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.kind).toBe('convert');
    expect(engine.calls[0]?.opts).toMatchObject({
      to: 'webm',
      video: {
        width: 64,
        height: 64,
        fit: 'cover',
        crop: { x: 1, y: 2, width: 32, height: 24 },
        rotate: 90,
        flip: 'h',
        colorspace: { to: 'bt2020' },
        tonemap: { to: 'sdr' },
      },
      sink: { kind: 'blob' },
    });
  });

  it('injects file and stream terminal sinks into the final operation', async () => {
    const fileEngine = fakeEngine();
    const file = await createMediaChain(fileEngine, new Uint8Array([5]))
      .convert({ to: 'mp4' })
      .file('clip.mp4');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('clip.mp4');
    expect(fileEngine.calls[0]?.opts.sink).toEqual({ kind: 'file', name: 'clip.mp4' });

    const streamEngine = fakeEngine();
    const stream = await createMediaChain(streamEngine, new Uint8Array([6]))
      .convert({ to: 'mp4' })
      .stream();
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(streamEngine.calls[0]?.opts.sink).toEqual({ kind: 'stream' });
  });

  it('supports run, remux, decrypt, and explicit audio/video disable sugar', async () => {
    const engine = fakeEngine();

    const out = await createMediaChain(engine, new Uint8Array([8]))
      .remux({ to: 'mkv', fragmented: true })
      .decrypt({ scheme: 'cenc', keys: { keyId: '00112233' } })
      .video(false)
      .audio(false)
      .to('mp4')
      .run();

    expect(out).toBeInstanceOf(Blob);
    expect(engine.calls.map((c) => c.kind)).toEqual(['remux', 'decrypt', 'convert']);
    expect(engine.calls[0]?.opts).toMatchObject({
      to: 'mkv',
      fragmented: true,
      sink: { kind: 'blob' },
    });
    expect(engine.calls[1]?.opts).toMatchObject({
      scheme: 'cenc',
      keys: { keyId: '00112233' },
      sink: { kind: 'blob' },
    });
    expect(engine.calls[2]?.opts).toEqual({ video: false, audio: false, to: 'mp4' });
  });

  it('accepts an empty convert option object and links terminal abort signals', async () => {
    const parent = new AbortController();
    parent.abort();
    const engine = fakeEngine();

    const out = await createMediaChain(engine, new Uint8Array([9]))
      .convert()
      .blob({
        signal: parent.signal,
      });

    expect(out).toBeInstanceOf(Blob);
    expect(engine.calls[0]?.opts).toEqual({ sink: { kind: 'blob' } });
    expect(engine.calls[0]?.callOptions?.signal?.aborted).toBe(true);
  });

  it('propagates fluent cancellation into the operation signal', async () => {
    const engine = fakeEngine();
    const op = createMediaChain(engine, new Uint8Array([10]))
      .resize(320, 180)
      .blob();

    op.cancel();
    const out = await op;

    expect(out).toBeInstanceOf(Blob);
    expect(engine.calls[0]?.opts).toMatchObject({
      video: { width: 320, height: 180 },
      sink: { kind: 'blob' },
    });
    expect(engine.calls[0]?.callOptions?.signal?.aborted).toBe(true);
  });

  it('supports proxy symbol reads and cancellation after the lazy operation has become active', async () => {
    const engine = fakeEngine();
    const chain = createMediaChain(engine, new Uint8Array([10]));
    expect(Reflect.get(chain, Symbol.toStringTag)).toBeUndefined();

    const op = chain.convert({ to: 'mp4' }).blob();
    await expect(op).resolves.toBeInstanceOf(Blob);
    op.cancel();
    expect(engine.calls[0]?.callOptions?.signal?.aborted).toBe(true);
  });

  it('rejects an empty chain instead of inventing a no-op output', async () => {
    const engine = fakeEngine();
    await expect(createMediaChain(engine, new Uint8Array([7])).blob()).rejects.toBeInstanceOf(
      InputError,
    );
    expect(engine.calls).toEqual([]);
  });

  it('rejects malformed fluent steps with typed InputErrors before dispatch', async () => {
    const invalidMethod = createMediaChain(fakeEngine(), new Uint8Array([11])) as unknown as Record<
      'nonsense',
      () => MediaChain
    >;
    await expect(invalidMethod.nonsense().blob()).rejects.toBeInstanceOf(InputError);

    const invalidCalls: readonly {
      readonly run: (chain: MediaChain) => Cancellable<unknown>;
    }[] = [
      { run: (chain) => chain.resize(Number.NaN, 1).blob() },
      { run: (chain) => chain.colorspace('').blob() },
      { run: (chain) => chain.convert('bad options' as unknown as ConvertOptions).blob() },
      { run: (chain) => chain.video('bad video target' as unknown as false).blob() },
      {
        run: (chain) =>
          chain.crop('bad crop' as unknown as Parameters<MediaChain['crop']>[0]).blob(),
      },
      { run: (chain) => chain.file('') },
      { run: (chain) => chain.blob('bad call options' as unknown as CallOptions) },
    ];

    for (const invalidCall of invalidCalls) {
      const engine = fakeEngine();
      await expect(
        invalidCall.run(createMediaChain(engine, new Uint8Array([12]))),
      ).rejects.toBeInstanceOf(InputError);
      expect(engine.calls).toEqual([]);
    }
  });

  it('rejects terminal output shape mismatches with typed InputErrors', async () => {
    await expect(
      createMediaChain(constantEngine(undefined), new Uint8Array([13]))
        .convert({ to: 'mp4' })
        .blob(),
    ).rejects.toBeInstanceOf(InputError);

    await expect(
      createMediaChain(constantEngine(new Blob(['not a file'])), new Uint8Array([14]))
        .convert({ to: 'mp4' })
        .file('clip.mp4'),
    ).rejects.toBeInstanceOf(InputError);

    await expect(
      createMediaChain(constantEngine(new Blob(['not a stream'])), new Uint8Array([15]))
        .convert({ to: 'mp4' })
        .stream(),
    ).rejects.toBeInstanceOf(InputError);
  });
});
