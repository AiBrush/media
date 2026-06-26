# Where Others Will Exceed aibrush-media — an honest competitive-gaps register

> **Purpose.** A deliberately *unflattering* companion to the architecture docs and the benchmark
> summary: it records, with code/ADR evidence, the axes on which rival browser-media libraries will beat
> aibrush-media, and why a "win" on our own 558-feature harness is **not** the same as industry SOTA.
> Keep it honest; revisit it whenever someone is tempted to claim "SOTA". Evidence was gathered by reading
> source + `.wasm` presence (not docs alone) on 2026-06-25 (Session 2).
>
> **Status legend for the codec matrix:** `real-wasm-core` = vendored `.wasm` + Node-validated ·
> `webcodecs-only` = sole path is hardware/browser WebCodecs, **no software fallback** · `honest-scaffold`
> = driver + pure-TS framing + typed contract shipped but `supports()→false`, needs `emcc` (no core) ·
> `pure-ts` = real shipped TypeScript · `none` = no substrate at all.

---

## 0. TL;DR (the honest verdict)

aibrush-media can credibly become **best-in-aggregate among general-purpose, hardware-first,
deploy-anywhere (no COOP/COEP) browser-media engines** — a real, valuable position — **if** it fills the
WASM encode/decode tail and out-matures mediabunny on coverage. It is **not** "the definitive SOTA of
browser media processing," and several competitors beat it on specific, durable axes:

- **The whole ENCODE side is WebCodecs-or-nothing.** There is **zero working software encoder** for any
  lossy codec. Every benchmark feature that needs encode on a browser/codec WebCodecs doesn't cover is a
  guaranteed loss to ffmpeg.wasm-class engines — including the engine's own "encode to Opus instead"
  escape hatch, which is itself non-functional (no libopus core).
- **mediabunny — not ffmpeg.wasm — is the most dangerous competitor.** It already ships the exact thesis
  (WebCodecs-first + pure-TS containers, no WASM, no COOP/COEP, ~165 kB) and wins 56% of the benchmark.
  We have **no structural advantage** over it on the shared substrate; the only levers are our WASM tail
  and a future GPU rung, plus a long execution race on coverage against an active author.
- **The headline benchmark is self-authored end-to-end** (harness + oracles + golden bake + leaderboard +
  the adapter that decides NA-vs-attempt). A win on it is a necessary internal regression gate, not an
  external SOTA claim.

---

## 1. The dominant exposure — the encode/decode tail (code-verified)

Source of truth: `src/drivers/defaults.ts` (registration), `src/codecs/**`, the ADRs noted, and
`docs/architecture/10-browser-capability-matrix.md`.

### 1.1 Codec × direction reality matrix

| Codec | Decode | Encode | Where a competitor wins |
|---|---|---|---|
| **H.264** | `webcodecs-only` | `webcodecs-only` | No `openh264/x264` SW fallback (doc 10 line 16 is a *plan*). Firefox/Linux/no-proprietary-codec Chromium → hard miss; ffmpeg.wasm/x264 decode+encode. |
| **HEVC** | `webcodecs-only` | `webcodecs-only` | No `libde265/libx265`. Many builds lack a HEVC `VideoDecoder`. 10-bit HEVC encode is a declared no-winner (doc 10 §3). |
| **VP8** | `honest-scaffold` (no core, **not even registered** in `defaults.ts`) | `none` (`createEncoder` throws) | The exact miss it was written for (no `VideoDecoder`) hard-fails; SW VP8 encode doesn't exist anywhere. |
| **VP9** | `honest-scaffold` (no core, unregistered) | `none` | Safari/WebKit/unaccelerated-VP9 fallback produces a `CapabilityError`, not a decode. Needs `emcc`+libvpx (ADR-035). |
| **AV1** | `webcodecs-only` (no `dav1d` despite doc 10 line 20) | `webcodecs-only` (WC AV1 encode "limited") | No SW decode or encode; no AV1 scaffold dir even exists. Strong ffmpeg.wasm/SVT-AV1 opportunity. |
| **AAC** | **`real-wasm-core`** (Symphonia, AAC-LC mono/stereo only) | `none` | SBR/HE-AAC & >2ch rejected (`lib.rs`); no SW AAC encoder. |
| **Opus** | `honest-scaffold` (no core, unregistered) | `honest-scaffold` (encoder fully written, **no libopus core**) | **Biggest audio gap** — see §1.2. |
| **MP3** | **`real-wasm-core`** (Symphonia) | `none` (no `libmp3lame`; WC has no MP3 encoder) | Any `*→mp3` transcode is an unconditional hard miss; lamejs/libmp3lame win. |
| **FLAC** | **`pure-ts`, bit-exact** ✅ | `none` | Decode is a genuine strength (closes the Chrome-149 no-FLAC hole). `*→flac` encode hard-fails. |
| **Vorbis** | **`real-wasm-core`** (no browser has a Vorbis decoder → genuinely valuable) ✅ | `none` | No Vorbis encoder anywhere. |
| **PCM** | `pure-ts` ✅ | `pure-ts` ✅ | Fully covered — a strength. |

