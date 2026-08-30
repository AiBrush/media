/**
 * The typed error model — the only errors the engine throws (docs/architecture/05 §2, ADR-017).
 *
 * A capability miss is always a typed `CapabilityError`, never a silent wrong result; bad input is an
 * `InputError`; stage failures carry a specific `MediaErrorCode`. Strings are never thrown and errors
 * are never swallowed (ADR-018). The subclass codes are intrinsic: a `CapabilityError` is always
 * `capability-miss` and an `InputError` always `unsupported-input` — call sites name only the message
 * and the structured detail.
 */

import type { CodecQuery, ContainerQuery, FilterSpec } from './driver.ts';

/** Discriminant for every {@link MediaError}. */
export type MediaErrorCode =
  | 'capability-miss' // no eligible driver for op + codec + env
  | 'unsupported-input' // garbled / empty / unknown source
  | 'decode-error'
  | 'encode-error'
  | 'demux-error'
  | 'mux-error'
  | 'constraint-unsatisfied' // a valid request whose declared output constraints cannot all be met
  | 'resource-exhaustion' // bounded-memory/byte budget exceeded (REQUIREMENTS §8.4)
  | 'integrity-error' // range validator (ETag/Last-Modified) changed mid-assembly (REQUIREMENTS §5.1)
  | 'aborted' // signal aborted
  | 'driver-incompatible'; // apiVersion mismatch at registration

/**
 * Base class for every error the engine raises. Carries a machine-readable {@link MediaErrorCode} and
 * an optional structured `detail`. Concrete subclasses stamp their public names explicitly so minified
 * builds keep logs and `instanceof` readable without preserving every internal helper function name.
 */
export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly detail?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MediaError';
  }
}

/** Structured facts about an unsatisfiable named route (container/codec tokens, counts, flags). */
export type OperationFacts = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * The operation a capability probe could not satisfy, as a discriminated union over the three driver
 * seams plus named engine routes. `codec`/`container` carry the exact routed query, `filter` the exact
 * spec, and `route` names any other operation (an engine op, a driver-internal constraint, a runtime
 * gate) with optional structured {@link OperationFacts}.
 */
export type OperationDescriptor =
  | { readonly kind: 'codec'; readonly query: CodecQuery }
  | { readonly kind: 'container'; readonly query: ContainerQuery }
  | { readonly kind: 'filter'; readonly spec: FilterSpec }
  | {
      readonly kind: 'route';
      readonly id: string;
      readonly facts?: OperationFacts;
    };

/** Structured payload attached to a {@link CapabilityError} (`detail`). */
export interface CapabilityErrorDetail {
  /** The operation/query that could not be satisfied. */
  readonly op: OperationDescriptor;
  /** Driver ids probed, in ladder order, before giving up; empty only when nothing was probed. */
  readonly tried: readonly string[];
  /** Optional actionable hint (e.g. "register the WASM FLAC driver"). */
  readonly suggestion?: string;
}

/**
 * True when a value carries the exact {@link CapabilityErrorDetail} shape. Used where a detail arrives
 * untyped — e.g. rebuilt from the structured-clone worker wire — so a `CapabilityError` is only ever
 * constructed with a genuine typed detail, never a cast.
 */
export function isCapabilityErrorDetail(value: unknown): value is CapabilityErrorDetail {
  if (typeof value !== 'object' || value === null) return false;
  const detail = value as {
    op?: unknown;
    tried?: unknown;
    suggestion?: unknown;
  };
  if (!Array.isArray(detail.tried) || !detail.tried.every((id) => typeof id === 'string')) {
    return false;
  }
  if (detail.suggestion !== undefined && typeof detail.suggestion !== 'string') return false;
  if (typeof detail.op !== 'object' || detail.op === null) return false;
  const op = detail.op as {
    kind?: unknown;
    query?: unknown;
    spec?: unknown;
    id?: unknown;
  };
  switch (op.kind) {
    case 'codec':
    case 'container':
      return typeof op.query === 'object' && op.query !== null;
    case 'filter':
      return typeof op.spec === 'object' && op.spec !== null;
    case 'route':
      return typeof op.id === 'string';
    default:
      return false;
  }
}

/**
 * No eligible driver exists for an operation in this environment. The code is intrinsically
 * `capability-miss`; `detail` names what was tried and how to enable it (ADR-017). The detail is
 * typed but optional: an error rebuilt from a wire that carried none stays a `CapabilityError`
 * rather than gaining a fabricated operation descriptor.
 */
export class CapabilityError extends MediaError {
  declare readonly detail?: CapabilityErrorDetail;

  constructor(message: string, detail?: CapabilityErrorDetail, options?: ErrorOptions) {
    super('capability-miss', message, detail, options);
    this.name = 'CapabilityError';
  }
}

/**
 * The source bytes are garbled, empty, or of an unknown/unsupported kind. The code is intrinsically
 * `unsupported-input`.
 */
export class InputError extends MediaError {
  constructor(message: string, detail?: unknown, options?: ErrorOptions) {
    super('unsupported-input', message, detail, options);
    this.name = 'InputError';
  }
}

/** One bounded candidate considered while satisfying an objective output constraint. */
export interface ConstraintAttemptDetail {
  readonly attempt: number;
  readonly targetBytes: number;
  readonly actualBytes: number;
  readonly averageBitrate: number;
  readonly qualityMean?: number;
  readonly qualitySamples?: number;
}

/** Structured evidence carried when no bounded candidate satisfies every declared constraint. */
export interface ConstraintUnsatisfiedDetail {
  readonly constraint: 'h264-quality-rate';
  readonly preferredAverageBitrate: number;
  readonly maxAverageBitrate: number;
  readonly minimumQualityMean: number;
  readonly metric: 'ssim-luma-v1';
  readonly attempts: readonly ConstraintAttemptDetail[];
}

/**
 * The engine understood and attempted a constraint-bearing request, but no candidate met all hard
 * bounds. This is distinct from bad input and from a missing codec capability: callers may inspect the
 * bounded attempt evidence and choose a different declared rate/quality contract.
 */
export class ConstraintUnsatisfiedError extends MediaError {
  declare readonly detail: ConstraintUnsatisfiedDetail;

  constructor(message: string, detail: ConstraintUnsatisfiedDetail, options?: ErrorOptions) {
    super('constraint-unsatisfied', message, detail, options);
    this.name = 'ConstraintUnsatisfiedError';
  }
}
