# GOAL: make @aibrush/media best-in-class, feature by feature

Work autonomously in here until `aibrush-media` leads every feature measured by @/Users/tarek/Home/software/projects/aibrush/aibrush.lib/media-test in correctness, coverage, speed, and memory.

## Non-negotiable scope

Treat media-test as an immutable external benchmark. You may run it, but never manually edit its scenarios, oracles, tolerances, fixtures, goldens, adapters, support rules, runner, or expected results. Never weaken, bypass, or game a test. Its only allowed writes are deterministic `bun sync-vendor` output and normal result artifacts.

Change the media product and its own tests/docs only. Improve real implementation, routing, codecs, containers, streaming, cancellation, memory ownership, and WASM integration. Preserve public API compatibility, browser portability, deterministic behavior, packaging, and licenses. Never special-case benchmark assets, falsify support, trade correctness for speed, or hide an implementable gap as NA_ENGINE.

Close one feature before starting the next: probe, demux, remux, transcode, decode-seek, trim, mux, encryption, metadata, streaming-output, audio-dsp, robustness, and performance. Choose the largest current deficit first. Within each feature, fix FAIL/ERROR/timeout/OOM and unjustified NA_ENGINE before optimizing speed and peak memory.

## Feature loop

1. Capture one fresh exhaustive baseline JSON, comparing all engines with identical browser, corpus, seed, warmup, and iterations.
2. Diagnose from result evidence, public behavior, specs, independent tools, profiling, and media-repo tests. Implement a general production fix and add fail-first product regression tests.
3. Run focused product tests/typecheck. After every product change and before testing it in media-test, run exactly:
   `cd /Users/tarek/Home/software/projects/aibrush/aibrush.lib/media-test && bun sync-vendor`
4. Re-run only affected scenarios with `--engine aibrush-media --no-reuse`. Never repeat an unchanged broad run.
5. At feature closure, run one fresh exhaustive all-engine comparison:
   `bash scripts/run.sh --browser chromium --feature <feature> --pillar all --exhaustive --no-reuse --random-seed <stable-feature-seed> --warmup 1 --iters 5`
6. Record before/after correctness, coverage, timing, memory, commands, and result paths. Make a coherent local commit in media after its gates pass; never push unless asked. Continue immediately.

Use one baseline per feature, targeted runs during development, feature-wide comparison only at closure, and the complete matrix only for final proof. On failure, investigate and change code/config before rerunning. Revert only your own failed changes. If one feature has a genuine external blocker, record evidence and continue all other safe work. Ask the user only when every remaining path requires new authority or unavailable input.

## Completion gate

Do not complete this goal until fresh evidence proves:

- Every applicable exhaustive aibrush-media scenario passes: zero FAIL, ERROR, timeout, OOM, partial coverage, or regression.
- Every remaining NA is an unavoidable browser/spec/input limitation with concrete evidence, never missing implementation.
- In every correctness-qualified comparable benchmark, aibrush-media is statistically #1 or tied for primary speed and peak memory, and no rival has better feature coverage.
- `bun run gate` passes in media; then run final `bun sync-vendor` and one fresh exhaustive all-engine media-test matrix.
- A final feature ledger links all proof artifacts.

Do not stop at a plan, update, partial win, green targeted test, or one completed feature. Keep implementing and measuring efficiently until every condition above is proven.