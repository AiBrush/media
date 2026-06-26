# BUILD INSTRUCTIONS — SESSION 5 (suite → 100% PASS, cross-browser)

> **Audience:** Claude Code (lead + a fan-out of Opus subagents), continuing the `aibrush-media` build.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§4/§5/§6/§10/§11/§13 remain **fully binding**. This file is the **Session-5 work order** built from a **real measured run**.
> **How to use:** max reasoning effort. Read this, then [`SESSION5_GOAL.md`](SESSION5_GOAL.md), then [`docs/architecture/`](docs/architecture/README.md). Execute §4 phase by phase to all-green; **do not stop until §2 (100% suite) is met.**

---

## 0. SESSION-5 PRIME DIRECTIVE (on top of parent §0)

**The goal is the ENTIRE 558/561-cell suite at 100% PASS — zero N/A, zero FAIL, zero ERROR — on chromium, WebKit, and Firefox.** We get there by **genuinely building/correctly-wiring every capability**, never by declaring an unbuilt one (that FAILs the oracle — worse than N/A — and violates parent §0.6 NEVER FAKE). The only admissible non-PASS is a cell that is **physically impossible on a given browser AND for which no software fallback exists** — and even then we build the SW fallback first. Every remaining cell below is a **hard requirement.**

---

## 1. STARTING STATE — MEASURED (chromium, fresh, 2026-06-26)

**436 PASS / 1 FAIL / 1 ERROR / 113 NA_ENGINE / 10 NA_BROWSER = 561** → **99.54% conformance, 78.07% coverage.** Rank #2 (mediabunny 100%/91.4%). Sessions 1–4 fixed the 3 conf-killers and wired multi-source mux, PCM, HLS input, FLAC/MP3/ADTS muxers, trim, rotation, VFR, ts-incremental, CENC-CTR decrypt, worker-offload.

**The metric** (`aggregate.mjs`): conformance% DESC → coverage% DESC tiebreak. **Both must hit their max:** conformance 100% (fix the 1 FAIL + 1 ERROR) and coverage 100% (flip all 123 N/A).

**Key diagnosis of the 123 N/A** (from the measured reasons): **roughly half are adapter declaration/routing gaps for capabilities we already have**; the rest are genuine builds. This is the precise breakdown in §3.

---

## 2. DEFINITION OF DONE — SESSION 5 (100%)

Not done until **every** box is green (parent §2 also holds):

