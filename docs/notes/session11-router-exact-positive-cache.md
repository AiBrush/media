# Session 11 — exact codec cache and revalidated filter cache

Decision: ADR-207

## Goal

Keep stable top-rung codec selection off the repeated capability-probe path without allowing one accepted
decoder/encoder configuration to stand in for another. Selection must remain exact across codec description
bytes, geometry, colour, alpha, direction, determinism, and cost, and a transient lower-tier fallback must
not hide later hardware recovery. Filter selection must likewise remain exact across the complete target
spec rather than only media/operation type. The caches are optimizations only: an unprovable identity
re-probes.

## Chosen approach

Build a bounded descriptor-driven snapshot of the complete provable record. It reads data descriptors
directly and never invokes `toJSON` or an accessor. Ordinary `BufferSource` views contribute their exact
visible bytes rather than their backing-buffer identity. The codec snapshot is computed before `supports()`
and again after that asynchronous probe; if the caller mutates the query while the probe is pending, the
result is returned for that operation but is not cached.

Only a highest-ranked positive codec driver enters the 64-entry LRU. A lower-tier positive remains valid for its
current operation but is deliberately re-probed next time, allowing a temporarily unavailable hardware or
native rung to recover. `clearCache()` retains the public session-reset behavior. The Router stores neither
the caller object nor its media-description buffer.

Filter cache hits re-run the cached driver's synchronous `supports()` on the current exact spec and cache
only a top-ranked positive. A Canvas2D display-space colourspec therefore cannot stand in for a later
wide-gamut colourspec that only the CPU driver accepts, and a lower fallback cannot hide a faster driver on
a later spec. Its media/type/determinism/cost key remains naturally bounded.

## Uncacheable inputs and failure behavior

- Shared or cross-realm buffers, oversized descriptions, cyclic graphs, accessors, callable/symbol facts,
  hostile traps, non-record values, and non-finite numeric fields skip caching rather than sharing an
  ambiguous key. Caller `toJSON` is never executed.
- Distinct description subviews, in-place byte mutations, geometry, colour, effective VPx alpha, direction,
  determinism, and cost buckets remain isolated.
- A rejected or throwing top rung can fall through for the current operation; that lower-tier result is not
  retained, so support can recover on a later call.
- The cache changes neither codec support semantics nor packet/frame ownership, B-frame/VFR ordering,
  backpressure, cancellation, abort behavior, or `force-software` selection.

## Rejected alternatives

A codec-string-only or object-identity key can return the wrong driver for a newly allocated or mutated
configuration. Caching lower-tier positives for the session makes a transient hardware miss permanent.
Serializing accessor/cyclic/hostile objects risks collisions or side effects, while an unbounded key or cache
turns an optimization into retained caller state. Removing the positive cache entirely preserves correctness
but reinstates a native capability probe on every stable top-rung operation.

## Validation and current status

Fail-first tests cover geometry and VPx keep/discard in both operation orders, exact description subviews and
mutation, shared/cross-realm-buffer re-probing, a hostile `toJSON`, mutation during an unresolved probe,
dynamic hardware recovery, target-dependent filters in both orders, determinism/cost isolation, and
64-entry codec LRU eviction. The focused Router suite passes 33/33. Typecheck, scoped
Biome, production build, and budget checks are green.

After the cache and the independent eager codec-frame split, the current production measurements are
49.70 KiB for the eager closure (0.30 KiB below the 50 KiB guard) and 216.68 KiB for the default-driver
first-operation closure. These are package measurements, not evidence of browser codec throughput.

Fresh rotated Chromium `n≥5` wall/peak-memory comparison, the complete no-PASS-to-FAIL board, and WebKit and
Firefox close-out remain lead-owned Session 11 acceptance work. Until those runs are recorded, ADR-207 is a
correctness and bounded-overhead fix, not a leaderboard-closure claim.
