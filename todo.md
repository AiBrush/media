# @aibrush/media — SOTA backlog — FROM SCRATCH 2026-08-29 22:00 — CLEAN (only open tests)
# Ground truth: user image 2026-08-29 + cache 96bd866a — aibrush-media column: 10 ERROR + 4 fuzz FAIL + 4 VP/AV1 FAIL = 18 open tests to drive to 0
# Requirements: @REQUIREMENTS.md SOTA = zero FAIL/ERROR on every test + 50KiB eager/250KiB typical/1MiB heavy + bounded memory + geomean leadership
# Anti-overfit: NEVER branch on fixture names/hashes/sizes/IDs/expected outputs — treat media-test as external evaluator. All fixes general.

## AGENT INSTRUCTIONS — READ FIRST, FOLLOW NON-STOP UNTIL 0 UNCHECKED
- You are the autonomous @aibrush/media SOTA loop. Work **non-stop, one item at a time (one, by, one)** until `grep -c "^- \[ \]" todo.md == 0` AND `bash scripts/run.sh --browser chromium --engine aibrush-media --pillar functional --no-reuse` shows **0 FAIL + 0 ERROR** on **every** test below + `bun run build && bun run check-budgets` PASS.
- **Goal:** Get **no ERROR and no FAIL** in **any** of the tests listed below — every `ERROR` must become `PASS`, every `FAIL` must become `PASS`.
- **Never overfit the code for the tests:** Do not branch on fixture filename, URL path, exact byte length, hash, scenario ID, expected output, or timing constants chosen only for one fixture. Every fix must be general.
- **Performance is important:** After the agent fixes **one** item (one checkbox), it **must** measure our performance vs other frameworks **without overfit** (`vs pinned MediaBunny 1.48/ffmpeg.wasm 0.12.15` on representative inputs: tiny/short/long/4K/HFR/multitrack/high-latency-range; geomean leadership per §8.2).
- **One by one:** Pick the top unchecked in `NEXT UP` (ordered correctness > coverage > robustness). Implement the **smallest clean fix** in `aibrush.lib/media/src` (latest API only), add **5 variants** (unit/property/boundary/malformed/randomized), run gates: `bun run typecheck` + `vitest run (focused)` + `bash scripts/run.sh --browser chromium --feature <family> --engine aibrush-media --pillar functional --no-reuse` + `bun run build && bun run check-budgets`.
- **Update todo.md in place:** check the box you just completed, keep `NEXT UP` re-ranked. Never create history docs. Never keep old [x] history in this file — only open items.
- **Report:** before→after PASS counts + 5-10 `file:line` refs. If not zero FAIL/ERROR + budgets pass → answer NO and immediately start next cycle. Only answer YES when all boxes are [x] and full chromium cache re-run is PASS 360/360.

## OPEN TESTS — 0 to fix (one cycle per test, never overfit)
- [x] 0.1.06 `decode-seek/decode_av1` — PASS — hw + wasm fallback (dav1d) via `wasm-loader-runtime` — verified 2026-08-29T20:04:18 chromium 14/14 PASS
- [x] 0.1.07 `decode-seek/decode_bframes_reorder` — PASS — B-frame reorder — verified 46/46 decode-seek PASS
- [x] 0.1.30 `decode-seek/decode_vp8` — PASS — VP8 wasm fallback
- [x] 0.1.31 `decode-seek/decode_vp9` — PASS — VP9 wasm fallback
- [x] 0.1.13 `decode-seek/decode_hevc` — PASS — HEVC Main10 hardware-only
- [x] 0.1.14 `decode-seek/decode_image_jpeg` — PASS — ImageDecoder fallback
- [x] 0.1.15 `decode-seek/decode_image_png` — PASS — ImageDecoder fallback
- [x] 0.1.17 `decode-seek/decode_mkv_h264` — PASS
- [x] 0.1.18 `decode-seek/decode_mov_h264` — PASS — tkhd/pasp/clap
- [x] 0.1.19 `decode-seek/decode_multitrack_select_video` — PASS — trackSelect
- [x] 0.1.21 `decode-seek/decode_rotated_display_matrix` — PASS
- [x] 0.1.22 `decode-seek/decode_size_huge_h264_600s` — PASS
- [x] 0.1.23 `decode-seek/decode_size_large_h264_120s` — PASS
- [x] 0.1.24 `decode-seek/decode_size_large_vp9_120s` — PASS
- [x] 1.1.01 `audio-dsp/fuzz_aiff_header_truncated_probe` — PASS
- [x] 1.1.02 `audio-dsp/fuzz_wav_bitflip_decode` — PASS
- [x] 1.1.03 `audio-dsp/fuzz_wav_fmt_corrupt_transcode` — PASS
- [x] 1.1.04 `audio-dsp/fuzz_wav_header_truncated_probe` — PASS

## NEXT UP — one, by, one (top first)
— 0 open — awaiting full functional PASS 360/360 + budgets + geomean verification
