import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { type Sink, materialize, toElement } from './sink.ts';

function bytesStream(...chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

function chunkedStream(bytes: Uint8Array, chunkBytes = 4096): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
}

function bytesOf(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source).slice();
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

function merge(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `byte mismatch at ${index}: got ${String(actual[index])}, expected ${String(expected[index])}`,
      );
    }
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

class TestSourceBuffer extends EventTarget {
  static autoComplete = true;
  static appendError: unknown;
  static abortError: unknown;

  readonly appended: Uint8Array[] = [];
  updating = false;
  abortCount = 0;

  appendBuffer(source: BufferSource): void {
    if (TestSourceBuffer.appendError !== undefined) throw TestSourceBuffer.appendError;
    if (this.updating) throw new DOMException('append already in progress', 'InvalidStateError');
    this.appended.push(bytesOf(source));
    this.updating = true;
    if (TestSourceBuffer.autoComplete) queueMicrotask(() => this.complete());
  }

  complete(): void {
    if (!this.updating) return;
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }

  fail(): void {
    if (!this.updating) return;
    this.updating = false;
    this.dispatchEvent(new Event('error'));
  }

  abort(): void {
    this.abortCount++;
    if (TestSourceBuffer.abortError !== undefined) throw TestSourceBuffer.abortError;
    if (!this.updating) return;
    this.updating = false;
    this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('updateend'));
  }
}

class TestMediaSource extends EventTarget {
  static instances: TestMediaSource[] = [];
  static supported = true;
  static supportError: unknown;
  static constructionError: unknown;
  static addSourceBufferError: unknown;
  static endOfStreamError: unknown;

  static isTypeSupported(_mime: string): boolean {
    if (TestMediaSource.supportError !== undefined) throw TestMediaSource.supportError;
    return TestMediaSource.supported;
  }

  readyState: ReadyState = 'closed';
  readonly sourceBuffer = new TestSourceBuffer();
  readonly addedMimes: string[] = [];
  readonly endErrors: (EndOfStreamError | undefined)[] = [];

  constructor() {
    super();
    if (TestMediaSource.constructionError !== undefined) throw TestMediaSource.constructionError;
    TestMediaSource.instances.push(this);
  }

  addSourceBuffer(mime: string): SourceBuffer {
    if (TestMediaSource.addSourceBufferError !== undefined) {
      throw TestMediaSource.addSourceBufferError;
    }
    if (this.readyState !== 'open') throw new DOMException('source is closed', 'InvalidStateError');
    this.addedMimes.push(mime);
    return this.sourceBuffer as unknown as SourceBuffer;
  }

  endOfStream(error?: EndOfStreamError): void {
    if (TestMediaSource.endOfStreamError !== undefined) throw TestMediaSource.endOfStreamError;
    if (this.readyState !== 'open') throw new DOMException('source is closed', 'InvalidStateError');
    this.endErrors.push(error);
    this.readyState = 'ended';
    this.dispatchEvent(new Event('sourceended'));
  }

  open(): void {
    if (this.readyState !== 'closed') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('sourceclose'));
  }

  endBeforeOpen(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('sourceended'));
  }
}

class TestMediaElement extends EventTarget {
  openObjectUrls = true;
  openDirectSources = true;
  openSynchronously = false;
  endInsteadOfOpen = false;
  rejectDirectSources = false;
  retainDirectSources = true;
  rejectSrcAssignment = false;
  loadCount = 0;
  #src = '';
  #srcObject: MediaProvider | null = null;

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    if (this.rejectSrcAssignment)
      throw new DOMException('src assignment rejected', 'NotSupportedError');
    this.#src = value;
    const source = TestMediaSource.instances.at(-1);
    if (value.startsWith('blob:') && this.openObjectUrls && source !== undefined) {
      const open = (): void => {
        if (this.endInsteadOfOpen) source.endBeforeOpen();
        else source.open();
      };
      if (this.openSynchronously) open();
      else queueMicrotask(open);
    }
  }

  get srcObject(): MediaProvider | null {
    return this.#srcObject;
  }

  set srcObject(value: MediaProvider | null) {
    if (value !== null && this.rejectDirectSources) {
      throw new DOMException('MediaSource srcObject unsupported', 'TypeError');
    }
    this.#srcObject = value === null || this.retainDirectSources ? value : null;
    if (value instanceof TestMediaSource && this.openDirectSources) {
      const open = (): void => {
        if (this.endInsteadOfOpen) value.endBeforeOpen();
        else value.open();
      };
      if (this.openSynchronously) open();
      else queueMicrotask(open);
    }
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.#src = '';
  }

  load(): void {
    this.loadCount++;
  }
}

