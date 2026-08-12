# API reference

This page summarizes the application-facing exports from `@aibrush/media`. Import TypeScript types with
`import type` so they do not create runtime edges.

## Engine creation and lifecycle

```ts
function createMedia(options?: CreateMediaOptions): MediaEngine;
function resetDefaultMedia(): Promise<void>;
```

`createMedia()` returns an isolated engine. `resetDefaultMedia()` disposes and removes the shared engine
behind bare functions; the next bare call creates a new instance.

`CreateMediaOptions`:

| Field | Type | Behavior |
| --- | --- | --- |
| `determinism` | `'auto' | 'force-software'` | Selects automatic routing or a proved software route |
| `enableThreads` | `boolean` | Enables threaded WASM only when isolation and `SharedArrayBuffer` are available |
| `worker` | `boolean | { pool?: number }` | Opts heavy pipelines into worker execution |
| `assetBaseUrl` | `string` | Same-origin base directory for selected WASM assets |
| `onLog` | `(event: LogEvent) => void` | Receives diagnostic events |

`MediaEngine` exposes every operation below plus `load`, `from`, `source`, `use`, `preload`,
`canConvert`, `dispose`, and `Symbol.asyncDispose`.

## Bare operations

| Function | Signature summary | Result |
| --- | --- | --- |
| `probe` | `(input, callOptions?)` | `Cancellable<MediaInfo>` |
| `packetInfo` | `(input, packetInfoOptions?)` | `Cancellable<PacketInfoTable>` |
| `packetInfoBatches` | `(input, batchOptions?)` | `Cancellable<PacketInfoBatchStream>` |
| `demux` | `(input, callOptions?)` | `Cancellable<Demuxed>` |
| `convert` | `(input, convertOptions, callOptions?)` | `Cancellable<Output>` |
| `transcode` | Alias of `convert` | `Cancellable<Output>` |
| `h264AbrLadder` | `(input, rungs, callOptions?)` | `Cancellable<readonly Output[]>` |
| `remux` | `(input, remuxOptions, callOptions?)` | `Cancellable<Output>` |
| `trim` | `(input, trimOptions, callOptions?)` | `Cancellable<Output>` |
| `decode` | `(input, decodeOptions?)` | `MediaStreams` |
| `seek` | `(input, timeUs, callOptions?)` | `Cancellable<VideoFrame>` |
| `encode` | `(mediaStreams, encodeOptions, callOptions?)` | `Cancellable<Output>` |
| `mux` | `(packetStreams, muxSpec, callOptions?)` | `Cancellable<Output>` |
| `decrypt` | `(input, decryptOptions, callOptions?)` | `Cancellable<Output>` |
| `run` | `(mediaJob, callOptions?)` | `Cancellable<Blob>` |
| `canConvert` | `(convertOptions)` | `Promise<boolean>` |
| `preload` | `(...preloadSpecs)` | `Promise<void>` |
| `load` | `(input)` | `MediaChain` |

See [Operations](operations.md) for usage and ownership rules.

## Shared call options

```ts
interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  strategy?: {
    determinism?: 'auto' | 'force-software';
    pinDriver?: string;
  };
}

interface Progress {
  done: number;
  total?: number;
  stage: string;
}
```

`strategy.pinDriver` is an expert/test routing override. Normal application code should express the
desired codec and container and let the engine route it.

## Conversion targets

```ts
interface ConvertOptions {
  to?: Container;
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
  faststart?: boolean | 'reserve';
  maximumPacketCount?: number;
  fragmented?: boolean;
  sink?: Sink;
}
```

`faststart: true` requests a metadata-first layout. `faststart: 'reserve'` supports positioned streaming
output and requires a per-track `maximumPacketCount` ceiling.

`VideoTarget` fields:

| Group | Fields |
| --- | --- |
| Codec and rate | `codec`, `bitrate`, `bitrateMode`, `crf`, `twoPass` |
| Dimensions | `width`, `height`, `fit`, `fps` |
| Geometry | `crop`, `pad`, `rotate`, `flip` |
| Color | `bitDepth`, `colorspace`, `tonemap`, `alpha` |
| Hard constraints | `maxAverageBitrate`, `quality` |

`quality` currently uses `metric: 'ssim-luma-v1'` with `minimumMean` and optional sample count. It must
be paired with both `bitrate` and `maxAverageBitrate`.

