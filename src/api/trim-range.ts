/**
 * Trim-range validation (moved out of the `engine.ts` god-file, R-S05.1). Consumed by the trim runner
 * through the engine's operation-runner context and unit-covered directly.
 */

import { InputError } from '../contracts/errors.ts';

/**
 * Slack (seconds) allowed past the probed duration on a trim's `end`, so a legitimate "to EOF" request
 * that rounds up to a whole second past a sub-second-short probed duration still validates. It is far
 * below any genuinely-out-of-range request (e.g. seconds-to-hours past EOF) yet above probe rounding
 * and integer-second clamp slack — the same ~1-GOP order the keyframe-trim oracle tolerates.
 */
const TRIM_END_SLACK_SEC = 1;

/**
 * Reject a malformed trim range with a typed {@link InputError} before any cut is attempted. Valid
 * ranges satisfy `0 ≤ start < end` and, when the media's duration is known (`durationSec > 0`),
 * `start < durationSec` and `end ≤ durationSec + {@link TRIM_END_SLACK_SEC}`. Wording is deliberately
 * plain (no "capability"/"codec"/"browser" vocabulary) so callers and adapters read it as bad input,
 * not a capability gap. Exported for direct unit coverage of every guard branch (incl. the
 * unknown-duration path that real, always-timed corpus media cannot reach through the public op).
 */
export function assertTrimRange(startSec: number, endSec: number, durationSec: number): void {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('bad trim');
  }
  if (startSec < 0) {
    throw new InputError('start<0');
  }
  if (endSec <= startSec) {
    throw new InputError('empty trim');
  }
  // Duration-relative bounds only when a real duration was probed; a 0/unknown duration cannot bound
  // the range without spuriously failing an otherwise well-formed request.
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError('start>=duration');
    }
    if (endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError('end>duration');
    }
  }
}
