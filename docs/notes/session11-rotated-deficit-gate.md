# Session 11 — rotation- and cohort-exact deficit gate

## Problem

The original one-shot deficit generator keyed an overlay by only browser, scenario, and engine. A targeted
rerun therefore replaced whichever different corpus rotation had been measured earlier. It could also pair
our newest result with a rival from an unrelated old export, present the newest export timestamp as if it
described every retained cell, inspect only wall time, and call `peakMemory: { n: 0, median: 0 }` lean. Those
properties made the generated board useful as a loose seed but incapable of proving Session 11's all-file,
fresh `n≥5` wall-and-memory Definition of Done.

## Design

The generator now separates two identities:

- Correctness cells use browser + scenario + baked/rotated filename slot + engine. The selected SHA remains
  visible in the report, while a newer result for the same filename supersedes bytes removed by a justified
  corpus repair.
- Performance cohorts use browser + scenario + filename slot + source export. Engines are compared only
  inside one exported run, so selection, environment, corpus version, and measurement schedule are shared.

Every supplied export contributes to the known scenario/candidate-count universe. Only exports within 24
hours of the newest input can satisfy current evidence. Consequently, a fresh targeted overlay exposes
unmeasured/stale rotations rather than inheriting their old status. For every historically contested metric,
the report gates all expected rotations, warmup ≥1, and every measured participant at `n≥5`. Wall and
positive-sample peak memory are ranked independently. An absent, zero-sample, or zero-median memory metric
is explicitly unmeasured. Functional red, bake-blocked, missing-rotation, under-sampled, missing-rival, wall
loss, and memory-loss conditions all keep the generator exit status non-zero.
An `NA_ENGINE`/`NA_BROWSER` result is also an active coverage gap when a rival PASSes the same cohort,
unless `coverage-parity-exemptions.json` names the exact physical capability boundary and its governing
ADR. The register currently contains only ADR-109's two MP3-encode rows, HEVC Main10 output, and H.264
two-pass mode.

## Validation

`node --test docs/perf/gen-deficits.test.mjs` covers six adversarial cases:

1. two rotations remain distinct and only the genuinely slower rotation is reported;
2. our result and a rival in separate exports are never spliced into a comparison;
3. a fresh partial export cannot inherit stale correctness coverage;
4. a justified new digest in the same named rotation supersedes the obsolete bytes.
5. `n=1` wall evidence gates while zero-sample memory stays unmeasured.
6. an engine NA remains a coverage red when a rival PASSes the same rotation.

The current public exports intentionally leave the strengthened gate red: they are single-engine,
single-sample development reruns, not close-out evidence. A final full all-engine rotation with `n≥5` and
memory measurement must regenerate the board before any leaderboard claim.

A seven-run warm benchmark over the current 50-export, 19 MiB public result set measured 0.08 s median
wall (range 0.08–0.09 s) while parsing, cohorting, rendering, and atomically replacing each report. The
worklist gate therefore adds negligible time beside even one browser cell.

## Rejected alternatives

- Keying only by scenario, which overwrites rotations.
- Keying a rotation permanently by digest, which retains failures for corpus bytes no longer selectable.
- Combining engines across exports, even when filenames happen to match.
- Treating an old complete export plus a new partial overlay as fresh complete evidence.
- Treating an unavailable memory metric as zero.
- Allowing `n=1` ratios or a one-file selection to close the gate.
