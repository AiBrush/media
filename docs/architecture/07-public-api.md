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
media.h264AbrLadder(input: MediaInput, ladder: readonly H264AbrRung[], o?: CallOptions): Promise<readonly Output[]>
media.remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Promise<Output>     // copy, no re-encode
media.trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Promise<Output>
media.decode(input: MediaInput, o?: CallOptions): MediaStreams                            // -> frame streams
media.encode(frames: MediaStreams, opts: EncodeOptions, o?: CallOptions): Promise<Output>
media.demux(input: MediaInput, o?: CallOptions): Promise<Demuxed>                          // -> packet streams + tracks
media.mux(streams: PacketStreams, opts: MuxSpec, o?: CallOptions): Promise<Output>          // explicit tracks + packets
media.decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Promise<Output>
```

`convert` is the headline op and **auto-routes copy-vs-re-encode** per stream: if a stream already matches the target codec/params it is stream-copied (remux-fast); otherwise it is re-encoded (ADR-012). `transcode` is an exported alias of `convert`.

Still/animated images are accepted by `probe` and `decode` for GIF, PNG/APNG, JPEG, WebP, and AVIF (ADR-049/077). `probe` returns a video-like `MediaInfo` track from the pure header parser, including exact animation duration when GIF/APNG/WebP headers carry per-frame delays; animated images without parsed timing keep the conservative frame-count fallback, and still images report duration `0`. `decode` returns a lazy video `ReadableStream<VideoFrame>` via browser `ImageDecoder`; the paired audio stream is empty, and Node raises a typed `CapabilityError` for image pixel decode because `ImageDecoder` is absent there.

### Option shapes (flat, typed — ADR-011)

```ts
interface CallOptions { signal?: AbortSignal; onProgress?: (p: Progress) => void; strategy?: StrategyOverride /* hidden, ADR-014 */ }

type AudioBiquad = {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf'
  frequency: number
  q: number
  gainDb?: number
}

interface ConvertOptions {
  to?: 'mp4' | 'mov' | 'webm' | 'mkv' | 'ogg' | 'wav' | 'mp3' | 'aac' | 'adts'
    | 'flac' | 'aiff' | 'caf' | 'avi' | 'ts' | 'm2ts' | 'mts' | 'mpegts'       // target container
  video?: false | {                                  // false = drop video
    codec?: 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1'
    width?: number; height?: number; fit?: 'contain' | 'cover' | 'fill'
    fps?: number; bitrate?: number; bitrateMode?: VideoEncoderBitrateMode
    crf?: number; twoPass?: boolean; bitDepth?: 8 | 10 | 12
    alpha?: 'keep' | 'discard'
    rotate?: 0 | 90 | 180 | 270; flip?: 'h' | 'v'
    crop?: { x: number; y: number; width: number; height: number }
    colorspace?: { to: string }; tonemap?: { to: 'sdr' }
  }
  audio?: false | {
    codec?: 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis'
      | 'pcm' | 'pcm-u8' | 'pcm-s8' | 'pcm-s16' | 'pcm-s24' | 'pcm-s32' | 'pcm-f32' | 'pcm-f64'
      | 'pcm-u8be' | 'pcm-s8be' | 'pcm-s16be' | 'pcm-s24be' | 'pcm-s32be' | 'pcm-f32be' | 'pcm-f64be'
    sampleRate?: number; channels?: number; bitrate?: number
    gainDb?: number
    fade?: { inSec?: number; outSec?: number; curve?: 'linear' | 'equal-power' }
    dynamics?: { normalize?: { mode: 'peak' | 'rms'; targetDbfs: number }; limit?: { ceilingDbfs?: number; mode?: 'hard' | 'soft'; knee?: number } }
    biquad?: AudioBiquad | readonly AudioBiquad[]
  }
  faststart?: boolean; fragmented?: boolean          // MP4/WebM streaming layout
  sink?: Sink                                        // default: Blob
}
interface RemuxOptions {
  to: ConvertOptions['to']; faststart?: boolean; fragmented?: boolean
  tags?: Record<string, string>                      // same-container tag rewrite
  trackSelect?: readonly string[]; sink?: Sink
}
interface TrimOptions  { start: number; end: number; mode?: 'keyframe' | 'accurate'; sink?: Sink }   // seconds
interface DecryptOptions { scheme: 'cenc' | 'cens' | 'cbcs' | 'hls-aes128' | 'hls-sample-aes'; keys: KeyMap; sink?: Sink }
interface PacketStream { track: TrackInfo; packets: ReadableStream<Packet | EncodedChunk> }
interface PacketStreams { video?: PacketStream; audio?: PacketStream; tracks?: readonly PacketStream[] }
interface MuxSpec { container: ConvertOptions['to']; faststart?: boolean; fragmented?: boolean; sink?: Sink }
interface H264AbrRung { name?: string; width: number; height: number; bitrate: number; fps?: number }
```

`trim({ mode:'keyframe' })` is the fast lossless packet-copy path. `trim({ mode:'accurate' })`
routes through the browser codec seam: decode from a safe preroll, keep decoded frames whose timestamps
fall inside `[start,end)`, rebase to `0`, re-encode, and mux. Unsupported WebCodecs/container/track cases
surface as typed errors; the op never falls back to returning the input bytes.

`mux()` is the low-level packet seam. Each stream must include the source or encoder `TrackInfo`; the
muxer needs codec-private data (`description` boxes/headers), dimensions or sample layout, duration, and
media type before it can write a legal container. Bare `ReadableStream<EncodedChunk>` inputs are rejected
with `InputError` and cancelled rather than guessed.

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

Image helper exports are available from `@aibrush/media/image` for callers that want the standalone route without constructing an engine: `probeImage`, `inspectImage`, `sniffImageFormat`, `decodeImage`, `decodeImageFrames`, `hasImageDecoder`, `IMAGE_FORMATS`, `IMAGE_MIME`, and the `ImageInfo`/`ImageFormat`/`DecodeImageOptions` types. They live on a subpath so the pure image parser does not join the eager default-entry bundle.

## 3. Data in — sources (ADR-013)

Operations accept media **directly** (`MediaInput`), so most callers never construct a source:

```ts
type MediaInput =
  | ArrayBuffer | Uint8Array | Blob | File
  | ReadableStream<Uint8Array> | URL | string /* url */
  | HTMLMediaElement | MediaStream | Source

