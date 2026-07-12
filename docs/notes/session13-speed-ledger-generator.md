# Session 13 qualified speed-ledger generator

## Goal

Generate the Session 13 per-feature speed ledger from public browser-harness JSON exports without reading
or depending on harness implementation details. A row may close as `LEAD` only when every selected
rotation has the complete pinned seven-engine roster, identical selection/cohort identity, warm `n>=5`
wall and positive-memory observations, a wall lead larger than the pairwise sum of MADs, and memory no
greater than the leanest passing rival.

## Approach

The generator validates each export and same-export scenario cohort before comparing anything. It keeps
the newest supplied observation for a named rotation, requires all input exports to share browser,
suite/corpus/environment, scenario set, and launcher settings, and checks rotation coverage against the
public `candidateCount`. Wall is classified pairwise as `LEAD`, `PARITY`, or `BEHIND` using
`rivalMedian - ourMedian` versus `ourMAD + rivalMAD`; the feature row takes the worst rotation. Memory is
ranked separately on positive post-warmup observations. An optional notes JSON file can
supply root cause and optimization narrative without making generated measurements hand-editable. A
rejected alternative was extending `gen-deficits.mjs`: that tool intentionally overlays a long-lived
correctness board, while this ledger needs one strict same-environment sweep and noise-aware pairwise
classification. Wall needs at least five timed samples; peak memory follows the binding positive-sample
rule independently, so one positive post-warmup observation qualifies while zero/missing telemetry does
not.

## Edge cases and failure modes

Duplicate/missing roster members, mixed run seeds inside a cohort, mismatched filename/SHA selection,
result reuse, mixed browser/suite/corpus settings, exports older than the freshness window, malformed
medians/MADs, `n<5`, zero or missing memory, incomplete rotations, PASS rows without metrics, and aibrush
PASS-to-FAIL rotations are
all explicit qualification gaps. Missing evidence can never become a zero-cost observation or a `LEAD`.
An all-NA cohort is excluded because it has neither a selection identity nor a passing engine to contest;
an export containing only such cohorts remains red rather than becoming vacuously qualified. Mixed cohorts
remain strict, and the worst-rotation choice uses the smallest durable margin across every passing rival,
not merely the rival with the lowest raw median.
An ADR-backed metric exemption can produce `EXEMPT`, but cannot hide incomplete rotation/cohort coverage
or a failure in a non-exempt metric. The generator writes both Markdown and canonical JSON atomically and
returns nonzero until every row is `LEAD`, `UNCONTESTED`, or validly `EXEMPT`.

This reporting-only path owns no media frames, streams, or payload buffers, so B-frames, VFR timestamps,
seek, cancellation, backpressure, and frame close-once semantics are unchanged. Rotation identity is
nonetheless preserved so a fast VFR/B-frame asset cannot overwrite a slower selected asset.
The public schema proves `reuseSuccessful:false` but does not encode browser-profile deletion; that final
fresh-profile fact remains an operational run-provenance check and is stated explicitly in generated output.

## Test plan

Adversarial Node tests use small public-schema-shaped exports to prove pairwise sum-MAD classification,
worst-rotation retention, newest same-slot supersession, all-engine roster and selection/run-seed checks,
warm wall/sample gates, positive post-warmup memory ranking, incomplete-rotation gating, all-NA exclusion
without empty-set qualification, every-rival worst-margin selection, and uncontested handling. A real
focused public export is then parsed as a smoke check; a positive one-sample memory observation may qualify,
but a missing or zero observation must remain unqualified rather than being reported as a win.
