# 05 — Driver Contracts (v1)

> The canonical TypeScript contracts every backend implements — the kernel/backend boundary (ADR-016). The router consumes these ([`04`](04-capability-router-and-ladder.md)); the execution model runs them ([`06`](06-execution-and-runtime.md)). **This file is the source of truth for the contract types.**

## 1. Principles

- **Three kinds:** `CodecDriver` (decode/encode one codec), `ContainerDriver` (demux/mux one container family), `FilterDriver` (transform frames).
- **Streaming via `TransformStream`.** Backpressure, cancellation (via `signal`), and error propagation come for free, and the stream *is* the lifecycle (configure on start, flush on close). No bespoke `init()/close()` for coders.
- **WebCodecs-native units at the seams.** Encoded units are `EncodedVideoChunk`/`EncodedAudioChunk`; raw frames are `VideoFrame`/`AudioData`. A demuxer's output feeds a decoder directly.
- **Drivers declare, the router decides.** A driver answers `supports()`; it never picks itself over another.

## 2. The contracts

```ts
// ============ versioning ============
export const DRIVER_API_VERSION = 1 as const

// ============ shared ============
export type Tier = 'hardware' | 'gpu' | 'native' | 'wasm'   // ranking order, best first
export type MediaType = 'video' | 'audio'

export interface StageOptions {
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
  determinism?: 'auto' | 'force-software'      // force-software drops the hardware/gpu tiers
}
export interface Progress { done: number; total?: number; stage: string }

// WebCodecs-native units flow across the seams:
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk   // sealed coded unit (PTS in .timestamp)
export type RawFrame     = VideoFrame | AudioData                  // codec <-> filter

// The container <-> codec seam packet: a sealed chunk + its optional DECODE timestamp (ADR-045). The
// sealed Encoded*Chunk exposes only `timestamp` (PTS); a reordered (B-frame/open-GOP) stream also needs
// DTS for decode-order enumeration + lossless remux. `dtsUs` undefined ⇒ DTS == PTS (no reordering).
export interface Packet {
  readonly chunk: EncodedChunk
  readonly dtsUs?: number
}

export interface DriverBase {
  readonly id: string          // unique, e.g. 'webcodecs-video', 'wasm-flac', 'mp4'
  readonly apiVersion: number  // = DRIVER_API_VERSION it was built against
}

// ============ error model ============
export type MediaErrorCode =
  | 'capability-miss'     // no eligible driver for op + codec + env
  | 'unsupported-input'   // garbled / empty / unknown source
  | 'decode-error' | 'encode-error' | 'demux-error' | 'mux-error'
  | 'aborted'             // signal aborted
  | 'driver-incompatible' // apiVersion mismatch at registration
export class MediaError extends Error {
  constructor(readonly code: MediaErrorCode, message: string, readonly detail?: unknown) { super(message) }
}
export class CapabilityError extends MediaError {}   // 'capability-miss'; detail carries { op, tried[] }
export class InputError extends MediaError {}        // 'unsupported-input'

// ============ 1) CodecDriver ============
export type DecoderConfig = VideoDecoderConfig | AudioDecoderConfig   // WebCodecs-native
export type EncoderConfig = VideoEncoderConfig | AudioEncoderConfig
export interface CodecQuery { mediaType: MediaType; direction: 'decode' | 'encode'; config: DecoderConfig | EncoderConfig }
export interface CodecSupport { supported: boolean; hardwareAccelerated?: boolean; reason?: string }

export interface CodecDriver extends DriverBase {
  readonly kind: 'codec'
  readonly tier: Tier
  supports(q: CodecQuery): Promise<CodecSupport>                                  // wraps isConfigSupported
  createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame>
  createEncoder(c: EncoderConfig, o?: StageOptions): TransformStream<RawFrame, EncodedChunk>
}

// ============ 2) ContainerDriver ============
export interface ByteSource {
  stream(): ReadableStream<Uint8Array>
  size?: number
  range?(start: number, end: number): Promise<Uint8Array>   // enables header-only probe
}
export interface ContainerQuery { direction: 'demux' | 'mux'; mime?: string; extension?: string; head?: Uint8Array /* magic */ }
export interface TrackInfo {
  id: number; mediaType: MediaType; codec: string; durationSec?: number
  config?: DecoderConfig            // video: coded dims/rotation/fps; audio: sampleRate/channels
}
export interface Demuxer {
  readonly tracks: readonly TrackInfo[]
  packets(trackId: number): ReadableStream<Packet>         // lazy, per-track (Packet = chunk + optional DTS)
  close(): Promise<void>
}
export interface MuxOptions { faststart?: boolean; fragmented?: boolean }
export interface Muxer {
  readonly output: ReadableStream<Uint8Array>
  addTrack(info: TrackInfo): number
  write(trackId: number, packet: Packet): Promise<void>    // honors packet.dtsUs for B-frame layout (ADR-045)
  finalize(): Promise<void>
}
export interface StreamCopyOptions extends StageOptions {  // ADR-021
  trim?: { startSec: number; endSec: number }              // keyframe-aligned range copy; omit for full remux
  faststart?: boolean
  fragmented?: boolean
}
export interface PcmTransform extends StageOptions {       // ADR-022 (raw-PCM containers, e.g. WAV)
  channels?: number                                        // up/down-mix (BS.775); omit = passthrough
  sampleRate?: number                                      // resample (pure-TS band-limited windowed-sinc, ADR-022)
  gainDb?: number                                          // gain
}
export interface DecryptParams extends StageOptions {      // ADR-023 (CENC / HLS sample decryption)
  scheme: 'cenc' | 'cbcs' | 'hls-aes128'
  keys: Record<string, string>                             // keyId(hex) → key(hex); CENC keys by tenc default_KID
}
export interface ContainerDriver extends DriverBase {
  readonly kind: 'container'
  readonly formats: readonly string[]                      // e.g. ['mp4','mov']
  supports(q: ContainerQuery): boolean                     // sync: mime / extension / magic
  demux(src: ByteSource, o?: StageOptions): Promise<Demuxer>
  createMuxer(o?: MuxOptions): Muxer
  // Optional lossless same-container stream-copy (remux + keyframe-trim), bypassing the PTS-only
  // codec seam so DTS/B-frames/codec-private survive (ADR-021). Absent ⇒ fall back to demux→mux.
  streamCopy?(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>>
  // Optional PCM-native audio transform for raw-PCM containers (ADR-022): apply mix/gain/resample in
  // the TS audio-dsp path and re-serialize, preserving the source sample-format. Absent ⇒ codec seam.
  transformPcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>
  // Optional driver-native sample decryption (ADR-023): parse protection boxes (enca/tenc/senc),
  // AES-CTR-decrypt with the caller's keys (WebCrypto), re-serialize cleartext. Absent ⇒ typed miss.
  decrypt?(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>>
  // Optional pure-TS decode of a compressed-audio container to a raw-PCM (WAV) byte stream (ADR-024),
  // e.g. FLAC → WAV, applying a PcmTransform. Absent ⇒ the WebCodecs/WASM codec seam.
  decodePcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>
}

// ============ 3) FilterDriver ============
export type FilterSpec =
  | { mediaType: 'video'; type: 'resize'; width: number; height: number; fit?: 'contain' | 'cover' | 'fill' }
  | { mediaType: 'video'; type: 'crop'; x: number; y: number; width: number; height: number }
  | { mediaType: 'video'; type: 'rotate'; degrees: 0 | 90 | 180 | 270 }
  | { mediaType: 'video'; type: 'flip'; axis: 'h' | 'v' }
  | { mediaType: 'video'; type: 'colorspace'; to: string }
  | { mediaType: 'video'; type: 'tonemap'; to: 'sdr' }
  | { mediaType: 'audio'; type: 'resample'; sampleRate: number }
  | { mediaType: 'audio'; type: 'remix'; channels: number }
  | { mediaType: 'audio'; type: 'gain'; db: number }
export interface FilterDriver extends DriverBase {
  readonly kind: 'filter'
  readonly substrate: 'webgpu' | 'webgl' | 'canvas2d' | 'wasm'
  supports(f: FilterSpec): boolean
  createFilter(f: FilterSpec, o?: StageOptions):           // matches the spec's mediaType
    | TransformStream<VideoFrame, VideoFrame>
    | TransformStream<AudioData, AudioData>
}

// ============ registration ============
export interface Registry {
  addCodec(d: CodecDriver): void
  addContainer(d: ContainerDriver): void
  addFilter(d: FilterDriver): void
}
export interface DriverModule {
  readonly apiVersion: number   // checked against DRIVER_API_VERSION at registration
  register(reg: Registry): void // adds this module's drivers
}
// A lazily-imported driver chunk default-exports a DriverModule.
```

