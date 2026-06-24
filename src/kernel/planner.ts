/**
 * Planner seam (docs/architecture/03 §4) — turns an op call into a **stage graph**
 * (source → demux → decode → filter → encode → mux → sink) and decides copy-vs-re-encode per stream
 * for `convert`. These are the graph types and the Planner interface; the concrete planning logic is
 * built alongside the ops in Phase 1 (ARCH-3 monolith → ARCH-1, ADR-015) — the seam types here do not
 * move across that refactor.
 */

import type { FilterSpec, MediaType } from '../contracts/driver.ts';

/** The kind of work a stage performs. */
export type StageKind = 'demux' | 'decode' | 'filter' | 'encode' | 'mux' | 'copy' | 'decrypt';

/** One node in the planned pipeline. */
export interface PlannedStage {
  readonly kind: StageKind;
  readonly mediaType?: MediaType;
  /** Codec token for decode/encode stages; container token for demux/mux. */
  readonly target?: string;
  /** Filter spec for a `filter` stage. */
  readonly filter?: FilterSpec;
  /** A human-readable label for diagnostics/progress. */
  readonly label: string;
}

/** A planned pipeline: an ordered list of stages plus whether any stream is a pure stream-copy. */
export interface StageGraph {
  readonly stages: readonly PlannedStage[];
  /** True when every stream is copied (no codec stages) — i.e. a remux/keyframe-trim fast path. */
  readonly copyOnly: boolean;
}

/** Normalized request handed to the Planner (refined per-op in Phase 1). */
export interface PlanRequest {
  readonly op:
    | 'probe'
    | 'demux'
    | 'remux'
    | 'trim'
    | 'convert'
    | 'decode'
    | 'encode'
    | 'mux'
    | 'decrypt';
}

/** Produces a {@link StageGraph} for an op; implemented in Phase 1 (needs concrete drivers). */
export interface Planner {
  plan(request: PlanRequest): StageGraph;
}
