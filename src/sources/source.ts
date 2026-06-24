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
  /** Total byte length when known ahead of time. */
  readonly size?: number;
  /** Random access for header-only reads; half-open `[start, end)`. Absent for pure streams. */
  range?(start: number, end: number): Promise<Uint8Array>;
  /** A MIME hint from the origin (Blob type, element, etc.), if any. */
  readonly mimeHint?: string;
  /** A filename hint (from a `File`), if any. */
  readonly filename?: string;
}

export interface FromUrlOptions {
  /** Use HTTP Range requests for `range()`/probe (default true). */
  rangeRequests?: boolean;
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
  const filename = isFile(blob) ? blob.name : undefined;
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
        throw new InputError(
          'unsupported-input',
          'stream source already consumed (it is single-use)',
        );
      }
      consumed = true;
      return readable;
    },
  };
}

/** Wrap a URL (or URL string). `stream()` is returned synchronously, backed by `fetch`. */
export function fromURL(url: string | URL, opts: FromUrlOptions = {}): Source {
  const href = typeof url === 'string' ? url : url.href;
  const rangeRequests = opts.rangeRequests ?? true;
  const source: Source = {
    __media: 'source',
    kind: 'url',
    stream: () => fetchStream(href),
    ...(rangeRequests ? { range: (start, end) => fetchRange(href, start, end) } : {}),
  };
  return source;
}

/** Read a media element's current source as bytes (default), per ADR-013 (never `loadedmetadata`). */
export function fromElement(el: HTMLMediaElement, opts: FromElementOptions = {}): Source {
  const mode = opts.mode ?? 'bytes';
  if (mode === 'capture') {
    throw new InputError(
      'unsupported-input',
      'element capture mode is not available yet (Phase 1); use mode:"bytes"',
    );
  }
  const href = el.currentSrc || el.src;
  if (!href) {
    throw new InputError('unsupported-input', 'media element has no resolvable currentSrc/src');
  }
  return { ...fromURL(href), kind: 'element' };
}

/** Read a file from the Origin Private File System by path. */
export async function fromOPFS(path: string): Promise<Source> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new InputError('unsupported-input', 'OPFS is unavailable in this environment');
  }
  const file = await opfsFile(storage, path);
  return { ...fromBlob(file), kind: 'opfs' };
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
  if (typeof input === 'string') return fromBareString(input, opts);
  if (isMediaElement(input)) return fromElement(input);
  if (isMediaStream(input)) {
    throw new InputError(
      'unsupported-input',
      'MediaStream capture is not available yet (Phase 1); pass bytes, a Blob, or a URL',
    );
  }
  throw new InputError(
    'unsupported-input',
    `cannot normalize input of type ${describeType(input)}`,
  );
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

function fromBareString(s: string, opts: FromOptions): Source {
  // URL by precedence (http(s) | blob | data | file); otherwise a relative fetch (resolved by the host).
  return fromURL(s, opts);
}

function fetchStream(href: string): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (!reader) {
        const res = await fetch(href);
        if (!res.ok || !res.body) {
          throw new InputError(
            'unsupported-input',
            `fetch failed for ${href} (status ${res.status})`,
          );
        }
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

async function fetchRange(href: string, start: number, end: number): Promise<Uint8Array> {
  // HTTP Range is inclusive; our contract is half-open [start, end).
  const res = await fetch(href, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!res.ok) {
    throw new InputError(
      'unsupported-input',
      `range fetch failed for ${href} (status ${res.status})`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range returns 200 with the whole body → slice locally.
  return res.status === 206
    ? buf
    : buf.subarray(clamp(start, buf.byteLength), clamp(end, buf.byteLength));
}

async function opfsFile(storage: StorageManager, path: string): Promise<File> {
  const parts = path.split('/').filter((p) => p.length > 0);
  const name = parts.pop();
  if (name === undefined) {
    throw new InputError('unsupported-input', `invalid OPFS path '${path}'`);
  }
  let dir = await storage.getDirectory();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

function isFile(blob: Blob): blob is File {
  return typeof File !== 'undefined' && blob instanceof File;
}

function isMediaElement(x: unknown): x is HTMLMediaElement {
  return typeof HTMLMediaElement !== 'undefined' && x instanceof HTMLMediaElement;
}

function isMediaStream(x: unknown): x is MediaStream {
  return typeof MediaStream !== 'undefined' && x instanceof MediaStream;
}

function describeType(x: unknown): string {
  if (x === null) return 'null';
  if (typeof x === 'object') return (x as object).constructor?.name ?? 'object';
  return typeof x;
}

function clamp(n: number, max: number): number {
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}