> **`FilterDriver` covers audio too (ADR-033).** The three audio `FilterSpec` variants (`resample`/`remix`/`gain`) are served by `audioDspFilterDriver` (`src/filters/audio-dsp.ts`) — a `TransformStream<AudioData, AudioData>` over the pure-TS dsp kernels (`src/dsp`). It declares `substrate:'wasm'` as the **least-wrong existing value**: `FilterSubstrate` (`webgpu|webgl|canvas2d|wasm`) is pixel-oriented and has no CPU-native value, yet a CPU audio filter must rank *below* the GPU substrates, and `'wasm'` is the router's lowest, non-GPU tier (the GPU/canvas values would wrongly imply a pixel pipeline). The proper fit is a future **additive `'native'` `FilterSubstrate`** value (mirroring `Tier`'s existing `'native'`) — a `DRIVER_API_VERSION` event (§5), not yet made. This driver is implemented + tested but **not yet auto-registered** in `defaults.ts` (doc 09 status table).

## 3. Lifecycle, cancellation, errors

- A coder/filter is a `TransformStream`. The driver configures its underlying WebCodecs/WASM object when the stream starts, processes each chunk, and **flushes on writable close** (encoder/muxer `finalize`).
- **Cancellation:** aborting `StageOptions.signal` cancels the readable and writable; the driver must release WebCodecs/WASM resources in the stream's `cancel`/`abort` handlers.
- **Errors:** a driver throws/【rejects the stream with】a `MediaError` (`decode-error`/`encode-error`/`demux-error`/`mux-error`); never swallow an error and emit silence (that is exactly the kind of WEAK-GATE behavior we reject, ADR-018).
- **Out-of-band encoder→muxer config (ADR-029):** the encoder `TransformStream` carries only `EncodedChunk` bytes, but a muxer needs the encoder-produced `DecoderConfig` (codec string + `description`, e.g. AAC's AudioSpecificConfig / AVC's `avcC`) to write the sample entry. A WebCodecs encoder publishes it on the first chunk's `EncodedVideoChunkMetadata`/`EncodedAudioChunkMetadata.decoderConfig`; the first-party drivers surface it through an **additive, driver-local** options extension read structurally off `o` — `VideoEncoderStageOptions extends StageOptions { keyFrameInterval?; onDecoderConfig? }` and `AudioEncoderStageOptions extends StageOptions { onConfig? }`. The `CodecDriver` contract (`createEncoder(c, o?: StageOptions)`) is **unchanged** — these are engine↔driver implementation detail, not part of the published contract, so they are purely additive (§5, no `DRIVER_API_VERSION` bump). The engine allocates the muxer track lazily on the first chunk once the config has arrived.

