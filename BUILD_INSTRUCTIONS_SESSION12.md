# BUILD INSTRUCTIONS — SESSION 12 (product completeness first: finish every remaining feature correctly)

> **Audience:** Codex, working at maximum reasoning effort on `aibrush-media` and the public fair-harness surface.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) and the black-box, anti-overfit, rotation, frame-lifetime, real-corpus, documentation, and non-stop rules from [`BUILD_INSTRUCTIONS_SESSION11.md`](BUILD_INSTRUCTIONS_SESSION11.md).
> **How to use:** Session 12 is now a product-completeness session before it is an evidence close-out.
> Preserve the large Session 11/12 worktree, finish every genuine missing or throwing aibrush-media feature,
> validate and benchmark each feature narrowly as it lands, and postpone broad/full harness repetition and
> leaderboard work until the implementation inventory is closed.

---

## 0. SESSION-12 PRIME DIRECTIVE

### Binding user-directed priority (2026-07-11)

**Make all remaining aibrush-media features work correctly before returning to broad testing or leaderboard
work.** This priority overrides the old phase ordering below wherever it conflicts.

1. Stop repeated full-browser, full-rotation, frame-bake, and all-engine runs while genuine implementation
   gaps remain. Use only focused validation and focused benchmarks for code being changed.
2. Maintain a truth-based implementation inventory. Separate:
   - a real product gap or typed throw;
   - a browser/OS codec absence;
   - a corpus/catalog selection mistake;
   - a stale golden or invocation/platform boundary.
   Only the first category counts as missing aibrush-media implementation, but every public boundary must
   still be resolved later for final acceptance.
3. Implement features in highest-leverage order: documented/public capabilities that currently throw,
   cross-browser software codec tails, incomplete codec/profile/rate-control paths, then performance and
   memory deficits in already-correct features.
4. Never manufacture capability. A declared feature must execute real work and produce independently
   valid media. A software codec tail must have reproducible provenance, compatible licensing, lazy
   same-origin loading, strict validation, and a benchmark. If a dependency needs a new copyleft/license
   decision, record it as an explicit decision boundary rather than silently vendoring it.
5. Preserve streaming, backpressure, cancellation, B-frame/VFR timing, force-software determinism, and
   exactly-once `VideoFrame`/`AudioData` closure in every new path.
6. Resume the broad correctness rotations and all-engine fastest/leanest sweep only after the feature
   inventory has no genuine missing implementation or accidental capability throw.

**Do not interpret an empty performance-loss list as a win when no comparison qualified.** The current generated data has one qualified contested wall loss, so the product is not performance-green. Session 12 is complete only when the evidence is both **complete** and **green**:

- zero product, corpus, golden, invocation, timeout, and OOM reds across every required rotation;
- a completed full Chromium run, not a partial launcher-timeout export;
- fresh same-export, same-rotation, warm `n>=5` wall and positive-sample peak-memory evidence against the rivals;
- nonzero contested coverage where the suite has contested cells, with zero non-exempt losses;
- `bun run gate` and the cross-browser regression board green.

Correctness remains ahead of speed. Never change correct product behavior to satisfy an impossible invocation, stale golden, unsupported browser playback path, or generated fixture. Repair the responsible boundary with independently proven truth, or report it honestly; never hide it with guessed keys, wrong containers/codecs, fabricated tracks, passthrough, padding, fixture branches, or a weaker oracle.

### The fair harness remains a black box

Run its public commands and read only status/metric/reason output and exported JSON. **Never open or read its scenario, oracle, tolerance, runner, rotation/selection, output-parser, or adapter source.** This applies to every agent and every phase. Use `ffmpeg`, `ffprobe`, `openssl`, `mediainfo`, format specifications, public product calls, and independently baked goldens to establish truth.

---

## 1. VERIFIED HANDOFF STATE (2026-07-11)

### 1.1 Browser evidence

