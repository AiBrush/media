import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { collect } from '../kernel/executor.ts';
import type { MaterializeOptions } from './materialize.ts';

export async function writeElement(
  sink: { el: HTMLMediaElement; via: 'blob' | 'mse' | 'stream' },
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<void> {
  try {
    requireElementEvents(sink.el);
  } catch (error) {
    await cancelUnlockedStream(stream, error);
    throw error;
  }
  const session = beginElementSession(sink.el, opts.signal);
  const activeOpts: MaterializeOptions = { ...opts, signal: session.controller.signal };
  try {
    switch (sink.via) {
      case 'blob':
        await writeElementBlob(sink.el, stream, activeOpts);
        return;
      case 'mse':
      case 'stream':
        await writeElementMediaSource(sink.el, sink.via, stream, activeOpts, session);
        return;
      default:
        return assertNever(sink.via);
    }
  } catch (error) {
    await cancelUnlockedStream(stream, error);
    throw mapElementFailure(error, session.controller.signal);
  } finally {
    session.finish();
  }
}

interface ElementSession {
  readonly controller: AbortController;
  abort(error: MediaError): void;
  finish(): void;
}

interface ElementAttachment {
  releaseUrl(): void;
  detach(): void;
}

const activeElementSessions = new WeakMap<HTMLMediaElement, ElementSession>();
const activeElementAttachments = new WeakMap<HTMLMediaElement, ElementAttachment>();

function beginElementSession(
  el: HTMLMediaElement,
  callerSignal: AbortSignal | undefined,
): ElementSession {
  activeElementSessions
    .get(el)
    ?.abort(new MediaError('aborted', 'element sink was replaced by a newer attachment'));

  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(new MediaError('aborted', 'operation aborted'));
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  let finished = false;
  const session: ElementSession = {
    controller,
    abort(error): void {
      if (!controller.signal.aborted) controller.abort(error);
    },
    finish(): void {
      if (finished) return;
      finished = true;
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (activeElementSessions.get(el) === session) activeElementSessions.delete(el);
    },
  };
  activeElementSessions.set(el, session);
  return session;
}

async function writeElementBlob(
  el: HTMLMediaElement,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<void> {
  const bytes = await collect(stream, opts);
  if (opts.signal !== undefined) throwIfAborted(opts.signal);
  const blob = new Blob([bytes], opts.mime ? { type: opts.mime } : {});
  attachObjectUrl(el, blob, 'blob', true);
}

async function writeElementMediaSource(
  el: HTMLMediaElement,
  via: 'mse' | 'stream',
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
  session: ElementSession,
): Promise<void> {
  const mime = opts.mime?.trim();
  if (!mime) {
    throw new InputError(
      'unsupported-input',
      `element sink via '${via}' requires an output MIME type`,
    );
  }
  throwIfAborted(session.controller.signal);
  requireElementEvents(el);

  const MediaSourceConstructor = mediaSourceConstructor(via, mime);
  let mediaSource: MediaSource;
  try {
    mediaSource = new MediaSourceConstructor();
  } catch (error) {
    throw elementCapability(via, `MediaSource construction failed for '${mime}'`, error);
  }

  const onElementError = (): void => {
    session.abort(new MediaError('mux-error', 'media element rejected the streamed output'));
  };
  el.addEventListener('error', onElementError);

  let attachment: ElementAttachment | undefined;
  let sourceBuffer: SourceBuffer | undefined;
  try {
    attachment =
      via === 'mse'
        ? attachObjectUrl(el, mediaSource, 'mse', false)
        : attachDirectMediaSource(el, mediaSource);
    await waitForSourceOpen(mediaSource, session.controller.signal);
    attachment.releaseUrl();

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch (error) {
      throw mapSourceBufferCreationFailure(via, mime, error);
    }
    await pumpMediaSource(stream, sourceBuffer, mediaSource, opts);
  } catch (error) {
    if (sourceBuffer?.updating) {
      try {
        sourceBuffer.abort();
      } catch {
        // The MediaSource may already have detached; upstream cancellation still owns resource release.
      }
    }
    attachment?.detach();
    throw error;
  } finally {
    el.removeEventListener('error', onElementError);
  }
}

type MediaSourceClass = typeof MediaSource;

function mediaSourceConstructor(via: 'mse' | 'stream', mime: string): MediaSourceClass {
  const MediaSourceApi = globalThis.MediaSource;
  if (typeof MediaSourceApi !== 'function') {
    throw elementCapability(via, 'Media Source Extensions are unavailable in this environment');
  }
  let supported: boolean;
  try {
    supported = MediaSourceApi.isTypeSupported(mime);
  } catch (error) {
    throw elementCapability(via, `MediaSource support probing failed for '${mime}'`, error);
  }
  if (!supported) {
    throw elementCapability(via, `MediaSource does not support '${mime}'`);
  }
  return MediaSourceApi;
}

function prepareElementAttachment(el: HTMLMediaElement): void {
  activeElementAttachments.get(el)?.releaseUrl();
}

function attachObjectUrl(
  el: HTMLMediaElement,
  source: Blob | MediaSource,
  via: 'blob' | 'mse',
  releaseWhenOpened: boolean,
): ElementAttachment {
  requireElementEvents(el);
  const urlApi = objectUrlApi(via);
  let url: string;
  try {
    url = urlApi.create(source);
  } catch (error) {
    throw elementCapability(via, 'the platform could not create an element object URL', error);
  }

  let urlOwned = true;
  const releaseCreatedUrl = (): void => {
    if (!urlOwned) return;
    urlOwned = false;
    urlApi.revoke(url);
  };
  try {
    prepareElementAttachment(el);
    if ('srcObject' in el) el.srcObject = null;
  } catch (error) {
    releaseCreatedUrl();
    throw elementCapability(via, 'the media element could not release its prior source', error);
  }

  const onReady = (): void => attachment.releaseUrl();
  const attachment: ElementAttachment = {
    releaseUrl(): void {
      if (!urlOwned) return;
      if (releaseWhenOpened) {
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onReady);
      }
      releaseCreatedUrl();
    },
    detach(): void {
      attachment.releaseUrl();
      if (activeElementAttachments.get(el) !== attachment) return;
      activeElementAttachments.delete(el);
      el.removeAttribute('src');
      el.load();
    },
  };

  if (releaseWhenOpened) {
    el.addEventListener('loadedmetadata', onReady);
    el.addEventListener('error', onReady);
  }
  activeElementAttachments.set(el, attachment);
  try {
    el.src = url;
  } catch (error) {
    attachment.detach();
    throw elementCapability(via, 'the media element rejected its object URL', error);
  }
  return attachment;
}

function attachDirectMediaSource(
  el: HTMLMediaElement,
  mediaSource: MediaSource,
): ElementAttachment {
  requireElementEvents(el);
  if (!('srcObject' in el)) {
    throw elementCapability('stream', 'this media element does not expose srcObject');
  }
  prepareElementAttachment(el);

  const attachment: ElementAttachment = {
    releaseUrl(): void {},
    detach(): void {
      if (activeElementAttachments.get(el) !== attachment) return;
      activeElementAttachments.delete(el);
      if (el.srcObject === mediaSource) el.srcObject = null;
      el.load();
    },
  };
  activeElementAttachments.set(el, attachment);
  try {
    el.removeAttribute('src');
    el.srcObject = mediaSource;
    if (el.srcObject !== mediaSource) {
      throw new DOMException(
        'MediaSource srcObject assignment was not retained',
        'NotSupportedError',
      );
    }
  } catch (error) {
    attachment.detach();
    throw elementCapability('stream', 'direct MediaSource attachment is unavailable', error);
  }
  return attachment;
}

function requireElementEvents(el: HTMLMediaElement): void {
  if (
    typeof el.addEventListener !== 'function' ||
    typeof el.removeEventListener !== 'function' ||
    typeof el.removeAttribute !== 'function' ||
    typeof el.load !== 'function'
  ) {
    throw new InputError('unsupported-input', 'element sink requires an HTMLMediaElement');
  }
}

function objectUrlApi(via: 'blob' | 'mse'): {
  create(source: Blob | MediaSource): string;
  revoke(url: string): void;
} {
  if (
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    throw elementCapability(via, 'object URLs are unavailable in this environment');
  }
  return {
    create: (source) => URL.createObjectURL(source),
    revoke: (url) => URL.revokeObjectURL(url),
  };
}

function waitForSourceOpen(mediaSource: MediaSource, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signalFailure(signal));
  if (mediaSource.readyState === 'open') return Promise.resolve();
  if (mediaSource.readyState === 'ended') {
    return Promise.reject(new MediaError('mux-error', 'MediaSource ended before it opened'));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      mediaSource.removeEventListener('sourceopen', onOpen);
      mediaSource.removeEventListener('sourceclose', onClose);
      mediaSource.removeEventListener('sourceended', onEnded);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new MediaError('mux-error', 'MediaSource closed before it opened'));
    };
    const onEnded = (): void => {
      cleanup();
      reject(new MediaError('mux-error', 'MediaSource ended before it opened'));
    };
    const onAbort = (): void => {
      cleanup();
      reject(signalFailure(signal));
    };
    mediaSource.addEventListener('sourceopen', onOpen);
    mediaSource.addEventListener('sourceclose', onClose);
    mediaSource.addEventListener('sourceended', onEnded);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function pumpMediaSource(
  stream: ReadableStream<Uint8Array>,
  sourceBuffer: SourceBuffer,
  mediaSource: MediaSource,
  opts: MaterializeOptions,
): Promise<void> {
  const signal = opts.signal;
  if (signal === undefined)
    throw new MediaError('mux-error', 'element sink session signal is missing');
  throwIfAborted(signal);

  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceElementAbort(reader.read(), signal);
      if (done) break;
      if (value.byteLength === 0) continue;
      await appendSourceBuffer(sourceBuffer, mediaSource, value, signal);
      total += value.byteLength;
      opts.onProgress?.({ done: total, stage: 'element' });
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the primary typed pipeline failure; cancellation was still requested synchronously.
    }
    throw mapElementFailure(error, signal);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can finish after an abort race; reader cancellation above owns final release.
    }
  }

  throwIfAborted(signal);
  if (mediaSource.readyState !== 'open') {
    throw new MediaError('mux-error', 'MediaSource closed before the output stream completed');
  }
  try {
    mediaSource.endOfStream();
  } catch (error) {
    throw toMuxError(error, 'MediaSource could not end the output stream');
  }
}

