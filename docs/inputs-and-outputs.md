# Inputs and outputs

All high-level operations accept `MediaInput`. You can pass a supported value directly or normalize it
into a `Source` when you need MIME hints, known sizes, range control, or caching.

## Accepted inputs

| Input | Notes |
| --- | --- |
| `File` or `Blob` | Re-readable, sized, and range-capable |
| `ArrayBuffer` or an `ArrayBufferView` | Re-readable in-memory bytes |
| `ReadableStream<Uint8Array>` | Single-use; routing preserves its sniffed prefix |
| `string` or `URL` | Fetched as a URL; HTTP range requests are enabled by default |
| `HTMLMediaElement` | Reads `currentSrc`/`src` as bytes by default |
| `MediaStream` or `LiveMediaSource` | Raw live tracks; only operations that support live frames can consume it |
| `Source` | An already normalized byte source |

### Files and byte buffers

Pass files and bytes directly when no extra hints are required:

```ts
import { fromBytes, probe } from '@aibrush/media';

const source = fromBytes(bytes, { mime: 'video/mp4' });
const info = await probe(source);
```

`fromBlob(blob)` preserves the Blob MIME type. When the value is a `File`, it also preserves its name as
a routing hint.

### URLs

Raw strings and `URL` objects use `fetch`. Use `fromURL()` to provide details the server does not expose:

```ts
import { fromURL, probe } from '@aibrush/media';

const source = fromURL('/media/asset', {
  mime: 'video/mp4',
  size: 24_810_552,
  rangeRequests: true,
});

const info = await probe(source);
```

Range reads are half-open: `[start, end)`. The source translates them to HTTP `Range` requests and
records whether the server returned a compliant partial response. If the server ignores ranges, the
engine falls back to full-body behavior without treating the response as partial data.

Use `probeUrlSize(url)` to learn a remote size with `HEAD` or a one-byte ranged request without
downloading the full resource.

For repeated overlapping range reads, opt into an in-memory cache:

```ts
import { cacheSource } from '@aibrush/media';

const source = cacheSource('/media/movie.mp4', { maxBytes: 8 * 1024 * 1024 });
await source.prime();
```

`maxBytes` bounds retained seekable windows. `eager: true` intentionally materializes the full resource
on the first read or `prime()` call.

Browser fetch rules still apply. Cross-origin media URLs must permit your application origin, and byte
seeking is most efficient when the server exposes content length and honors range requests.

### Streams

Use `fromStream()` when the producer exposes MIME or size out of band:

```ts
import { fromStream, probe } from '@aibrush/media';

const source = fromStream(response.body!, {
  mime: response.headers.get('content-type') ?? undefined,
  size: Number(response.headers.get('content-length')) || undefined,
});

const info = await probe(source);
```

A stream source is single-use. Do not pass the same source to a second operation after it has been
consumed. Use a `Blob`, byte buffer, URL, or a new stream when several independent operations need the
same media.

### Media elements and live streams

An `HTMLMediaElement` is read as encoded bytes from its current URL by default:

```ts
import { fromElement } from '@aibrush/media';

const source = fromElement(videoElement);
```

Live capture is explicit and depends on `HTMLMediaElement.captureStream()`:

```ts
const live = fromElement(videoElement, { mode: 'capture' });
```

Use `fromMediaStream(stream)` for an existing camera, microphone, or composed media stream. A live source
is not a container byte stream, so `probe`, `demux`, `remux`, and byte-oriented decrypt operations reject
it with a typed capability miss.

### OPFS input

Resolve an Origin Private File System path before passing it to an operation:

```ts
import { fromOPFS, probe } from '@aibrush/media';

const source = await fromOPFS('/uploads/input.mp4');
const info = await probe(source);
```

OPFS is a secure-context browser feature and is not available in every runtime.

## The `Source` contract

`Source` is useful for adapters and infrastructure code. It exposes:

- `stream()` for a byte stream;
- optional `size` for the total byte length;
- optional `range(start, end, signal)` for random access;
- optional `readAll(signal)` for an owned full-buffer read;
- `mimeHint` and `filename` routing hints.

A `Source` represents one immutable byte snapshot. Create a new source when the underlying URL or OPFS
file changes.