function mediaElement(): TestMediaElement & HTMLMediaElement {
  return new TestMediaElement() as TestMediaElement & HTMLMediaElement;
}

describe('toElement materialization', () => {
  beforeEach(() => {
    TestMediaSource.instances = [];
    TestMediaSource.supported = true;
    TestMediaSource.supportError = undefined;
    TestMediaSource.constructionError = undefined;
    TestMediaSource.addSourceBufferError = undefined;
    TestMediaSource.endOfStreamError = undefined;
    TestSourceBuffer.autoComplete = true;
    TestSourceBuffer.appendError = undefined;
    TestSourceBuffer.abortError = undefined;
    vi.stubGlobal('MediaSource', TestMediaSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('revokes a Blob URL after metadata opens and revokes an older owned URL on replacement', async () => {
    const urls = ['blob:first', 'blob:second', 'blob:third'];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => urls.shift() ?? 'blob:unexpected');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();

    await materialize(toElement(element), bytesStream([1, 2]), { mime: 'video/mp4' });
    expect(element.src).toBe('blob:first');
    expect(revoke).not.toHaveBeenCalled();

    await materialize(toElement(element), bytesStream([3, 4]), { mime: 'video/mp4' });
    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(element.src).toBe('blob:second');

    element.dispatchEvent(new Event('loadedmetadata'));
    expect(revoke).toHaveBeenCalledWith('blob:second');
    expect(revoke).toHaveBeenCalledTimes(2);

    await materialize(toElement(element), bytesStream([5]), { mime: 'video/mp4' });
    expect(element.src).toBe('blob:third');
    expect(revoke).toHaveBeenCalledTimes(2);
    element.dispatchEvent(new Event('error'));
    expect(revoke).toHaveBeenCalledWith('blob:third');
  });

  it('streams MSE bytes in exact order, ends the source, and revokes its attachment URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mse');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();

    await materialize(toElement(element, { via: 'mse' }), bytesStream([1, 2], [3], [4, 5]), {
      mime: 'video/mp4',
    });

    const source = TestMediaSource.instances[0];
    expect(source).toBeDefined();
    if (source === undefined) throw new Error('MediaSource was not constructed');
    expect(create).toHaveBeenCalledWith(source);
    expect(element.src).toBe('blob:mse');
    expect(source.addedMimes).toEqual(['video/mp4']);
    expect([...merge(source.sourceBuffer.appended)]).toEqual([1, 2, 3, 4, 5]);
    expect(source.endErrors).toEqual([undefined]);
    expect(revoke).toHaveBeenCalledWith('blob:mse');
  });

  it('uses MediaSource srcObject for via:stream without creating an object URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const element = mediaElement();

    await materialize(toElement(element, { via: 'stream' }), bytesStream([8], [9, 10]), {
      mime: 'video/webm',
    });

    const source = TestMediaSource.instances[0];
    expect(source).toBeDefined();
    if (source === undefined) throw new Error('MediaSource was not constructed');
    expect(element.srcObject).toBe(source);
    expect(create).not.toHaveBeenCalled();
    expect([...merge(source.sourceBuffer.appended)]).toEqual([8, 9, 10]);
    expect(source.endErrors).toEqual([undefined]);
  });

  it('does not pull the next producer chunk until the prior SourceBuffer update ends', async () => {
    TestSourceBuffer.autoComplete = false;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mse-backpressure');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();
    let pulls = 0;
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          const chunk = chunks[pulls++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );

    const writing = materialize(toElement(element, { via: 'mse' }), stream, {
      mime: 'video/mp4',
    });
    await waitUntil(
      () => (TestMediaSource.instances[0]?.sourceBuffer.appended.length ?? 0) === 1,
      'first append did not start',
    );
    const buffer = TestMediaSource.instances[0]?.sourceBuffer;
    if (buffer === undefined) throw new Error('SourceBuffer was not constructed');
    expect(pulls).toBe(1);

    buffer.complete();
    await waitUntil(() => buffer.appended.length === 2, 'second append did not start');
    expect(pulls).toBe(2);

    buffer.complete();
    await waitUntil(() => buffer.appended.length === 3, 'third append did not start');
    expect(pulls).toBe(3);
    buffer.complete();
    await writing;
  });

  it('cancels upstream and revokes the URL when aborted while waiting for sourceopen', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();
    element.openObjectUrls = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel(): void {
        cancelled = true;
      },
    });
    const controller = new AbortController();

    const writing = materialize(toElement(element, { via: 'mse' }), stream, {
      mime: 'video/mp4',
      signal: controller.signal,
    });
    await waitUntil(
      () => TestMediaSource.instances.length === 1,
      'MediaSource was not constructed',
    );
    controller.abort();
    const error = await writing.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(cancelled).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:pending');
  });

  it('aborts an updating SourceBuffer and cancels upstream on cancellation', async () => {
    TestSourceBuffer.autoComplete = false;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:updating');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const writing = materialize(toElement(element, { via: 'mse' }), stream, {
      mime: 'video/mp4',
      signal: controller.signal,
    });
    await waitUntil(
      () => (TestMediaSource.instances[0]?.sourceBuffer.appended.length ?? 0) === 1,
      'append did not start',
    );

    controller.abort();
    const error = await writing.catch((reason: unknown) => reason);
    const buffer = TestMediaSource.instances[0]?.sourceBuffer;
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(buffer?.abortCount).toBe(1);
    expect(cancelled).toBe(true);
  });

  it('maps a SourceBuffer failure to mux-error and cancels the producer', async () => {
    TestSourceBuffer.autoComplete = false;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failing');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const writing = materialize(toElement(element, { via: 'mse' }), stream, {
      mime: 'video/mp4',
    });
    await waitUntil(
      () => (TestMediaSource.instances[0]?.sourceBuffer.appended.length ?? 0) === 1,
      'append did not start',
    );
    TestMediaSource.instances[0]?.sourceBuffer.fail();
    const error = await writing.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('mux-error');
    expect(cancelled).toBe(true);
  });

  it('supersedes an in-flight attachment instead of leaving its detached source pending', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first-pending');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();
    element.openObjectUrls = false;
    let firstCancelled = false;
    const firstStream = new ReadableStream<Uint8Array>({
      cancel(): void {
        firstCancelled = true;
      },
    });
    const first = materialize(toElement(element, { via: 'mse' }), firstStream, {
      mime: 'video/mp4',
    });
    await waitUntil(
      () => TestMediaSource.instances.length === 1,
      'first MediaSource was not constructed',
    );

    element.openDirectSources = true;
    const second = materialize(toElement(element, { via: 'stream' }), bytesStream([7]), {
      mime: 'video/webm',
    });
    const firstError = await first.catch((reason: unknown) => reason);
    await second;

    expect(firstError).toBeInstanceOf(MediaError);
    expect((firstError as MediaError).code).toBe('aborted');
    expect(firstCancelled).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:first-pending');
    expect(element.srcObject).toBe(TestMediaSource.instances[1]);
  });

  it('rejects missing/unsupported MSE capabilities with typed errors before consuming bytes', async () => {
    let cancelled = 0;
    const cancellable = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelled++;
        },
      });
    const element = mediaElement();

    const noMime = await materialize(toElement(element, { via: 'mse' }), cancellable()).catch(
      (reason: unknown) => reason,
    );
    expect(noMime).toBeInstanceOf(InputError);

    TestMediaSource.supported = false;
    const unsupported = await materialize(toElement(element, { via: 'mse' }), cancellable(), {
      mime: 'video/not-real',
    }).catch((reason: unknown) => reason);
    expect(unsupported).toBeInstanceOf(CapabilityError);

    vi.stubGlobal('MediaSource', undefined);
    const unavailable = await materialize(toElement(element, { via: 'mse' }), cancellable(), {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(unavailable).toBeInstanceOf(CapabilityError);
    expect(cancelled).toBe(3);
  });

  it('rejects via:stream when direct MediaSource attachment is unavailable', async () => {
    const element = mediaElement();
    element.rejectDirectSources = true;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel(): void {
        cancelled = true;
      },
    });

    const error = await materialize(toElement(element, { via: 'stream' }), stream, {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(cancelled).toBe(true);
  });

  it('cancels a pre-aborted call and rejects a forged element mode with typed errors', async () => {
    const element = mediaElement();
    let cancelled = 0;
    const pending = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelled++;
        },
      });

    const controller = new AbortController();
    controller.abort('caller cancelled before attachment');
    const aborted = await materialize(toElement(element, { via: 'mse' }), pending(), {
      mime: 'video/mp4',
      signal: controller.signal,
    }).catch((reason: unknown) => reason);
    expect(aborted).toBeInstanceOf(MediaError);
    expect((aborted as MediaError).code).toBe('aborted');
    expect(TestMediaSource.instances).toHaveLength(0);

    const forged = { ...toElement(element), via: 'invalid-mode' } as unknown as Sink;
    const invalid = await materialize(forged, pending()).catch((reason: unknown) => reason);
    expect(invalid).toBeInstanceOf(InputError);
    expect(cancelled).toBe(2);
  });

  it('maps MediaSource probe, construction, and SourceBuffer creation failures precisely', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:platform-failure');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const element = mediaElement();

    TestMediaSource.supportError = new Error('support probe crashed');
    const probeError = await materialize(toElement(element, { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(probeError).toBeInstanceOf(CapabilityError);

    TestMediaSource.supportError = undefined;
    TestMediaSource.constructionError = new Error('constructor rejected');
    const constructionError = await materialize(
      toElement(element, { via: 'mse' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(constructionError).toBeInstanceOf(CapabilityError);

    TestMediaSource.constructionError = undefined;
    TestMediaSource.addSourceBufferError = new DOMException(
      'codec unsupported',
      'NotSupportedError',
    );
    const unsupportedBuffer = await materialize(
      toElement(element, { via: 'mse' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(unsupportedBuffer).toBeInstanceOf(CapabilityError);

    TestMediaSource.addSourceBufferError = new DOMException('source detached', 'InvalidStateError');
    const detachedBuffer = await materialize(toElement(element, { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(detachedBuffer).toBeInstanceOf(MediaError);
    expect((detachedBuffer as MediaError).code).toBe('mux-error');
  });

  it('rejects malformed elements and object/direct attachment failures without leaking URLs', async () => {
    const invalidElement = { src: '' } as HTMLMediaElement;
    let invalidPulls = 0;
    let invalidCancelled = false;
    const invalidStream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          invalidPulls++;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel(): void {
          invalidCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const invalid = await materialize(toElement(invalidElement), invalidStream).catch(
      (reason: unknown) => reason,
    );
    expect(invalid).toBeInstanceOf(InputError);
    expect(invalidPulls).toBe(0);
    expect(invalidCancelled).toBe(true);

    const originalUrl = URL;
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:missing-revoke' });
    const missingUrlApi = await materialize(toElement(mediaElement()), bytesStream([1])).catch(
      (reason: unknown) => reason,
    );
    expect(missingUrlApi).toBeInstanceOf(CapabilityError);
    vi.stubGlobal('URL', originalUrl);

    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new DOMException('cannot create URL', 'NotSupportedError');
    });
    const createFailure = await materialize(toElement(mediaElement()), bytesStream([1])).catch(
      (reason: unknown) => reason,
    );
    expect(createFailure).toBeInstanceOf(CapabilityError);
    create.mockRestore();

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:must-revoke');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const rejectingElement = mediaElement();
    rejectingElement.rejectSrcAssignment = true;
    const srcFailure = await materialize(toElement(rejectingElement), bytesStream([1])).catch(
      (reason: unknown) => reason,
    );
    expect(srcFailure).toBeInstanceOf(CapabilityError);
    expect(revoke).toHaveBeenCalledWith('blob:must-revoke');

    const noSrcObject = Object.assign(new EventTarget(), {
      src: '',
      load(): void {},
      removeAttribute(): void {},
    }) as unknown as HTMLMediaElement;
    const directMissing = await materialize(
      toElement(noSrcObject, { via: 'stream' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(directMissing).toBeInstanceOf(CapabilityError);

    const nonRetainingElement = mediaElement();
    nonRetainingElement.retainDirectSources = false;
    const directRejected = await materialize(
      toElement(nonRetainingElement, { via: 'stream' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(directRejected).toBeInstanceOf(CapabilityError);
  });

  it('handles synchronous open, pre-open close/end, and element errors during a pending read', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lifecycle');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const synchronous = mediaElement();
    synchronous.openSynchronously = true;
    await materialize(toElement(synchronous, { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    });

    const closing = mediaElement();
    closing.openObjectUrls = false;
    const closesBeforeOpen = materialize(toElement(closing, { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    });
    await waitUntil(
      () => TestMediaSource.instances.length >= 2,
      'closing source was not constructed',
    );
    TestMediaSource.instances.at(-1)?.close();
    const closeError = await closesBeforeOpen.catch((reason: unknown) => reason);
    expect(closeError).toBeInstanceOf(MediaError);
    expect((closeError as MediaError).code).toBe('mux-error');

    const ending = mediaElement();
    ending.endInsteadOfOpen = true;
    ending.openSynchronously = true;
    const endError = await materialize(toElement(ending, { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(endError).toBeInstanceOf(MediaError);
    expect((endError as MediaError).code).toBe('mux-error');

    const pendingElement = mediaElement();
    let pendingCancelled = false;
    const pendingStream = new ReadableStream<Uint8Array>({
      cancel(): void {
        pendingCancelled = true;
      },
    });
    const pendingWrite = materialize(toElement(pendingElement, { via: 'mse' }), pendingStream, {
      mime: 'video/mp4',
    });
    await waitUntil(
      () => (TestMediaSource.instances.at(-1)?.addedMimes.length ?? 0) === 1,
      'pending source did not open',
    );
    pendingElement.dispatchEvent(new Event('error'));
    const elementError = await pendingWrite.catch((reason: unknown) => reason);
    expect(elementError).toBeInstanceOf(MediaError);
    expect((elementError as MediaError).code).toBe('mux-error');
    expect(pendingCancelled).toBe(true);

    const directPending = mediaElement();
    let directCancelled = false;
    const directSourceCount = TestMediaSource.instances.length;
    const directWrite = materialize(
      toElement(directPending, { via: 'stream' }),
      new ReadableStream<Uint8Array>({
        cancel(): void {
          directCancelled = true;
        },
      }),
      { mime: 'video/mp4' },
    );
    await waitUntil(
      () =>
        TestMediaSource.instances.length === directSourceCount + 1 &&
        (TestMediaSource.instances.at(-1)?.addedMimes.length ?? 0) === 1,
      'direct pending source did not open',
    );
    directPending.dispatchEvent(new Event('error'));
    const directError = await directWrite.catch((reason: unknown) => reason);
    expect(directError).toBeInstanceOf(MediaError);
    expect((directError as MediaError).code).toBe('mux-error');
    expect(directPending.srcObject).toBeNull();
    expect(directCancelled).toBe(true);
  });

  it('maps synchronous append, platform abort, source end, and cleanup failures without hanging', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:append-failure');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    TestSourceBuffer.appendError = new DOMException('bad segment', 'InvalidStateError');
    const appendError = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(appendError).toBeInstanceOf(MediaError);
    expect((appendError as MediaError).code).toBe('mux-error');

    TestSourceBuffer.appendError = new MediaError('encode-error', 'typed append failure');
    const typedAppend = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      bytesStream([1]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(typedAppend).toBeInstanceOf(MediaError);
    expect((typedAppend as MediaError).code).toBe('encode-error');

    TestSourceBuffer.appendError = undefined;
    TestSourceBuffer.autoComplete = false;
    const abortSourceCount = TestMediaSource.instances.length;
    const abortWrite = materialize(toElement(mediaElement(), { via: 'mse' }), bytesStream([1]), {
      mime: 'video/mp4',
    });
    await waitUntil(
      () =>
        TestMediaSource.instances.length === abortSourceCount + 1 &&
        (TestMediaSource.instances.at(-1)?.sourceBuffer.appended.length ?? 0) === 1,
      'abort append did not start',
    );
    TestMediaSource.instances.at(-1)?.sourceBuffer.abort();
    const bufferAbort = await abortWrite.catch((reason: unknown) => reason);
    expect(bufferAbort).toBeInstanceOf(MediaError);
    expect((bufferAbort as MediaError).code).toBe('mux-error');

    const endedSourceCount = TestMediaSource.instances.length;
    const endedWrite = materialize(toElement(mediaElement(), { via: 'mse' }), bytesStream([2]), {
      mime: 'video/mp4',
    });
    await waitUntil(
      () =>
        TestMediaSource.instances.length === endedSourceCount + 1 &&
        (TestMediaSource.instances.at(-1)?.sourceBuffer.appended.length ?? 0) === 1,
      'ended append did not start',
    );
    TestMediaSource.instances.at(-1)?.endBeforeOpen();
    const sourceEnded = await endedWrite.catch((reason: unknown) => reason);
    expect(sourceEnded).toBeInstanceOf(MediaError);
    expect((sourceEnded as MediaError).code).toBe('mux-error');

    const controller = new AbortController();
    TestSourceBuffer.abortError = new Error('abort cleanup failed');
    const cleanupSourceCount = TestMediaSource.instances.length;
    const cleanupWrite = materialize(toElement(mediaElement(), { via: 'mse' }), bytesStream([3]), {
      mime: 'video/mp4',
      signal: controller.signal,
    });
    await waitUntil(
      () =>
        TestMediaSource.instances.length === cleanupSourceCount + 1 &&
        (TestMediaSource.instances.at(-1)?.sourceBuffer.appended.length ?? 0) === 1,
      'cleanup append did not start',
    );
    controller.abort();
    const cleanupError = await cleanupWrite.catch((reason: unknown) => reason);
    expect(cleanupError).toBeInstanceOf(MediaError);
    expect((cleanupError as MediaError).code).toBe('aborted');

    TestSourceBuffer.abortError = undefined;
    TestSourceBuffer.autoComplete = true;
    TestMediaSource.addSourceBufferError = new Error('unexpected allocation failure');
    const allocationFailure = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      bytesStream([4]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(allocationFailure).toBeInstanceOf(MediaError);
    expect((allocationFailure as MediaError).code).toBe('mux-error');
  });

  it('awaits asynchronous producer cancellation before rejecting and aborting the SourceBuffer', async () => {
    TestSourceBuffer.autoComplete = false;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:async-cancel');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const order: string[] = [];
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1]));
      },
      async cancel(): Promise<void> {
        order.push('cancel:start');
        await cancelGate;
        order.push('cancel:end');
      },
    });
    const controller = new AbortController();
    const writing = materialize(toElement(mediaElement(), { via: 'mse' }), stream, {
      mime: 'video/mp4',
      signal: controller.signal,
    });
    let settled = false;
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitUntil(
      () => (TestMediaSource.instances[0]?.sourceBuffer.appended.length ?? 0) === 1,
      'async-cancel append did not start',
    );

    controller.abort();
    await waitUntil(() => order.includes('cancel:start'), 'producer cancellation did not start');
    expect(settled).toBe(false);
    expect(TestMediaSource.instances[0]?.sourceBuffer.abortCount).toBe(0);

    releaseCancel?.();
    const error = await writing.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(order).toEqual(['cancel:start', 'cancel:end']);
    expect(TestMediaSource.instances[0]?.sourceBuffer.abortCount).toBe(1);
  });

  it('reports progress, ignores empty chunks, handles producer/EOF failures, and copies shared bytes', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mixed');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const progress: number[] = [];
    await materialize(toElement(mediaElement(), { via: 'mse' }), bytesStream([], [1, 2]), {
      mime: 'video/mp4',
      onProgress: ({ done }) => progress.push(done),
    });
    expect(progress).toEqual([2]);

    const producerFailure = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      new ReadableStream<Uint8Array>({
        pull(): void {
          throw new Error('producer failed');
        },
      }),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(producerFailure).toBeInstanceOf(MediaError);
    expect((producerFailure as MediaError).code).toBe('mux-error');

    TestMediaSource.endOfStreamError = new DOMException('cannot end', 'InvalidStateError');
    const eofFailure = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      bytesStream([3]),
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(eofFailure).toBeInstanceOf(MediaError);
    expect((eofFailure as MediaError).code).toBe('mux-error');
    TestMediaSource.endOfStreamError = undefined;

    let delivered = false;
    const closesAtEof = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (!delivered) {
            delivered = true;
            controller.enqueue(new Uint8Array([4]));
            return;
          }
          TestMediaSource.instances.at(-1)?.close();
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const closedEof = await materialize(toElement(mediaElement(), { via: 'mse' }), closesAtEof, {
      mime: 'video/mp4',
    }).catch((reason: unknown) => reason);
    expect(closedEof).toBeInstanceOf(MediaError);
    expect((closedEof as MediaError).code).toBe('mux-error');

    let closesWithChunk = false;
    const closesBeforeAppend = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (closesWithChunk) {
            controller.close();
            return;
          }
          closesWithChunk = true;
          controller.enqueue(new Uint8Array([8]));
          TestMediaSource.instances.at(-1)?.close();
        },
      },
      { highWaterMark: 0 },
    );
    const closedAppend = await materialize(
      toElement(mediaElement(), { via: 'mse' }),
      closesBeforeAppend,
      { mime: 'video/mp4' },
    ).catch((reason: unknown) => reason);
    expect(closedAppend).toBeInstanceOf(MediaError);
    expect((closedAppend as MediaError).code).toBe('mux-error');

    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(3));
      shared.set([5, 6, 7]);
      await materialize(
        toElement(mediaElement(), { via: 'mse' }),
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(shared);
            controller.close();
          },
        }),
        { mime: 'video/mp4' },
      );
      expect([...merge(TestMediaSource.instances.at(-1)?.sourceBuffer.appended ?? [])]).toEqual([
        5, 6, 7,
      ]);
    }
  });

  it('preserves every byte of a real downloaded MP4 across the streaming append pump', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:real-mse');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const truth = await loadFixture('h264.mp4');

    await materialize(toElement(mediaElement(), { via: 'mse' }), chunkedStream(truth), {
      mime: 'video/mp4',
    });

    const source = TestMediaSource.instances[0];
    if (source === undefined) throw new Error('MediaSource was not constructed');
    expectBytesEqual(merge(source.sourceBuffer.appended), truth);
    expect(source.endErrors).toEqual([undefined]);
  });
});