function appendSourceBuffer(
  sourceBuffer: SourceBuffer,
  mediaSource: MediaSource,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signalFailure(signal));
  if (mediaSource.readyState !== 'open') {
    return Promise.reject(new MediaError('mux-error', 'MediaSource closed during append'));
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onError);
      sourceBuffer.removeEventListener('abort', onBufferAbort);
      mediaSource.removeEventListener('sourceclose', onSourceClose);
      mediaSource.removeEventListener('sourceended', onSourceEnded);
      signal.removeEventListener('abort', onSignalAbort);
    };
    const succeed = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: MediaError): void => {
      cleanup();
      reject(error);
    };
    const onUpdateEnd = (): void => succeed();
    const onError = (): void => fail(new MediaError('mux-error', 'SourceBuffer append failed'));
    const onBufferAbort = (): void =>
      fail(
        signal.aborted
          ? signalFailure(signal)
          : new MediaError('mux-error', 'SourceBuffer append was aborted'),
      );
    const onSourceClose = (): void =>
      fail(new MediaError('mux-error', 'MediaSource closed during append'));
    const onSourceEnded = (): void =>
      fail(new MediaError('mux-error', 'MediaSource ended during append'));
    const onSignalAbort = (): void => fail(signalFailure(signal));

    sourceBuffer.addEventListener('updateend', onUpdateEnd);
    sourceBuffer.addEventListener('error', onError);
    sourceBuffer.addEventListener('abort', onBufferAbort);
    mediaSource.addEventListener('sourceclose', onSourceClose);
    mediaSource.addEventListener('sourceended', onSourceEnded);
    signal.addEventListener('abort', onSignalAbort, { once: true });
    try {
      sourceBuffer.appendBuffer(toMseBufferSource(chunk));
    } catch (error) {
      fail(toMuxError(error, 'SourceBuffer rejected an output chunk'));
    }
  });
}