- Historical pre-refresh full Chromium export: `chromium-2026-07-10T23-25-04-841Z.json` — **563 rows: 482 PASS, 20 FAIL, 2 ERROR, 59 N/A**, with no per-row timeout or OOM.
- Latest completed full Chromium export used by the current board: `chromium-2026-07-11T14-55-47-618Z.json` — **563 rows: 499 PASS, 57 `NA_ASSET`, 2 `NA_BROWSER`, 2 `NA_ENGINE`, 2 FAIL, 1 ERROR**. Later work remains focused; this is not a new full-suite claim.
- Newer broad export: `chromium-2026-07-11T02-43-00-871Z.json` — **545 rows: 479 PASS, 4 FAIL, 2 ERROR, 60 N/A**, but the launcher stopped after 1,800,000 ms. Its 18 omitted scenarios were subsequently exercised in the targeted `03-41-51` export; this does not turn the partial export into full close-out evidence.
- Later targeted work cleared the crop, same-rate resample, and massive-demux rows that were red in that broad export.
- Five result rows remained freshly reproduced before the unfinished gapless handoff:
  - `audio-dsp/edge_gapless_aac_decode`, rotations `01` and `03`;
  - `mux/edge_hevc_decode_mux_mkv`, baked input;
  - `probe/hls_aes128`, baked input;
  - `metadata/write_mkv_tags`, rotation `03`.
- Three of those are independently proven non-product boundaries (§3): HEVC-in-MKV Chromium playback, HLS ciphertext without decryption context, and stripped Matroska attachment side data.

### 1.2 The generated deficit report is deliberately red and incomplete

[`docs/perf/_deficit-data.json`](docs/perf/_deficit-data.json) was regenerated from 193 public result exports at
`18:29:39.282Z` and currently reports:

- 12 functional red records, representing the nine retained red slots plus repeated focused reproductions;
- 176 correctness-rotation gaps;
- 175 bake-blocked rotations;
- 1 metric-rotation gap and 0 sample gaps in the currently supplied exports;
- `comparisonEvidenceMissing: false`;
- one eligible contested wall loss and zero peak-memory losses. The current loss record is the focused
  `03.wav` export `chromium-2026-07-11T18-26-02-864Z.json`: aibrush `58.270 ms` versus Mediabunny
  `27.655 ms` (2.107×). The latest export `chromium-2026-07-11T18-29-37-500Z.json` selected retained
  `01.wav`, so it correctly has no timing metrics and reproduces the shared stale-golden failure.

Therefore `activeLossCount: 1` is an active performance loss, not a green result. Regenerate only after adding
every newer public export, and keep the generator red until all integrity conditions pass.

### 1.3 Native AAC suppression is implemented; corpus/operation evidence remains open

Chromium can suppress AAC priming represented by an MP4 presentation edit before emitting `AudioData`. The old public pipeline could then trim the same leading samples again. Session 11 added a generic bounded native-suppression preflight and MP4 gapless provenance/capacity clamp in:

- `src/api/gapless-native-suppression.ts` and its focused test;
- `src/api/codec-pipeline.ts` and `src/api/codec-pipeline.test.ts`;
- `src/drivers/mp4/gapless.ts` and its focused test;
- the full and simple MP4 probe paths.

The implementation has focused lifecycle/backpressure tests, a fresh gapless benchmark, ADR-213, production-gate evidence, and focused browser validation. The remaining gapless work is corpus/golden provenance and the public operation window; do not alter AAC bytes, pad output, or weaken the oracle.

### 1.4 The sibling gapless corpus is exact real-media evidence; one golden remains disputed

The current replacement corpus is five exact CC0 real recordings from BigSoundBank and LaSonotheque; their URLs,
licenses, hashes, durations, and AAC facts are recorded in [`docs/notes/session12-gapless-corpus-and-native-suppression.md`](docs/notes/session12-gapless-corpus-and-native-suppression.md).

The old generated Mozilla tones and the separately trialled long Internet Archive recording are historical only and
must not be restored or substituted. The exact `05.mp4` public proof reports 50,176 samples independently through
aibrush and FFmpeg, while the committed 50,784-sample expectation is disputed; the harness's 48,128-sample result
is a separate operation-window cutoff. Do not create excerpts, remuxes, tones, derived clips, or locally encoded
candidates.

### 1.5 Session 11 work that must be held

Do not regress the landed fixes for CENC graceful rejection/decrypt, CENS/CBCS, MP4/MOV rotation and crop, HLS re-readable sources, fragmented AAC probing, retained MP4 ranges, monotonic packet draining, exact WebCodecs acceleration, lazy audio containers, exact Router caching, same-rate WAV, massive packet truth, Matroska attachment preservation, or the hardened deficit generator. Rebuild and re-vendor from current source before browser validation; the sibling vendor must never be assumed current after an interrupted experiment.

