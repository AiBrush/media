# Session 12 - exact public runtime controls

## Design note

The three controls are instance/per-call routing facts, never mutable process policy. `pinDriver` first
resolves its registered kind so a codec pin can coexist with automatic demux/filter stages; once its kind
is routed, the candidate set is exactly one and no cached/unpinned winner can escape. The engine resolves
threads and the asset directory once, before media ownership, then carries immutable structured-cloneable
facts through stage options, preload, container-owned WASM decode, and workers. Every external WASM URL is
resolved only after that tail is selected. The absent-override branch returns the existing import-meta URL
object exactly, while an override is an absolute same-origin directory. URL/profile keyed promises prevent
different engine configurations from sharing a failed location verdict. These controls operate before or
beside the data graph, so DTS/PTS/B-frame order, VFR, seek, bounded stream queues, abort teardown, and
close-once frame ownership do not change.

## Edge and lifecycle inventory

- Unknown pins join one in-flight lazy default registration (including concurrent first calls), then raise
  `CapabilityError` with `tried:[pin]` before a source opens. A pre-aborted call does not perform this
  optional warmup.
- A pinned driver's negative support verdict never probes a fallback; codec, container, and filter caches
  include pin identity.
- A pin registered only as a codec does not constrain container/filter selection. Nested codec routes and
  worker-reconstructed calls retain it.
- `enableThreads:false` is baseline even when isolation and SAB exist. `true` without either requirement is
  baseline with a reason. No baseline path allocates/exposes `SharedArrayBuffer`.
- Browser asset roots reject credentials, cross-origin URLs, and non-HTTP(S) schemes synchronously. Node
  and file pages may use `file:` for deterministic tests. Query/hash are removed and a trailing slash makes
  directory semantics unambiguous.
- Support probes do not call a core loader. A selected decoder/encoder, direct ADTS decode, or ready-level
  preload receives the resolved profile/root; cancellation continues through the existing stage signal.
- Worker jobs carry the already-normalized absolute root and resolved profile, so worker `import.meta.url`
  and global isolation checks cannot drift the host decision.

## Validation

Fail-first failures covered all three previously inert controls. Current focused evidence:

- `bunx vitest run src/kernel/router.test.ts src/kernel/wasm-runtime.test.ts src/api/runtime-controls.test.ts src/kernel/worker-main.test.ts src/kernel/worker-host.test.ts src/api/worker-offload.test.ts` - 98/98.
- `bunx vitest run src/api/preload-runtime-controls.test.ts src/api/preload.test.ts src/api/runtime-controls.test.ts src/kernel/worker-host.test.ts src/kernel/worker-main.test.ts` - 41/41.
- AAC, MP3, Vorbis, Opus, AV1, VPX, and Vorbis-encode focused core suites - 277/277.

The strict assertions cover exact ids/`tried` lists, no non-pinned probes or lazy loads, zero source opens
for an unknown pin, exact baseline profile reasons, normalized absolute URLs, no fetch on URL rejection,
preload arguments, and the host→wire→inner-engine context.

## Fresh benchmark

`bun run bench-session12-runtime-controls` uses three warmups and eleven recorded samples with an output
sink/oracle on every iteration:

- exact pinned codec route, 2,500 selections/sample: median 1.968 ms = 0.787 µs/pick;
- profile + root normalization + asset resolution, 20,000 sets/sample: median 45.308 ms = 2.265 µs/set;
- `createMedia({enableThreads:false, assetBaseUrl, worker:false})`, 20,000 engines/sample: median
  37.617 ms = 1.881 µs/engine.

These are package-level control-plane measurements, not the final cross-browser media throughput gate.
