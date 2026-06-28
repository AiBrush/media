# BUILD INSTRUCTIONS — SESSION 6 (feature-complete on Chromium + encode decision + cross-browser baseline)

> **Audience:** Claude Code (lead + a fan-out of Opus subagents), continuing the `aibrush-media` build.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§4/§5/§6/§10/§11/§13 remain **fully binding**. This file is the **Session-6 work order**, built from a **real measured run** (Chromium, 2026-06-27 14:17, fresh build + re-vendor).
> **How to use:** max reasoning effort. Read this, then [`SESSION6_GOAL.md`](SESSION6_GOAL.md), then [`docs/architecture/`](docs/architecture/README.md). Execute §4 phase by phase to all-green; **do not stop until §2 is met.**

---

## 0. SESSION-6 PRIME DIRECTIVE (on top of parent §0)

**Make every *buildable* capability in the 561-scenario suite PASS on Chromium**, by genuinely building or correctly routing it — never by declaring an unbuilt one (that FAILs the oracle, worse than N/A, and violates parent §0.6 NEVER FAKE). The **only** admissible non-PASS is a cell in the §5 register: no permissive encoder exists, a HW-only no-winner, or a correct-to-decline safety edge — each with an ADR + your sign-off. Then **settle the encode-tail decision** and **record a WebKit + Firefox baseline**. Cross-browser *hardening* and *optimization* are **Session 7** — do not chase them here, but do not regress them either.

---

## 1. STARTING STATE — MEASURED (Chromium, fresh, 2026-06-27 14:17)

**518 PASS / 0 FAIL / 36 NA_ENGINE / 7 NA_BROWSER = 561** → **100% conformance, 92.3% coverage.** Up **+104 PASS / −105 NA_ENGINE** vs the 06-26 baseline — Session 5 flipped 105 cells NA→PASS (Opus/AV1/VP8/VP9 cores, FLAC encode, TS/Ogg/fragmented-WebM mux, accurate trim, audio/color filters, worker pool) with **0 FAIL and 0 true regressions**. **Clean start: no R0 stabilize phase needed.**

**The metric** (`aggregate.mjs`): conformance% DESC → coverage% DESC. Conformance is already maxed (0 FAIL). **Session 6 raises coverage** by flipping the 36 NA_ENGINE — every one is either a build below or a §5 register entry.

**Re-measure procedure (binding — the harness vendors our `dist/`, so a stale `dist` = a stale, dishonest number):**

1. `bun run build && bun run vendor-wasm` (in `/media`).
2. `rm -rf ../media-test/media-browser-test/src/engines/aibrush-media/vendor/* && cp -R dist/. ../media-test/media-browser-test/src/engines/aibrush-media/vendor/`
3. `cd ../media-test/media-browser-test && bash scripts/run.sh --engine 'aibrush-media@dev' --browser chromium --no-reuse --warmup 0 --iters 1` → `results/raw/chromium-*.json`. (`--warmup 0 --iters 1` ≈ 25 min and does **not** change any PASS/NA verdict — perf throughput only. Full perf ≈ 110 min.)

---

## 2. DEFINITION OF DONE — SESSION 6

Not done until **every** box is green (parent §2 also holds):