function toMseBufferSource(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Uint8Array.from(chunk);
}

function raceElementAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signalFailure(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signalFailure(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signalFailure(signal);
}

function signalFailure(signal: AbortSignal): MediaError {
  return signal.reason instanceof MediaError
    ? signal.reason
    : new MediaError('aborted', 'operation aborted');
}

async function cancelUnlockedStream(
  stream: ReadableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  if (!stream.locked) await stream.cancel(reason).catch(() => undefined);
}

function mapElementFailure(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof MediaError) return error;
  if (signal.aborted) return signalFailure(signal);
  return toMuxError(error, 'element sink failed');
}

function toMuxError(error: unknown, message: string): MediaError {
  if (error instanceof MediaError) return error;
  return new MediaError(
    'mux-error',
    error instanceof Error ? `${message}: ${error.message}` : `${message}: ${String(error)}`,
    error,
  );
}

function mapSourceBufferCreationFailure(
  via: 'mse' | 'stream',
  mime: string,
  error: unknown,
): MediaError {
  const name = error instanceof DOMException ? error.name : undefined;
  if (name === 'NotSupportedError' || name === 'QuotaExceededError') {
    return elementCapability(via, `MediaSource cannot add a SourceBuffer for '${mime}'`, error);
  }
  return toMuxError(error, `MediaSource could not add a SourceBuffer for '${mime}'`);
}

function elementCapability(
  via: 'blob' | 'mse' | 'stream',
  message: string,
  cause?: unknown,
): CapabilityError {
  return new CapabilityError('capability-miss', message, {
    op: { op: 'element-sink', via },
    tried: [],
    ...(cause === undefined ? {} : { cause }),
  });
}

function assertNever(x: never): never {
  throw new InputError('unsupported-input', `unknown sink ${JSON.stringify(x)}`);
}
