# SESSION 13 — GOAL: be the fastest engine on every feature, honestly

## Binding mission

This summarizes, never narrows, [`BUILD_INSTRUCTIONS_SESSION13.md`](BUILD_INSTRUCTIONS_SESSION13.md). The product is
functionally built and already wins the aggregate winner race, but it still **loses or only ties individual
features** to rival engines. Work continuously until aibrush-media is the **strictly fastest passing engine on
every contested feature**, achieved by general engineering — never by fitting code to the harness. Never stop at
a plan, an aggregate win, an empty loss list, a within-noise tie, or a blocker; record blocked/exempt paths and
continue the next feature. Request input only when no meaningful safe work remains.

Before every change, ultrathink truth, edge cases, B-frames/VFR, streaming, cancellation, backpressure, memory,
and frame ownership. Use subagents to profile and optimize independent features in parallel; coordinate shared
seams centrally; review every change for output invariance before integration.

## Method: feature by feature

Sweep the benchmark scenario by scenario against `mediabunny`, `ffmpeg.wasm`, `mp4box`, `remotion-media-parser`,
and `web-demuxer`. For each feature, compare warm median wall and peak memory against every rival that also
passes it. Where a rival leads (e.g. `probe/h264_4k_10s`, `probe/hevc_1080p_10s`, `probe/h264_vfr`), open a
tracked todo and a row in the committed speed ledger, root-cause the gap, then close it with a real optimization
and fresh qualified evidence. Correctness is the precondition: a fastest-but-wrong row is a loss.

## Never overfit

Do not tune to the harness's assets, sizes, names, rotations, or thresholds. No fixture detection, per-asset
caching, recognized-input short-cuts, passthrough, padding, spoofed containers, or weakened oracles. Try every
legitimate idea instead — lazy/single-pass parsing, zero-copy views, buffer/decoder reuse, the
hardware→GPU→WASM ladder, warm workers and transferables, bounded streaming memory, SIMD, reduced GC. Every
optimization must be a **general** win that makes the engine faster, leaner, more solid, more stable, and more
future-proof on any real input of that shape, proven not to change output bytes/sample/frame truth, benchmarked
fresh against the rival it beats, and covered by docs/ADR.

## Finish condition

Harness stays black-box: public commands, status/metric/reason output, and exported JSON only; never read
scenario/oracle/tolerance/runner/rotation/parser/adapter code. Do not regress Session 12 correctness — zero
PASS→FAIL, the nine retained reds and evidence rows stay resolved or held, force-software determinism and
close-exactly-once frame ownership stay green. Stop only when a fresh same-export, rotation-on, warm `n>=5`
all-engine sweep shows aibrush-media strictly fastest by a durable margin and `<=` the leanest rival in memory
on **every** contested feature, `bun run gate` passes, the anti-overfit audit is clean, and the complete
Definition of Done in §2 is verified.
