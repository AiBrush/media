# 07 — Public API (DX Spec)

> The developer-facing surface. Concrete enough to implement and to write `.d.ts` against. Decisions: ADR-009 (surface), ADR-010 (call styles), ADR-011 (options), ADR-012 (naming), ADR-013 (data), ADR-017 (errors). All backend choice is invisible (ADR-003).

## 1. Initialization

```ts
import { createMedia } from '@aibrush/media'

const media = createMedia({
  determinism?: 'auto' | 'force-software',   // default 'auto'                (ADR-007)
  enableThreads?: boolean,                    // default = crossOriginIsolated (ADR-006)
  worker?: boolean | { pool?: number },       // default true for heavy ops    (ADR-019)
  assetBaseUrl?: string,                       // override; default = import.meta.url-resolved (ADR-005)
  onLog?: (e: LogEvent) => void,
})
```

Bare-function sugar (backed by a default instance) for simple apps:

```ts
import { probe, convert } from '@aibrush/media'
const info = await probe(file)
```

## 2. Core operations

All ops are `async`, accept a trailing `{ signal?, onProgress? }`, and return a cancellable handle (the returned `Promise` also has `.cancel()`).

```ts
media.probe(input: MediaInput, o?: CallOptions): Promise<MediaInfo>
media.convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Promise<Output>
media.remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Promise<Output>     // copy, no re-encode
media.trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Promise<Output>
media.decode(input: MediaInput, o?: CallOptions): MediaStreams                            // -> frame streams
media.encode(frames: MediaStreams, opts: EncodeOptions, o?: CallOptions): Promise<Output>
media.demux(input: MediaInput, o?: CallOptions): Promise<Demuxed>                          // -> packet streams + tracks
media.mux(streams: PacketStreams, opts: MuxSpec, o?: CallOptions): Promise<Output>
media.decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Promise<Output>
```

`convert` is the headline op and **auto-routes copy-vs-re-encode** per stream: if a stream already matches the target codec/params it is stream-copied (remux-fast); otherwise it is re-encoded (ADR-012). `transcode` is an exported alias of `convert`.

### Option shapes (flat, typed — ADR-011)

```ts
interface CallOptions { signal?: AbortSignal; onProgress?: (p: Progress) => void; strategy?: StrategyOverride /* hidden, ADR-014 */ }

interface ConvertOptions {
  to?: 'mp4' | 'mov' | 'webm' | 'mkv' | 'ogg' | 'wav' | 'mp3' | 'aac' | 'ts'   // target container
  video?: false | {                                  // false = drop video
    codec?: 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1'
    width?: number; height?: number; fit?: 'contain' | 'cover' | 'fill'
    fps?: number; bitrate?: number; crf?: number
    rotate?: 0 | 90 | 180 | 270; flip?: 'h' | 'v'
    crop?: { x: number; y: number; width: number; height: number }
  }
  audio?: false | { codec?: 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | 'pcm'; sampleRate?: number; channels?: number; bitrate?: number }
  faststart?: boolean; fragmented?: boolean          // MP4 layout
  sink?: Sink                                        // default: Blob
}
interface RemuxOptions { to: ConvertOptions['to']; faststart?: boolean; fragmented?: boolean; sink?: Sink }
interface TrimOptions  { start: number; end: number; mode?: 'keyframe' | 'accurate'; sink?: Sink }   // seconds
interface DecryptOptions { scheme: 'cenc' | 'cbcs' | 'hls-aes128'; keys: KeyMap; sink?: Sink }
```

### `MediaInfo` (probe result)

```ts
interface MediaInfo {
  container: string; durationSec: number; sizeBytes?: number
  tracks: Array<{
    id: number; type: 'video' | 'audio'; codec: string; durationSec?: number
    width?: number; height?: number; rotation?: number; fps?: number          // video
    sampleRate?: number; channels?: number                                    // audio
    language?: string
  }>
  tags?: Record<string, string>
}
```

## 3. Data in — sources (ADR-013)

Operations accept media **directly** (`MediaInput`), so most callers never construct a source:

```ts
type MediaInput =
  | ArrayBuffer | Uint8Array | Blob | File
  | ReadableStream<Uint8Array> | URL | string /* url */
  | HTMLMediaElement | MediaStream | Source

await media.probe(file)
await media.probe('https://cdn/x.mp4')      // URL string -> range/header read
await media.probe(videoEl)                  // <video> -> BYTES mode (reads currentSrc), never loadedmetadata
```