### 1.2 The biggest single gaps (ranked)

1. **Software encode is entirely absent for every lossy codec.** The only encode substrate is
   `webcodecs-video.ts` / `webcodecs-audio.ts`. Every wasm/scaffold `createEncoder` either throws
   `CapabilityError` (vpx/aac/mp3/vorbis are decode-only) or has no core (opus). **On any browser/config
   where WebCodecs lacks the encoder, the encode is a hard miss** — ffmpeg.wasm-based engines win all of
   these.
2. **Opus software encode** is the single most damaging gap: the encoder is *fully written*
   (`wasm-opus-driver.ts` FrameAccumulator / re-chunking / pre-skip) but has **no libopus core** (needs
   `emcc`, ADR-031). Opus is the engine's universal recommended encode target — the AAC/MP3/Vorbis drivers
   all say "encode to Opus instead" — yet that fallback never works where WebCodecs `AudioEncoder` lacks
   opus. Worst case `flac→opus` (a doc-10 §3 feature) fails on such browsers.
3. **VP8/VP9 decode fallback does not actually work** — the scaffold has no `.wasm` core *and isn't
   registered* (`defaults.ts` lines 58-60). The Safari/WebKit/unaccelerated-VP9 miss it targets hard-fails.
4. **H.264 / HEVC / AV1 have no SW decode fallback at all** — no scaffold dir exists. Doc 10 promises wasm
   fallbacks (lines 16/17/20); none are built.
5. **MP3 and FLAC encode missing entirely** — `*→mp3` / `*→flac` are unconditional hard misses (WebCodecs
   has no encoder either).
6. **Doc/code disagreement on bundle reachability.** ADR-041/README say the wasm tail is "not in the
   default bundle," but `defaults.ts` registers WasmVorbis/Aac/Mp3 (lines 52-54). Browser reachability
   still hinges on `scripts/vendor-wasm.ts` co-vendoring (ADR-042) being run after build — **verify it's
   wired** before claiming the real decoders are browser-reachable in a consumer build.
7. **AAC decode is AAC-LC mono/stereo only** (Symphonia rejects SBR/HE-AAC & >2ch).

> **Net:** decode is genuinely strong where it ships (3 real Symphonia decoders, bit-exact TS FLAC, PCM);
> the **entire encode side is WebCodecs-or-nothing**. The three confirmed no-winner features in doc 10 §3
> (`flac→opus`, `h264→hevc-10bit`, `h264→vp8/webm`) all sit on exactly these encode/decode-fallback gaps.

---

## 2. Per-competitor — who beats us, and where (the 7 benchmark engines)

| Engine | What it is | Where it exceeds us |
|---|---|---|
| **mediabunny** (~165 kB, zero-WASM, single active author) | WebCodecs orchestrator + hand-written pure-TS/ESM containers — **our exact thesis, already shipping** | **Maturity on the shared substrate.** Same bundle class, same deployability → **no structural advantage**. Every container quirk / codec-string edge / conversion auto-route it already handles and we don't is a direct loss. Only levers vs it: our WASM tail + a future GPU rung. |
| **ffmpeg.wasm** (multi-MB core, Worker, single-thread) | Full libav in WASM; capabilities parsed honestly at runtime | **Audio-DSP throughput** (WebCodecs gives no HW edge on PCM — ~2.4× on a 1h resample, ~34× on a downmix) and **the exotic long tail** (codecs/containers/filters + SW encoders) we *disown as a non-goal*. We tie it only by shipping the same lazy WASM in our miss-only tier; on the truly exotic tail we CapabilityError by design. |
| **remotion-webcodecs** (~94 kB, GPU resize/rotate) | Polished WebCodecs converter, Remotion team | **Convert-path maturity** (backpressure-tuned pipeline) on contested transcode/decode-seek margins. Same substrate → not architecture. *(One "win", `remux/huge_…600s`, is a SUSPECT input-passthrough ftyp-flip — not a real axis.)* |
| **remotion-media-parser** (~73 kB, read-only) | Pure-TS streaming demuxer/probe, HTTP-Range lazy reads | **Read-only bundle size** (~half our eager budget) and possibly probe latency on pathological/huge files; a smaller, more-hardened read surface can edge our corrupt-input graceful-failure cases. Narrow (read-only); mostly WEAK-GATE wins. |
| **platform** (raw Chrome-149, no library) | The suite baseline + decode oracle | **Lowest-overhead native decode/seek** — calls `VideoDecoder` directly with no router/worker/driver indirection. A floor we can **tie but never beat**; it defines the ceiling our hardware path can't exceed. NAs everything needing a real muxer. |
| **mp4box** (~41 kB) | Pure-JS ISO-BMFF parser/fragmenter/writer | **Smallest bundle** (a conceded non-goal) and **ISO-BMFF box-format depth** (edit lists, exotic boxes, CMAF segmentation) we won't match on day one. MP4/MOV-only. |
| **web-demuxer** (~43 kB + WASM, bilibili) | FFmpeg demuxers in WASM → ready WebCodecs objects | **Demux/probe breadth on browser-unsupported codecs** (HEVC/AV1 where WebCodecs decode is absent) that a WebCodecs-first probe false-NAs. Until our WASM demux fallback covers the same. *(One "win", `iterate-packets-medium`, is a SUSPECT hardcoded sample-table shortcut.)* |

