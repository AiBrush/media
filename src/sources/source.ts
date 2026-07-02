/**
 * Source normalization (ADR-013, docs/architecture/07 §3) — turn anything a caller has (bytes, Blob,
 * URL, stream, DOM element) into a uniform {@link Source}: a {@link ByteSource} with a fresh
 * `stream()`, an optional `size`, and optional random-access `range()` (which is what keeps `probe`
 * fast — header-only reads). Web streams are used so a huge file never fully buffers.
 *
 * `range(start, end)` is **half-open** `[start, end)` (JS `subarray`/`slice` semantics); the URL source
 * translates it to the inclusive HTTP `Range` header.
 */

import { InputError } from '../contracts/errors.ts';

const TINY_KNOWN_FULL_RANGE_GET_BYTES = 16 * 1024;

/** Internal identity hook used for short-lived cross-operation source caches. Not exported from the public barrel. */
export const SOURCE_CACHE_KEY: unique symbol = Symbol('a');

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
  | Source;

/** How a {@link Source} was constructed (used for diagnostics and sink defaults). */
export type SourceKind = 'bytes' | 'blob' | 'stream' | 'url' | 'opfs' | 'element';

/** A normalized, re-readable byte source. */
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
  /** `bytes` reads `currentSrc` (default); `capture` taps `captureStream()` (Phase 1). */
  mode?: 'bytes' | 'capture';
}
export type FromOptions = FromUrlOptions & { mime?: string };

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
  return {
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

/** Wrap a single-use byte stream (no random access; consuming twice throws). */
export function fromStream(readable: ReadableStream<Uint8Array>): Source {
  let consumed = false;
  return {
    __media: 'source',
    kind: 'stream',
    stream: () => {
      if (consumed) {
        throw new InputError('unsupported-input', 'used');
      }
      consumed = true;
      return readable;
    },
  };
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
  // `size` is a real own property, present only once known: seeded if the caller passed it, otherwise set
  // (assigned a `number`, never an explicit `undefined`) the first time a fetch learns it from a
  // `Content-Range`/`Content-Length`. The fetch closures share this object so a later read can clamp.
  const source: Source = {
    __media: 'source',
    kind: 'url',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    ...(opts.mime !== undefined ? { mimeHint: opts.mime } : {}),
    [SOURCE_CACHE_KEY]: href,
    stream: () => fetchStream(href, source),
    ...(opts.rangeRequests !== false
      ? { range: (start, end) => fetchRange(href, start, end, source) }
      : {}),
  };
  return source;
}

/** Read a media element's current source as bytes (default), per ADR-013 (never `loadedmetadata`). */
export function fromElement(el: HTMLMediaElement, opts: FromElementOptions = {}): Source {
  const mode = opts.mode ?? 'bytes';
  if (mode === 'capture') {
    throw new InputError('unsupported-input', 'capture');
  }
  const href = el.currentSrc || el.src;
  if (!href) {
    throw new InputError('unsupported-input', 'src');
  }
  // A URL-backed source relabelled `element` (reads `currentSrc`, never `loadedmetadata`). Built directly
  // over the fetch helpers (rather than spreading a `fromURL`) so `size` is learned onto *this* object on
  // the first range/stream read, exactly like a plain URL source.
  const element: Source = {
    __media: 'source',
    kind: 'element',
    stream: () => fetchStream(href, element),
    range: (start, end) => fetchRange(href, start, end, element),
  };
  return element;
}

/** Read a file from the Origin Private File System by path. */
export async function fromOPFS(path: string): Promise<Source> {
  const { fromOPFSImpl } = await import('./opfs.ts');
  return fromOPFSImpl(path);
}

/**
 * The universal normalizer (ADR-013). Accepts anything in {@link MediaInput} and returns a
 * {@link Source}; a bare string resolves to a URL by protocol precedence, else a relative fetch.
 */
export function from(input: MediaInput, opts: FromOptions = {}): Source {
  if (isSource(input)) return input;
  if (input instanceof Uint8Array) return fromBytes(input, opts);
  if (input instanceof ArrayBuffer) return fromBytes(input, opts);
  if (ArrayBuffer.isView(input)) return fromBytes(input, opts);
  if (input instanceof Blob) return fromBlob(input);
  if (input instanceof ReadableStream) return fromStream(input);
  if (input instanceof URL) return fromURL(input, opts);
  if (typeof input === 'string') return fromURL(input, opts);
  if (isMediaElement(input)) return fromElement(input);
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

function fetchStream(href: string, learn?: LearnSize): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (!reader) {
        const res = await fetch(href);
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
): Promise<Uint8Array> {
  // Clamp a never-negative, ordered window first; if we already know the size, never ask past EOF.
  const known = learn?.size;
  const lo = Math.max(0, Math.trunc(start));
  let hi = Math.max(lo, Math.trunc(end));
  if (known !== undefined) hi = Math.min(hi, known);
  if (hi <= lo) return new Uint8Array(0); // empty window (incl. start at/after a known EOF)

  if (known !== undefined && lo === 0 && hi === known && known <= TINY_KNOWN_FULL_RANGE_GET_BYTES) {
    const res = await fetch(href);
    if (!res.ok) {
      throw new InputError('unsupported-input', `f ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (learn) learnSize(learn, parseContentLength(res.headers) ?? buf.byteLength);
    return buf;
  }

  // HTTP Range is inclusive; our contract is half-open [lo, hi).
  const res = await fetch(href, { headers: { Range: `bytes=${lo}-${hi - 1}` } });
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