## 4. Authoring a driver (the rules)

1. Implement exactly one `kind` and one substrate; keep it small and lazily importable.
2. `supports()` must be cheap and **honest** — return `false` rather than throwing later. For codecs, defer to `isConfigSupported`; for WASM, feature-detect what the core actually builds.
3. Set `tier` truthfully (`hardware`/`gpu`/`native`/`wasm`) — the router ranks on it.
4. Emit/consume only the seam types (`EncodedChunk`, `RawFrame`, `Uint8Array`). Do not invent a private frame type.
5. Heavy `.wasm` loads inside `createDecoder/Encoder/Filter`, **not** in `supports()` (keeps probing cheap, [`04`](04-capability-router-and-ladder.md)).
6. Declare `apiVersion = DRIVER_API_VERSION`.

### Skeleton (a WASM FLAC decode driver)

> Illustrative of the `DriverModule`/`createDecoder` **pattern** only (the `loadFlacWasm()` is hypothetical). The shipped FLAC decoder is in fact **pure TS**, exposed via `ContainerDriver.decodePcm`, not a WASM `CodecDriver` (ADR-024) — this skeleton stands in for any genuinely-WASM codec (e.g. libopus/libvorbis).

```ts
const FlacModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg) {
    reg.addCodec({
      id: 'wasm-flac', kind: 'codec', tier: 'wasm', apiVersion: DRIVER_API_VERSION,
      async supports(q) {
        return { supported: q.mediaType === 'audio' && q.direction === 'decode'
                            && (q.config as AudioDecoderConfig).codec.startsWith('flac') }
      },
      createDecoder(config, o) {
        return new TransformStream<EncodedChunk, RawFrame>({
          async start() { this.core = await loadFlacWasm() /* new URL('./flac.wasm', import.meta.url) */ },
          async transform(chunk, ctrl) { ctrl.enqueue(this.core.decode(chunk)) /* -> AudioData */ },
          flush() { this.core.free() },
        })
      },
      createEncoder() { throw new MediaError('encode-error', 'flac encode not provided by this driver') },
    })
  },
}
export default FlacModule
```

## 5. Versioning / semver policy (for third-party drivers)

The driver API has its **own integer major** (`DRIVER_API_VERSION`), **decoupled** from the library's public semver. Each driver declares the version it targets; the core verifies compatibility at registration.

| Change | Bump | Examples |
|---|---|---|
| **Breaking** | major | remove/rename a method, change a signature, narrow a type, change the lifecycle/ordering contract |
| **Additive** | minor | new *optional* method/field, a new `Tier`/substrate value, a new `FilterSpec` variant |
| **Clarification** | patch | docs/behavior note, no shape change |

- The core supports the **current and previous major** (`N`, `N-1`) via an internal shim, for a **2-minor deprecation window**, then drops `N-1`.
- **Registration check:** if `driver.apiVersion` is unsupported, the core refuses to register it and throws `MediaError{ code: 'driver-incompatible', detail: { got, supported } }` — a clear error, not a later crash.
- **First-party** drivers move in lockstep with the core; the policy exists for **third-party** drivers published as separate packages.

## 6. Why these three contracts (and not more)

They map exactly to the two data-flow seams ([`03`](03-system-architecture.md) §5): containers↔codecs (packets) and codecs↔filters (frames). Everything an engine does is some composition of demux/decode/filter/encode/mux, so three driver kinds cover the whole surface. Sources/sinks are separate (they bound the pipeline, they aren't stages) — see [`07-public-api.md`](07-public-api.md).
