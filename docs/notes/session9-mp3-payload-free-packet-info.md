# Session 9 Note - MP3 Payload-Free Packet Info

## Goal

Close `demux/realworld_mdn_trex_mp3` on Chromium without changing the `golden-packets` oracle, skipping
any MPEG frames, or pretending MP3 has an index it does not have.

## Design Note

The row was fixed-overhead dominated. The MP3 driver already owned the hard correctness part:
`enumerateMp3Packets()` walks every complete MPEG Layer III frame, skips the leading Xing/Info metadata
frame, and derives packet PTS from the sample clock. The old browser path still created a live demux
session and `EncodedAudioChunk` packet stream before the adapter reduced the answer to packet facts.

The fix exposes that existing framer through `Mp3Driver.packetInfo()` and a byte-backed
`mp3PacketInfoFromBytes()` helper on the `/core` surface. Both still read and validate the whole MP3 byte
stream because elementary MP3 has no packet index. They only remove source-wrapper, router, and WebCodecs
chunk-construction overhead when the caller wants packet rows rather than payload streams.

## Validation

- Package focused tests: `bun test src/drivers/mp3/mp3.test.ts`
- Package formatter: `bunx biome check src/drivers/mp3/mp3-driver.ts src/drivers/mp3/mp3.test.ts src/core.ts`
- Package typecheck: `bun run typecheck`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Harness adapter typecheck: `bun run typecheck` in `../media-test/media-browser-test`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario demux/realworld_mdn_trex_mp3 --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-13-38-400Z.json`

`demux/realworld_mdn_trex_mp3`:

- aibrush-media: PASS `golden-packets`, median **3.235 ms**, n=9
- mediabunny: PASS `golden-packets`, stored median **3.305 ms**
- oracle detail: **81 packets**, 1 compared track, `maxPtsDriftUs=0`

Regenerated backlog: `271 active deficits (0/0/50/221), 1 exempt`.