### 1.6 Historical exact slots that still need superseding evidence

These are acceptance-active until a fresh run of the same named rotation supersedes them, even where independent evidence indicates a stale golden rather than a product bug:

- `audio-dsp/throughput_decode_s24`, rotation `01` (the passing `03` rotation now also has a measured
  pre-optimization contested wall loss; it does not supersede the retained `01` slot);
- `demux/graceful_mp4_header_destroyed`, old rotation `03` bytes;
- the repaired ADTS rotation `02` is superseded by the targeted packet-clock PASS; retain its independent truth in [`docs/notes/session12-public-truth-boundaries.md`](docs/notes/session12-public-truth-boundaries.md), not as an active red;
- `performance/size-ladder-iterate-packets-massive`, baked packet vector;
- nineteen retained video-frame rows spanning rotation/tag-edit/mux/remux/performance properties. Use the exact list in [`docs/notes/session11-fair-harness-boundary-audit.md`](docs/notes/session11-fair-harness-boundary-audit.md) and the exported JSON, not harness internals.

### 1.7 Product-completeness handoff after the reprioritization

The latest completed Chromium export's apparent “about 60 missing features” was not an accurate product-gap
count: it contained 57 `NA_ASSET`, two `NA_BROWSER`, and two `NA_ENGINE` rows. All 57 printed `NA_ASSET`
reasons are missing oracle/golden evidence, not product capability declarations. A separate public-catalog
audit found 51 conversion-family rows that incorrectly included output-only codecs in their input
requirements; a hash-guarded repair corrected those after verifying 54 unique exact-source hashes. That
catalog repair is separate from, and does not clear, the 57 evidence N/As listed in §1.8.

The two genuine engine-declared gaps in that export now have product implementations:

- HEVC Main10 output authors `hev1.2.4.L120.B0` and performs exact 8-bit→10-bit encoder widening without a
  pixel copy; unsupported browser configs remain honest.
- H.264 two-pass bitrate now performs a real fixed-QP analysis encode, reopens the replayable source, and
  executes a distinct PTS-exact quantizer-scheduled final encode. Retained evidence is packed to nine bytes
  per frame. One-shot public `encode()` streams reject because replay is impossible.

Focused performance work also fused BS.775 5.1→mono (2.27× faster, two temporary planes removed) and fused
the common stereo rational polyphase resampler (1.570 ms→1.105 ms on one second of 48→44.1 kHz audio, with
bit-identical mono-path parity).

Known optional work outside the current public capability envelope includes, but is not limited to:

- MP3 encode on browsers where WebCodecs rejects it. The shipped public envelope is decode-only there; LAME
  and Shine are LGPL, so a future encoder requires an explicit license decision or a proven permissive
  alternative.
- Cross-browser software video encode/decode tails outside the shipped exact envelopes. H.264/HEVC have no
  software fallback, and VP8/VP9/AV1 tails are decode-only; do not ship proof-of-concept full-container
  encoders as fake packet drivers.
- Software AAC encode and broader AAC decode profiles/layouts outside the shipped AAC-LC mono/stereo decode
  envelope where host WebCodecs is absent.

ADR-225 narrows these optional tails out of the current public promise. They can become additive future
features only after license/provenance, packet/frame/lifecycle validation, and benchmark approval.
- Fresh focused browser proof is complete for Main10/two-pass. The harness documentation assigns capability
  declarations to the registered engine adapter's `capabilities()` result; public CLI filters and exported JSON
  provide no declaration route. The external harness still reports both rows as `NA_ENGINE`; do not edit or
  inspect forbidden harness adapter internals.
- Any additional real product throw revealed when the 51 repaired conversions are exercised later through
  public commands. Add it to the inventory and implement it before restarting the full matrix.

### 1.8 Exact remaining feature/evidence board (public snapshot; do not collapse these categories)

Authoritative snapshot: completed public export
`chromium-2026-07-11T14-55-47-618Z.json`, plus the current generated deficit data through
`chromium-2026-07-11T18-29-37-500Z.json`. The completed export has **499 PASS, 57 `NA_ASSET`, two
`NA_BROWSER`, two `NA_ENGINE`, two FAIL, and one ERROR**. The retained cross-export correctness board has
**eight FAIL + one ERROR = nine reds**. The earlier remembered “about ten failures” included
`mux/audio_only_aac_to_mp4`; its exact `02.aac` duration row was subsequently superseded by a targeted PASS
after the packet-clock truth repair, so it is not one of the nine retained reds.