await media.probe(file)
await media.probe('https://cdn/x.mp4')      // URL string -> range/header read
await media.probe(imageFile)                // GIF/PNG/JPEG/WebP/AVIF -> pure image header probe
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
As built (ADR-083), preload normalizes loose specs, imports/registers the default driver bundle, warms
requested container/codec/filter probes through the router, dynamically imports predicted WASM tails, and
calls their core loaders for compile/ready levels. It is memoized per normalized spec and catches every
warmup miss; failed probes or unavailable WASM assets are surfaced only through optional logs, never as a
rejected `preload()` promise.

## 6. Errors (ADR-017)

```ts
class MediaError extends Error { code: MediaErrorCode; detail?: unknown }
class CapabilityError extends MediaError {}   // code 'capability-miss'; detail { op, tried[], suggestion? }
class InputError extends MediaError {}        // code 'unsupported-input'
```

A capability miss is always a typed throw, never a silent wrong result (e.g. FLAC decode where unsupported — see [`10-browser-capability-matrix.md`](10-browser-capability-matrix.md)).

## 7. Low-level graph (escape hatch, ADR-010)

For power users; the flat ops and fluent chain share the same operation seams.

```ts
const src     = media.source(input)
const demuxed = await media.demux(src)
const video   = demuxed.tracks.find(t => t.mediaType === 'video' && t.config)
if (!video) throw new Error('no muxable video track')
const out     = await media.mux({ video: { track: video, packets: demuxed.packets(video.id) } }, { container: 'mp4' })
await demuxed.close()
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

## 10. Fluent chain (ADR-010)

A small immutable façade over the flat task API. Each fluent transform stores intent until a terminal
sink (`blob`/`file`/`stream`/`run`) is called, then delegates to the existing `trim`/`convert`/`remux`/
`decrypt` operations. Multi-step chains materialize intermediate flat-op outputs as `Blob`s until the
serialized declarative runner becomes the primary execution path; this keeps one codec/filter/mux
implementation and avoids a second hidden pipeline.

```ts
await media.load(file).trim({ start: 0, end: 5 }).resize(1280, 720).convert({ to: 'mp4' }).blob()
await load(file).resize(640, 360).to('webm').stream()
```
