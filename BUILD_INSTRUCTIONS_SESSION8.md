# BUILD INSTRUCTIONS — SESSION 8 (focused: finish the genuinely-missing Chrome features)

> **Audience:** Claude Code (lead + optional fan-out).
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§2/§5/§6/§10/§13 remain **fully binding** (ULTRATHINK, every line SOTA, no feature without strict validation + a benchmark on the real corpus, docs-as-law, never fake).
> **How to use:** max effort. Read this, then [`SESSION8_GOAL.md`](SESSION8_GOAL.md). Execute §4 to all-green. **This session is deliberately narrow — build only the three features in §3; touch nothing Chrome already does.**

---

## 0. SESSION-8 PRIME DIRECTIVE (on top of parent §0)

Implement, **strictly validate, and benchmark only the three pure-TS features Chromium genuinely lacks** (§3). They are **gaps in our code, not browser limits**, so each must reach a real PASS on a strict oracle — never a stub, never a fake. **Do not** build anything Chrome already does, **do not** start cross-browser work, **do not** touch the honest-NA cells. **NEVER FAKE** (parent §0.6): a declared-but-unbuilt path FAILs the oracle.

---

## 1. STARTING STATE — VERIFIED (2026-06-30, chromium)

- **#1; 557 PASS / 0 FAIL / 0 ERROR / 7 NA** (`results/raw/chromium-2026-06-28T*…`). The 7 NA = **4 signed-off honest-NA** (2× MP3 encode, HEVC Main10, H.264 two-pass) **+ 3 phantom** retired IDs (`image_*_probe_na`, superseded by passing `image_*_probe` — prune from the pool). Every *buildable* Chromium cell already passes.
- **Already landed — do NOT redo:** ADR-113 streaming WebM/MKV remux, ADR-114 bounded source-range trim, ADR-121 CENC `cens` + HLS SAMPLE-AES decrypt.
- **The only buildable-on-Chrome gaps left are the three pure-TS items in §3.** Highest ADRs in use: **114 and 121** → assign new ones from the free range **115/116/117** (verify against `docs/architecture/02-decision-records.md`).
- **Budgets razor-thin** (eager ~49.95/50, first-op ~246/256) → any new driver code registers behind a lazy default proxy and lazy-splits its glue (ADR-103 pattern); `.wasm` is irrelevant here (no new cores).

---

## 2. DEFINITION OF DONE (scoped)

Not done until **every** box is green:

- [ ] **Metadata-write breadth (R1):** WAV/AIFF/CAF tag write implemented; **metadata-exact** reimport oracle on ≥5 real fixtures (write→reparse == input tags; all other bytes unchanged), bit-exact in force-software; benchmark recorded.
- [ ] **WAV mux (R2):** `WavDriver.createMuxer()` produces a real container; **structural + bit-exact PCM** `demux(mux(x))==x` on ≥5 real fixtures; benchmark recorded.
- [ ] **AVI mux (R3):** RIFF muxer with `idx1` (+ OpenDML for >1 GB); structural reimport via an **independent demuxer** (ffmpeg) + `demux(mux(x))==x`; benchmark recorded.
- [ ] **Tests cover the missing features only;** a full regression run shows **no PASS→FAIL** on the existing board (re-vendor + re-measure Chromium once at the end).
- [ ] New ADRs (115/116/117) + `docs/notes/<feature>.md` design notes; docs in sync.
- [ ] `bun run gate` exits 0; coverage ≥90%; budgets green **with margin**; anti-cheat green.

---

## 3. THE THREE FEATURES (parent §6 TDD loop: design note → failing strict test → SOTA impl → pass → benchmark → green commit)

### R1 — Metadata-write breadth *(highest value: touches the required WAV container set)*

- **What:** add tag writers so `media` can write metadata into **WAV (`LIST`/`INFO` + `bext`), AIFF (`ANNO`/`NAME`/etc.), CAF (`info`)**. Today `src/api/engine.ts:1196` declines every target outside MP4/MKV/MP3/FLAC/OGG.
- **Where:** the per-container writer modules under `src/drivers/{wav,aiff,caf}/` + the dispatch at `engine.ts:1196`.
- **Oracle:** metadata-exact — write a tag set, reparse with our probe **and** an independent tool, assert tags equal and the audio payload bytes are byte-identical. ≥5 real fixtures/format.

### R2 — WAV container mux

- **What:** complete `WavDriver.createMuxer()` (`src/drivers/wav/wav-driver.ts:206`, currently a typed not-yet-implemented throw asserted in `wav.test.ts:87`) so foreign-packet→WAV mux is first-class (PCM `fmt`/`data`, correct sizes/endianness, `LIST` passthrough).
- **Oracle:** structural + **bit-exact PCM** `demux(mux(packets))==packets`; reject non-PCM inputs with a typed error. ≥5 real PCM fixtures (s16/s24/f32, LE/BE).

### R3 — AVI mux *(completeness; not in the DoD container set — skip if minimal)*

- **What:** replace the `src/drivers/avi/avi-driver.ts:155` throw with a real RIFF AVI muxer: `hdrl/strl` headers, `movi` with chunk interleave, `idx1`, OpenDML (`indx`/`RIFF AVIX`) for >1 GB.
- **Oracle:** structural reimport + **independent demux** (ffmpeg) of the muxed AVI == source packets; `demux(mux(x))==x`.

---

## 4. PHASES (each to a green gate; fan out — the three touch disjoint files)

- **8.A — Metadata-write breadth (R1):** design note → failing metadata-exact tests → impl → pass → bench. **GATE:** R1 box green.
- **8.B — WAV mux (R2):** flip the `wav.test.ts:87` assertion to require a working muxer → impl → pass → bench. **GATE:** R2 box green.
- **8.C — AVI mux (R3, optional):** failing structural/round-trip tests → impl → pass → bench. **GATE:** R3 box green.
- **8.D — Close-out (lead):** re-vendor + one Chromium re-measure to confirm **no regression**; `bun run gate` → 0; ADRs 115/116/117 + design notes written; docs synced. **GATE:** parent §2 (scoped) fully green. **DONE.**

---

## 5. EXPLICITLY OUT OF SCOPE (do not build this session)

- **SW VP8/VP9/AV1 encoders** — Chrome already encodes these via hardware WebCodecs; a software tail only matters off-Chrome, which is deferred.
- **WebKit / Firefox cross-browser** — deliberately set aside.
- **MP3 encode** (license/LGPL), **HEVC Main10 output** (no permissive core + no WebCodecs 10-bit target), **H.264 two-pass** (WebCodecs exposes no first-pass stats) — these stay **honest-NA**; do not fake them.

---

## 6. ORCHESTRATION (disjoint files — parent §10)

The three features touch disjoint trees (`src/drivers/{wav,aiff,caf}`, `src/drivers/avi`, plus the `engine.ts:1196` dispatch which the **lead** owns to avoid a shared-file race). Lead owns the gate, the final re-vendor + Chromium re-measure, and the `engine.ts` dispatch edits; agents own one feature each. Per feature: failing strict test → SOTA impl → strict oracle green → fresh bench → adversarial verify (mutated golden must reject).

---

## 7. NON-STOP (parent §13)

Drive each feature to green; don't stop between; blocked → SOTA + ADR + continue. **Done when the three §2 boxes are green, the existing Chromium board is un-regressed, and `bun run gate` exits 0.** Then report the scoped scorecard.

**Now: read [`SESSION8_GOAL.md`](SESSION8_GOAL.md), create one task per R-feature, and begin Phase 8.A. Do not expand scope beyond §3.**
