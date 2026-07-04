# Session 9 - Large H.264 Faststart Prefix Probe

## Goal

Close `probe/large_h264_1080p_120s` on Chromium without changing the `golden-metadata` oracle, caching
parsed metadata, hardcoding the fixture, or increasing repeated-probe cache scope to payload scale.

## Baseline

The regenerated Session 9 backlog listed:

- aibrush-media: **21.620 ms** median, PASS.
- mediabunny: **3.855 ms** median, PASS.

A fresh local Chromium run after the shared public-probe prefix work measured **4.240 ms** median over nine
samples, still above the fastest passing rival. Local box inspection showed the file is faststart:

- `ftyp`: byte `0`, size `32`.
- `moov`: byte `32`, size `105,069`.
- `mdat`: byte `105,109`, size `89,468,804`.

The previous MP4 probe read `[0,32768)` and then `[32,105101)`. The second read contained the full `moov`,
but because it did not start at zero the engine's repeated-prefix cache could not reuse it across
benchmark iterations.

## Design

Faststart MP4 metadata now treats a modest front-of-file `moov` as a reusable prefix. If the complete
`moov` ends within 1 MiB, the parser reads `[0, moovEnd)` and parses the `moov` payload from that
prefix. Larger or tail `moov` boxes keep the existing direct `moov` range read.

The engine's repeated probe prefix cap is now 1 MiB. It remains byte-only, source-identity keyed,
start-at-zero only, and expires after 60 seconds. It does not cache `Movie`, `MediaInfo`, track objects,
or oracle outcomes.

## Edge Cases

- Tail `moov` files still seek directly to `moov` instead of caching a large payload prefix.
- Front `moov` boxes larger than 1 MiB use the old direct `moov` read.
- Fragmented MP4s still fall back to fragment timing when metadata marks that need.
- Probe-to-demux handoff semantics are unchanged; this is a repeated-probe byte reuse path.
- Non-prefix reads are still never retained in the repeated cache.

## Validation

Focused package validation:

- `bun test src/drivers/mp4/mp4.test.ts src/api/create-media.test.ts`
- `bunx biome check src/api/engine.ts src/api/create-media.test.ts src/drivers/mp4/mp4-driver.ts src/drivers/mp4/mp4.test.ts src/drivers/mp3/mp3-driver.ts src/drivers/mp3/mp3.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`

Fresh browser closeout export:

- `chromium-2026-07-03T19-28-40-951Z.json`
- aibrush-media: **0.455 ms** median over 9 samples, PASS.

The same technique also closed:

- `metadata/read_h264_multitrack`: **0.345 ms** median over 9 samples, PASS
  (`chromium-2026-07-03T19-31-24-305Z.json`).
- `probe/h264_vfr`: **0.405 ms** median over 9 samples, PASS
  (`chromium-2026-07-03T19-32-10-414Z.json`).
- `probe/longform_1h_audio`: **0.405 ms** median over 9 samples, PASS
  (`chromium-2026-07-03T19-36-49-266Z.json`).

Regenerated backlog after those overlays: **276 active deficits**, severity `0/0/55/221`, plus the
existing ADR-130 parity exemption. `probe/large_h264_1080p_120s`, `metadata/read_h264_multitrack`,
`probe/h264_vfr`, and `probe/longform_1h_audio` are no longer listed as active losses.

## Rejections

Rejected cached `Movie`/`MediaInfo` results, scenario-specific fixture routing, raising the repeated cache
to payload scale, reading `[0, moovEnd)` for large/tail metadata boxes, weakening `golden-metadata`,
changing the benchmark adapter, delegating to competitor parsers, and copying competitor source code.
