# Session 9 Note - Realworld MP4 Demux Packet Info

## Goal

Fold `demux/realworld_mdn_flower_mp4` with a fresh Chromium multi-sample run, preserving the
`golden-packets` oracle and the existing payload-free MP4 packet-table semantics.

## Design Note

This row closed through the existing Session 9 MP4 packet-info work rather than a new code technique. The
correct fast path is to walk validated MP4 sample tables and emit packet metadata: native byte
offset/size, track id, PTS/DTS, duration, and keyframe status. The browser adapter already routes ordinary
MP4 demux rows through the engine-owned packet-info contract, so no packet payloads, decoder setup, or
WebCodecs wrappers are needed when the oracle only checks packet facts.

The fresh result proves the row was stale in the living backlog. The current bundle still performs the
same validated work and matches the same oracle, but its median is at or below the fastest rival's stored
passing median.

## Validation

- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario demux/realworld_mdn_flower_mp4 --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-07-02-183Z.json`

`demux/realworld_mdn_flower_mp4`:

- aibrush-media: PASS `golden-packets`, median **7.050 ms**, n=9
- mp4box: PASS `golden-packets`, rounded backlog median **7.1 ms**
- oracle detail: **387 packets**, 2 compared tracks, `maxPtsDriftUs=0`

Regenerated backlog: `272 active deficits (0/0/51/221), 1 exempt`.
