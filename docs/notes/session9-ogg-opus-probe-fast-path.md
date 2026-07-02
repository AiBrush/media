# Session 9: Ogg Opus Probe Fast Path

## Goal

Close the `probe/opus` Chromium speed deficit without changing the `golden-metadata` oracle. The row uses
the 145,910 byte `opus.ogg` fixture and requires the engine to report the correct 10.007 second Opus
duration from the Ogg final granule position.

## Finding

The first focused fresh run showed a correctness regression: aibrush-media reported about 4 seconds because
the browser harness dropped manifest `sizeBytes` when it created URL-backed engine sources. Without known
size, the Ogg driver could not range-read the tail page and only saw the head granules.

After preserving `sizeBytes` and routing clean Ogg fixtures through the engine's known-container probe path,
the row passed but still lost: aibrush-media median 9.665 ms versus mediabunny 4.980 ms. The remaining
overhead was caused by Ogg lacking a `ContainerDriver.probe()` hook. `probeContainer()` therefore fell back
to `demux()`, and `demux()` eagerly read packet payload state and codec-private data that metadata probe
does not consume. For this small local fixture, two timed range requests for head+tail were also slower than
one bounded full-source read.

## Design

Add `OggDriver.probe(src)`, returning `TrackInfo[]` from `parseOgg()` without constructing a demux session or
packet stream. Keep `demux()` unchanged for callers that need packet payloads.

For seekable sources with known `size <= 256 KiB`, read `[0, size)` once and skip the tail range because the
metadata window already covers the whole file. For larger Ogg files, keep the existing `64 KiB` head plus
`64 KiB` tail range strategy so probe cost remains independent of media duration.

At the harness boundary, preserve manifest `sizeBytes` only for unmutated URL fixtures and add Ogg to the
clean known-container probe route. Mutated robustness inputs still become byte sources and never trust the
manifest.

## Validation

- `fromURL(..., { size })` exposes the caller-provided size without a network size probe.
- `OggDriver.probe()` on a synthetic 70 KiB known-size Ogg source performs exactly one `[0, size)` range read
  and derives duration from the last page.
- Focused package checks:
  - `bunx biome check src/drivers/ogg/ogg-driver.ts src/drivers/ogg/ogg.test.ts src/sources/source.test.ts`
  - `bun run test -- src/drivers/ogg/ogg.test.ts src/sources/source.test.ts`
  - `bun run typecheck`
  - `bun run build`
  - `bun run vendor-wasm`
  - `bun run check-budgets`
- Focused sibling harness checks:
  - `bunx biome check src/engines/aibrush-media/adapter.ts`
  - `bunx tsc -p tsconfig.json --noEmit`

## Fresh Proof

Fresh Chromium all-engine run:

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T22-47-08-147Z.json`

| Engine | Status | Median wall | Samples | Oracle |
|--------|--------|------------:|--------:|--------|
| aibrush-media@dev | PASS | 2.320 ms | 9 | golden-metadata:PASS |
| mediabunny@1.48.0 | PASS | 3.690 ms | 9 | golden-metadata:PASS |
| ffmpeg.wasm@0.12.15 | PASS | 6.785 ms | 9 | golden-metadata:PASS |

Regenerating `docs/perf/performance-deficits.md` with the fresh export reports 302 active deficits
(`0/3/86/213`), down from 303, with `probe/opus` removed.
