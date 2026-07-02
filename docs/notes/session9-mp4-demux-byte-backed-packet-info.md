# Session 9: MP4 Demux Byte-Backed Packet Info

## Goal

Close the size-ladder MP4 demux deficits without changing the `golden-packets` oracle. The target rows are
`demux/size_tiny_tiny_h264_360p_2s` and `demux/size_micro_micro_h264_1frame`.

## Finding

Fresh Chromium timing showed the stored severe losses had shrunk but were still real. Before the change,
`demux/size_tiny_tiny_h264_360p_2s` measured aibrush-media at 6.710 ms versus mp4box at 3.860 ms, with all
engines passing `golden-packets`. The adapter already used `engine.packetInfo()` for MP4/MOV, so the row was
not paying for live packet payload streams. The remaining overhead was URL source construction, generic
engine packet-info routing, and range setup on tiny files where the manifest already proves the source is
small.

ADR-126 had already added the package core helper `mp4PacketInfoFromBytes(bytes)`, which asks the MP4 driver
for validated packet-info rows from an owned byte buffer. Reusing that helper in the harness keeps the same
parser/oracle contract and removes the URL-backed wrapper work for bounded tiny inputs.

## Design

For clean MP4/MOV demux inputs with manifest `sizeBytes <= 16 MiB`, the aibrush browser adapter now fetches
the fixture bytes once in the measured iteration and calls `/core` `mp4PacketInfoFromBytes(bytes)` directly.
The returned table is shaped through the same `demuxResultFromPacketInfo()` helper as the URL-backed
`engine.packetInfo()` fallback, so metadata and packet rows are identical at the harness boundary.

The path is intentionally bounded and conservative:

- Mutated robustness inputs skip it.
- Unknown-size and oversized inputs skip it.
- Empty packet-info results fall back to the existing demux path.
- Large MP4 rows keep the seekable packet-info/index route instead of regressing into whole-file reads.
- No fixture bytes or packet tables are cached across iterations.

## Validation

- Existing package real-fixture coverage for `mp4PacketInfoFromBytes()` remains the parser guard.
- Sibling harness checks:
  - `bunx biome check src/engines/aibrush-media/adapter.ts`
  - `bunx tsc -p tsconfig.json --noEmit`

## Fresh Proof

Fresh Chromium all-engine runs:

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T22-54-55-024Z.json`

| Scenario | Engine | Status | Median wall | Samples | Oracle |
|----------|--------|--------|------------:|--------:|--------|
| `demux/size_tiny_tiny_h264_360p_2s` | aibrush-media@dev | PASS | 4.415 ms | 9 | golden-packets:PASS |
| `demux/size_tiny_tiny_h264_360p_2s` | mp4box@2.3.0 | PASS | 5.300 ms | 9 | golden-packets:PASS |
| `demux/size_tiny_tiny_h264_360p_2s` | mediabunny@1.48.0 | PASS | 5.465 ms | 9 | golden-packets:PASS |

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T22-57-30-746Z.json`

| Scenario | Engine | Status | Median wall | Samples | Oracle |
|----------|--------|--------|------------:|--------:|--------|
| `demux/size_micro_micro_h264_1frame` | aibrush-media@dev | PASS | 3.460 ms | 9 | golden-packets:PASS |
| `demux/size_micro_micro_h264_1frame` | mp4box@2.3.0 | PASS | 4.165 ms | 9 | golden-packets:PASS |
| `demux/size_micro_micro_h264_1frame` | mediabunny@1.48.0 | PASS | 4.795 ms | 9 | golden-packets:PASS |

Regenerating `docs/perf/performance-deficits.md` reports 300 active deficits (`0/1/86/213`), down from 302,
with both MP4 demux rows removed.
