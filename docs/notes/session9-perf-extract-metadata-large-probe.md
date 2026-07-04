# Session 9 Note - Large Metadata Probe Fold

## Goal

Fold `probe/perf-extract-metadata-large` with a fresh Chromium multi-sample run while preserving the
`golden-metadata` oracle.

## Design Note

This row closed through the existing Session 9 MP4 faststart and repeated-prefix probe work. The benchmark
asks for metadata repeatedly on a large-but-faststart MP4 shape. The correct fast path is to read only the
bounded metadata prefix containing `ftyp`/`moov`, reuse source-prefix bytes across repeated probes by
source identity, and return parsed track metadata without materializing packet streams or payload bytes.

The fresh result proves the stale backlog row is no longer a loss. No new code technique was needed for
this specific fold.

## Validation

- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario probe/perf-extract-metadata-large --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-16-07-469Z.json`

`probe/perf-extract-metadata-large`:

- aibrush-media: PASS `golden-metadata`, median **0.405 ms**, n=9
- mediabunny: PASS `golden-metadata`, rounded backlog median **3.6 ms**
- oracle detail: 2 tracks, duration delta **0.021333 s** <= **0.041667 s** tolerance

Regenerated backlog: `270 active deficits (0/0/49/221), 1 exempt`.
