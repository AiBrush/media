# Session 9 - HLS First-Segment Probe

## Goal

Close `probe/hls_vod` on Chromium without changing the HLS fixture, using `<video>`, weakening the
`golden-metadata` oracle, or pretending playlist text alone contains codec and track facts.

## Observation

The old browser path paid whole-source HLS costs for a metadata-only question. A VOD media playlist already
contains the total presentation duration as the sum of `#EXTINF` segment durations, while the first MPEG-TS
segment contains the real PAT/PMT and first PES headers needed to identify H.264/AAC tracks, dimensions,
sample rate, and channel count. Fetching and stitching every segment is therefore the wrong cost shape for
`probe()`.

The competitor technique to reuse is bounded metadata work: treat the playlist as the index and use one real
segment probe for stream shape. The implementation remains ours: the adapter calls the engine's existing
known-container TS probe path for segment metadata and returns a newly assembled HLS `MediaInfo`.

## Design

For clean known HLS VOD probe inputs, the browser adapter now:

- reads only the playlist bytes;
- parses `#EXTINF` durations and finds the first media segment URI;
- resolves the segment URI relative to the playlist URL;
- fetches only that first segment;
- calls `engine.probeContainer(segment, 'ts')` to get real MPEG-TS track facts;
- returns `container:'hls'`, playlist-derived duration, and segment-derived tracks.

Master playlists, playlists without media segment URIs, malformed playlists, encrypted/unsupported segment
shapes, mutated robustness inputs, and aborts keep the established generic or typed-error paths. No parsed
playlist, segment metadata, oracle answer, or output bytes are cached across measured calls.

## Validation

- Sibling adapter typecheck passed after the HLS probe edit.
- Fresh browser benchmark:
  `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media,mediabunny --scenario probe/hls_vod --warmup 3 --iters 5 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-05T17-13-22-684Z.json`

`probe/hls_vod`:

- aibrush-media: PASS `golden-metadata`, median **8.855 ms**, samples
  `[5.895, 8.855, 14.290, 13.420, 8.830]`
- mediabunny: PASS `golden-metadata`, median **27.255 ms**, samples
  `[23.060, 24.685, 27.255, 30.845, 28.320]`

The living `docs/perf/performance-deficits.md` file still lists this row until the next allowed
`gen-deficits.mjs` run includes the fresh export.
