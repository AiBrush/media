# Session 9 Note - MP4 URL Packet-Info Prefix

## Goal

Close `performance/metamorphic-vfr-iterate-packets` on Chromium without changing the
`golden-packets` oracle, skipping audio rows, or caching packet tables across measured calls.

## Design Note

The workload asks only for MP4 packet facts over the real `h264_vfr.mp4` fixture: two tracks, 581 packet
rows, exact sizes, keyframe flags, and zero timestamp drift. Fetching the whole 2.28 MB file for the
byte-backed helper was therefore the wrong cost shape. A public range-backed packet-info path removed the
full-body read, but still paid generic engine dispatch and several overlapping tiny header ranges on a
faststart file whose `moov` fits near the head.

The final path adds a first-party `/core` helper, `mp4PacketInfoFromUrl(url, { mime, size, signal })`, for
driver-author and harness-style packet-only callers. It builds a URL source, wraps it in the existing byte
range cache, primes exactly one 8 KiB start-at-zero prefix, and calls `Mp4Driver.packetInfo()` directly.
Faststart files with metadata inside that prefix pay one range request; files with larger metadata fall
through to the same strict MP4 driver range reads. The browser adapter keeps byte-backed MP4 packet-info
only for clean files at or below 512 KiB and sends larger clean MP4/MOV packet-only demux rows through the
URL helper. No parsed metadata, packet table, oracle result, or output is cached across benchmark
iterations.

## Validation

- Package focused tests: `bun test src/api/mp4-prepared-mux.test.ts`
- Package formatter: `bunx biome check src/api/mp4-prepared-mux.ts src/api/mp4-prepared-mux.test.ts`
- Package typecheck: `bun run typecheck`
- Harness typecheck: `bun run typecheck` in `../media-test/media-browser-test`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Harness vendor sync: `rsync -a --delete dist/ ../media-test/media-browser-test/src/engines/aibrush-media/vendor/`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario performance/metamorphic-vfr-iterate-packets --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-44-45-304Z.json`

`performance/metamorphic-vfr-iterate-packets`:

- aibrush-media: PASS `golden-packets`, median **3.795 ms**, n=9
- remotion-webcodecs: PASS `golden-packets`, stored median **4.600 ms**
- oracle detail: `packetCount=581`, `comparedTracks=2`, `maxPtsDriftUs=0`
- timing detail: fresh baselines moved from whole-byte helper **9.635 ms** to public range path
  **7.745 ms**, direct URL helper **7.035 ms**, and prefix-primed URL helper **3.795 ms**

Regenerated backlog: `268 active deficits (0/0/47/221), 1 exempt`.