#### 1.8.1 The 57 `NA_ASSET` rows: evidence work, not 57 unimplemented product features

Every name below still needs a truthful public oracle/golden and a focused PASS before final closure. Do not
count any of them as a product implementation gap unless the public operation actually runs and then exposes
a typed product miss or wrong output.

**A. Output-metadata oracle unavailable — 24 rows.** The operation targets WAV/FLAC/Ogg/TS, but the public
oracle cannot currently read/reimport the output metadata. Independently bake exact track/duration/layout
truth from the produced container, then run the real operation:

- `transcode/aac_to_pcm_wav_extract`
- `audio-dsp/fade_in_out_f32`
- `audio-dsp/upmix_mono_to_stereo`
- `audio-dsp/resample_48k_to_16k`
- `audio-dsp/edge_longform_audio_resample_16k`
- `audio-dsp/pcm_s24_to_f32`
- `audio-dsp/upmix_stereo_to_5_1`
- `audio-dsp/pcm_s16be_to_s16le`
- `transcode/wav_to_flac`
- `audio-dsp/pcm_s24be_to_s16le`
- `audio-dsp/resample_48k_to_44k1`
- `transcode/wav_to_vorbis_ogg`
- `audio-dsp/gain_half_f32`
- `audio-dsp/gain_minus6db_s16`
- `audio-dsp/pcm_s24_to_s16`
- `audio-dsp/resample_44k1_to_48k`
- `audio-dsp/pcm_f32_to_s16`
- `audio-dsp/edge_variable_channel_count_downmix`
- `audio-dsp/downmix_stereo_to_mono`
- `transcode/h264_to_ts`
- `audio-dsp/pcm_s16_to_f32`
- `transcode/wav_to_opus_ogg`
- `audio-dsp/downmix_5_1_to_stereo`
- `audio-dsp/throughput_encode_s24`

**B. Duration/probe oracle unavailable — 10 rows.** Bake exact packet-clock/container duration and make the
public reimport path able to prove it; do not infer duration from bitrate:

- `mux/opus_to_ogg`
- `mux/vorbis_to_ogg`
- `streaming-output/prop_probe_dur_stream_shape`
- `remux/prop_recorder_headerless_duration_materialized`
- `mux/prop_h264_mux_duration_mp4_to_ts`
- `metadata/tagedit_no_corrupt_audio_flac`
- `mux/aac_to_adts`
- `mux/mp3_to_mp3`
- `streaming-output/prop_ts_stream_duration_materialized`
- `mux/h264_aac_to_ts`

**C. Reference-reimport oracle unavailable — 10 rows.** Add independently baked track/packet/layout truth
for the exact output container and then exercise the public operation:

- `remux/h264_in_mkv_mkv_to_ts`
- `metadata/write_flac_vorbiscomment`
- `metadata/write_mp3_id3`
- `remux/aac_adts_adts_to_ts`
- `remux/h264_1080p_5s_mov_to_ts`
- `metadata/write_ogg_vorbiscomment`
- `remux/micro_audio_short_mp4_to_adts`
- `remux/h264_1080p_30s_mp4_to_ts`
- `streaming-output/ts_tiny_writes`
- `streaming-output/ts_continuity_many_writes`

**D. Trim-boundary oracle unavailable — six rows.** Bake exact source/output packet clocks and prove the
whole-frame/keyframe selection boundaries without decoding duration guesses:

- `trim/audio_opus_ogg_copy`
- `trim/ts_keyframe_aligned`
- `trim/audio_aac_adts_copy`
- `trim/audio_mp3_copy`
- `trim/audio_flac_noseektable_copy`
- `trim/audio_flac_seektable_copy`

**E. Frame-bake evidence missing — three rows.** These require real independently decoded frame
digests/signatures for the selected exact licensed sources before they can run:

- `decode-seek/meta_decode_remux_eq_decode_anchored`
- `decode-seek/decode_h264_first_frames`
- `decode-seek/decode_size_tiny_h264_360p`

**F. Gapless/headerless metadata evidence missing — four rows.** Restore only eligible real gapless corpus
coverage and exact metadata; do not restore the deleted generated trial file or invent headerless duration:

