# 05 — Driver Contracts (v1)

> The canonical TypeScript contracts every backend implements — the kernel/backend boundary (ADR-016). The router consumes these ([`04`](04-capability-router-and-ladder.md)); the execution model runs them ([`06`](06-execution-and-runtime.md)). **This file is the source of truth for the contract types.**

## 1. Principles

- **Three kinds:** `CodecDriver` (decode/encode one codec), `ContainerDriver` (demux/mux one container family), `FilterDriver` (transform frames).
- **Images are a side capability, not a fourth driver kind.** Still/animated images have no packet seam, so `ImageOps` registers on the first-party registry side slot (ADR-049) and leaves the driver API unchanged.
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
  wasmRuntime?: WasmRuntimeProfile             // optional ADR-006 profile; omitted = resolve from runtime
}
export interface Progress { done: number; total?: number; stage: string }

// WebCodecs-native units flow across the seams:
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk   // sealed coded unit (PTS in .timestamp)
export type RawFrame     = VideoFrame | AudioData                  // codec <-> filter

// The container <-> codec seam packet: a sealed chunk plus optional side data (ADR-045/055/107/125/126).
// The sealed Encoded*Chunk exposes only `timestamp` (PTS); reordered streams also need DTS, muxers may
// reuse already-owned payload bytes instead of copying from the host chunk again, VPx alpha may travel as
// a paired encoded chunk, and some container oracles need the on-disk packet size when the decoder access
// unit strips container headers.
export interface Packet {
  readonly chunk: EncodedChunk
  readonly data?: Uint8Array    // owned payload bytes equal to chunk.copyTo(); optional mux copy-elision hint
  readonly alpha?: EncodedVideoChunk // WebM/Matroska VPx BlockAdditions alpha side data, when present
  readonly dtsUs?: number        // undefined ⇒ DTS == PTS (no reordering)
  readonly sizeBytes?: number    // undefined ⇒ chunk.byteLength
}
export interface PacketMetadata {
  readonly trackId: number
  readonly sizeBytes: number
  readonly ptsUs: number
  readonly dtsUs: number
  readonly durationUs: number
  readonly keyframe: boolean
}
export interface PacketInfoMetadata {
  readonly trackIndex: number
  readonly offset?: number       // source byte offset when known without payload materialization
  readonly size: number
  readonly ptsUs: number
  readonly dtsUs: number
  readonly durationUs?: number   // packet duration when known without payload materialization
  readonly keyframe: boolean
}
export interface PacketInfoTable {
  readonly tracks: readonly TrackInfo[]
  readonly packets: readonly PacketInfoMetadata[]
}

export interface DriverBase {
  readonly id: string          // unique, e.g. 'webcodecs-video', 'wasm-flac', 'mp4'
  readonly apiVersion: number  // = DRIVER_API_VERSION it was built against
}

