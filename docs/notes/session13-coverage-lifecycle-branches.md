# Session 13 lifecycle branch closure

## Design note

**Goal.** Raise the exact Node branch gate with meaningful coverage of source ownership, lazy stream
termination, worker serialization, and worker cancellation/backpressure seams, without changing product
behaviour or touching the MP4, WAV, FLAC, Ogg, or semantic-copy owners. **Approach.** Drive the existing
public/internal contracts through strict observable assertions: byte identity and fetch/request shape for
sources, lock release plus close/cancel counts for deferred streams, and typed payload/error/transfer facts
for workers. This is preferable to adding test-only production exports or implementation-specific mocks,
which would couple the gate to private locals rather than contracts. **Edge cases.** Empty and past-EOF
ranges, negative/fractional bounds, partial/over-returning HTTP responses, redirect URL learning, one-shot
EOF/error/cancel races, queued-value ownership, cancel rejection, duplicate/shared transferables, bounded
serialization depth, malformed worker payloads, missing hints, abort before first pull, and non-stream
worker results are all exercised. B-frames, VFR, open-GOP, and seek truth are unaffected because these
tests stop at byte/frame ownership boundaries; no media timeline is rewritten. **Failure modes.** Raw
source failures must remain typed `InputError`/`MediaError`; worker validation must reject malformed wire
data before opening an engine; cancellation must release locks and never double-close a queued frame.
**Test plan.** Add deterministic unit suites over the production seams, record focused pre/post V8 branch
counts, then run strict typecheck, Biome, the focused tests, and the full coverage gate with the normal 90%
threshold unchanged. No benchmark is added because this is validation-only closure with zero runtime code
change.