- [ ] **Chromium: 561/561 PASS** — 0 FAIL, 0 ERROR, 0 N/A. (100% conformance AND 100% coverage.)
- [ ] **WebKit: 100% PASS.** **Firefox: 100% PASS.** (Run all three; any browser-only impossibility must be closed with a SW fallback, or documented in §5 with an ADR + the user's sign-off.)
- [ ] **Every §3 requirement** delivered: built to SOTA + validated on ≥5 real fixtures with a strict (bit-exact/structural) oracle + benchmarked, OR correctly declared/routed in the adapter and proven to PASS.
- [ ] **No regressions:** the 1 FAIL + 1 ERROR (§3 R0) fixed at the root (not reverted away).
- [ ] **Quality gates:** typecheck 0 / 0 `any`; biome clean; coverage ≥90% lines+branches; eager kernel ≤50 kB; **typical-app first-op ≤256 kB** (currently 284, RED — #21); wasm lazy/miss-only; anti-cheat green; `bun run gate` exits 0.
- [ ] **Docs:** every feature → design note + ADR; §5 register complete; README/examples updated; ADR numbering reconciled.

---

## 3. THE REQUIREMENTS — the complete measured N/A + FAIL/ERROR inventory

Every cell that is not PASS today. Grouped by work-type (how it gets fixed). Counts are exact from the 2026-06-26 chromium run. (Full raw list cached at `/tmp/na_inventory.json` during measurement; re-derive with `aggregate.mjs` anytime.)

### R0 — REGRESSIONS to fix at the root (2 cells, drag conformance < 100%)

- **`mux/mp3_to_mp3` FAIL** — Mp3Muxer emits 2.27 s for a 10 s source (duration/frame-drop bug). Fix `src/drivers/mp3/mp3-mux.ts` so the remux preserves all frames + duration.
- **`probe/hls_aes128` ERROR** — "key must be 16 bytes, got 27872": the HLS resolver fetches the wrong resource as the AES key in-browser (key-URI resolution bug). Fix `src/drivers/hls/hls-source.ts` key-URI/`fetchResource` handling.

### R1 — ADAPTER DECLARE + VERIFY: capabilities we (likely) already have, just not declared (~29 cells)

Add the feature token to `capabilities().features`/`encryption` **after** proving the engine genuinely passes the oracle on real fixtures. Tokens → scenarios:

- `mux:browser-decode-equality` **[8]** — edge_{bframes,hevc,rotation}_decode_mux_{mp4,mkv,mov}, prop_h264_decode_mux* (goldens already baked; decode(mux(x))==decode(x)).
- `webcrypto:cenc-ctr-clear-output` **[3]** — cenc_ctr_decrypt(+_eq_cleartext,+perf) (we validated CENC-CTR in #16).
- `streaming:decode-equality` **[3]** — prop_decode_equals_{buffer,stream}_shape, prop_frag_premise_decode_equality_mp4.
- `trim:compose` **[2]** — prop_trim_{concatenation,additivity_compose} (metamorphic).
- `headerless` **[2]** — webm_headerless_live_stream, prop_webm_headerless_duration_materialized.
- `audio-samples:gapless-priming` **[2]** — edge_gapless_aac_decode, prop_gapless_sample_count_priming.
- singles **[≈9]**: `trim:frame-accurate-hevc`, `flac:seektable-seek-equivalence`, `trim:flac-seektable-copy`, `trim:flac-no-seektable-frame-scan`, `trim:massive-lazy-read`, `remux:compose`, `mux:roundtrip-compare`, `remux:vp9-opus-in-mp4`, `remux:av1-opus-in-mp4`.

### R2 — ADAPTER ROUTING fixes: wired capability mis-gated (~22 cells)

- **PCM via audio-dsp not WebCodecs [12]** — demux/wav_{s16,s24,f32}, demux/pcm_s16be, demux/empty_audio, transcode/{wav_to_opus_ogg,wav_to_aac_mp4,gapless_pcm_to_opus,gapless_pcm_to_aac}, mux/{pcm_s16,pcm_s24,pcm_f32}_to_wav. Route PCM through the `transformPcm`/audio-dsp path; don't gate on `AudioEncoder.isConfigSupported`.
- **FLAC routed to WebCodecs instead of our codec [≈4]** — transcode/{wav_to_flac, flac_to_aac_mp4, flac_to_opus_webm} (+vp8 variants): use the pure-TS FLAC encoder / our FLAC decoder, not WebCodecs.
- **Robustness reject mapped to N/A, should be graceful-reject-PASS [6]** — robustness/fuzz_{mp3,ogg_opus,webm,mp4}_*_{truncated,zeroed}_{probe,demux,decode}, demux/graceful_{mp4,webm}_header_destroyed: map "no container driver for demux unknown" → the harness graceful-rejection outcome.

### R3 — RE-VENDOR already-built work (3 cells)

- **ts-incremental-writes (#29)** — streaming-output/{ts_tiny_writes, ts_continuity_many_writes, prop_ts_stream_duration}: fragwebm built the 188-byte incremental TS writes; they're not in the vendored dist yet. Rebuild + re-vendor + drop the stale TS-stream-target NA gate in the adapter.

### R4 — BUILD video/transcode features (~24 cells)

- **fps-resample [6]** — h264_fps_{30_to_60,15_to_30,30_to_15}, extreme_fps_{1,240}, h264_vfr_to_cfr_30 → frame drop/dup retimer in `src/api/codec-pipeline.ts`.
- **metadata:write [5]** — write_{mp4_tags,mp3_id3,mkv_tags,flac_vorbiscomment,ogg_vorbiscomment} → tag writers (ilst→`mp4/write.ts`; ID3/Matroska-Tags/VorbisComment as new modules).
- **alpha [4]** — decode_vp9_alpha, vp9_alpha_keyframe_aligned, vp9_alpha_to_{vp8,vp9}_keepalpha → VP9 4:4:4/alpha decode in `webcodecs-video.ts` + alpha-preserving transcode.
- **fastStart:reserve [4]** — mp4_faststart_reserve ×2, edge_faststart_reserve_remux, prop_faststart_reserve_duration → sparse forward-moov reserve+backfill in `mp4/write.ts`.
- **depth-change [2]** — h264_10bit_to_h264_8bit, h264_8bit_to_hevc_10bit → bit-depth conversion in the pixel path.
- **crf [1]** h264_crf_quality_mode, **two-pass [1]** h264_two_pass_bitrate, **fanout [1]** fanout_h264_abr_ladder → encoder rate-control modes + the multi-rendition op (`engine.ts`).

### R5 — BUILD remux/mux/trim gaps (~13 cells)

- **webm/mkv keyframe trim [5]** — trim/{av1,vp8,vp9,mkv}_keyframe_aligned, trim/vp9_noop_full_range_idempotent → EBML cluster-seek streamCopy in `src/drivers/webm/`.
- **lossy/elementary audio copy-trim [3]** — trim/{audio_opus_ogg_copy, audio_mp3_copy, audio_aac_adts_copy} → frame/granule-enumerated re-mux trim.
- **mp3-in-mp4 [2 → R1 token]** mp3_xing_mp3_to_mp4, prop_mp3_to_mp4_duration + mux/mp3_to_mp4_audio → MP3 sample table in `mp4/write.ts`.
- **av1-in-mp4 mux [2]** — av1_opus_to_mp4, prop_av1_mux_duration → write av01 sample entry (avNC) in `mp4/write.ts`/codec-pipeline.
- **large-file streaming [4]** — streaming-output/{stream_huge_h264_mov, stream_massive_h264, stream_large_vp9_webm, buffer_massive_h264} + remux/massive_h264_2h → streaming Clusters-on-write (webm) + raise/stream the in-browser materialize limit (validation's (a)).

### R6 — ENCODERS (permissive cores) (~6 cells)

- **AV1 encode [≈1]** transcode/h264_to_av1_mp4 (+extreme_resize_1x1) → rav1e wasm (BSD, #9). Needed because Chrome AV1 encode is HW-only (NA_BROWSER on non-AV1-HW Macs).
- **Vorbis encode [1]** wav_to_vorbis_ogg → libvorbis via emcc (BSD, #10).
- **MP3 encode [2]** wav_to_mp3_mp4, aac_to_mp3_mp4 → ⚠ **DECISION-GATE (§5)**: no permissive MP3 encoder exists. 100% requires an LGPL LAME tail (isolated/lazy/separately-licensed + ADR) — **your call.**
- **VP8 encode routing [≈3]** h264_to_vp8_webm, vp9_to_vp8_webm, hevc_to_vp8_webm → currently NA_BROWSER; verify Chrome VP8 encode path / route correctly (libvpx #22 SW fallback if needed).

### R7 — DECRYPT / EME schemes (~6 cells)

- **hls-aes128 [≈3]** hls_aes128_decrypt(+_eq_cleartext), demux/hls_aes128 → declare `hls-aes128` + fix R0 key bug.
- **cenc-cbcs [2]** cenc_cbcs_decrypt, edge_cbcs_boundary → implement/declare AES-CBC subsample (cbcs) decrypt.
- **clearkey / cens / sample-aes [3]** clearkey_decrypt, cenc_cens_decrypt, hls_sample_aes → EME ClearKey + the remaining schemes (these are the genuine charter-edge; §5 if any prove out-of-scope).

### Misc singles to slot into the above

- transcode/negative_{jpeg,png,webp}_to_video, mux/neg_* , transcode/mismatch_mislabeled, robustness/fuzz_mp4_zeroed_decode → negative/robustness routing (R2-style graceful reject).

**Net:** R1+R2+R3 (~54, mostly adapter) + R4+R5+R6+R7 (~49, genuine build) + R0 (2) = the full 125. **All required for 100%.**

---

## 4. PHASES (each to a green gate; do not stop between)

- **5.0 — Stabilize (lead):** fix R0 (2 regressions) at root → conformance back to 100%. Re-vendor R3 (#29). Re-measure. **GATE:** 0 FAIL, 0 ERROR.
- **5.1 — Adapter declare+route (fan-out + lead):** R1 (declare+verify each token on real fixtures) + R2 (PCM/FLAC/robustness routing). Lead is sole adapter editor; agents verify the engine genuinely passes each, hand the lead the token. **GATE:** all R1+R2 cells PASS (no new FAIL); ~+76 coverage.
- **5.2 — Build features (fan-out, disjoint files per §6):** R4 (fps, metadata, alpha, faststart:reserve, depth, crf, two-pass, fanout) + R5 (webm-trim, audio-trim, mp3/av1-in-mp4, streaming). **GATE:** every cell PASS + validated + benchmarked + ADR.
- **5.3 — Encoders & decrypt (fan-out):** R6 (av1/vorbis [+mp3 per §5 decision]) + R7 (hls-aes128, cbcs, clearkey/cens/sample-aes). **GATE:** target cells PASS; license hygiene; budgets hold.
- **5.4 — DoD + cross-browser:** #21 budget ≤256 kB; #23 longtasks≈0; #6 pad; #7 audio filter; #11 ADR; coverage ≥90%. Re-measure **chromium + WebKit + Firefox**. **GATE:** §2 100% on all three; `bun run gate` exits 0.

---

## 5. HONEST-NA / DECISION REGISTER (the only admissible non-100% — each needs your sign-off + an ADR)

- **MP3 encode (2 cells)** — no permissive encoder exists (lamejs/LAME/Shine = LGPL). To hit 100% you must approve an **isolated, lazy, separately-licensed LGPL LAME tail** (ADR + license notice). **Default until you decide: these 2 stay N/A** — the only gap to 100% that needs a license call.
- **Any cell physically impossible on a browser with no SW fallback** — must be closed by building the SW fallback first; only if truly impossible does it get an ADR here. (Target: this list stays empty besides MP3.)

---

## 6. ORCHESTRATION (disjoint files — no parallel edits to one file)

Lead owns: harness **adapter.ts** (all declarations/routing), all **builds/vendor/re-measure** (serialized, swarm-idle for browser runs). Agents own disjoint files: `codec-pipeline.ts` (fps/depth/crf/two-pass) · `mp4/write.ts` (metadata-ilst + faststart:reserve + mp3/av1 sample entries — ONE owner) · `webcodecs-video.ts` (alpha) · `webm/ebml-write.ts` (trim streamCopy + streaming Clusters) · `mp3-mux.ts` (R0 fix) · `hls-source.ts` (R0 fix + schemes) · `defaults.ts` (#21) · each encoder its own `src/codecs/*`. Per feature: failing oracle first → SOTA → pass → bench → hand lead the adapter token → adversarial verify. Re-measure only when the swarm is idle.

---

## 7. NON-STOP (parent §13)

Drive each phase to green; don't stop at boundaries; blocked → SOTA + ADR + continue, **except** the MP3-encode LGPL call (§5, yours). Finish line: **561/561 PASS on chromium + WebKit + Firefox**, `bun run gate` green. Then run the full harness once more on all three, confirm, and report.

**Now: read [`SESSION5_GOAL.md`](SESSION5_GOAL.md), create the Session-5 tasks (one per R-group), and begin Phase 5.0. Do not stop until the suite is 100%.**
