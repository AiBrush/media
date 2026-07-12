/**
 * Source normalization (ADR-013, docs/architecture/07 §3) — turn anything a caller has (bytes, Blob,
 * URL, byte stream, DOM element) into a uniform {@link Source}: a {@link ByteSource} with a fresh
 * `stream()`, an optional `size`, and optional random-access `range()` (which is what keeps `probe`
 * fast — header-only reads). A raw `MediaStream` remains the distinct {@link LiveMediaSource} brand;
 * it is never represented as container bytes. Web streams are used so a huge file never fully buffers.
 *
 * `range(start, end)` is **half-open** `[start, end)` (JS `subarray`/`slice` semantics); the URL source
 * translates it to the inclusive HTTP `Range` header.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import {
  type LiveMediaSource,
  captureElementMediaStream,
  fromMediaStream,
  isLiveMediaSource,
  mediaStreamOf,
} from './live-source.ts';

const TINY_KNOWN_FULL_RANGE_GET_BYTES = 16 * 1024;

/** Internal identity hook used for short-lived cross-operation source caches. Not exported from the public barrel. */
export const SOURCE_CACHE_KEY: unique symbol = Symbol('a');
/** Final effective URL learned from Fetch (after redirects), kept separate from cache identity. */
export const SOURCE_URL_KEY: unique symbol = Symbol('u');

/** Anything the public ops accept directly (ADR-013). */
export type MediaInput =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>
  | URL
  | string
  | HTMLMediaElement
  | MediaStream
  | LiveMediaSource
  | Source;

/** Inputs normalized into the finite/one-shot byte {@link Source} contract (never raw live tracks). */
export type ByteMediaInput =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>
  | URL
  | string
  | Source;

/** A normalized byte source or a separately-branded raw live source. */
export type NormalizedSource = Source | LiveMediaSource;

/** How a {@link Source} was constructed (used for diagnostics and sink defaults). */
export type SourceKind = 'bytes' | 'blob' | 'stream' | 'url' | 'opfs' | 'element';

/**
 * A normalized, re-readable byte snapshot. Every read from one Source object must describe the same
 * immutable media bytes; create a new Source when a mutable URL/OPFS resource changes.
 */
export interface Source {
  readonly __media: 'source';
  readonly kind: SourceKind;
  /** A fresh readable each call (except `stream` sources, which are single-use). */
  stream(): ReadableStream<Uint8Array>;
  /** Total byte length when known ahead of time (absent/`undefined` ⇒ unknown until probed). */
  readonly size?: number;
  /** Random access for header-only reads; half-open `[start, end)`. Absent for pure streams. */
  range?(start: number, end: number): Promise<Uint8Array>;
  /** A MIME hint from the origin (Blob type, element, etc.), if any. */
  readonly mimeHint?: string;
  /** A filename hint (from a `File`), if any. */
  readonly filename?: string;
  /** Opaque source identity for same-origin, short-lived cache handoffs between operations. */
  readonly [SOURCE_CACHE_KEY]?: string;
  /** Effective resource URL, updated from `Response.url` after a URL/element fetch follows redirects. */
  readonly [SOURCE_URL_KEY]?: string;
}

export interface FromUrlOptions {
  /** Use HTTP Range requests for `range()`/probe (default true). */
  rangeRequests?: boolean;
  /** A caller-provided MIME hint for extensionless URLs or opaque fixture endpoints. */
  mime?: string;
  /**
   * A known total byte length, when the caller already has it (e.g. from a prior `Content-Length`). Seeds
   * {@link Source.size} without a round-trip; otherwise size is learned lazily from a `Content-Range`.
   */
  size?: number;
}
export interface FromElementOptions {
  /** `bytes` reads `currentSrc` (default); `capture` explicitly taps the live `captureStream()`. */
  mode?: 'bytes' | 'capture';
}
export interface FromStreamOptions {
  /** A caller-provided MIME hint used to route a one-shot stream without an unnecessary large sniff. */
  mime?: string;
  /** A known total byte length, if the producer exposes it out of band. */
  size?: number;
}

/** Universal source options: one all-optional shape spanning URL, stream, and element inputs. */
export interface FromOptions {
  /** Use HTTP Range requests for URL-backed sources (default true). */
  rangeRequests?: boolean;
  /** Caller-provided content type for URLs, streams, or bytes. */
  mime?: string;
  /** Known byte length for URL/stream sources. */
  size?: number;
  /** Element input mode; live capture is always explicit. */
  mode?: 'bytes' | 'capture';
}

/** Type guard: is this already a normalized {@link Source}? */
export function isSource(x: unknown): x is Source {
  return typeof x === 'object' && x !== null && (x as { __media?: unknown }).__media === 'source';
}

