# SESSION 8 — GOAL (finish the genuinely-missing Chrome features)

## Scope (binding)

Chromium is already at its honest ceiling — **#1, 557 PASS / 0 FAIL / 0 ERROR**; the only non-PASS are signed-off honest-NA + 3 phantom IDs. This session implements + validates **only the features the engine genuinely lacks on Chromium** (pure-TS code gaps it declines today). **Do not touch anything Chrome already does.**

**Out of scope (do NOT build):** SW VP8/VP9/AV1 encoders — Chrome already encodes via WebCodecs; all WebKit/Firefox cross-browser work; and the honest-NA (MP3 encode = license, HEVC Main10 + H.264 two-pass = WebCodecs API limit). **Already landed, do NOT redo:** streaming WebM/MKV remux (ADR-113), bounded source-range trim (ADR-114), CENC `cens` + HLS SAMPLE-AES decrypt (ADR-121).

## The missing features (the only work)

1. **Metadata-write breadth** — tag writers for WAV (`INFO`/`bext`), AIFF, CAF. Today `src/api/engine.ts:1196` declines them; only MP4/MKV/MP3/FLAC/OGG ship. *(All pure TS — a gap in our code, not a browser limit.)*
2. **WAV container mux** — complete the stubbed `WavDriver.createMuxer()` (`src/drivers/wav/wav-driver.ts:206`) so foreign-packet→WAV mux is first-class. (WAV output already works via convert; this finishes the seam.)
3. **AVI mux** — RIFF `hdrl/strl/movi/idx1` (+ OpenDML for >1 GB); replace the `src/drivers/avi/avi-driver.ts:155` "not yet implemented" throw. *(Completeness — AVI is not in the DoD container set; drop if you want strict minimalism.)*

## Definition of Done

in full details here: @BUILD_INSTRUCTIONS_SESSION8.md

- Each feature implemented to SOTA and **validated on the ≥5-file real corpus** with its strongest oracle — **metadata-exact** reimport for tags (write→reparse == input, bytes elsewhere unchanged); **structural + bit-exact PCM** round-trip and `demux(mux(x))==x` for WAV/AVI mux — **bit-exact in force-software**, plus a **fresh benchmark**.
- **Tests cover the missing features only.** The existing green Chrome surface is untouched; a single regression run just confirms no PASS→FAIL.
- New ADRs from the free range (**115/116/117**; 113/114/121 are taken) + design notes in `docs/notes/`; docs in sync.
- `bun run gate` exits 0; budgets green **with margin** (lazy-split any new driver code); coverage ≥90%; anti-cheat green.

One line: **ship + strictly validate + benchmark WAV/AIFF/CAF metadata-write, WAV mux, and AVI mux on Chromium — nothing else — with `bun run gate` green and the existing board un-regressed.**