- `audio-dsp/edge_gapless_aac_decode` — the obsolete generated `gapless_aac.m4a` is intentionally absent;
  the replacement exact CC0 corpus is present, but the public operation window still truncates the selected
  real recording before the disputed 50,784-sample expectation; independent full-source truth is 50,176 samples.
- `robustness/prop_gapless_sample_count_priming` — no exact sample-rate/duration truth for the selected row.
- `robustness/edge_gapless_priming_probe` — exact metadata golden absent.
- `probe/metamorphic-recorder-headerless-sane-duration` — no source/golden duration for the headerless input.

#### 1.8.2 The two `NA_BROWSER` rows: intentionally unavailable optional fallback

Both rows request MP3 encode, but the current public envelope has no software MP3 encoder when Chromium's
exact `AudioEncoder.isConfigSupported` query returns false:

- `transcode/aac_to_mp3_mp4`
- `transcode/wav_to_mp3_mp4`

This is an honest `NA_BROWSER`, not a product throw or a missing promise. The shipped `wasm-mp3` tail is
decode-only. A future encoder remains optional work and would require an explicitly approved redistributable
license, a reproducible lazy same-origin core, raw MP3 `EncodedAudioChunk`s, encoder delay/Xing facts through
MP4, real-corpus decode/SNR/bitrate/lifecycle oracles, and a fresh benchmark. LAME and Shine are LGPL; do not
silently add either.

#### 1.8.3 The two `NA_ENGINE` rows: product proof exists; external declaration remains pending

- `transcode/h264_8bit_to_hevc_10bit` — the product now authors Main10
  `hev1.2.4.L120.B0` and uses encoder widening. The focused Chromium proof records an honest
  `NA_BROWSER` (`capability-miss`: no exact Main10 codec driver); the external adapter declaration remains
  pending, and unsupported exact browser configs remain `NA_BROWSER`, not a fake pass.
- `transcode/h264_two_pass_bitrate` — the product performs a real analysis encode plus replay-backed PTS-exact
  second pass. The focused Chromium proof passes bitrate/structure/determinism/lifecycle checks; only the
  external `two-pass` capability declaration remains pending.

#### 1.8.4 The nine retained reds: exact rows and responsible work

| # | Status | Exact feature/rotation | Classification | Required closure |
|---:|---|---|---|---|
| 1 | FAIL | `audio-dsp/edge_gapless_aac_decode` — `01.mp4@7a5b8dd34a` | gapless corpus/invocation | Replace trial state with eligible exact real recording coverage; prove complete-stream sample count through the public operation. |
| 2 | FAIL | `audio-dsp/edge_gapless_aac_decode` — `02.mp4@f34444c8c4` | gapless corpus/invocation | Same; do not accept the one-second partial public consumption as a full decode. |
| 3 | FAIL | `audio-dsp/edge_gapless_aac_decode` — `03.mp4@e471b83ad7` | gapless corpus/invocation | Same; validate native suppression versus independent PCM/sample truth. |
| 4 | FAIL | `audio-dsp/edge_gapless_aac_decode` — `05.mp4@c35fe072c2` | gapless tail accounting | Prove the remaining 2,656-sample delta against exact edit/priming/padding facts and fix only the responsible layer. |
| 5 | FAIL | `audio-dsp/throughput_decode_s24` — `01.wav@3cb89a79d3` | stale/disproved audio golden | Aibrush f32 bytes match independent ffmpeg hashes; the public metadata/packet baker and RGBA frame-bake have no audio golden route, so provide decoded-audio PCM evidence through the allowed public seam, then rerun the exact rotation. The product now also has a bounded WAV PCM stream path (ADR-226) and interleaved `f32` raw-audio egress (ADR-228), with focused lifecycle tests and fresh real-s24 benchmarks; rerun the passing `03` rotation for post-change contested timing. |
| 6 | FAIL | `metadata/write_mkv_tags` — `03.mkv@15ac6672ae` | public invocation strips container side data | Forward the exact attachment/projection side data through the public seam; do not synthesize timed tracks or fixture branches. |
| 7 | FAIL | `mux/edge_hevc_decode_mux_mkv` — baked HEVC | Chromium platform decoder boundary | Keep valid MKV/HEVC bytes; validate with a capable standards decoder or classify the physical platform boundary honestly. |
| 8 | FAIL | `performance/size-ladder-iterate-packets-massive` — baked two-hour MP4 | public packet-size projection boundary | Preserve all 553,501 payload-free packet sizes through the public output; product table already matches independent ffprobe truth. |
| 9 | ERROR | `probe/hls_aes128` — baked manifest | detached invocation context | The standalone public URL and explicit-base detached proofs pass; the black-box harness invocation must carry the manifest/source URL or resolver base. Its public CLI has no source-context override, so rerun this exact row only after that external seam is legitimately supplied. Never guess keys, IVs, or sibling paths. |