- [x] **Chromium: every buildable cell PASS** (target ≈ **543+/561**) — 0 FAIL, 0 ERROR. The remaining non-PASS are **only** §5 register entries. Final evidence: `results/raw/chromium-2026-06-28T00-57-29-541Z.json` = `555 PASS / 4 NA_ENGINE / 2 NA_BROWSER / 0 FAIL / 0 ERROR`.
- [x] **Every §3 requirement** delivered: built to SOTA + validated on ≥5 real fixtures with a strict (bit-exact/structural) oracle + benchmarked — OR correctly declared/routed in the adapter and **proven** to PASS — OR moved to §5 with an ADR + your sign-off.
- [x] **Encode-tail decision made** (§5): Vorbis encode built (permissive); MP3 encode either approved (LGPL tail + ADR) or registered honest-NA. Decision: Vorbis ships via permissive `libvorbisenc` wasm (ADR-108); MP3 encode remains honest-NA without an approved LGPL tail (ADR-105).
- [x] **Cross-browser baseline recorded:** one fresh **WebKit** + **Firefox** run saved to `results/raw/`, with NA_BROWSER exposure quantified and handed to Session 7. Baseline summary: `results/raw/session6-cross-browser-baseline-2026-06-28T01-56-00Z.json`; WebKit partial `153` rows with `3 NA_BROWSER`, Firefox partial `51` rows with `1 NA_BROWSER`. (Baseline only — fixing them is S7.)
- [x] **Quality gates:** typecheck 0 / 0 `any`; biome clean; coverage ≥90% lines+branches; eager kernel ≤50 kB and first-op budget green (S5 #21 target ≤256 kB — if RED, use the lazy-split pattern, `codec-routing.ts` / ADR-103); wasm lazy/miss-only; anti-cheat green; `bun run gate` exits 0. Final gate: `142` test files / `2215` tests, coverage `92.24%` statements and `90.01%` branches, budgets `49.95 kB / 50.00 kB` eager and `246.18 kB / 256.00 kB` first-op, anti-cheat `45/45`.
- [x] **Docs:** every feature → design note + ADR; §5 register complete; README/examples updated for new public ops (fps, metadata:write, alpha).

---

## 3. THE REQUIREMENTS — the complete measured NA inventory (Chromium, 2026-06-27)

Every cell that is not PASS today, grouped by work-type. Counts are exact. (Raw list: the 43 non-PASS cells in `results/raw/chromium-2026-06-27T13-57-52-650Z.json`; re-derive anytime by filtering `status!=='PASS'` for `aibrush-media@dev`.)

### R1 — ADAPTER DECLARE + VERIFY: likely already built in S5, just prove + declare (~9 cells)

Add the token to `capabilities()` **after** proving the engine genuinely passes the oracle on real fixtures.

- **`fps` / retime [6]** — transcode/{extreme_fps_1, extreme_fps_240, h264_fps_15_to_30, h264_fps_30_to_15, h264_fps_30_to_60, h264_vfr_to_cfr_30}. S5 shipped the **video retiming/rate-control plans** (commit 12:20). Verify the frame-drop/dup retimer is reachable from `convert`, validate frame-exact, then declare `fps`.
- **`trim:compose` [2]** — robustness/{prop_trim_additivity_compose, prop_trim_concatenation}. Metamorphic; verify compose/concatenation identity holds, then declare.
- **Vorbis-decode routing [1]** — transcode/vp8_to_h264_mp4 (reason: "browser cannot decode vorbis"). We **ship a Vorbis wasm decoder** — route the source's Vorbis audio track through the wasm tail instead of gating on `AudioDecoder.isConfigSupported`. (Routing fix, not a build.)

### R2 — BUILD buildable features (~12 cells)

- **`metadata:write` [5]** — metadata/{write_mp4_tags, write_mp3_id3, write_mkv_tags, write_flac_vorbiscomment, write_ogg_vorbiscomment}. Tag writers: iTunes `ilst` → `mp4/write.ts`; ID3v2 (MP3); Matroska `\Tags` (MKV); VorbisComment (FLAC + Ogg) as new modules. Bit-exact/structural oracle vs an independent tag reader.
- **`alpha` (VP9) [4]** — decode-seek/decode_vp9_alpha, transcode/{vp9_alpha_to_vp8_keepalpha, vp9_alpha_to_vp9_keepalpha}, trim/vp9_alpha_keyframe_aligned. VP9 4:4:4/alpha decode in `webcodecs-video.ts` + alpha-preserving transcode/trim.
- **`audio-samples:gapless-priming` [2]** — audio-dsp/edge_gapless_aac_decode, robustness/prop_gapless_sample_count_priming. AAC encoder-delay/priming + edit-list/`iTunSMPB` handling so decoded sample counts are gapless-exact.
- **`trim:frame-accurate-hevc` [1]** — trim/hevc_frame_accurate. Extend the accurate-trim codec seam (ADR-082) to HEVC.

### R3 — BUILD webm/mkv-source keyframe trim (5 cells)

- trim/{av1_keyframe_aligned, mkv_keyframe_aligned, vp8_keyframe_aligned, vp9_keyframe_aligned, vp9_noop_full_range_idempotent} (reason: "trim to 'webm' from a webm source needs the codec seam"). EBML cluster-seek `streamCopy` in `src/drivers/webm/` — enumerate Clusters/SimpleBlocks, cut on keyframe boundaries, re-emit.

### R4 — encode rate-control / bit-depth (~6 cells; ~5 buildable, 1 → §5)

- **`crf` [1]** transcode/h264_crf_quality_mode · **`two-pass` [1]** h264_two_pass_bitrate · **`fanout` [1]** fanout_h264_abr_ladder (multi-rendition ABR op in `engine.ts`) · **`depth:10bit-to-8bit` [1]** h264_10bit_to_h264_8bit (bit-depth down-convert in the pixel path) · **degenerate [1]** extreme_resize_1x1 ("no codec driver for encode avc1" at 1×1 — fix/verify the tiny-dimension encode config).
- **`depth:10bit-output` [1]** h264_8bit_to_hevc_10bit → **§5 register**: HEVC 10-bit encode is HW-only (doc-10 §3 declared no-winner) unless a SW path proves out.

### R5 — ENCODE-TAIL (DECISION-GATE, §5) (the 7 NA_BROWSER + lossy-encode)

- **Vorbis encode [≈4]** — transcode/{wav_to_vorbis_ogg, h264_to_vp8_webm, hevc_to_vp8_webm, vp9_to_vp8_webm} (the WebM/Ogg Vorbis audio track). **libvorbis (BSD) via emcc — permissive, no license compromise → BUILD IT.** Mirror the vendored-core pattern (ADR-085/088/093).
- **MP3 encode [2]** — transcode/{aac_to_mp3_mp4, wav_to_mp3_mp4} → ⚠ **no permissive MP3 encoder exists** (LAME/lamejs/Shine = LGPL). Needs an **isolated, lazy, separately-licensed LGPL LAME tail + ADR + notice** — **your sign-off** (§5). Default: honest N/A.

### R6 — DECRYPT schemes (3 cells — verify-then-build-or-register)

- encryption/{clearkey_decrypt_na, hls_sample_aes_decrypt_na, cenc_cens_decrypt_na}. **First** confirm whether the oracle accepts a typed *graceful decline* as PASS (the `_na` suffix suggests so — if so, these are R1-style declare-the-graceful-rejection). If real decrypt is required: build ClearKey (EME), HLS sample-AES, CENC-CENS; else register honest-NA (§5).

**Net:** R1 (~9, declare/route) + R2 (12) + R3 (5) + R4 (~5 build) + R5 (Vorbis ~4 + MP3 2 decision) + R6 (3) + §5 register (≈4). **All buildable cells are required for §2.**

---

## 4. PHASES (each to a green gate; do not stop between)

- **6.0 — Verify-and-declare (lead + light fan-out):** R1 — prove fps reachability, trim:compose identity, and the Vorbis-decode route, then declare. **GATE:** R1 cells PASS, no new FAIL; re-measure.
- **6.1 — Build buildable features (fan-out, disjoint files §6):** R2 (metadata:write, alpha, gapless, hevc-trim) + R3 (webm/mkv keyframe trim). **GATE:** every cell PASS + validated (≥5 fixtures, strict oracle) + benchmarked + ADR.
- **6.2 — Encode rate-control / bit-depth (fan-out):** R4 buildable cells. **GATE:** PASS + bench + ADR; h264→hevc-10bit moved to §5.
- **6.3 — Encode-tail + decrypt (decision-gated):** R5 Vorbis (build now) + MP3 (per §5 decision) + R6. **GATE:** target cells PASS or registered; license hygiene; budgets hold.
- **6.4 — DoD + cross-browser baseline:** `bun run gate` → 0; re-measure Chromium (confirm §2); then **one fresh WebKit + Firefox run** (`--browser webkit,firefox`), record NA_BROWSER exposure for S7. **GATE:** §2 fully green.

---

## 5. HONEST-NA / DECISION REGISTER (the only admissible non-PASS — each needs your sign-off + an ADR)

- **MP3 encode (2)** — aac_to_mp3_mp4, wav_to_mp3_mp4. No permissive encoder. Needs an isolated/lazy/separately-licensed LGPL LAME tail to close. **Your call.** Default: N/A.
- **HEVC 10-bit encode output (1)** — h264_8bit_to_hevc_10bit. HW-only (doc-10 §3 no-winner). Register unless a permissive SW path proves out.
- **H.264 two-pass bitrate (1)** — h264_two_pass_bitrate. WebCodecs has no first-pass stats API, and no approved software H.264 two-pass tail is shipped.
- **Massive bounded declines (2)** — remux/massive_h264_1080p_2h_mp4_to_mkv (~1091 MB), trim/massive_h264_copy_sustained. **ADR-102 safety: a typed decline > OOM-ing the tab.** Keep as honest declines (the one S5 "regression" was this, by design). **Verify** whether the harness scores a clean typed decline as PASS for these; if so, ensure we emit that outcome.
- **Any decrypt scheme** ruled out-of-scope in R6.

> Target: this register stays ≤ ~5 cells. Everything else is buildable and is a §2 requirement.

---

## 6. ORCHESTRATION (disjoint files — no parallel edits to one file)

Lead owns: harness **adapter.ts** (all declarations/routing), all **builds/vendor/re-measure** (serialized; re-measure only when the swarm is idle). Agents own disjoint files: `codec-pipeline.ts` (fps/crf/two-pass/depth) · `engine.ts` (fanout ABR) · `mp4/write.ts` (metadata `ilst`) · new tag-writer modules (`id3`, `matroska-tags`, `vorbiscomment` — one owner each) · `webcodecs-video.ts` (VP9 alpha) · `src/drivers/webm/` (cluster-seek trim) · `src/codecs/wasm-vorbis/` (encoder) · `hls`/`cenc` decrypt modules. Per feature: **failing oracle first → SOTA → pass → bench → hand the lead the adapter token → adversarial verify.**

---

## 7. NON-STOP (parent §13)

Drive each phase to green; don't stop at boundaries; blocked → SOTA + ADR + continue, **except** the MP3-encode LGPL call (§5, yours). Cross-browser *hardening* and *optimization* are **Session 7** — out of scope here. Finish line: **all buildable features PASS on Chromium, the §5 register complete, the encode decision made, `bun run gate` green, and a WebKit + Firefox baseline recorded.**

**Now: read [`SESSION6_GOAL.md`](SESSION6_GOAL.md), create the Session-6 tasks (one per R-group), and begin Phase 6.0. Do not stop until §2 is met.**
