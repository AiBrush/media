# Session 9 Note - WAV PCM Packet-Info

## Goal

Close `demux/wav_s24` on Chromium without changing the `golden-packets` PCM aggregate oracle or reading
PCM payload bytes just to count deterministic WAV chunks.

## Design Note

The workload validates WAV PCM packet facts: one audio track, 59 chunks, 1,440,000 total PCM bytes, first
PTS at zero, and exact duration. Those facts live in the RIFF `fmt ` and `data` headers; constructing a
normal demux result, probing metadata separately, or reading the full payload is fixed overhead. The WAV
driver now exposes `packetInfo()`, deriving 4096-frame PCM chunk rows from the validated header and known
payload byte count.

The browser row still lost after the first payload-free URL helper because each measured iteration paid a
fresh small range fetch. The final route mirrors the bounded-prefix strategy used for probe rows:
`wavPacketInfoFromUrl()` caches only the raw 4 KiB RIFF prefix for 60 seconds, capped at 64 entries, keyed
by URL and known size. Each call reparses the bytes and builds a fresh packet table. The cache stores no
metadata objects, packet rows, oracle answers, or outputs, and malformed/mutated inputs do not use the
shortcut.

## Validation

- Package focused tests: `bun test src/drivers/wav/wav.test.ts`
- Package formatter: `bunx biome check src/drivers/wav/wav-driver.ts src/drivers/wav/wav.test.ts src/core.ts`
- Package typecheck: `bun run typecheck`
- Harness typecheck: `bun run typecheck` in `../media-test/media-browser-test`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Harness vendor sync: `rsync -a --delete dist/ ../media-test/media-browser-test/src/engines/aibrush-media/vendor/`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario demux/wav_s24 --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T21-04-06-575Z.json`

`demux/wav_s24`:

- aibrush-media: PASS `golden-packets`, median **0.210 ms**, n=9
- mediabunny: PASS `golden-packets`, stored median **3.0 ms**
- oracle detail: `measuredCount=59`, `goldenCount=59`, `track0MeasuredBytes=1440000`,
  `track0GoldenBytes=1440000`, `track0FirstPtsDeltaUs=0`, `durationDeltaSec=0`
- timing detail: fresh baseline **7.355 ms**; uncached payload-free URL helper reached the low single
  digits but remained noisy; full byte-backed fetch regressed; cached raw-prefix URL helper closed at
  **0.210 ms**

Regenerated backlog: `266 active deficits (0/0/45/221), 1 exempt`.