## Output sinks

Operations buffer into a `Blob` by default. Set `sink` to select another destination.

| Helper | Result | Behavior |
| --- | --- | --- |
| `toBlob()` | `Blob` | Retains the complete output in memory |
| `toFile(name)` | `File` | Retains the complete output with a filename |
| `toStream()` | `ReadableStream<Uint8Array>` | Returns a pull-driven output stream |
| `toOPFS(path)` | `undefined` | Streams to an OPFS file |
| `toElement(element, options)` | `undefined` | Attaches output by Blob URL, MSE, or streaming mode |
| `toStreamTarget(destination, options)` | `undefined` | Writes incrementally to a writable stream or callback |

### Choosing a sink before the operation runs

The right sink depends on the route the engine selects, not just on the request: the same
`remux(source, { to: 'mp4' })` is an append-only, bounded-memory byte stream for one source and a
whole-payload rewrite for another. `planRemuxOutput()` declares that contract before any byte is
produced. It routes the source container and returns immediately; it never encodes, muxes, or writes.

```ts
import { planRemuxOutput, remux, toBlob, toStreamTarget } from '@aibrush/media';

const plan = await planRemuxOutput(source, { to: 'mp4' });
// plan.writeOrder            → 'append-only' | 'positioned'
// plan.requiresSeek          → the sink must accept writes at an earlier offset
// plan.requiresReservation   → a byte region is reserved up front and patched at the end
// plan.requiresFinalization  → the bytes are a complete program only after the last chunk
// plan.boundedRetentionAvailable → peak memory can stay bounded with a streaming sink
// plan.acceptedSinkKinds     → sink kinds this route accepts

const sink =
  plan.boundedRetentionAvailable && !plan.requiresSeek
    ? toStreamTarget(async (chunk) => { await uploadPart(chunk); })
    : toBlob();
await remux(source, { to: 'mp4', sink });
```

The declaration is conservative: where a route may decline at runtime and continue into another, it
reports the strictest requirement any reachable route imposes, so a sink chosen from it stays valid.
An illegal request — a reserved fast-start with a whole-output sink, a `maximumPacketCount` without a
reservation — is rejected here rather than after the operation has run.

### Readable output

```ts
import { convert, toStream } from '@aibrush/media';

const output = await convert(file, {
  to: 'webm',
  video: { codec: 'vp9' },
  audio: { codec: 'opus' },
  sink: toStream(),
});

if (output instanceof ReadableStream) {
  await output.pipeTo(uploadBody);
}
```

The operation resolves when the lazy stream is ready. Encoding and muxing continue as the consumer pulls
bytes, so read failures surface from the stream.

### Incremental writes with backpressure

`toStreamTarget()` writes each output chunk directly to a caller-owned destination:

```ts
import { convert, toStreamTarget } from '@aibrush/media';

await convert(file, {
  to: 'mp4',
  video: { codec: 'h264' },
  audio: { codec: 'aac' },
  fragmented: true,
  sink: toStreamTarget(async (chunk, position) => {
    await uploadPart(chunk, position);
  }),
});
```

Returning a promise from the callback applies backpressure. `position` is the producer's intended byte
offset, which allows a muxer to patch an earlier output region. An append-only `WritableStream` rejects a
non-contiguous write rather than placing bytes at the wrong offset.

The optional write-shaping modes are mutually exclusive:

- `{ chunked: true, chunkSize }` coalesces contiguous writes;
- `{ writeChunkBytes }` emits exact-size destination writes and rejects an incomplete final block.

For the earliest first byte, leave both modes disabled.

### OPFS and media elements

```ts
import { convert, toElement, toOPFS } from '@aibrush/media';

await convert(file, {
  to: 'mp4',
  video: { codec: 'h264' },
  sink: toOPFS('/exports/output.mp4'),
});

await convert(file, {
  to: 'webm',
  video: { codec: 'vp9' },
  audio: { codec: 'opus' },
  sink: toElement(videoElement, { via: 'blob' }),
});
```

`via: 'blob'` retains the whole file before assigning a Blob URL. `via: 'mse'` and `via: 'stream'`
require an output/container combination supported by the runtime's streaming media path.
