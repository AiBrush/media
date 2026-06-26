# BUILD_INSTRUCTIONS — Session 3 (finish aibrush-media to DoD-green)

> Companion to `BUILD_INSTRUCTIONS.md` (the original; **§2 is the binding Definition of Done**),
> `BUILD_INSTRUCTIONS_SESSION2.md` (Session-2 plan), `CLAUDE.md`, and `docs/architecture/`. **Read all of
> them first.** This file is the **remaining-work plan** for Session 3 and describes the **WHAT** (the
> end-state each item must reach + how to know it's done). It deliberately does **not** prescribe the
> **HOW** — you (Claude Code) ULTRATHINK each step at max reasoning effort and choose the SOTA mechanism.

## 0. Operating mode (MANDATORY — every step)

- **ULTRATHINK before every step**, at maximum reasoning effort. Restate the goal in concrete terms;
  enumerate edge cases (B-frames, VFR, open-GOP, seek, cancel, frame lifetime, backpressure, truncated
  input); weigh ≥2 approaches; write a one-paragraph design note; **then** code. Never type code you
  haven't reasoned through.
- **Drive this with the Workflow tool — fan out parallel opus agents (MAX reasoning effort) as much as
  possible.** A workflow per phase; one agent per **strictly disjoint** driver/feature/file set. Pattern:
  understand → fan-out implement (disjoint files) → **adversarially verify** (independent skeptic agents
  per finding) → integrate (the LEADER runs the authoritative full gate + harness serially and
  re-vendors). Each agent must ULTRATHINK, write a **failing strict-oracle test first** on **≥5 real
  downloaded files** (independent oracle — ffprobe/sips/afinfo — that **can fail**), implement to SOTA,
  pass it, add a fresh multi-sample benchmark, and **self-verify** (typecheck filtered to its files +
  `vitest run <its files>`) before returning a structured summary. **Never** run a heavy multi-agent
  workflow *concurrently* with a browser harness run — the browser starves and the run hangs (learned in
  Session 2). Run agents, THEN the harness; or vice-versa. Keep agents WARM (reassign the next backlog
  item on finish; never cold-start while backlog remains).
- **NEVER STOP until §2 is 100% green.** Blocked → pick the SOTA option, record an ADR
  (`docs/architecture/02-decision-records.md`, next is **ADR-046+**), continue. **EVERY LINE SOTA**
  (strict TS, zero `any`/non-null `!`, typed errors, exhaustive, no dead code, every `VideoFrame`/
  `AudioData` closed once). **NO FEATURE WITHOUT TESTS** (real downloaded corpus + can-fail oracle +
  fresh benchmark; one-file green is a fail). **DOCS ARE LAW** (every change → doc + ADR same commit).
  **NEVER FAKE** (no hardcoded paths, no input→output passthrough, no oracle that can't fail, honest NA).
- **NEVER run git** (the user commits). Keep `main` green at every step.

## 1. Where Session 2 left off (VERIFIED state — build on this, do NOT redo)

`main` is **GREEN**: `bun run typecheck` (3 tsconfigs) 0 errors, `bunx biome ci .` 0, **1486 Vitest tests
pass**, `bun run build` ok, budgets met. Landed + validated this session:

- **#61 DTS packet-seam — DONE & verified in a fresh chromium run (ADR-045).** The container↔codec seam
  is now `Packet { chunk: EncodedChunk; dtsUs?: number }` (in `src/contracts/driver.ts`):
  `Demuxer.packets()→ReadableStream<Packet>`, `Muxer.write(trackId, packet)`. `dtsUs` undefined ⇒ DTS==PTS.
  Demuxers attach DTS (mp4 from `stts`/`samples.ts`, mpegts from PES DTS); webm/avi/ogg/pcm omit it.
  `Mp4Muxer.buildMuxSamples` lays ctts = PTS−DTS + duration from DTS gaps when every packet carries DTS;
  `WebmMuxer` stores blocks in **decode** order (sort by `dtsMs`, cluster Timecode = min PTS so relative
  timecodes ≥ 0). Decoders consume bare chunks via `unwrapPackets()`; `drainEncoderToMuxer` normalizes
  encoder chunks vs demuxer packets (`toPacket`). **Result: `demux/h264_bframes_1080p` flipped FAIL→PASS,
  and ~all `mp4→mkv` remux scenarios PASS** (incl. `prop_bframes_decode_remux_mp4_mkv`).
- **Gap#5 audio `packets()` — DONE & integrated.** `adts`/`mp3`/`ogg` demuxers now enumerate real audio
  packets: pure exported framers `enumerateAdtsFrames` / `enumerateMp3Packets` / `oggAudioPackets`
  (Node-tested against **ffprobe-baked** can-fail oracles), browser-gated `EncodedAudioChunk` emission.
  ADTS synthesizes a 2-byte AudioSpecificConfig + emits raw AUs; mp3 skips ID3v2/Xing + handles VBR; ogg
  de-laces pages, skips header packets, Opus-TOC sample counts. +51 tests.
- **Streaming-output — DONE engine-side + adapter-side (ADR-034).** `Sink` union widened to include
  `StreamTarget`; `materialize` delegates `'stream-target'` → `writeToStreamTarget` (incremental writes).
  `mp4` `streamCopy` emits a **fragmented/CMAF** stream (`fragmentMp4`: init segment + `moof`/`mdat`) when
  `fragmented:true`, and lays mdat-before-moov when `faststart:false` (already in `write.ts`). `Mp4Muxer`
  now supports `fragmented` (finalize emits init + media segments). The **harness adapter** declares the
  `fragmented` feature, honors `fragmented` in `remux` (mp4/mov-only) and the `fastStart` knob in `mux`.
  **Verified flips: `streaming-output/mp4_fragmented_cmaf` PASS, `streaming-output/mp4_faststart_none_control`
  PASS, `mux/mp4_progressive_buffer` FAIL→PASS.**

The adapter lives at `../media-test/media-browser-test/src/engines/aibrush-media/adapter.ts` (the harness's
OWN live file — edits are NOT vendored). The engine is re-vendored to `…/aibrush-media/vendor/`.

## 2. Definition of Done (unchanged — `BUILD_INSTRUCTIONS.md` §2)

Every box green: all ops + full codec/container set; strict-oracle validation on ≥5 real **downloaded**
diverse files; **aggregate benchmark WIN vs all 7 engines** (fresh, multi-sample, **cross-browser**);
typecheck / lint / format / **coverage ≥ 90% (all 4 metrics)** / cross-browser green; budgets met; ESM +
`.d.ts`; docs synced (change → doc + ADR same commit); CI green. Never "mostly done"; never fake.

## 3. Remaining work — the WHAT (priority order; the path to the win is COVERAGE + the WIN gate)

### A. BLOCKER — the streaming-output `target:'stream'` HANG (fix FIRST; it blocks all full runs)

**Symptom (observed twice):** a fresh chromium run **hangs indefinitely** on
`streaming-output/prop_probe_dur_stream_shape` (a `shape:{ container:'mp4', target:'stream' }` scenario),
never settling, past the adapter's 30 s per-op timeout and the page-error safety net. It froze the run at
61/79 and earlier zeroed a run. **End-state required:** every `target:'stream'` / `target:'buffer'` /
`ttfb` streaming-output scenario **settles deterministically** — PASS if the engine genuinely supports it,
or a clean **NA** — and a full 558-scenario run **completes without hanging**. WHAT to figure out: how the
runner drives a `target:'stream'` op (it likely hands the adapter a streaming **destination** the adapter
currently ignores, or the post-op probe of a stream-shaped output never resolves), and either (a) wire the
engine's real `StreamTarget` sink through the adapter so writes happen and the op settles, or (b) make the
adapter recognize `target:'stream'`/`target:'writes'` shapes it does not support and NA them *before* any
op can hang — **honestly** (never a fake number). Confirm with a full-family `--feature streaming-output`
run that finishes. This is the single most important fix: **without it you cannot measure the aggregate.**

### B. The 2 remaining FAILs after the Session-2 flips (Node-validatable — write the failing oracle first)

1. **`mux/opus_to_ogg` (+ likely `mux/vorbis_to_ogg`) — duration short by ~0.067 s.** Re-muxing Opus into
   Ogg via the seam (`OggMuxer` in `src/drivers/ogg/ogg-write.ts`, fed by the new `oggAudioPackets`)
   produces an output whose probed duration (9.94 s) is **shorter** than the source (10.007 s). **End-state:**
   `probe(out).durationSec ≈ probe(source).durationSec` within the oracle tolerance (≤ 0.0417 s). WHAT to
   reason about: the final **granule position** the muxer writes, and Opus **pre-skip** accounting (the
   total decoded samples = Σ frame samples − pre_skip; the last page's granule must reflect the true end).
   Add a Node round-trip oracle in `ogg-write.test.ts` that re-reads the granule/duration and asserts it
   matches the source within tolerance — make it **fail first**.

2. **`remux/h264_bframes_1080p_mp4_to_mkv` — reimport duration exceeds source by ~0.134 s.** One specific
   B-frame 1080p file: the WebM output's reimported duration (10.134 s) is **longer** than golden (10.0 s,
   tol 0.1 s). Decode order is now correct (the rest of mkv-remux passes); only the duration is over.
   **End-state:** reimport duration within tolerance. WHAT to reason about: `WebmMuxer.buildBlockTimeline`
   `endMs` (last presented PTS + duration) vs the per-track end under B-frame reorder, and whether the
   audio vs video track-end differs from the source. Reproduce in Node with a B-frame fixture; assert the
   computed `endMs` equals the true presentation end.

### C. Cross-container foreign-packet muxers (#75, several NA mux/remux scenarios)

3. **`ogg` `createMuxer` accepting foreign demuxed packets** (Opus/Vorbis/FLAC-in-Ogg) and **`mpegts`
   `createMuxer`** accepting foreign packets (H.264/HEVC/AAC). Today `mpegts.createMuxer` and several ogg
   paths are typed misses, so `mux/*_to_ogg`, `flac_to_*`, `h264…→ts`, etc. are NA. **End-state:** a
   single-source cross-container mux through the seam produces a faithful Ogg / MPEG-TS the harness
   reference-reimport accepts; an illegal codec→container stays a typed `CapabilityError` → NA (never a
   wrong file). Each is **strictly disjoint** (one agent per container) — fan them out. Update the adapter's
   `MUX_FAITHFUL_TARGETS` / `containersOut` only for pairs an oracle proves.

### D. Image decode in-browser + registration (coverage lever)

4. **Wire `ImageDecoder`** (`src/codecs/image/decode.ts` already exists) as a registered driver in
   `src/drivers/defaults.ts`, and **advertise it in the adapter** (`containersIn` + the relevant decode
   capability). The image **probe** is already validated; decode is browser-only (gate it, v8-ignore the
   browser path, Node-test the pure parts). **End-state:** image decode/probe scenarios that are NA today
   flip to PASS in-browser; `defaults.ts` registration is idempotent and adds no eager-bundle weight beyond
   budget. NB: `defaults.ts` is a **shared** file — the LEADER edits it centrally after the image agent
   delivers the driver, to avoid parallel-edit conflicts.

### E. Verify the new browser-decode paths actually decode (transcode family)

5. The Gap#5 audio `packets()` framing is **Node-validated**, but the actual **in-browser decode**
   (ADTS→AAC raw-AU + synthesized ASC; MP3 raw frames; Ogg de-laced Opus/Vorbis with the right
   `description`) is only proven by the harness. **End-state:** run `--feature transcode` and confirm the
   audio-extract transcodes (`aac→pcm`, `mp3→aac`, `opus→aac`, etc.) flip NA→PASS; if a browser decode
   fails, reason about the `description`/framing the decoder needs (raw-AU vs framed; OpusHead presence)
   and fix the demuxer's emitted bytes/config — **never** weaken the oracle.

### F. Coverage gate ≥ 90% branch (currently ~88%; see ADR-044)

6. Lift `src/codecs/wasm-mp3/mp3.ts` and `src/codecs/wasm-aac/aac.ts` frame-header **branch** coverage with
   real MPEG-1/2/2.5 + VBR/CBR + free-format header tests; mark genuinely browser-only image
   decode/driver paths `/* v8 ignore */` and Node-test their pure parts. **End-state:** `vitest run
   --coverage` reports **≥ 90% on all four metrics** (statements/branches/functions/lines) with **zero**
   coverage-only no-op tests (ADR-044: never tickle an unreachable `noUncheckedIndexedAccess` `?? fallback`
   — exclude those honestly via `/* v8 ignore */` or a config branch exclusion, never lower the threshold
   on real branches).

### G. Remaining FAIL-class items (finish + validate with real tests)

7. **#65 worker isolation** and **#66 fuzz battery** — finish and validate with real tests (garbled /
   truncated / zeroed / bitflipped / empty inputs reject cleanly — no crash, no wrong output). **#62 trim
   corrupt-source** is already settled honestly (ADR-043: entropy-coded bitflips are undetectable at the
   container level without a full decode — keep the honest graceful-failure, no filename-match fake).

### H. THE WIN — measurement gate (the external judge; run AFTER A–G land, in this exact order)

8. **Re-vendor** (`bun run build && bun run vendor-wasm`, then copy `dist/*.{js,d.ts,wasm}` into the harness
   `vendor/`, wiping stale hashed chunks first). **Full fresh chromium run** of all 13 families (clear
   `results/.browser-cache/chromium` first), then **`bun scripts/aggregate.mjs`** to get the leaderboard.
   Identify the **largest remaining NA buckets** and target them (close NA = the win). Then **webkit +
   firefox** full runs. **Iterate A–G until the aggregate WIN vs all 7 engines holds on every browser**,
   on strict oracles, measured fresh. Record per-family results. **This is the finish line of §2.**

### I. Docs + CI

9. Every change → doc update + ADR (`02-decision-records.md`, ADR-046+). Keep `README` quickstart +
   runnable examples current. Final `biome ci` + full `bun run test --coverage` + CI workflow green.

## 4. Mechanics (env + harness — exact)

- **bun 1.3.14** (NOT npm/npx). Gate: `bun run typecheck`, `bunx biome ci .`, `bunx vitest run --coverage`,
  `bun run build`. Re-vendor for the harness: `bun run build && bun run vendor-wasm`; then **wipe** the old
  `vendor/*.{js,d.ts,wasm}` and copy fresh `dist/*.{js,d.ts,wasm}` to
  `../media-test/media-browser-test/src/engines/aibrush-media/vendor/` (stale hashed `defaults-*.js` /
  `chunk-*.js` from a prior build will otherwise linger; verify every relative import in `vendor/*.js`
  resolves).
- **Run the harness:** `cd ../media-test/media-browser-test && rm -rf results/.browser-cache/chromium &&
  bash scripts/run.sh --engine aibrush-media --browser chromium [--feature <family>]`. **Always clear the
  browser profile before each run** (stale-session bug). Results land in `results/raw/chromium-*.json`
  (`status` ∈ PASS / FAIL / NA_ENGINE / NA_BROWSER; per-oracle detail in `oracleOutcomes`); score with
  `bun scripts/aggregate.mjs`. Families: transcode, robustness, mux, probe, remux, demux, decode-seek,
  trim, audio-dsp, performance, streaming-output, metadata, encryption (558 total). `ffprobe` / `afinfo` /
  `sips` are available as independent oracles. **Playwright + chromium/webkit/firefox are installed.**
- **HANG hygiene:** if a run stalls (0 new results for minutes — check `results/raw/.partial/`), kill the
  tree (`pkill -f "run.sh --engine"; pkill -f launch.mjs; pkill -f serve.sh; pkill -f "Chrome for Testing"`)
  and take the partial. Do NOT run agent workflows during a harness run (CPU starvation → stall).
- The adapter's `capabilities()` / `containersIn` / `containersOut` / `MUX_FAITHFUL_TARGETS` / `features`
  gate what is attempted vs NA. Declaring a capability the engine genuinely does is a cheap coverage lever
  — but **never advertise unverified output** (honesty §15).
- **Real fixtures** under `fixtures/media/` + `fixtures/media-derived/` (with provenance); only a couple of
  adts/mp3/ogg fixtures exist — **download more diverse ones** (≥5/feature) where coverage demands it.

## 5. Definition of Done for Session 3

Run the full §2 checklist. The headline: **a fresh, multi-sample, cross-browser (chromium + webkit +
firefox) 558-feature run where `aibrush-media` WINS in aggregate vs each of the 7 reference engines**, with
typecheck / lint / format / coverage ≥ 90% / CI all green, budgets met, docs + ADRs in sync. Begin by
ULTRATHINKing the §3.A hang (it gates measurement), then fan out §3.B–G across parallel opus agents, then
run §3.H. Do not stop until every box is green.