#### 1.8.5 Optional fallback tails outside the current public envelope

These are explicitly non-promised future tails. The current product surface remains honest by probing the
exact host config and raising a typed capability miss when no shipped tail accepts it:

| Capability | Current state | Work still required |
|---|---|---|
| MP3 encode | Native WebCodecs only; decode-only WASM tail | Optional approved/reproducible encoder tail; not a current public promise. |
| AAC software encode | Native WebCodecs only | Optional license-compatible encoder tail; not a current public promise. |
| VP8/VP9 software encode | Decode-only WASM tail | Optional packet encoder with planar-frame, alpha, backpressure, cancellation, and codec-private proof. |
| AV1 software encode | Decode-only dav1d tail | Optional permissive packet encoder with independent decode proof. |
| H.264 software decode/encode | Native WebCodecs only | Optional licensed/permissive fallback; exact host misses remain typed. |
| HEVC software decode/encode | Native WebCodecs only | Optional licensed/permissive fallback; exact host misses remain typed. |
| AAC fallback decode breadth | AAC-LC mono/stereo only | Optional SBR/HE-AAC/PCE/multichannel expansion; current envelope is explicit. |
| VPx/AV1 fallback decode breadth | 8-bit 4:2:0 envelopes | Optional 10-bit/chroma/monochrome expansion; current envelope is explicit. |

This section is the working checklist. Update the counts and move a row out only when a newer public export
or independently verified implementation evidence supersedes the exact item; never delete it because a
different rotation passed.

---

## 2. DEFINITION OF DONE

Session 12 is done only when every item is simultaneously true:

- [ ] The implementation inventory contains zero genuine missing features for the documented public surface
  and eligible real-corpus feature catalog. No feature is declared merely to turn a red into N/A/PASS.
- [ ] Every formerly throwing product path has focused fail-first validation, a real implementation,
  lifecycle/backpressure coverage proportional to risk, a focused multi-sample benchmark, and current docs/ADR.
- [ ] Documented cross-browser fallback promises are either implemented with reproducible, license-compatible
  lazy software cores or narrowed honestly in the architecture and public capability surface.
- [ ] Main10 and H.264 two-pass pass focused licensed-source browser validation before broad rotations resume.

- [ ] The gapless trial corpus is removed; every accepted replacement is an exact downloaded, openly licensed real recording with URL, license, SHA-256, traits, and independent gapless truth. No generated or derived subject media remains.
- [ ] The native AAC suppression fix passes a diverse real-media matrix, the exact browser controls, lifecycle/backpressure tests, its multi-sample benchmark, production build, budgets, and an ADR (next available is currently **213+**; verify before assigning).
- [ ] Every retained historical exact-slot red is freshly rerun or corrected by a stricter independently justified corpus/golden repair.
- [ ] A completed full Chromium rotation reports **0 FAIL, 0 ERROR, 0 timeout, 0 OOM**, with no launcher timeout and no PASS-to-FAIL.
- [ ] The HLS, HEVC-MKV, and Matroska-attachment boundaries are resolved at the responsible public corpus/invocation/platform boundary without corrupting product output or weakening an oracle.
- [ ] The deficit generator reports zero functional, bake, coverage, correctness-rotation, timed-rotation, and sample gaps; `comparisonEvidenceMissing` is false.
- [ ] Fresh all-engine evidence uses identical same-export work, rotation on, warmup >=1 and `n>=5`; wall and positive-sample peak memory are <= the fastest/leanest passing rival on every contested cell. `activeLossCount` is zero **with real contested coverage**.
- [ ] Chromium, WebKit, and Firefox smoke/correctness are un-regressed; force-software determinism and close-exactly-once frame ownership remain green.
- [ ] `bun run gate` exits 0; coverage is >=90%; format/lint/typecheck/test/anti-cheat/package verification pass; eager and typical budgets retain margin.
- [ ] Session 12 design notes, ADRs, regenerated deficit artifacts, and the final aggregate scorecard are committed together with the code they justify.

