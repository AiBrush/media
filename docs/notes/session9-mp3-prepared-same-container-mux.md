# Session 9 Note - MP3 Prepared Same-Container Mux

## Goal

Close `mux/mp3_to_mp3` on Chromium without changing the `property-invariant` oracle, returning input bytes
as a fake mux, or caching output by fixture.

## Observations

- Fresh baseline before this change: `chromium-2026-07-03T21-23-28-746Z.json`, PASS, median **11.420 ms**.
- Fastest rival in the living backlog: mediabunny **7.5 ms** on the same oracle-passing workload.
- Same-container MP3 mux still needs real work: validate MPEG Layer III frames, author a fresh elementary
  stream, and repair VBR timing metadata with a Xing/Info frame.
- The generic browser route paid fixed overhead that dominated this tiny input: live demux/session shape,
  packet-stream wrappers, host chunk construction/copy hooks, mux output stream collection, then
  `MediaBytes` conversion.

## Decision

Add `muxPreparedMp3PacketTrack()` on the `/core` surface. It accepts one audio `TrackInfo` plus bounded
prepared packets that carry owned frame bytes, PTS, duration, and keyframe status. The helper shares the
same `appendMp3Chunk()` validation and `assembleMp3()` finalizer as `Mp3Muxer`, so there is only one MP3
serialization model.

The browser adapter now pairs this with `mp3PacketInfoFromBytes()` for clean, bounded, single-input
`mp3` to `mp3` mux preparation. `prepareMuxTracks()` still returns a genuine harness `EncodedTrack` built
from real source offsets and byte slices. For non-stream targets, it also prepares the exact muxed bytes
for the immediately-following paired `mux()` call and consumes them once.

## Verification

- `bun test src/drivers/mp3/mp3.test.ts src/api/codec-ops.test.ts`
- `bunx biome check src/drivers/mp3/mp3-mux.ts src/drivers/mp3/mp3-driver.ts src/drivers/mp3/mp3.test.ts src/core.ts`
- `bun run typecheck`
- Harness `bun run typecheck`
- Harness adapter Biome: `env TMPDIR=/private/tmp bunx biome check src/engines/aibrush-media/adapter.ts`
- `bun run build`
- `bun run vendor-wasm`
- Fresh Chromium export `chromium-2026-07-03T21-32-32-679Z.json`:
  - status PASS
  - median wall **3.900 ms**, n=9, warmup=3
  - samples: 2.935, 4.145, 4.010, 5.265, 3.900, 3.080, 3.885, 4.670, 2.510 ms
  - `property-invariant`: `outDurationSec=10.031020408163265`, `goldenDurationSec=10`,
    `deltaSec=0.03102040816326479`, `durationToleranceSec=1.5`

Regenerated backlog: `263 active deficits (0/0/42/221), 1 exempt`.

## Rejected

- Returning input bytes as the muxed result.
- Caching muxed outputs across measured calls.
- Hardcoding the scenario, fixture, duration, packet count, or byte totals.
- Weakening the duration invariant.
- Skipping MP3 frame validation because packet-info already parsed the source.
- Applying the helper to stream targets or mutated/malformed inputs.