**Framing (from the research):** treat "win vs all 7" primarily as **"exceed mediabunny's union by adding
the ~5% heavy tail"** — mediabunny already covers most of the WebCodecs majority. ffmpeg.wasm's edge is
real but **bounded and largely conceded by our non-goals**. The raw `platform` is a floor, not a rival.
**3 of the 7's headline wins are SUSPECT** (input-passthrough remux, hardcoded sample-table iterate,
degenerate peak-memory metric) — do **not** cite them as genuine threats.

---

## 3. Out-of-benchmark threats (not in the 7, but real)

- **ffmpeg.wasm-mt under COOP/COEP** (multi-thread `@ffmpeg/core-mt`, or a build with `libaom`/`dav1d`/
  `SVT-AV1`): threads beat the transcode-throughput races we "won" single-threaded, **and** adds the AV1
  encode + exotic breadth we push to a lazy tier. (The benchmarked build deliberately omits AV1 encode and
  runs single-thread.)
- **LibAV.js (Yahweasel)** — full libavformat+libavcodec+**libavfilter** in WASM with a streaming/threaded
  programmatic graph: broader formats + real filtergraphs than ffmpeg.wasm's CLI wrapper; beats us on the
  exotic tail + complex filters we scope out (`01-goals-and-requirements.md:61`).
- **WebAV / mp4-muxer / webm-muxer / avc.wasm** — focused WebCodecs+WASM *editing/compositing* stacks;
  WebAV adds timeline/compositing glue we don't build (player/editor is a non-goal, `…:63`).
- **Specialized single-codec WASM** — `libopus`/`opus-encoder`, `fdk-aac`/`aac.js`, `lamejs` (MP3),
  `libflac.js`/`flac.wasm`, `libvorbis.js`: each out-features our general encoder on its one codec
  (MP3 VBR, Opus complexity, FLAC compression levels). These **are** our planned miss-only fallback tier,
  so day-one a hand-tuned single-codec encoder beats us on that codec.
- **hls.js / Shaka / dash.js / video.js / Plyr** — adaptive streaming (HLS/DASH), ABR, EME/DRM, MSE
  buffering, player UX: **entirely outside our scope** (no player, no DRM license acquisition, `…:63-64`).
- **MediaInfo.js / music-metadata** — deep metadata/tag extraction across hundreds of formats: broader
  probe/tag coverage than our practical matrix.
- **VideoContext / Etro / seriously.js** (WebGL compositing) — richer visual-effects graphs than our
  resize/crop/rotate/colorspace set.
- **jsmpeg / Broadway.js** — pure-JS H.264/MPEG decoders for *no-WebCodecs* environments we don't target.

---

## 4. Why a harness "win" ≠ industry SOTA (methodology risks — code-verified)

These do not say the benchmark is dishonest — the honesty discipline (typed `CapabilityError`, anti-cheat
self-checks) is visibly conscientious — but they bound what the aggregate can *claim*.

1. **Self-authored end-to-end.** The same project wrote the harness, the oracles, the golden bake, the
   leaderboard, **and** the aibrush adapter that authors its own capability declaration (`adapter.ts`
   `capabilities()`), its own NA-classification regex (`MISS_RE`), and its own graceful-rejection taxonomy.
   "We wrote the exam, graded it, and decided which questions don't count" cannot substantiate *industry*
   SOTA. → **Require an independent re-run before any external claim.**
2. **"Coverage" (closing NA) is the headline lever, and the adapter controls what counts as NA.**
   `conformancePct` is computed over **non-NA** cells, so every NA is removed from the denominator and can
   never lower the score. The adapter sets the NA boundary by declaring/withholding features **and** by a
   brittle message-regex that maps a throw to NA whenever the text matches phrases like "capability-miss"
   — so a real **bug** emitting such a sentence silently becomes NA (invisible) instead of FAIL. →
   **Report 3 numbers (pass-rate over admissible, absolute pass over all 558, an NA ledger diffed vs
   competitors); make typed `CapabilityError` the *sole* NA signal and delete the message-regex.**