// ── Constructors ────────────────────────────────────────────────────────────────────────────────

/** Wrap in-memory bytes. */
export function fromBytes(bytes: ArrayBuffer | ArrayBufferView, opts?: { mime?: string }): Source {
  const u8 =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source: Source = {
    __media: 'source',
    kind: 'bytes',
    size: u8.byteLength,
    ...(opts?.mime !== undefined ? { mimeHint: opts.mime } : {}),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(u8);
          c.close();
        },
      }),
    range: (start, end) =>
      Promise.resolve(u8.subarray(clamp(start, u8.byteLength), clamp(end, u8.byteLength))),
  };
  return source;
}

/** Wrap a `Blob`/`File`. */
export function fromBlob(blob: Blob): Source {
  const filename = typeof File !== 'undefined' && blob instanceof File ? blob.name : undefined;
  return {
    __media: 'source',
    kind: 'blob',
    size: blob.size,
    ...(blob.type ? { mimeHint: blob.type } : {}),
    ...(filename !== undefined ? { filename } : {}),
    stream: () => blob.stream() as ReadableStream<Uint8Array>,
    range: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

/** Internal one-shot stream state shared with the lazy prefix-replay implementation. */
export const SOURCE_STREAM_STATE: unique symbol = Symbol('s');

/** Internal operations installed lazily after the first routing peek. */
export interface StreamCursor {
  peek(limit: number, signal?: AbortSignal): Promise<Uint8Array>;
  open(): ReadableStream<Uint8Array>;
  cancel(reason?: unknown): Promise<void>;
}

/** Internal mutable ownership cell for a public single-use stream source. */
export interface StreamSourceState {
  readonly readable: ReadableStream<Uint8Array>;
  consumed: boolean;
  cursor?: StreamCursor;
}

interface StreamStateSource extends Source {
  readonly [SOURCE_STREAM_STATE]: StreamSourceState;
}

/**
 * Wrap a single-use byte stream. Routing peeks retain only a bounded prefix and the sole later
 * {@link Source.stream} call replays it before continuing the same reader, so sniffing never steals bytes.
 */
export function fromStream(
  readable: ReadableStream<Uint8Array>,
  opts: FromStreamOptions = {},
): Source {
  if (readable.locked) {
    throw new InputError('unsupported-input', 'stream is already locked');
  }
  const state: StreamSourceState = { readable, consumed: false };
  const source: StreamStateSource = {
    __media: 'source',
    kind: 'stream',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    ...(opts.mime !== undefined ? { mimeHint: opts.mime } : {}),
    stream: () => {
      if (state.cursor !== undefined) return state.cursor.open();
      if (state.consumed) throw new InputError('unsupported-input', 'used');
      state.consumed = true;
      return readable;
    },
    [SOURCE_STREAM_STATE]: state,
  };
  return source;
}

/**
 * Read a bounded source prefix without consuming it from the later container reader. A true stream input
 * uses its single-reader replay cursor; re-readable sources open and cancel a temporary reader.
 */
export async function peekSourceHead(
  src: Source,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const bounded = Math.max(0, Math.trunc(limit));
  assertSourceNotAborted(signal);
  if (src.range !== undefined) {
    const head = await src.range(0, bounded);
    assertSourceNotAborted(signal);
    return head;
  }
  const { peekUnseekableSourceHead } = await import('./stream-input.ts');
  return peekUnseekableSourceHead(src, bounded, signal);
}

/** Cancel a normalized one-shot source if it currently owns a routing reader. */
export async function cancelSource(src: Source, reason?: unknown): Promise<void> {
  if (!(SOURCE_STREAM_STATE in src)) return;
  const { cancelOneShotSource } = await import('./stream-input.ts');
  await cancelOneShotSource(src, reason);
}

function assertSourceNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new MediaError('aborted', 'source read aborted', signal.reason);
  }
}