export type WasmRuntimeProfileKind = 'baseline' | 'isolated-simd-threads'
export interface WasmRuntimeProfile {
  readonly kind: WasmRuntimeProfileKind
  readonly simd: boolean
  readonly threads: boolean
  readonly sharedArrayBuffer: boolean           // true only when cross-origin isolated
  readonly reason?: string
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
  encrypted?: boolean               // protected samples require decrypt() before generic decode/seek
  config?: DecoderConfig            // video: coded dims/rotation/fps; audio: sampleRate/channels
                                     // config.description carries codec-private data for muxers, e.g. AVC/AAC config or FLAC metadata (ADR-064/065/066/067)
}
export interface Demuxer {
  readonly tracks: readonly TrackInfo[]
  packetTable?(): readonly PacketMetadata[]                // optional payload-free packet metadata
  packets(trackId: number): ReadableStream<Packet>         // lazy, per-track Packet stream
  close(): Promise<void>
}
export interface MuxOptions { container?: string; faststart?: boolean; fragmented?: boolean }
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
  container?: string                                       // requested target flavor from the same driver family
}
export interface PcmTransform extends StageOptions {       // ADR-022 (raw-PCM containers, e.g. WAV)
  container?: 'wav' | 'aiff' | 'caf'                       // target raw-PCM wrapper; omit = source wrapper
  sampleFormat?: SampleFormat                              // target wire sample format; omit = source/legal target format
  endian?: Endianness                                      // target wire endianness; omit = source endianness
  channels?: number                                        // up/down-mix (BS.775); omit = passthrough
  sampleRate?: number                                      // resample (pure-TS band-limited windowed-sinc, ADR-022)
  gainDb?: number                                          // gain
  fade?: { inSec?: number; outSec?: number; curve?: 'linear' | 'equal-power' } // PCM-native fade
  dynamics?: {                                             // PCM-native normalize/limit (ADR-074)
    normalize?: { mode: 'peak' | 'rms'; targetDbfs: number }
    limit?: { ceilingDbfs?: number; mode?: 'hard' | 'soft'; knee?: number }
  }
  biquad?: BiquadSpec | readonly BiquadSpec[]              // PCM-native RBJ biquad/EQ chain (ADR-074)
}
export interface DecryptParams extends StageOptions {      // ADR-023/121 (CENC / HLS decryption)
  scheme: 'cenc' | 'cens' | 'cbcs' | 'hls-aes128' | 'hls-sample-aes'
  keys: Record<string, string>                             // CENC: keyId(hex) → key(hex); HLS: key/iv hex
}
export interface ContainerDriver extends DriverBase {
  readonly kind: 'container'
  readonly formats: readonly string[]                      // e.g. ['mp4','mov']
  supports(q: ContainerQuery): boolean                     // sync: mime / extension / magic
  // Optional metadata-only probe: return TrackInfo without constructing a live Demuxer or packet streams.
  // Absent => media.probe() falls back to demux().tracks. Additive, so DRIVER_API_VERSION stays 1.
  probe?(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]>
  demux(src: ByteSource, o?: StageOptions): Promise<Demuxer>
  createMuxer(o?: MuxOptions): Muxer
  // Optional cross-target stream-copy declarations. A source driver lists only target containers it
  // can author natively while preserving coded packets and the target layout rules (ADR-133).
  // Unlisted cross-container targets fall back to demux→mux.
  streamCopyTargets?: readonly string[]
  // Optional lossless stream-copy (remux + keyframe-trim), bypassing the PTS-only codec seam so
  // DTS/B-frames/codec-private survive (ADR-021/068/133). Used for same-container targets and for
  // explicit streamCopyTargets. Absent ⇒ fall back to demux→mux.
  streamCopy?(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>>
  // Optional PCM-native audio transform for raw-PCM containers (ADR-022/054/059/061/074): apply target
  // wrapper/sample-format/endianness, gain/fade, mix/resample, biquad/EQ, and dynamics in the TS
  // audio-dsp path, then re-serialize. Source sample-format/endianness are preserved unless the transform
  // asks for a target format or the target wrapper requires a legal 8-bit mapping (`pcm-s8` AIFF/CAF ↔
  // `pcm-u8` WAV); ordinary cross-wrapper WAV/AIFF/CAF output is still PCM-native, while ADR-116 adds a
  // separate WAV-only raw-packet muxer for callers that already have legal PCM packet bytes.
  // Absent ⇒ codec seam.
  transformPcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>
  // Optional driver-native decryption (ADR-023/121): parse protection boxes (enca/tenc/senc),
  // AES-CTR/CBC-decrypt with the caller's keys (WebCrypto), re-serialize cleartext. Absent ⇒ typed miss.
  decrypt?(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>>
  // Optional decode of a compressed-audio container to a raw-PCM (WAV) byte stream (ADR-024/050),
  // e.g. FLAC → WAV in pure TS, or ADTS AAC → WAV through native WebCodecs / the wasm tail, applying
  // a PcmTransform. Absent ⇒ the WebCodecs/WASM codec seam.
  decodePcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>
  // Optional decode of a raw-PCM container to canonical planar PCM for public decode() (ADR-063).
  // The engine wraps the returned samples as browser AudioData chunks. Absent ⇒ codec seam.
  decodePcmAudio?(src: ByteSource, o?: StageOptions): Promise<PcmAudio>
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
  readonly substrate: 'webgpu' | 'webgl' | 'canvas2d' | 'native' | 'wasm'
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

> **`FilterDriver` covers audio too (ADR-033/076).** The three audio `FilterSpec` variants (`resample`/`remix`/`gain`) are served by `audioDspFilterDriver` (`src/filters/audio-dsp.ts`) — a `TransformStream<AudioData, AudioData>` over the pure-TS dsp kernels (`src/dsp`). It declares `substrate:'native'`, the same truthful CPU value used by the pure-TS `cpu-video-filter`; the router ranks native below WebGPU/WebGL/Canvas2D and above the WASM tail. Adding `native` to `FilterSubstrate` was additive (older drivers that declare `webgpu`/`webgl`/`canvas2d`/`wasm` still conform) and did not change `DRIVER_API_VERSION`. This driver is implemented, tested, and auto-registered in `defaults.ts` (doc 09 status table).

> **`ImageOps` is intentionally outside the driver contract (ADR-049).** GIF/PNG/JPEG/WebP/AVIF probe is pure header parsing, and browser image decode is `ImageDecoder` over a whole encoded image payload. There is no demuxed packet stream and no codec-config handoff, so forcing images into `ContainerDriver`/`CodecDriver` would invent a fake seam. `ImageModule` is `DriverModule`-shaped only so `defaults.ts` can register it alongside first-party modules; it attaches to an `ImageRegistry` host and does not change `DRIVER_API_VERSION`.

## 3. Lifecycle, cancellation, errors

- A coder/filter is a `TransformStream`. The driver configures its underlying WebCodecs/WASM object when the stream starts, processes each chunk, and **flushes on writable close** (encoder/muxer `finalize`).
- **Cancellation:** aborting `StageOptions.signal` cancels the readable and writable; the driver must release WebCodecs/WASM resources in the stream's `cancel`/`abort` handlers.
- **Errors:** a driver throws/【rejects the stream with】a `MediaError` (`decode-error`/`encode-error`/`demux-error`/`mux-error`); never swallow an error and emit silence (that is exactly the kind of WEAK-GATE behavior we reject, ADR-018).
- **Out-of-band encoder→muxer config (ADR-029/051):** the encoder `TransformStream` carries only `EncodedChunk` bytes, but a muxer needs the encoder-produced `DecoderConfig` (codec string + `description`, e.g. AAC's AudioSpecificConfig / AVC's `avcC`) to write the sample entry. A WebCodecs encoder publishes it on the first chunk's `EncodedVideoChunkMetadata`/`EncodedAudioChunkMetadata.decoderConfig`; the first-party drivers surface it through an **additive, driver-local** options extension read structurally off `o` — `VideoEncoderStageOptions extends StageOptions { keyFrameInterval?; onDecoderConfig? }` and `AudioEncoderStageOptions extends StageOptions { onConfig? }`. The `CodecDriver` contract (`createEncoder(c, o?: StageOptions)`) is **unchanged** — these are engine↔driver implementation detail, not part of the published contract, so they are purely additive (§5, no `DRIVER_API_VERSION` bump). The engine allocates the muxer track lazily on the first chunk once the config has arrived, and when the encode stage came from a demuxed source track it also carries that track's declared `durationSec` into the mux `TrackInfo` rather than inventing timing from encoder tails. For packet-copy remux into MP4/MOV, `Mp4Muxer` can also synthesize AVC `avcC` from Annex-B SPS/PPS access units (ADR-066) and AAC AudioSpecificConfig from ADTS headers (ADR-067) when `config.description` is absent, rather than guessing codec-private bytes.

## 4. Authoring a driver (the rules)

1. Implement exactly one `kind` and one substrate; keep it small and lazily importable.
2. `supports()` must be cheap and **honest** — return `false` rather than throwing later. For codecs, defer to `isConfigSupported`; for WASM, feature-detect what the core actually builds.
3. Set `tier` truthfully (`hardware`/`gpu`/`native`/`wasm`) — the router ranks on it.
4. Emit/consume only the seam types (`EncodedChunk`, `RawFrame`, `Uint8Array`). Do not invent a private frame type.
5. Heavy `.wasm` loads inside `createDecoder/Encoder/Filter`, **not** in `supports()` (keeps probing cheap, [`04`](04-capability-router-and-ladder.md)). WASM drivers may import tiny JS glue during `supports()` to prove an artifact is vendored, but they must not instantiate/fetch the `.wasm` core until the stream is actually built.
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