3. **"Wins" include uncontested + perf-margin cells.** If only one engine is eligible the cell is an
   "uncontested win" (a default, not demonstrated superiority); contested ranking is a single throughput
   median, and the genuinely fast substrate (WebCodecs) is browser-native and shared. → **Split
   contested vs uncontested wins; weight contested correctness wins on STRICT oracles only; treat perf as
   a fresh multi-sample tiebreaker.** *(542/555 original margins were single-sample/cached.)*
4. **Chromium-only.** The harness runs in whatever browser opens the page (Chromium/M1); there is no
   cross-browser automation in-repo. The engine is WebCodecs-first, so on Safari/WebKit & Firefox a large
   fraction of the codec tier would become **NA_BROWSER**, not PASS. → **Stand up real Playwright
   Chromium+WebKit+Firefox; publish a per-browser scorecard; scope claims to browsers actually tested.**
5. **A fixed self-curated corpus + baked goldens ≠ real-world robustness.** A handful of files per family,
   author-baked goldens, and already-loosened duration tolerances for whole container classes
   (`LOOSE_DURATION_CONTAINERS`, `isLooseMp3`, `isLooseRecorderWebm`) — a green 558 says nothing about the
   long tail (VFR, open-GOP, broken MediaRecorder WebM, edit lists, truncated downloads). → **Run a large
   external/randomized + adversarial corpus gated on "no crash / no WRONG output," reported separately;
   audit every loosened tolerance.**
6. **Adapter-level survival machinery is an asymmetric advantage.** The aibrush adapter installs a
   page-error suppressor + a 30 s per-op abort (below the runner's 120 s) + synthesized graceful-rejections
   — bespoke advantages the other 6 adapters lack, applied by the engine's own author inside its own cells.
   → **Move shared survival logic into the runner for all engines, or disable it for the official scoring
   run; confirm the *engine* (not the adapter) rejects impossible requests.**
7. **Maturity / DX / ecosystem / real bundle are unmeasured.** The harness measures correctness+speed, not
   published-package quality, types/docs/examples, semver stability, **real installed/tree-shaken bundle**
   (aibrush is vendored from `dist/`, so the real npm path isn't even exercised), or adoption. "SOTA" to an
   adopter means "I can depend on it," which the matrix can't speak to. → **Ship the npm package, measure
   the real installed bundle, integration-test via the public API, pursue ≥1 downstream integration.**

---

## 5. What it would take to earn the claim (priority order)

1. **Fill the WASM encode cores** — libopus first (it unblocks the universal "encode to Opus" fallback),
   then libvpx (VP8/VP9 encode+decode), dav1d/SVT-AV1 (AV1), libmp3lame, libFLAC. This is the single
   biggest real-SOTA lever and needs an `emcc` build machine (out of scope in the current sandbox).
2. **Verify the wasm-tail co-vendoring is actually wired** for consumer builds (ADR-042), and reconcile
   the doc/code disagreement (ADR-041 vs `defaults.ts`).
3. **Get the harness re-run by a non-author** on a clean checkout of the **published** package, with the
   results published and diffable; replace the message-regex NA path with typed codes only; publish the
   contested/uncontested + NA-ledger breakdown.
4. **Real cross-browser** (Playwright Chromium+WebKit+Firefox, ideally real Safari/iOS) with a per-browser
   scorecard quantifying NA_BROWSER exposure.
5. **At-scale wild + fuzz corpus** gated on no-crash/no-wrong-output, reported separately from the 558.
6. **Move the adapter survival machinery into the shared runner** (or disable for scoring) so no
   aibrush-specific harness advantage is in the numbers.

---

## 6. Defensible positioning (what to say / not say)

- ✅ **Say:** "Best-in-aggregate among general-purpose, hardware-first, deploy-anywhere (no COOP/COEP)
  browser-media engines, on a flat intent-only API — measured on our 558-feature internal harness
  (Chromium)." Scope the browser. Cite the contested-win + strict-oracle breakdown, not a bare aggregate.
- ❌ **Don't say:** "The SOTA of browser media processing." ffmpeg.wasm beats us on completeness; a focused
  encoder beats us on any single codec; hls.js/Shaka own streaming/DRM; mediabunny is a strong moving
  target on the identical substrate; and the headline benchmark is self-authored and Chromium-only.

> The architecture doc's own framing — *best-in-aggregate on a flat, deployable API*, not *best at
> everything* — is the durable claim. This register exists so we keep using it.