/** Derive a query/hash-free last pathname component without mistaking opaque data/blob URLs for files. */
function filenameFromHref(href: string): string | undefined {
  if (/^(?:data|blob):/i.test(href)) return undefined;
  const end = href.search(/[?#]/);
  const path = end >= 0 ? href.slice(0, end) : href;
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const filename = path.slice(slash + 1);
  return filename.length > 0 && !filename.includes(':') ? filename : undefined;
}

/**
 * Wrap a URL (or URL string). `stream()` is returned synchronously, backed by `fetch`; `range()` issues
 * an HTTP `Range` request and, when the server answers `206`, learns the resource's total length from the
 * `Content-Range` header and memoizes it — so `size` becomes known after the first range read (and a
 * driver's tail-seek for a trailing `moov`/last-Ogg-page can clamp correctly). `size` is exposed as a
 * getter returning the memoized total (still `undefined` until learned, which is honest: a remote URL's
 * length is not known without a round-trip). To learn it eagerly use {@link probeUrlSize} (the
 * caching/preload layer does this in `prime()`).
 */
export function fromURL(url: string | URL, opts: FromUrlOptions = {}): Source {
  const href = typeof url === 'string' ? url : url.href;
  const filename = filenameFromHref(href);
  let effectiveUrl = href;
  const learnEffectiveUrl = (url: string): void => {
    effectiveUrl = url;
  };
  // `size` is a real own property, present only once known: seeded if the caller passed it, otherwise set
  // (assigned a `number`, never an explicit `undefined`) the first time a fetch learns it from a
  // `Content-Range`/`Content-Length`. The fetch closures share this object so a later read can clamp.
  const source: Source = {
    __media: 'source',
    kind: 'url',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    ...(opts.mime !== undefined ? { mimeHint: opts.mime } : {}),
    ...(filename !== undefined ? { filename } : {}),
    [SOURCE_CACHE_KEY]: href,
    get [SOURCE_URL_KEY](): string {
      return effectiveUrl;
    },
    stream: () => fetchStream(href, source, learnEffectiveUrl),
    ...(opts.rangeRequests !== false
      ? { range: (start, end) => fetchRange(href, start, end, source, learnEffectiveUrl) }
      : {}),
  };
  return source;
}

/** Read a media element's current source as bytes (default), per ADR-013 (never `loadedmetadata`). */
export function fromElement(el: HTMLMediaElement): Source;
export function fromElement(
  el: HTMLMediaElement,
  opts: FromElementOptions & { readonly mode: 'capture' },
): LiveMediaSource;
export function fromElement(
  el: HTMLMediaElement,
  opts: FromElementOptions & { readonly mode?: 'bytes' },
): Source;
export function fromElement(el: HTMLMediaElement, opts: FromElementOptions): NormalizedSource;
export function fromElement(el: HTMLMediaElement, opts: FromElementOptions = {}): NormalizedSource {
  const mode = opts.mode ?? 'bytes';
  if (mode === 'capture') return captureElementMediaStream(el);
  const href = el.currentSrc || el.src;
  if (!href) {
    throw new InputError('unsupported-input', 'src');
  }
  const filename = filenameFromHref(href);
  let effectiveUrl = href;
  const learnEffectiveUrl = (url: string): void => {
    effectiveUrl = url;
  };
  // A URL-backed source relabelled `element` (reads `currentSrc`, never `loadedmetadata`). Built directly
  // over the fetch helpers (rather than spreading a `fromURL`) so `size` is learned onto *this* object on
  // the first range/stream read, exactly like a plain URL source.
  const element: Source = {
    __media: 'source',
    kind: 'element',
    get [SOURCE_URL_KEY](): string {
      return effectiveUrl;
    },
    stream: () => fetchStream(href, element, learnEffectiveUrl),
    range: (start, end) => fetchRange(href, start, end, element, learnEffectiveUrl),
    ...(filename !== undefined ? { filename } : {}),
  };
  return element;
}

/** Read a file from the Origin Private File System by path. */
export async function fromOPFS(path: string): Promise<Source> {
  const { fromOPFSImpl } = await import('./opfs.ts');
  return fromOPFSImpl(path);
}

/**
 * The universal normalizer (ADR-013/236). Byte inputs become {@link Source}; a `MediaStream` or explicit
 * element capture remains a separately-branded {@link LiveMediaSource}. A bare string resolves to a URL
 * by protocol precedence, else a relative fetch.
 */
export function from(input: MediaStream | LiveMediaSource, opts?: FromOptions): LiveMediaSource;
export function from(
  input: HTMLMediaElement,
  opts: FromOptions & { readonly mode: 'capture' },
): LiveMediaSource;
export function from(input: HTMLMediaElement): Source;
export function from(
  input: HTMLMediaElement,
  opts: FromOptions & { readonly mode?: 'bytes' },
): Source;
export function from(input: ByteMediaInput, opts?: FromOptions): Source;
export function from(input: HTMLMediaElement, opts: FromOptions): NormalizedSource;
export function from(input: MediaInput, opts?: FromOptions): NormalizedSource;
export function from(input: MediaInput, opts: FromOptions = {}): NormalizedSource {
  if (isSource(input)) return input;
  if (isLiveMediaSource(input)) return input;
  const mediaStream = mediaStreamOf(input);
  if (mediaStream !== undefined) return fromMediaStream(mediaStream);
  if (input instanceof Uint8Array) return fromBytes(input, opts);
  if (input instanceof ArrayBuffer) return fromBytes(input, opts);
  if (ArrayBuffer.isView(input)) return fromBytes(input, opts);
  if (input instanceof Blob) return fromBlob(input);
  if (input instanceof ReadableStream) return fromStream(input, opts);
  if (input instanceof URL) return fromURL(input, opts);
  if (typeof input === 'string') return fromURL(input, opts);
  if (isMediaElement(input)) return fromElement(input, opts);
  throw new InputError('unsupported-input', 'bad');
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

/** A write-through view used to memoize a learned total length onto a source object (never to `undefined`). */
interface LearnSize {
  size?: number;
}

/** Record a freshly-learned total length onto the source, but only once (first writer wins). */
function learnSize(target: LearnSize, total: number | undefined): void {
  if (total !== undefined && target.size === undefined) target.size = total;
}

function learnResponseUrl(response: Response, learn?: (url: string) => void): void {
  if (response.url.length > 0) learn?.(response.url);
}

function fetchStream(
  href: string,
  learn?: LearnSize,
  learnUrl?: (url: string) => void,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (!reader) {
        const res = await fetch(href);
        learnResponseUrl(res, learnUrl);
        if (!res.ok || !res.body) {
          throw new InputError('unsupported-input', `f ${res.status}`);
        }
        // A full GET exposes the total via `Content-Length` — memoize it for later range clamping.
        if (learn) learnSize(learn, parseContentLength(res.headers));
        reader = res.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason): void {
      void reader?.cancel(reason);
    },
  });
}

async function fetchRange(
  href: string,
  start: number,
  end: number,
  learn?: LearnSize,
  learnUrl?: (url: string) => void,
): Promise<Uint8Array> {
  // Clamp a never-negative, ordered window first; if we already know the size, never ask past EOF.
  const known = learn?.size;
  const lo = Math.max(0, Math.trunc(start));
  let hi = Math.max(lo, Math.trunc(end));
  if (known !== undefined) hi = Math.min(hi, known);
  if (hi <= lo) return new Uint8Array(0); // empty window (incl. start at/after a known EOF)

  if (known !== undefined && lo === 0 && hi === known && known <= TINY_KNOWN_FULL_RANGE_GET_BYTES) {
    const res = await fetch(href);
    learnResponseUrl(res, learnUrl);
    if (!res.ok) {
      throw new InputError('unsupported-input', `f ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (learn) learnSize(learn, parseContentLength(res.headers) ?? buf.byteLength);
    return buf;
  }

  // HTTP Range is inclusive; our contract is half-open [lo, hi).
  const res = await fetch(href, { headers: { Range: `bytes=${lo}-${hi - 1}` } });
  learnResponseUrl(res, learnUrl);
  if (!res.ok) {
    throw new InputError('unsupported-input', `r ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (res.status === 206) {
    // Learn the authoritative total from `Content-Range: bytes lo-hi/total` for future clamping.
    if (learn) learnSize(learn, parseContentRangeTotal(res.headers.get('Content-Range')));
    // A spec-compliant 206 returns exactly the requested window; guard a server that over-returns.
    return buf.byteLength > hi - lo ? buf.subarray(0, hi - lo) : buf;
  }
  // A server that ignores Range returns 200 with the whole body → it is the full resource: memoize its
  // length and slice the requested window locally.
  if (learn) learnSize(learn, buf.byteLength);
  return buf.subarray(clamp(lo, buf.byteLength), clamp(hi, buf.byteLength));
}

/**
 * Detect a URL's total byte length without downloading it: a `HEAD` (reading `Content-Length`), falling
 * back to a one-byte ranged `GET` (`bytes=0-0`) whose `206` reply carries `Content-Range: …/total` — the
 * robust path when a server omits `Content-Length` on HEAD or disallows HEAD. Returns `undefined` when
 * neither header is present (an unknown-length / chunked resource). Used by the caching/preload layer to
 * learn size eagerly so tail-seeking probes work on remote files.
 */
export async function probeUrlSize(url: string | URL): Promise<number | undefined> {
  const { probeUrlSizeImpl } = await import('./url-size.ts');
  return probeUrlSizeImpl(url);
}

/** Parse a non-negative integer `Content-Length`, or `undefined` if absent/malformed. */
function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('Content-Length');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Parse the `total` from `Content-Range: bytes <start>-<end>/<total>` (`*` total ⇒ `undefined`). */
function parseContentRangeTotal(value: string | null): number | undefined {
  if (value === null || !value.includes('/')) return undefined;
  const tail = value.slice(value.lastIndexOf('/') + 1).trim();
  if (tail === '*' || tail === '') return undefined;
  const n = Number(tail);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function isMediaElement(x: unknown): x is HTMLMediaElement {
  return typeof HTMLMediaElement !== 'undefined' && x instanceof HTMLMediaElement;
}

function clamp(n: number, max: number): number {
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}
