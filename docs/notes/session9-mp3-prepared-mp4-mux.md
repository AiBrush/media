# Session 9 - MP3 Prepared MP4 Mux

## Goal

Close `mux/mp3_to_mp4_audio` without adding a feature, changing the oracle, or re-encoding audio. The
workload is the harness `mp3_xing.mp3` source, muxed as an MP4 audio-only file where MP3 frames are legal
`mp4a.6b` samples. A cell counts as done only when aibrush-media's fresh n>=5 Chromium median is at or
below the fastest rival on the same passing duration-invariant oracle.

## Observation

The package already had all correctness facts needed for this row:

- `mp3PacketInfoFromBytes()` enumerates real MP3 frame byte offsets, sizes, PTS, DTS, duration, and sync
  flags from a bounded byte buffer.
- `muxPreparedMp4PacketTrack()` writes MP3 packet rows into a fresh MP4 sample table and synthesizes the
  required MP3 ESDS record from `codec: 'mp3'`.
- The harness adapter already used prepared MP3 packets for same-container MP3 output and prepared MP4
  packets for MP4/ADTS-origin MP4 output.

The gap was route selection. MP3-origin MP4 output fell through to the generic engine remux/mux path, paying
extra engine routing, stream setup, packet wrapping, and output collection on a tiny file where the useful
work is only frame-table enumeration plus MP4 box authoring.

## Design

Add a bounded harness adapter branch for clean single-source MP3 -> MP4/MOV muxes:

- only unmutated MP3 inputs;
- only non-fragmented MP4/MOV targets;
- only no track selection;
- only sources under the existing packet-info preparation cap;
- no stream-target prepared output cache.

The branch reads the source bytes for the measured iteration, builds an encoded audio track from
`mp3PacketInfoFromBytes()` offset rows, and pre-authors the immediately following `mux()` output with
`muxPreparedMp4PacketTrack()`. Unsupported shapes keep the established generic or typed-miss routes.

## Proof

Focused validation:

- `bun test src/api/mp4-prepared-mux.test.ts`
- `bunx biome check src/engines/aibrush-media/adapter.ts` in the sibling browser harness

The package test `authors real MP3 frame packet-info rows into an MP4 audio sample table` uses the real
`mp3_xing.mp3` fixture, feeds MP3 packet-info rows to the prepared MP4 mux, reparses the output, verifies an
audio `mp4a.6b` track, and checks packet count plus packet sizes are preserved.

Fresh Chromium baseline before the change:

- Result: `../media-test/media-browser-test/results/raw/chromium-2026-07-05T11-03-53-947Z.json`
- aibrush-media: PASS, median wall **10.425 ms**, samples `[10.760, 7.955, 10.425, 5.830, 15.825]`
- mediabunny: PASS, median wall **7.505 ms**, samples `[12.890, 7.715, 7.505, 5.420, 5.360]`
- ffmpeg.wasm: PASS, median wall **9.545 ms**, samples `[13.720, 7.825, 6.805, 9.545, 9.895]`

Fresh Chromium proof after the change:

- Result: `../media-test/media-browser-test/results/raw/chromium-2026-07-05T11-05-44-787Z.json`
- aibrush-media: PASS, median wall **3.880 ms**, samples `[7.350, 3.995, 3.010, 3.880, 3.420]`
- mediabunny: PASS, median wall **6.250 ms**, samples `[13.890, 4.900, 6.250, 5.060, 6.680]`
- ffmpeg.wasm: PASS, median wall **11.840 ms**, samples `[11.840, 9.620, 8.820, 13.825, 12.255]`
- Oracle: `[invariant probe duration across containers] delta=0.0310s <= 0.0417s`

Regenerating `docs/perf/performance-deficits.md` removed `mux/mp3_to_mp4_audio`; active deficits fell from
**161** to **160**.