`AudioTarget` fields:

| Group | Fields |
| --- | --- |
| Codec and layout | `codec`, `sampleRate`, `channels`, `bitrate` |
| Level and time | `gainDb`, `fade` |
| Channel processing | `mixMatrix` |
| Dynamics and EQ | `dynamics`, `biquad` |

`dynamics.normalize` accepts `mode: 'peak' | 'rms'` and `targetDbfs`. `dynamics.limit` accepts an optional
`ceilingDbfs`, `mode: 'hard' | 'soft'`, and `knee`. Biquad types are `lowpass`, `highpass`, `bandpass`,
`notch`, `peaking`, `lowshelf`, and `highshelf`.

## Operation option types

```ts
interface RemuxOptions {
  to: Container;
  faststart?: boolean | 'reserve';
  maximumPacketCount?: number;
  fragmented?: boolean;
  tags?: Record<string, string>;
  trackSelect?: readonly string[];
  sink?: Sink;
}

interface TrimOptions {
  start: number;
  end: number;
  mode?: 'keyframe' | 'accurate';
  fragmented?: boolean;
  sink?: Sink;
}

interface EncodeOptions {
  to?: Container;
  video?: VideoTarget;
  audio?: AudioTarget;
  sink?: Sink;
}

interface MuxSpec {
  container: Container;
  faststart?: boolean | 'reserve';
  maximumPacketCount?: number;
  fragmented?: boolean;
  sink?: Sink;
}

interface DecryptOptions {
  scheme: 'cenc' | 'cens' | 'cbcs' | 'hls-aes128' | 'hls-sample-aes';
  keys: Record<string, string>;
  sink?: Sink;
}
```

`DecodeOptions` extends `CallOptions` with `trackSelect?: readonly string[]`.

`PacketInfoCallOptions` extends `CallOptions` with `container?: Container`.
`PacketInfoBatchCallOptions` also accepts `batchSize?: number` and
`includePayloadDigests?: boolean`. Digest-enabled rows carry `payloadDigest`, the SHA-256 of the exact
coded packet payload; range-backed drivers retain bounded read windows while performing the full scan.

## Containers and codecs

```ts
type Container =
  | 'mp4' | 'mov' | 'webm' | 'mkv' | 'ogg' | 'wav'
  | 'mp3' | 'aac' | 'adts' | 'flac' | 'aiff' | 'caf'
  | 'avi' | 'ts' | 'm2ts' | 'mts' | 'mpegts';

type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1';
type AudioCodec = 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | PcmCodec;
```

PCM tokens include `pcm`, signed and unsigned integer widths, floating-point widths, and big-endian
variants. Use TypeScript completion on `PcmCodec` for the exact union.

These unions describe legal request vocabulary. Runtime support for a complete container/codec/options
combination is determined by `canConvert()` and execution routing.

## Source helpers

| Export | Purpose |
| --- | --- |
| `from(input, options?)` | Universal input normalizer |
| `fromBlob(blob)` | Wrap a Blob or File |
| `fromBytes(bytes, options?)` | Wrap an ArrayBuffer or view |
| `fromStream(stream, options?)` | Wrap a single-use byte stream |
| `fromURL(url, options?)` | Create a fetch and range-backed source |
| `fromElement(element, options?)` | Read element bytes or explicitly capture live tracks |
| `fromOPFS(path)` | Resolve an OPFS path to a source |
| `fromMediaStream(stream)` | Normalize a live MediaStream |
| `captureElementMediaStream(element)` | Explicitly call the element capture seam |
| `cacheSource(sourceOrUrl, options?)` | Add an opt-in in-memory range cache |
| `probeUrlSize(url, signal?)` | Learn remote length without a full download |
| `isSource(value)` | Type guard for a normalized byte source |
| `isLiveMediaSource(value)` | Type guard for a normalized live source |

The primary related types are `MediaInput`, `ByteMediaInput`, `Source`, `LiveMediaSource`,
`NormalizedSource`, `FromOptions`, `CacheOptions`, and `CachingSource`.

## Sink helpers

