/**
 * The typed error model — the only errors the engine throws (docs/architecture/05 §2, ADR-017).
 *
 * A capability miss is always a typed `CapabilityError`, never a silent wrong result; bad input is an
 * `InputError`; stage failures carry a specific `MediaErrorCode`. Strings are never thrown and errors
 * are never swallowed (ADR-018).
 */

/** Discriminant for every {@link MediaError}. */
export type MediaErrorCode =
  | 'capability-miss' // no eligible driver for op + codec + env
  | 'unsupported-input' // garbled / empty / unknown source
  | 'decode-error'
  | 'encode-error'
  | 'demux-error'
  | 'mux-error'
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
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** Structured payload attached to a {@link CapabilityError} (`detail`). */
export interface CapabilityErrorDetail {
  /** A description of the operation/query that could not be satisfied. */
  op: unknown;
  /** Driver ids that were probed, in ladder order, before giving up. */
  tried: readonly string[];
  /** Optional actionable hint (e.g. "register the WASM FLAC driver"). */
  suggestion?: string;
}

/**
 * No eligible driver exists for an operation in this environment (code `capability-miss`). `detail`
 * carries {@link CapabilityErrorDetail} naming what was tried and how to enable it (ADR-017).
 */
export class CapabilityError extends MediaError {
  constructor(code: MediaErrorCode, message: string, detail?: unknown) {
    super(code, message, detail);
    this.name = 'CapabilityError';
  }
}

/** The source bytes are garbled, empty, or of an unknown/unsupported kind (code `unsupported-input`). */
export class InputError extends MediaError {
  constructor(code: MediaErrorCode, message: string, detail?: unknown) {
    super(code, message, detail);
    this.name = 'InputError';
  }
}
