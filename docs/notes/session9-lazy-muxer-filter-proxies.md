# Session 9 Note - Lazy muxer track mirroring and filter proxies

## Problem

The `mux/h264_aac_to_ts` speed row first failed correctness in Chromium because the lazy MPEG-TS muxer
loaded after the first stream wrote a packet. A second track added after that load existed only in the proxy,
so later writes for proxy track id `1` had no corresponding target track.

Fixing that race pushed the default/probe bundle above the 256 kB budget because `defaults.ts` still pulled
the concrete audio, GPU video, and CPU video filter modules into the default driver registration closure.

## Design

`LazyContainerMuxer.addTrack()` now preserves a simple invariant:

- tracks added before the real muxer loads are replayed in order during `#ensure()`;
- tracks added after load are immediately added to the loaded muxer and mapped to their target track id.

Default filter registration now installs cheap lazy `FilterDriver` proxies for:

- `webgpu-video-filter`;
- `canvas2d-video-filter`;
- `audio-dsp-filter`;
- `cpu-video-filter`.

Each proxy keeps a synchronous `supports()` predicate in the default bundle and imports the concrete filter
module only when a supported stream receives its first frame. Unsupported specs still throw a typed
`CapabilityError` synchronously. Empty filter streams do not import the heavy implementation.

## Edge Cases

- Late audio/video track registration after muxer load must preserve public proxy ids.
- Parallel drains must not require serialization to stay correct.
- Browser feature probes must stay cheap and side-effect free.
- Node must return typed filter misses without importing browser-only filter implementations.
- A load failure before frame handoff closes the input frame exactly once.

## Validation

- `bun test src/drivers/defaults.test.ts --test-name-pattern "lazy|tracks added|filter proxies"`
- `bun test src/api/codec-ops.test.ts --test-name-pattern "MPEG-TS|muxes caller-supplied demux packets"`
- `bunx biome check src/drivers/defaults.ts src/drivers/defaults.test.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`

The budget proof after the lazy filter split is eager **48.53 kB / 50.00 kB** and default/probe
**232.91 kB / 256.00 kB**.

## Rejected

- Raising the default/probe budget.
- Dropping CPU/GPU/audio filters from default registration.
- Importing concrete filter modules during `supports()`.
- Loading concrete filters before the first frame.
- Serializing all packet drains to avoid the muxer race.
- Special-casing the H.264/AAC TS benchmark instead of fixing the lazy muxer invariant.
