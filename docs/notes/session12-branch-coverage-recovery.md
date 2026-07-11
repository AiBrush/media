# Session 12 branch-coverage recovery

## Truth before change

The exact post-budget-refactor gate passes all 3,292 tests but reports 89.9323% branch coverage against the
binding 90% floor. The shortfall is twelve covered branches. Lowering the threshold, adding exclusions, or
forcing impossible array-invariant guards would weaken the oracle. The missing reachable contracts are
numeric saturation in video route-cost estimates, incomplete codec bit-depth metadata, final-frame timing
when no container duration is available, an explicit duration ending inside a long VFR interval, malformed
timestamp order, a throwing restamper, and PCM range bounds.

## Edge cases and ownership

- Route-cost multiplication must saturate instead of wrapping to `Infinity`; an overflowing pixel area is
  unknown rather than a fabricated finite cost.
- One-frame and two-frame streams must infer their tail from, in order, a positive frame duration, the prior
  VFR delta, or the requested CFR period.
- A declared duration may end inside an interior source interval. No frame after that end may be emitted,
  and cancellation must close buffered source/output frames exactly once.
- Non-monotonic timestamps and restamp failures must close every native-frame analogue exactly once while
  preserving the original typed failure. No B-frame assumption is made: retiming consumes presentation
  order and rejects a non-monotonic public stream rather than silently sorting live frames.
- PCM range reads clamp non-finite starts to zero and starts at/past EOF to the empty tail without reading
  outside channel storage.
- Truncated VP9 metadata and HEVC Main/Main10 profile strings must yield honest known/unknown bit-depth
  plans without inventing precision.

## Design

Start with fail-first pure Node validation and closable frame doubles so lifecycle assertions are
deterministic. Exercise overflow with finite operands whose products exceed representable range, drain or
cancel every stream, and assert exact schedules/data rather than smoke success. The fail-first run exposed
one production defect: interval validation happened before the retimer's ownership `finally`, so an
unrepresentable positive tail rejected with the right typed error but leaked its final frame. Put validation
inside that `try/finally`; do not change scheduling or error semantics. The existing branch threshold
remains unchanged and is the final oracle.