---

## 3. PROVEN BOUNDARIES — RESOLVE HONESTLY, NEVER PATCH AROUND THEM

1. **HLS AES-128 probe:** the failing invocation supplies AES ciphertext without the playlist, key, IV, or resolver. Valid manifest input probes and decrypts correctly. Ciphertext alone is information-theoretically insufficient; never guess a key/IV or use an asset path. The responsible public invocation must supply the manifest/decryption context.
2. **HEVC to Matroska:** both aibrush-media and FFmpeg emit valid HEVC Matroska with preserved packet/frame/HDR facts, while Chromium's `<video>` path reports zero intrinsic size for both. Never emit MP4 while claiming MKV, change HEVC to H.264 inside a mux operation, or return passthrough. Resolve the platform/oracle execution path using a standards-valid decoder capable of the output, or represent the physical capability honestly.
3. **Matroska tag rewrite, attachment rotation:** public source/build browser routes preserve H.264, AAC, the exact JSON attachment, and exact attached JPEG hashes. The failing black-box invocation drops additive `TrackInfo.containerSideData` before mux. Never synthesize attachment Blocks, hide bytes in timed packets, use a WeakMap/asset cache, or branch on the fixture. The public selection/invocation seam must forward the declared container metadata.
4. **Long rotated gapless input:** exact public product decode and independent FFmpeg truth for `05.mp4` report
   50,176 samples, while the harness operation window reports 48,128 against a disputed 50,784 expectation.
   A separate long native fixture has its own source facts. Do not pad, truncate, or invent absent edit metadata;
   use eligible real gapless fixtures and a public operation that consumes the complete stream.

These findings are not DoD exemptions. They identify where a truthful repair must occur.

---

## 4. EXECUTION PHASES

### 12.P — Finish the product feature inventory first (current phase; overrides 12.A–G ordering)

1. Build the inventory from public exports/status reasons, public aibrush calls, architecture promises, and
   typed product errors. Do not infer implementation gaps from `NA_ASSET` alone and do not inspect forbidden
   harness code.
2. For each real gap: write a fail-first focused validation, make a one-paragraph design note covering
   timing/frame ownership/backpressure/cancellation/memory, implement the real path, add a focused benchmark,
   run only the relevant tests plus strict typecheck, and update the ADR/docs.
3. Close codec tails in leverage order. Prefer existing permissive/reproducible cores and the normal
   hardware→native→WASM ladder. Do not add LGPL/GPL or custom-license code without an explicit recorded
   decision. Do not substitute full-container output for an `EncodedChunk` contract unless the architecture
   is deliberately changed and strict streaming/container oracles prove it.
4. Optimize correct hot paths when evidence identifies avoidable work: remove temporary full-signal planes,
   share immutable phase/kernel work, retain bounded packed evidence, avoid redundant decode/filter passes,
   and preserve byte/sample truth.
5. Keep an explicit “implemented / platform absent / catalog boundary / license decision” ledger. A platform
   absence is not a product implementation success, and a catalog repair is not a functional PASS.

**Gate:** no genuine missing/throwing product feature remains in the documented/eligible inventory; every new
path has focused correctness, lifecycle, benchmark, type, and documentation evidence. Only then continue at
12.A and eventually resume broad harness work at 12.E.

### 12.A — Sanitize and seal the handoff

1. Inspect the dirty worktree; preserve all Session 11/user changes and avoid destructive Git commands.
2. Remove the gapless corpus trial state. Verify hashes before and after every sibling-corpus edit. Do not call the current Mozilla generated tones final corpus.
3. Review the WIP gapless patch for boundedness, exact provenance, HE-AAC rate scaling, negative-prefix limits, replay-once behavior, HWM-0 backpressure, abort/cancel, and `AudioData.close()` exactly once.
4. Run the focused gapless tests and strict typecheck, then the full relevant MP4/audio suite.
5. Build, vendor WASM, check budgets, and re-vendor `dist/` into the sibling harness. Move the Chromium browser cache aside so an old module graph cannot validate stale code.

**Gate:** clean eligible corpus; reviewed WIP; focused/full relevant tests, typecheck, build, vendor, and budgets green; product and harness vendor byte-current.

