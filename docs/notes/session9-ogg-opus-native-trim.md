# Session 9 - Ogg Opus Native Trim

## Goal

Close `trim/audio_opus_ogg_copy` on Chromium by making the public same-container Ogg copy trim do only the
work the oracle requires: keep complete compressed packets in the requested time window, author a fresh Ogg
container, and preserve typed errors. No fixture ids, cached outputs, input passthrough, or oracle changes.

## Baseline

The row was already correct but slow after the earlier Ogg packet-info and prepared-mux work. Fresh
Chromium proof `chromium-2026-07-05T00-44-19-213Z.json` measured:

- aibrush-media: **13.500 ms** median, PASS.
- mediabunny: **9.850 ms** median, PASS.

Both engines passed `trim-boundaries` with `outDurationSec=5.0135` for the requested 5 s window. The
remaining cost was representation overhead: public trim demuxed Ogg into packets, wrapped kept packets as
host `EncodedAudioChunk`s, then copied the bytes back into the same Ogg writer.

## Design

`OggDriver.streamCopy()` now handles same-container trims directly. It validates the target container and
range, builds the existing byte-backed `oggPacketInfoTable()` over the real source bytes, selects packets
whose `[pts,duration)` overlaps the requested `[start,end)` window, rebases timestamps relative to the first
kept packet, and calls the existing `trackStateFrom()` + `writeOgg()` page writer with `ChunkStruct.data`
views into the source buffer.

The optimization is intentionally narrow. It does not add a new Ogg writer and it does not bypass Ogg page
lacing, granule positioning, or CRC generation. Unsupported targets, non-audio Ogg streams, missing packet
offset/duration facts, malformed ranges, and empty selections raise typed errors. A non-trimmed
same-container stream copy returns the same bytes through a stream because that is exactly the requested
unmodified Ogg remux shape, while partial trims always author fresh pages.

## Edge Cases

- Start/end must be finite, non-negative, non-empty, and within the parsed source duration plus the existing
  1 ms end slack.
- Packets are selected by overlap, matching the public compressed-audio trim semantics.
- Packet byte offsets and durations are required; missing facts are a demux error, not guessed timing.
- The first kept packet becomes timestamp zero; later packet durations and keyframe flags are preserved.
- Ogg page lacing, granule repair, and CRCs remain centralized in `writeOgg()`.
- Cross-container, malformed, non-audio, and unsupported Ogg shapes fall back or reject through the normal
  typed container-driver contract.

## Validation

Focused Node coverage proves the driver-native route on a real Opus fixture:

- `bun test src/drivers/ogg/ogg.test.ts src/api/codec-ops.test.ts --test-name-pattern "Ogg|compressed audio packet-copy"`
- `bunx biome check src/drivers/ogg/ogg-driver.ts src/drivers/ogg/ogg.test.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run check-budgets`
- `bun run vendor-wasm`
- browser harness `bun run typecheck`

Fresh Chromium export `chromium-2026-07-05T00-50-06-496Z.json` closed the cell:

- aibrush-media: **7.160 ms** median over `[7.160, 4.795, 6.365, 9.570, 7.530]`, PASS.
- mediabunny: **12.615 ms** median over `[12.615, 13.415, 6.815, 12.230, 14.460]`, PASS.
- aibrush-media throughput: **1397.626x** realtime; mediabunny throughput: **793.262x** realtime.
- aibrush-media peak memory median: **27,666,391 B**; mediabunny peak memory median: **28,187,649.5 B**.

Both engines passed `trim-boundaries`; aibrush-media reported `outDurationSec=5.0135`,
`requestedDurationSec=5`, and `durationDeltaSec=0.013499999999999623`.
