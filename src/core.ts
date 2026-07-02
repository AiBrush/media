/**
 * `@aibrush/media/core` — the driver-author surface (ADR-009/016).
 *
 * Exposes the engine internals, the driver contracts, the typed error model, the registry/router, the
 * conformance harness, and `DRIVER_API_VERSION` so third parties can publish drivers against a
 * versioned, stable boundary. Normal app code imports the default entry instead.
 */

// Driver contracts + error model
export * from './contracts/driver.ts';
export * from './contracts/errors.ts';

// Kernel internals (for driver authors / advanced embedders)
export {
  isApiVersionSupported,
  Registry,
  type RegistryView,
  supportedApiVersions,
} from './kernel/registry.ts';
export {
  type EnsureLoaded,
  Router,
  type RouterDeps,
  type StageSelectOptions,
} from './kernel/router.ts';
export {
  type WasmBindgenInit,
  type WasmRuntimeRequest,
  requireIsolatedWasmProfile,
  resolveWasmRuntimeProfile,
  wasmInitForProfile,
} from './kernel/wasm-runtime.ts';
export { closeFrame, closeFrames, type Closable, isClosable } from './kernel/frames.ts';
export { collect, composeChain, type ExecuteOptions, runToSink } from './kernel/executor.ts';
export {
  DEFAULT_CREDIT,
  InlineBridge,
  type RunStreamOptions,
  type WorkerBridge,
  type WorkerSelection,
  WorkerStreamBridge,
  resolvePoolSize,
  selectWorkerMode,
  workerOffloadAvailable,
} from './kernel/worker-bridge.ts';
// Worker offload surface (doc 06 §4, ADR-019): the ABR worker pool + rendition fan-out, the host spawn/
// offload glue, and the serializable job protocol — for advanced embedders composing offload directly.
// (The default entry reaches all of this transparently through `createMedia({ worker })`.)
export {
  type InlineWorkerPool,
  WorkerPool,
  type WorkerPoolOptions,
  type WorkerPoolTransport,
  inlineWorkerPool,
} from './kernel/worker-pool.ts';
export {
  type AbrRendition,
  type JobStreamRunner,
  type OffloadStreamOptions,
  type SpawnedWorker,
  type WithOptionalSink,
  type WorkerSpawn,
  buildOffloadPayload,
  createWorkerPool,
  ensureWorkerBridge,
  offloadAbrLadder,
  offloadHeavyOp,
  runOffloadStream,
} from './kernel/worker-host.ts';
export {
  type ConvertOffloadPayload,
  type InnerEngine,
  type InnerEngineFactory,
  type OffloadJobPayload,
  type TrimOffloadPayload,
  decodeOffloadPayload,
  makeJobRunner,
} from './kernel/worker-main.ts';
export {
  type ChunkMessage,
  type HostMessage,
  type JobMessage,
  type MessageLike,
  type OffloadJob,
  type WorkerMessage,
  collectTransferables,
  deserializeError,
  serializeError,
} from './kernel/worker-protocol.ts';
export { type JobRunner, type ProgressSink, runOffloadWorker } from './kernel/worker-entry.ts';
export type { PlannedStage, Planner, StageGraph, StageKind } from './kernel/planner.ts';

// Engine
export { createMedia } from './api/create-media.ts';
export { type MediaEngine, MediaEngineImpl } from './api/engine.ts';

// Advanced container writers (escape hatch, doc 09 streaming-output). The fragmented-MP4/CMAF generator
// lives on this driver-author surface — NOT the eager default entry — because it is heavy MP4 box-writer
// code; surfacing it from `@aibrush/media` would inline ~19 kB into the kernel chunk and break the
// "tiny eager kernel, lazy drivers" budget (BUILD §2, doc 08 §3/§7). Apps reach fragmented output through
// `convert(..., { fragmented: true })`; this export is for power users composing the muxer directly. The
// internal segment/run builders (`buildMediaSegment`/`planFragmentRuns`/`SegmentTrackRun`) stay private.
export { fragmentMp4 } from './drivers/mp4/fragment.ts';
export type { FragmentOptions, FragmentTrackInput } from './drivers/mp4/fragment.ts';
export { muxPreparedWebmAudioPacketTrack } from './api/flac-mkv-mux.ts';
export type { PreparedWebmAudioPacketMuxInput } from './api/flac-mkv-mux.ts';
export { mp4PacketInfoFromBytes, muxPreparedMp4PacketTrack } from './api/mp4-prepared-mux.ts';
export type { PreparedMp4PacketMuxInput } from './api/mp4-prepared-mux.ts';
export { oggPacketInfoFromBytes } from './drivers/ogg/ogg-driver.ts';

// HLS input resolution (RFC 8216). HLS `.m3u8` is a manifest, not a byte container — `resolveHlsSource`
// parses the playlist, fetches + AES-128-decrypts + stitches the segments into ONE demuxable `Source` the
// engine's existing probe/demux/decode path consumes (so the container router needs no "hls" entry). It is
// on this driver-author surface (NOT the eager default entry) because it pulls the m3u8 parser + the AES
// stack; apps/harnesses reach HLS by calling `resolveHlsSource(playlistText, { baseUrl, fetchResource })`
// and feeding the returned source to `probe`/`demux`/`convert`/`remux`/`decrypt`.
export {
  type HlsResolveOptions,
  type HlsResourceFetcher,
  type HlsVariantChoice,
  resolveHlsSource,
} from './drivers/hls/hls-source.ts';
export { parseM3u8 } from './drivers/hls/m3u8-parse.ts';

// Conformance harness (so third-party drivers can self-test against the contract)
export {
  assertCodecDriverConforms,
  assertContainerDriverConforms,
  assertFilterDriverConforms,
  type CodecConformanceCase,
  ConformanceError,
  type ContainerConformanceCase,
  type FilterConformanceCase,
} from './conformance/harness.ts';

export { VERSION } from './version.ts';
