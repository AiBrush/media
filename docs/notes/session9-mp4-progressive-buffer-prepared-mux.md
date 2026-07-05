# Session 9 Note - MP4 Progressive Buffer Prepared Mux

## Goal

Close `mux/mp4_progressive_buffer` on Chromium without adding a new feature, changing the source asset,
changing the `fastStart:false` output layout, weakening `reference-reimport`, `property-invariant`, or
`mp4-box-layout`, or returning the source MP4 as a fake mux result. The workload is a two-track MP4 source
packed into a progressive MP4 buffer with `mdat` before `moov`.

## What Was Slow

A fresh pre-fix Chromium n=5 run measured:

- aibrush-media: 101.775 ms median, samples `[101.935, 103.135, 101.775, 100.595, 92.525]`, PASS
- mediabunny: 64.255 ms median, samples `[64.255, 65.965, 54.960, 70.600, 53.770]`, PASS
- Both engines passed `reference-reimport` with 2308 packets and 1423 keyframes.
- Both engines passed `property-invariant` with `outDurationSec=30.021333333333335`,
  `durationDeltaSec=0.021333333333334537`, and tolerance `0.041666666666666664`.
- Both engines passed `mp4-box-layout` with `fastStart:false`; aibrush produced
  `ftyp@0, mdat@32, moov@31231509`, while mediabunny produced `ftyp@0, mdat@28, moov@31231513`.

The adapter had already paid the cost to parse the MP4 packet table and construct real bounded
`EncodedTrack` arrays for the mux contract. It then had prepared fast paths for single-track MP4 buffer
muxes and multi-track MP4 stream-target muxes, but not for the exact two-track buffer case. That left the
cell able to fall back to a generic source remux shell after the useful packet data was already available.

## Technique

The browser adapter now exposes the existing `/core` `muxPreparedMp4PacketTracks()` helper in its local type
surface. In `prepareMuxTracks()`, a clean single MP4 source targeting MP4/MOV prepares whole-buffer output
bytes when the request has no track selector, is not fragmented, and is not a stream target. The adapter
uses the same track-info and packet-array conversion helpers as the ordinary mux path, so codec-private
data, DTS/PTS, durations, keyframes, and packet bytes come from the genuine demuxed source tracks.

The paired `mux()` consumes that prepared output once when the recorded input and target match and the
request shape is still legal. The prepared bytes are created inside the timed operation, not reused across
iterations, and the adapter clears the state before dispatching each mux call. This removes duplicate
operation overhead without weakening the work: the first-party MP4 writer still authors fresh `ftyp`,
`mdat`, and `moov` bytes from the same sample tables.

## Edge Cases

- Track selectors stay on the ordinary mux route so a multi-track prepared all-track output cannot answer a
  selected-track request.
- Fragmented output stays on the fragmented muxer path.
- Stream targets continue to use `muxPreparedMp4PacketTracksStream()` and `writeToStreamTarget()`.
- Multi-source assembly remains a packet-seam mux over the recorded sources, not a single-source prepared
  shortcut.
- Empty or under-described tracks skip the prepared route and keep the existing typed error behavior.
- Unsupported codec/container pairs still fail inside the ordinary mux legality checks or the MP4 writer;
  the adapter does not author sample entries itself.

## Proof

Harness validation:

```bash
bun run typecheck
bunx biome check src/engines/aibrush-media/adapter.ts
bash scripts/run.sh --browser chromium \
  --engine aibrush-media,mediabunny \
  --scenario mux/mp4_progressive_buffer \
  --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Fresh result:
`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T23-25-24-723Z.json`.

- aibrush-media: 45.605 ms median, samples
  `[59.330, 43.940, 57.410, 45.040, 45.605]`, PASS
- mediabunny: 54.920 ms median, samples
  `[70.175, 52.775, 54.920, 64.725, 53.865]`, PASS
- Both engines passed `reference-reimport`, `property-invariant`, and `mp4-box-layout`.
- aibrush output remained progressive: `ftyp@0, mdat@32, moov@31231509`.
