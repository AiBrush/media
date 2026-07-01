# Session 9 FLAC probe and demux packet-info fast path

## Goal

Close the FLAC probe and golden-packet demux speed deficits without changing scenario semantics, oracles, or
fixture-specific behavior. Correctness was already green, but the speed backlog still showed FLAC probe and
demux rows behind rivals because the lazy default FLAC proxy fell back to full demux for probe, and the
browser demux adapter constructed payload streams for rows whose oracle only compares packet facts.

## Edge Cases

- STREAMINFO is the only mandatory FLAC metadata block; probe must not require SEEKTABLE.
- A SEEKTABLE is an index, not content. The benchmark seektable fixture has only 10 seek points for 105
  packets, so it cannot honestly produce the packet table.
- The no-seektable and metamorphic rows must enumerate frames from native frame headers.
- FLAC sync bytes can appear inside compressed payloads; candidate frame starts must still be validated with
  reserved-code checks, UTF-8 frame/sample-number parsing, explicit block-size/sample-rate fields, and CRC-8.
- Packet-info consumers need packet size, PTS/DTS, and keyframe facts, but not `EncodedAudioChunk` payload
  host objects.
- Live `demux().packets()` must remain available for remux and mux paths that need native frame bytes.
- The eager kernel and default first-operation bundles must remain within budget after adding the scanner.

## Decision

Move the lightweight FLAC STREAMINFO parser and validated frame-header scanner into `flac-sniff.ts`, and use
it from both the lazy default FLAC proxy and the full FLAC driver. The lazy proxy now implements
metadata-only `probe()` and payload-free `packetInfo()`. `packetInfo()` reads the full source once when size
is known, validates frame boundaries, and returns `PacketInfoMetadata` rows without constructing
`EncodedAudioChunk`s.

The browser harness adapter routes MP4/MOV/FLAC golden-packet rows through `engine.packetInfo(src, {
container })`, which lets known-container fixtures skip the generic sniff read while preserving the same
driver implementation. The separate `packetInfoContainer()` method prototype was rejected because it pushed
the eager kernel below the required budget guard band.

The scanner still validates each candidate header, but the next-sync search uses `Uint8Array.indexOf(0xff,
from)` instead of a JavaScript byte-by-byte loop. That keeps correctness anchored in header validation while
letting the browser's native search skip compressed payload bytes.

## Validation

- `bun test src/drivers/flac/flac.test.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- focused Chromium aibrush probe/demux rows:
  - `probe/flac_seektable`
  - `probe/flac_noseektable`
  - `demux/flac_seektable`
  - `demux/flac_noseektable`
  - `demux/metamorphic_flac_seektable_invariance`
- focused Chromium rival refreshes:
  - remotion-media-parser for FLAC probe rows
  - mediabunny for seektable demux rows
  - ffmpeg.wasm for no-seektable demux

Root tests assert generic `packetInfo()` matches decoder-backed frame spans, known-container
`packetInfo({ container:'flac' })` skips the routing sniff read, live payload streams stay browser-gated,
and frame enumeration remains byte-exact across the real FLAC corpus.

## Benchmark

Fresh Chromium 149 focused runs, `n=9` after three warmups for aibrush-media:

| Scenario | Engine | Status | Median wall | Samples |
| --- | --- | --- | ---: | --- |
| `probe/flac_seektable` | aibrush-media | PASS | 5.270 ms | 3.950, 5.420, 4.165, 4.395, 5.270, 7.300, 5.510, 7.530, 3.730 ms |
| `probe/flac_seektable` | remotion-media-parser | PASS | 6.525 ms | 6.525, 7.795, 8.765, 5.410, 6.115, 5.775, 8.120, 6.060, 7.255 ms |
| `probe/flac_noseektable` | aibrush-media | PASS | 4.055 ms | 2.955, 4.760, 2.965, 5.535, 4.055, 3.795, 3.650, 5.505, 4.620 ms |
| `probe/flac_noseektable` | remotion-media-parser | PASS | 6.010 ms | 6.010, 4.960, 5.540, 6.670, 5.920, 8.035, 6.495, 6.680, 4.725 ms |
| `demux/flac_seektable` | aibrush-media | PASS | 5.230 ms | 5.890, 5.550, 4.055, 3.750, 6.015, 2.155, 4.755, 6.185, 5.230 ms |
| `demux/flac_seektable` | mediabunny | PASS | 6.435 ms | 8.535, 7.480, 6.335, 6.435, 7.660, 4.590, 3.165, 6.235, 7.580 ms |
| `demux/flac_noseektable` | aibrush-media | PASS | 4.645 ms | 5.010, 4.645, 9.915, 6.475, 4.600, 4.315, 2.300, 4.090, 9.375 ms |
| `demux/flac_noseektable` | ffmpeg.wasm | PASS | 11.520 ms | 11.520, 10.850, 12.350, 9.370, 7.330, 12.500, 13.550, 8.060, 12.515 ms |
| `demux/metamorphic_flac_seektable_invariance` | aibrush-media | PASS | 4.785 ms | 4.435, 4.615, 6.710, 4.785, 6.100, 2.460, 5.995, 5.860, 4.275 ms |
| `demux/metamorphic_flac_seektable_invariance` | mediabunny | PASS | 6.995 ms | 6.070, 8.370, 6.915, 8.265, 5.860, 2.965, 10.070, 6.995, 9.860 ms |

Regenerating `docs/perf/performance-deficits.md` with these overlays reports 305 active deficits overall
(`0/6/86/213` by severity) and moves the top backlog row to `mux/flac_to_mkv_audio`.
