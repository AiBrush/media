/**
 * Planner seam (docs/architecture/execution-runtime §3.1) — compiles a normalized {@link PlanRequest}
 * into a **stage graph** (`source → demux → decode → filter → encode → mux → sink`) and decides
 * copy-vs-re-encode per stream. Everything here is capability-agnostic: `target` fields carry opaque
 * codec/container *tokens* (probe results, never a tier or implementation name), so a graph says *what*
 * must happen, and the router below decides *who* runs each stage.
 */

import type { FilterSpec, MediaType } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';

/** The kind of work a stage performs. */
export type StageKind = 'demux' | 'decode' | 'filter' | 'encode' | 'mux' | 'copy' | 'decrypt';

/** One node in the planned pipeline. */
export interface PlannedStage {
  readonly kind: StageKind;
  readonly mediaType?: MediaType;
  /** Codec token for decode/encode/copy stages; container token for demux/mux/decrypt. */
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

/** One elementary stream of the (probed) input. */
export interface PlanInputStream {
  readonly id: number;
  readonly mediaType: MediaType;
  /** Opaque codec token (a probe result). */
  readonly codec: string;
}

/** The normalized input descriptor: an opaque container token plus its probed streams. */
export interface PlanInput {
  readonly container: string;
  readonly streams: readonly PlanInputStream[];
  /** True when samples are protected — codec work is only plannable behind a decrypt stage. */
  readonly encrypted?: boolean;
}

/** Per-stream output target: keep (copy when possible), transcode, transform, or drop. */
export interface PlanStreamTarget {
  /** The {@link PlanInputStream.id} this target applies to. */
  readonly stream: number;
  /** Target codec token; omitted keeps the source codec. */
  readonly codec?: string;
  /** Ordered filters; any filter forces decode → filter… → encode. */
  readonly filters?: readonly FilterSpec[];
  /** Drop the stream from the output entirely. */
  readonly discard?: boolean;
}

/** The normalized output: an opaque container token plus per-stream targets. */
export interface PlanOutput {
  readonly container: string;
  /** Per-stream targets; a stream with no target keeps its codec (copy when nothing else forces work). */
  readonly targets?: readonly PlanStreamTarget[];
}

/** The trim window an op carries; `accurate` plans a frame-exact re-encode, `keyframe` a pure copy. */
export interface PlanTrimWindow {
  readonly startSec: number;
  readonly endSec: number;
  readonly mode?: 'keyframe' | 'accurate';
}

/** Normalized request handed to the Planner. */
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
  readonly input: PlanInput;
  readonly output?: PlanOutput;
  readonly trim?: PlanTrimWindow;
  /** Opaque sink-kind token the executor materializes into (e.g. `'blob'`, `'stream'`). */
  readonly sink?: string;
  readonly signal?: AbortSignal;
}

/** Produces a {@link StageGraph} for an op. {@link plan} is the engine's implementation. */
export interface Planner {
  plan(request: PlanRequest): StageGraph;
}

/**
 * Compile one normalized request into the single heterogeneous stage graph the executor runs. Copy vs
 * re-encode is decided **per stream**: a stream re-encodes only when the request changes its codec,
 * applies a filter, or demands a frame-accurate trim; otherwise it is a pure packet copy, and a graph
 * whose streams all copy is flagged `copyOnly` (the remux/keyframe-trim fast path).
 */