| Export | Sink result |
| --- | --- |
| `toBlob()` | Full `Blob` |
| `toFile(name)` | Full named `File` |
| `toStream()` | Lazy `ReadableStream<Uint8Array>` |
| `toOPFS(path)` | Direct OPFS write |
| `toElement(element, options?)` | Media element attachment |
| `toStreamTarget(destination, options?)` | Incremental caller-owned write |

`Output` is `Blob | File | ReadableStream<Uint8Array> | undefined`. A direct-write sink resolves to
`undefined` after the destination is complete.

## Result types

`MediaInfo`:

```ts
interface MediaInfo {
  container: string;
  durationSec: number;
  sizeBytes?: number;
  tracks: MediaInfoTrack[];
  tags?: Record<string, string>;
}
```

`MediaInfoTrack.type` is `video`, `audio`, or `other`. `other` represents declared non-media tracks.

`Demuxed` exposes `tracks`, `packets(trackId)`, an optional `packetTable()`, and `close()`.
`MediaStreams` has optional `video: ReadableStream<VideoFrame>` and
`audio: ReadableStream<AudioData>` members.

The core driver `Demuxer` can additionally expose `packetStats(trackId)`. Its
`PacketMetadataStats` result is constant-sized: packet count and total coded bytes plus exact
presentation bounds. Exact decode bounds are optional and must be supplied as a pair. Drivers must
compute this summary without materializing one packet-row object per packet.

`PacketInfoTable` contains `tracks` and materialized `packets`. Each packet row reports a track index,
size, PTS, DTS, keyframe flag, and optional offset/duration. `PacketInfoBatchStream` exposes the same
tracks, an async iterator of packet-row batches, and `cancel()`.

## Fluent API

`MediaChain` methods are immutable builders:

- operations: `trim`, `convert`, `remux`, `decrypt`;
- video helpers: `resize`, `crop`, `rotate`, `flip`, `colorspace`, `tonemap`, `video`;
- audio and container helpers: `audio`, `to`;
- terminals: `run`, `blob`, `file`, `stream`.

No work starts before a terminal method.

## Prepared MP4 packet authoring

The root and core entries export `muxPreparedMp4PacketTrack`, `muxPreparedMp4PacketTracks`, and
`muxPreparedMp4PacketTracksStream` for callers that already own validated encoded packets and track
descriptors. `muxPreparedSparseMp4PacketTrack` authors a progressive MP4 whose virtual extent is larger
than one JavaScript buffer. Its `SparseMp4WriteTarget` receives `setSize()` followed by positioned
`write()` calls, so holes are never allocated in memory.

Sparse `fileSize` and `sampleOffsets` accept `bigint` or unsigned decimal strings. Every value must fit
an unsigned 64-bit integer, every sample must lie inside the declared file extent, and the target is not
mutated when validation fails.

## Public constants and errors

- `VERSION`
- `H264_ABR_MAX_RUNGS`
- `H264_ABR_MAX_SOURCE_BYTES`
- `H264_ABR_MAX_RETAINED_OUTPUT_BYTES`
- `H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS`
- `MediaError`, `CapabilityError`, `InputError`, `ConstraintUnsatisfiedError`

See [Errors and resource ownership](errors-and-lifecycle.md) for error codes and cleanup.

## Package subpaths

### `@aibrush/media/image`

Direct helpers for GIF, PNG/APNG, JPEG, WebP, and AVIF:

- probe: `sniffImageFormat`, `probeImage`, `inspectImage`;
- decode: `hasImageDecoder`, `decodeImage`, `decodeImageFrames`;
- metadata: `IMAGE_FORMATS`, `IMAGE_MIME` and image result types.

Header inspection is byte-based. Pixel decode requires the browser `ImageDecoder` API, and the consumer
must close every emitted `VideoFrame`.

### `@aibrush/media/wav`

A small synchronous entry for WAV header parsing, bounded PCM prefix decode, copy planning, and PCM
rewrites. It does not initialize the media engine.

### `@aibrush/media/mp4-packet-info`

Focused `mp4PacketInfoFromBytes` and `mp4PacketInfoFromUrl` functions plus typed media errors. Use it in
startup-sensitive code that only needs MP4/MOV packet metadata.

### `@aibrush/media/core`

Driver contracts, registry/router APIs, worker primitives, conformance helpers, and advanced container
writers. Application code should prefer the root entry. See [Driver authoring](driver-authoring.md).
