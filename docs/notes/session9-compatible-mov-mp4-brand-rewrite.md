# Session 9 - Compatible MOV-to-MP4 Brand Rewrite

## Goal

Close `remux/huge_h264_1080p_600s_mov_to_mp4` on Chromium speed without changing the remux contract,
weakening `reference-reimport`, or adding a new feature. The cell is done only when aibrush-media's fresh
n>=5 median wall time is <= the fastest passing rival on the same workload and the output re-imports with
the same packet/timeline facts.

## Approach

The losing path was correct but overworked this source. The file is a faststart QuickTime-branded
ISO-BMFF layout: `ftyp` starts at byte 0, `moov` immediately follows it, tracks use MP4-compatible H.264/AAC
sample entries, and every `mdat` reference remains valid if the fixed-size brand box is rewritten in place.
The old stream-copy writer still reauthored a full MP4 layout and copied the payload through the generic
sample path.

The fix adds a narrow branch inside `Mp4Driver.streamCopy()`:

- It applies only to full, untrimmed, non-fragmented, buffered MOV->MP4 remux with default/non-false
  faststart and no tags, stream target, track selection, or encryption.
- It requires source major brand `qt  `, top-level `ftyp` followed immediately by `moov`, known source size,
  complete static sample tables, video sample entries `avc1`/`avc3` with `avcC`, and audio sample entries
  `mp4a` with `esds`.
- It validates every referenced sample byte range directly from `stsc`, `stsz`, and `stco`/`co64`, avoiding
  full packet/timing row allocation while preserving the same in-bounds safety property.
- It reads the source once, changes only fixed-size `ftyp` fields to MP4-compatible branding, and returns the
  bytes through the ordinary one-shot materializer.
- It falls through to the existing stream-copy writer or typed capability path for every unsupported shape.

Rejected alternatives were per-asset allowlists, returning the input unchanged, arbitrary `ftyp` flipping,
skipping sample-range validation, applying the branch to mdat-before-moov/fragmented/encrypted/tagged/trimmed
sources, weakening the oracle, or copying competitor source.

## Edge Cases

- **B-frames and open GOP:** `stts`/`ctts`, keyframe tables, and coded packets are untouched.
- **VFR:** timing tables are preserved byte-for-byte; no duration averaging or packet rescheduling is added.
- **Seek:** not part of the remux operation; the output keeps the same sample offsets and timeline metadata.
- **Cancel and backpressure:** the output still flows through the existing one-shot materializer and abort
  signal handling; stream-target outputs stay on the ordinary writer.
- **Frame lifetime:** no `VideoFrame` or `AudioData` objects are created.
- **Malformed or non-compatible MOV:** missing `avcC`/`esds`, encrypted tracks, incomplete sample tables,
  unknown sizes, mdat-before-moov layouts, tags, trims, selected tracks, stream targets, or fragmentation do
  not enter the rewrite branch.

## Validation

Focused Node validation:

```bash
bun test src/drivers/mp4/ops.test.ts src/drivers/mp4/roundtrip.test.ts src/drivers/mp4/mp4.test.ts
```

Result: 71 pass.

The new regression test synthesizes a QuickTime-branded but MP4-compatible MOV from the real `movie_5.mp4`
fixture, remuxes through the public API, and asserts:

- output major brand becomes `isom`;
- first compatible brand becomes `mp42`;
- output length matches input length;
- every byte after `ftyp` is identical to the input;
- reparsed track and sample-table shapes still match.

Additional checks:

```bash
bunx biome check src/drivers/mp4/mp4-driver.ts src/drivers/mp4/ops.test.ts
bun run build
bun run vendor-wasm
```

All passed before the fresh browser proof.

## Benchmark

Fresh Chromium n=5 run:

```bash
bash scripts/run.sh --browser chromium --engine aibrush-media@dev,remotion-webcodecs --scenario remux/huge_h264_1080p_600s_mov_to_mp4 --iters 5 --warmup 0 --no-reuse --timeout-ms 600000
```

Raw result:

- `results/raw/chromium-2026-07-04T10-06-00-532Z.json`
- aibrush-media: PASS, wall median **492.050 ms**, samples
  `[490.885, 516.855, 489.740, 507.595, 492.050]`
- remotion-webcodecs: PASS, wall median **500.220 ms**, samples
  `[500.220, 510.100, 493.750, 507.430, 487.115]`
- Oracles: `reference-reimport` PASS with 46,126 packets, 28,426 keyframes, 2 media tracks, and
  `durationDeltaSec=0`.

Deficit regeneration:

```bash
node docs/perf/gen-deficits.mjs docs/perf/stored-test-data-chromium-2026-07-01T08-33-45-588Z.json $(find ../media-test/media-browser-test/results/raw -maxdepth 1 -name 'chromium-*.json' -print | sort)
```

Result: `191 active deficits (0/0/9/182), 1 exempt`; `remux/huge_h264_1080p_600s_mov_to_mp4` is removed.