### 12.B — Finish the genuine gapless product fix

Write/retain fail-first tests across at least five real downloaded AAC/MP4 recordings covering presentation edits, decoded-count priming, no edit, terminal padding, negative first DTS, mono/stereo, 44.1/48 kHz, fragmented/ordinary MP4, and malformed edit totals. Prove browser PCM/sample alignment against FFmpeg on Chromium and WebKit. Include cancellation before/during preflight, decoder error, downstream cancellation, no-prefetch, bounded prefix memory, and close-exactly-once tests. Add a warm multi-sample benchmark and ADR.

**Gate:** exact real-media matrix green; browser controls green; no double trim; no missed trim on controls; lifecycle and benchmark green.

### 12.C — Close the three invocation/platform boundaries

Use only public harness output plus independent truth. Make the responsible corpus/catalog/public invocation carry sufficient information and use a decoder compatible with the declared output. Do not alter correct product bytes to mimic an unsupported platform or stripped input. Re-run each exact slot on every rotation after the boundary repair.

**Gate:** HLS probe, HEVC-MKV invariant, and Matroska attachment tag rewrite all green for truthful reasons; independent product interop remains exact.

### 12.D — Supersede every historical correctness slot

Run the exact s24, damaged-header, ADTS-duration, massive-packet, and nineteen video-frame slots. For each red, first compare source and output with independent real-world truth. Repair product code only for a genuine product defect; repair a stale corpus/golden with exact stronger evidence and an ADR. Never mark an old failure cleared because a different rotation passed.

**Gate:** every retained row is superseded by a fresh PASS or a documented stricter truth repair followed by PASS.

### 12.E — Complete full correctness rotation

Run a fresh headed Chromium full suite with a 7,200,000 ms launcher allowance, a fresh browser cache/profile, rotation enabled, and no result reuse. Repeat/target until every known rotation is covered. Regenerate:

```sh
node docs/perf/gen-deficits.mjs \
  docs/perf/stored-test-data-chromium-2026-07-01T08-33-45-588Z.json \
  ../media-test/results/raw/chromium-*.json
```

The generator must remain exit 1 until every correctness, bake, coverage, rotation, and sampling condition is truly closed.

**Gate:** completed full run; 0 functional reds; zero correctness/bake/coverage gaps; no regression.

### 12.F — Measure and eliminate the real speed/memory tail

Only after 12.P and 12.E, run all engines on identical rotations in the same exports with warmup and `n>=5`, including a separate positive-sample peak-memory pass. Profile severe, then moderate, then minor losses. Optimize only genuine product work: payload-free timeline facts, bounded retained ranges, cached proven configuration, reuse, and lazy code splitting. Preserve output bytes, public streaming/backpressure, and budgets.

**Gate:** comparison evidence present; timed/sample gaps zero; real contested coverage present; zero non-exempt wall or peak-memory losses.

### 12.G — Close-out

Run `bun run gate`, coverage, package/budget/anti-cheat, Chromium full, WebKit, and Firefox smoke/correctness. Regenerate the report from the final exports and record the all-engine aggregate and per-family wall/memory scorecard. Update architecture, ADRs, and `docs/notes/` in the same change.

**Gate:** §2 is fully green. Only then declare Session 12 complete.

---

## 5. CLEAN-MACHINE COMMAND ENVIRONMENT

- Bun is installed at `/Users/tarek/.bun/bin/bun`.
- Node/npm are under `/opt/homebrew/bin`.
- Use `PATH=/Users/tarek/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin` for product scripts and add `/usr/sbin:/sbin` for browser runs.
- Browser runs are headed. Use the harness's public `scripts/run.sh --help` and public command surface only; do not inspect its implementation.
- After every production build, re-vendor the current `dist/` into `../media-test/src/engines/aibrush-media/vendor/` before measuring, and invalidate the Chromium module cache/profile.

---

## 6. NON-STOP AND ANTI-OVERFIT

Work from correctness to evidence completeness to speed. A one-file pass, a different-rotation pass, an old cached bundle, a generated fixture, a cross-export rival comparison, an `n=1` timing, or zero-sample memory is not proof. Never weaken a golden/oracle, infer an encryption key, spoof a container, fabricate metadata, or special-case an asset. Done means the final report has complete qualified evidence and no red—not merely an empty loss array.
