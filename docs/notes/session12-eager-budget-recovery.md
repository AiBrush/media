# Session 12 eager-budget recovery

## Goal

Restore the required eager-kernel guard band after the Main10, replay-backed H.264 two-pass, and bounded
raw-PCM work landed. The fresh production closure is 49.99 kB against a 50.00 kB ceiling, while the package
gate requires at least 0.25 kB of margin. Runtime media bytes, codec choices, packet timing, and public API
behavior must remain unchanged.

After live input, runtime controls, declarative jobs, and composed remux metadata landed, an isolated clean
build measured 57.73 kB. The immediate recovery target is therefore at least 7.98 kB to restore the binding
0.25 kB guard, with more than 1 kB preferred so the next correct feature does not immediately exhaust it.

## Approach

Keep the actual two-pass implementation in its existing lazy browser module, but bind the engine-owned
codec/filter/stage callbacks once instead of repeating the same closure object at both lazy call sites. Reuse
the existing HLS/source-hint classifier for the no-MIME image-sniff decision rather than carrying a second
known-container extension lookup in the eager engine. The rejected alternatives are raising the ceiling,
removing the guard band, undoing the WAV range-read optimization, or moving media work into an eager helper;
all would either weaken the packaging oracle or regress first-frame behavior.

The Session 12 live/runtime/job additions also need an attribution guard that survives hashed chunk-name
changes. `check-budgets` therefore reads each emitted JavaScript source map and rejects heavy implementation
sources in either the eager/default-probe static closure, while still allowing the deliberately tiny live
identity module and synchronous runtime-option normalization. The emitted lazy frontier must retain literal
dynamic entries for live processing, live conversion, declarative job execution, and remux metadata rewriting.
Filename guards remain as a second independent check; neither the byte ceilings nor their margin are changed.

The principal recovery is an operation-level split matching architecture document 08: complete `remux`,
`trim`, explicit `mux`, and decrypt runners move behind literal dynamic imports, while the eager engine retains
only cancellation setup and a small set of engine-bound routing/codec callbacks. Remux planning still snapshots
tags before opening the source, performs the real native/packet remux before target-native rewriting, keeps its
two progress phases, buffers metadata output deliberately, and replays one-shot input exactly once for validated
full-track PCM selection. Trim retains native copy/PCM fast paths, B-frame/VFR packet clocks, safe-keyframe
preroll, decode/filter/encode ownership, sibling cancellation, worker offload, and final mux closure. Explicit
mux keeps prepared single-track fast paths, packet-stream validation, sibling cancellation, and
finalize-before-materialize ordering. A rejected alternative was a whole-engine lazy proxy: it would save more
bytes but would broaden synchronous `from/use` and cancellation semantics unnecessarily when focused operation
runners recover the measured gap.

Runtime control normalization remains synchronous and eager, but driver-only URL binding, threaded-only
capability errors, and wasm-bindgen payload construction move to `wasm-loader-runtime.ts`. Every software
driver imports that helper only from its already-lazy module; the default engine retains same-origin URL
validation and profile selection without inheriting loader-only code. Default `import.meta.url` identity,
URL+profile caches, and the support-probe no-fetch boundary are unchanged.

## Edge cases and failure modes

The shared callback binder must preserve the exact `this` instance and continue routing every codec/filter
query through the normal Router. H.264 B-frame/VFR evidence remains PTS-keyed in the lazy runner; no frames or
first-pass payloads cross the binder. Abort signals, backpressure, and close-exactly-once behavior remain owned
by the existing stage callbacks. Image sniffing must still run for images, unknown/text inputs, and ambiguous
no-MIME sources, while known audio/video extensions avoid the redundant range read; HLS manifest MIME hints
remain handled by the separate HLS resolver.

## Validation and benchmark

The original fail-first oracle was `bun run check-budgets` at 49.99 kB with 0.01 kB margin; the post-feature
oracle was red at 57.73 kB. The final production artifacts measure 48.98 kB eager against 50.00 kB (1.02 kB
margin) and 224.16 kB typical first-operation JS against 256.00 kB (31.84 kB margin). Source-map and hashed-
chunk guards prove that live processing, job, remux/metadata, trim, mux, decrypt, worker, and WASM-loader
implementations remain outside both static closures. Focused remux/metadata/trim validation passed 190/190;
engine/live passed 49/49; mux/codec/runtime passed 341/341; decrypt lifecycle/twin/diversity passed 173/173;
strict source/test/scripts typecheck and focused Biome are green. The measured artifact closure is the relevant
benchmark; no media-throughput claim is introduced by this refactor.
