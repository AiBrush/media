# Session 9 Note - ADTS Payload-Free Packet Info

## Goal

Close `demux/aac_adts` on Chromium without changing the `golden-packets` oracle, reducing packet facts,
initializing a decoder, or adding any fixture-specific behavior.

## Design Note

The deficit was fixed per-operation overhead, not ADTS parsing complexity. The oracle needs structural
packet facts: frame offset, full ADTS frame size, PTS/DTS, duration, keyframe flag, and track metadata. The
old demux route went through the normal demux object path before the browser adapter reduced the result
back into packet rows, which paid avoidable setup and wrapper cost on a tiny audio file.

The fix makes ADTS match the existing payload-free packet-table contract used by MP4/MOV, native FLAC, and
bounded Ogg callers. `AdtsDriver.packetInfo()` reads the validated ADTS source once, reuses the pure
`enumerateAdtsFrames()` walker, builds `TrackInfo` from the parsed layout and AudioSpecificConfig, and
returns a `PacketInfoTable` directly. It creates no `EncodedAudioChunk`s, never touches WebCodecs or the
wasm-aac decode tail, and caches no parsed rows across measured calls. The browser adapter now asks the
engine for ADTS `packetInfo()` before constructing packet streams, so the harness gets the same oracle
facts with less fixed work.

## Validation

- Package focused tests: `bun test src/drivers/adts/adts.test.ts`
- Package formatter: `bunx biome check src/drivers/adts/adts-driver.ts src/drivers/adts/adts.test.ts`
- Package typecheck: `bun run typecheck`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Harness adapter typecheck: `bun run typecheck` in `../media-test/media-browser-test`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario demux/aac_adts --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-04-14-906Z.json`

`demux/aac_adts`:

- aibrush-media: PASS `golden-packets`, median **4.015 ms**, n=9
- mediabunny: PASS `golden-packets`, median **5.920 ms** in the living backlog
- oracle detail: **470 packets**, `maxPtsDrift=0`

Regenerated backlog: `273 active deficits (0/0/52/221), 1 exempt`.