`from()` is the same normalizer, exported for when you want options; canonical constructors for unambiguous/optioned cases:

```ts
from(input, opts?)                          // universal
fromBytes(u8) · fromBlob(file) · fromURL(url, { rangeRequests }) · fromOPFS(path)
fromElement(el, { mode: 'bytes' | 'capture' })   // 'bytes' (default) | 'capture' = captureStream() live
fromStream(readable)
```

Bare-string rule: `from('…')` = URL by precedence (`http(s)|blob|data|file`), else relative `fetch`; **OPFS needs `fromOPFS()`**; otherwise `InputError`.

## 4. Data out — sinks (ADR-013)

```ts
type Sink = ReturnType<typeof toBlob> | /* … */ Sink
toBlob() · toFile(name) · toStream() · toOPFS(path)
toElement(el, { via?: 'blob' | 'mse' | 'stream' })   // default: blob (whole-file) / mse (streaming target)
```

`type Output = Blob | File | ReadableStream<Uint8Array> | void` depending on the sink. Default sink is `toBlob()`. Stream sinks are **lazy** (pull-based).

## 5. Warmup — `preload` (hide first-call latency)

```ts
type PreloadSpec = string | { op: string; video?: string; audio?: string; container?: string; level?: 'chunks' | 'compile' | 'ready' }
media.preload(...specs: PreloadSpec[]): Promise<void>        // fire-and-forget; accepts { signal }; idempotent; never throws

media.preload('probe')
media.preload({ op: 'convert', video: 'h264', container: 'mp4' }, { op: 'probe' })
```

Prefetches op/driver chunks, compiles the predicted WASM, and warms capability probes. `level` default `'compile'`. Explicit only (no auto-warm in v1).

## 6. Errors (ADR-017)

```ts
class MediaError extends Error { code: MediaErrorCode; detail?: unknown }
class CapabilityError extends MediaError {}   // code 'capability-miss'; detail { op, tried[], suggestion? }
class InputError extends MediaError {}        // code 'unsupported-input'
```

A capability miss is always a typed throw, never a silent wrong result (e.g. FLAC decode where unsupported — see [`10-browser-capability-matrix.md`](10-browser-capability-matrix.md)).

## 7. Low-level graph (escape hatch, ADR-010)

For power users; the flat ops and (post-v1) fluent chain compile to this.

```ts
const src     = media.source(input)
const demuxed = media.demux(src)
const frames  = media.decode(demuxed.video)
const filtered= media.filter(frames, [{ type: 'resize', mediaType: 'video', width: 1280, height: 720 }])
const encoded = media.encode(filtered, { codec: 'h264' })
const out     = await media.mux({ video: encoded, audio: demuxed.audio /* copy */ }, { container: 'mp4' }).toBlob()
```

## 8. Declarative job (worker/serialization boundary, ADR-010)

```ts
await media.run({
  input,
  ops: [{ op: 'trim', start: 0, end: 5 }, { op: 'resize', width: 1280, height: 720 }],
  output: { container: 'mp4', video: { codec: 'h264' }, audio: { codec: 'aac' } },
}, { signal, onProgress })
```

## 9. Worked examples

```ts
// 1) Read metadata (fast, main thread):
const info = await media.probe(file)

// 2) Convert an upload to a 720p MP4 (worker, hardware-first):
const mp4 = await media.convert(file, { to: 'mp4', video: { codec: 'h264', height: 720 }, audio: { codec: 'aac' } })

// 3) Trim, frame-accurate, to a Blob URL on a <video>:
await media.convert(file, { /* ... */ }, { signal })
const clip = await media.trim(file, { start: 1.5, end: 4.0, mode: 'accurate', sink: toElement(previewEl) })

// 4) Remux MOV->MP4 without re-encoding (fast copy):
const out = await media.remux(movFile, { to: 'mp4', faststart: true })

// 5) Decrypt CENC with provided keys:
const clear = await media.decrypt(encMp4, { scheme: 'cenc', keys })
```

## 10. Post-v1: fluent chain (ADR-010, deferred)

A façade over the declarative job, added non-breakingly after v1:

```ts
await media.load(file).trim({ start: 0, end: 5 }).resize(1280, 720).convert({ to: 'mp4' }).blob()
```
