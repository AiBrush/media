import { describe, expect, it } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import { type Source, cancelSource, fromBytes, fromStream, peekSourceHead } from './source.ts';

describe('one-shot source terminal branches', () => {
  it('rejects an unnormalized stream-shaped source and a pre-consumed normalized source', async () => {
    const unnormalized: Source = {
      __media: 'source',
      kind: 'stream',
      stream: () => new ReadableStream<Uint8Array>(),
    };
    await expect(peekSourceHead(unnormalized, 1)).rejects.toBeInstanceOf(InputError);

    const normalized = fromStream(fromBytes(Uint8Array.of(1)).stream());
    await normalized.stream().cancel('consumed directly');
    await expect(peekSourceHead(normalized, 1)).rejects.toBeInstanceOf(InputError);
  });

  it('cancels an untouched producer once, contains cancel rejection, and makes ownership terminal', async () => {
    let cancels = 0;
    const src = fromStream(
      new ReadableStream<Uint8Array>({
        cancel(): Promise<void> {
          cancels++;
          return Promise.reject(new Error('producer cancel failed'));
        },
      }),
    );

    await cancelSource(src, 'unused');
    await cancelSource(src, 'duplicate');

    expect(cancels).toBe(1);
    expect(() => src.stream()).toThrowError(InputError);
  });

  it('rejects ownership transfer while a peek is pending and cancel releases that reader', async () => {
    let pullStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    const src = fromStream(
      new ReadableStream<Uint8Array>(
        {
          pull(): void {
            pullStarted();
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const peek = peekSourceHead(src, 4);
    await started;

    expect(() => src.stream()).toThrowError(/routing read pending/);
    await cancelSource(src, 'stop');
    await cancelSource(src, 'stop again');
    await expect(peek).resolves.toEqual(new Uint8Array());
    expect(() => src.stream()).toThrowError(InputError);
  });

  it('replays retained chunks then closes immediately when the routing peek already reached EOF', async () => {
    const src = fromStream(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(Uint8Array.of(1, 2));
          controller.enqueue(Uint8Array.of(3));
          controller.close();
        },
      }),
    );
    expect(await peekSourceHead(src, 99)).toEqual(Uint8Array.of(1, 2, 3));

    const reader = src.stream().getReader();
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(1, 2) });
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(3) });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  it('maps a producer failure after retained replay to a typed input error and releases ownership', async () => {
    let pulls = 0;
    const src = fromStream(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            if (pulls++ === 0) controller.enqueue(Uint8Array.of(9));
            else controller.error(new Error('source broke'));
          },
        },
        { highWaterMark: 0 },
      ),
    );
    expect(await peekSourceHead(src, 1)).toEqual(Uint8Array.of(9));
    const reader = src.stream().getReader();
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(9) });
    await expect(reader.read()).rejects.toBeInstanceOf(InputError);
    reader.releaseLock();
  });

  it('preserves an existing typed aborted reason across the pre-read abort boundary', async () => {
    const reason = new MediaError('aborted', 'caller stopped');
    const controller = new AbortController();
    let pullStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    const src = fromStream(
      new ReadableStream<Uint8Array>(
        {
          pull(): void {
            pullStarted();
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const peek = peekSourceHead(src, 1, controller.signal);
    await started;
    controller.abort(reason);
    await expect(peek).rejects.toBe(reason);
  });
});
