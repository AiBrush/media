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
export { closeFrame, closeFrames, type Closable, isClosable } from './kernel/frames.ts';
export { collect, composeChain, type ExecuteOptions, runToSink } from './kernel/executor.ts';
export { InlineBridge, type WorkerBridge } from './kernel/worker-bridge.ts';
export type { PlannedStage, Planner, StageGraph, StageKind } from './kernel/planner.ts';

// Engine
export { createMedia } from './api/create-media.ts';
export { type MediaEngine, MediaEngineImpl } from './api/engine.ts';

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