export function plan(request: PlanRequest): StageGraph {
  validateRequest(request);
  const { op, input } = request;
  switch (op) {
    case 'probe':
    case 'demux':
      return graph([demuxStage(input)]);
    case 'decode':
      return graph([
        demuxStage(input),
        ...maybeDecrypt(request),
        ...input.streams.map((stream) => codecStage('decode', stream.mediaType, stream.codec)),
      ]);
    case 'encode': {
      const output = requireOutput(request);
      return graph([...streamStages(request, 'force-reencode'), muxStage(output.container)]);
    }
    case 'mux': {
      const output = requireOutput(request);
      return graph([muxStage(output.container)]);
    }
    case 'remux':
    case 'trim': {
      // A remux (and a keyframe trim) is copy-only by definition — a codec-changing target here is a
      // caller error, never a silent transcode. An `accurate` trim re-encodes for frame-exact cuts.
      const container = request.output?.container ?? input.container;
      const mode = request.trim?.mode === 'accurate' ? 'force-reencode' : 'copy-strict';
      return graph([
        demuxStage(input),
        ...maybeDecrypt(request),
        ...streamStages(request, mode),
        muxStage(container),
      ]);
    }
    case 'convert': {
      const container = request.output?.container ?? input.container;
      return graph([
        demuxStage(input),
        ...maybeDecrypt(request),
        ...streamStages(request, 'per-stream'),
        muxStage(container),
      ]);
    }
    case 'decrypt': {
      const container = request.output?.container ?? input.container;
      return graph([
        demuxStage(input),
        decryptStage(input.container),
        ...streamStages(request, 'copy-strict'),
        muxStage(container),
      ]);
    }
    default:
      return assertNever(op);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

function graph(stages: readonly PlannedStage[]): StageGraph {
  const hasCopy = stages.some((stage) => stage.kind === 'copy');
  const transforms = stages.some(
    (stage) =>
      stage.kind === 'decode' ||
      stage.kind === 'encode' ||
      stage.kind === 'filter' ||
      stage.kind === 'decrypt',
  );
  return { stages, copyOnly: hasCopy && !transforms };
}

type StreamPlanMode =
  /** Copy every kept stream; a codec/filter target is a typed error (remux, keyframe trim, decrypt). */
  | 'copy-strict'
  /** Decide copy vs decode → filters → encode per stream (convert). */
  | 'per-stream'
  /** Re-encode every kept stream (encode op, accurate trim). */
  | 'force-reencode';

/** Plan the per-stream middle of the graph: copy, or decode (→ filters) → encode. */
function streamStages(request: PlanRequest, mode: StreamPlanMode): PlannedStage[] {
  const targets = new Map<number, PlanStreamTarget>();
  for (const target of request.output?.targets ?? []) {
    if (targets.has(target.stream)) {
      throw new InputError(`plan target repeats stream ${target.stream}`);
    }
    if (!request.input.streams.some((stream) => stream.id === target.stream)) {
      throw new InputError(`plan target names unknown stream ${target.stream}`);
    }
    targets.set(target.stream, target);
  }
  const stages: PlannedStage[] = [];
  for (const stream of request.input.streams) {
    const target = targets.get(stream.id);
    if (target?.discard === true) continue;
    const codec = target?.codec ?? stream.codec;
    const filters = target?.filters ?? [];
    const transforms = codec !== stream.codec || filters.length > 0;
    if (mode === 'copy-strict' && transforms) {
      throw new InputError(
        `plan(${request.op}) is copy-only and cannot transform stream ${stream.id}`,
      );
    }
    const reencode = mode === 'force-reencode' || (mode === 'per-stream' && transforms);
    if (!reencode) {
      stages.push(codecStage('copy', stream.mediaType, stream.codec));
      continue;
    }
    stages.push(codecStage('decode', stream.mediaType, stream.codec));
    for (const filter of filters) {
      stages.push({
        kind: 'filter',
        mediaType: stream.mediaType,
        filter,
        label: `filter:${stream.mediaType}:${filter.type}`,
      });
    }
    stages.push(codecStage('encode', stream.mediaType, codec));
  }
  return stages;
}

function demuxStage(input: PlanInput): PlannedStage {
  return { kind: 'demux', target: input.container, label: `demux:${input.container}` };
}

function muxStage(container: string): PlannedStage {
  return { kind: 'mux', target: container, label: `mux:${container}` };
}

function decryptStage(container: string): PlannedStage {
  return { kind: 'decrypt', target: container, label: `decrypt:${container}` };
}

function codecStage(
  kind: 'decode' | 'encode' | 'copy',
  mediaType: MediaType,
  codec: string,
): PlannedStage {
  return { kind, mediaType, target: codec, label: `${kind}:${mediaType}:${codec}` };
}

/** Protected samples force a decrypt stage ahead of any codec work (never silently skipped). */
function maybeDecrypt(request: PlanRequest): PlannedStage[] {
  if (request.input.encrypted !== true) return [];
  return [decryptStage(request.input.container)];
}

function requireOutput(request: PlanRequest): PlanOutput {
  if (request.output === undefined) {
    throw new InputError(`plan(${request.op}) requires an output descriptor`);
  }
  return request.output;
}

function validateRequest(request: PlanRequest): void {
  if (request.input.container.trim() === '') {
    throw new InputError('plan input requires a container token');
  }
  const seen = new Set<number>();
  for (const stream of request.input.streams) {
    if (!Number.isSafeInteger(stream.id) || seen.has(stream.id)) {
      throw new InputError('plan input streams must carry unique integer ids');
    }
    seen.add(stream.id);
    if (stream.codec.trim() === '') {
      throw new InputError(`plan input stream ${stream.id} requires a codec token`);
    }
  }
  const trim = request.trim;
  if (trim !== undefined) {
    if (
      !Number.isFinite(trim.startSec) ||
      !Number.isFinite(trim.endSec) ||
      trim.startSec < 0 ||
      trim.endSec <= trim.startSec
    ) {
      throw new InputError('plan trim window needs 0 <= startSec < endSec');
    }
  }
  if (request.output?.container !== undefined && request.output.container.trim() === '') {
    throw new InputError('plan output requires a container token');
  }
}

function assertNever(op: never): never {
  throw new InputError(`plan received unknown op ${JSON.stringify(op)}`);
}
