# 11 — Testing & Validation Strategy

> Operationalizes ADR-018 (strict self-validation). The benchmark found **0 CHEAT but 206 WEAK-GATE + 3 SUSPECT** "wins" — passes resting on loose gates or hardcoded shortcuts [data: Finding 7]. Our own correctness must be gated on the **strongest applicable oracle**, and our oracles must be **able to fail**.

## 1. Oracle strictness ladder

From strongest to weakest. **Gate on the strongest one the operation admits.**

1. **Bit-exact / cryptographic** — `decoded-frames-bitexact` (sha256 of decoded RGBA vs golden), `golden-packets` (exact packet bytes/sizes/keyframes), `decrypt-bitexact`.
2. **Structural / metadata-exact** — `golden-metadata`, `mp4-box-layout`, `reference-reimport`, `seek-accuracy`, `trim-boundaries` (+ boundary-frame digests), `decoded-audio-pcm`, `alpha-plane`, `property-invariant`.
3. **Perceptual proxy** — `ssim-psnr`. **Only acceptable with `exactFrames > 0`**; an `exactFrames==0` SSIM-only pass is treated as *not validated* (this is the WEAK-GATE trap).
4. **Smoke** — `playback-smoke` (output plays). **Necessary but never sufficient** — it is an *additional* gate, not a substitute for 1–3. (The benchmark's `h264→vp8` produced output that failed playback-smoke; we treat that as a hard fail.)

## 2. Per-operation oracle mapping

| Operation | Primary oracle | Plus |
|---|---|---|
| probe | `golden-metadata` (exact + ±1-frame duration) | — |
| demux | `golden-packets` | — |
| decode/seek | `decoded-frames-bitexact` (force-software) | `seek-accuracy` |
| encode | `ssim-psnr` (`exactFrames>0`) | `playback-smoke`, `reference-reimport` |
| mux | `reference-reimport` | `mp4-box-layout` |
| remux | `reference-reimport` | anti-copy check (§5) |
| trim | `trim-boundaries` + boundary-frame digests | — |
| convert | `ssim-psnr` (`exactFrames>0`) | `playback-smoke`; bit-exact on copy paths |
| audio-dsp | `decoded-audio-pcm` (sample-exact) | `property-invariant` for lossy |
| filters | exact digest (geometric) / `ssim` | — |
| decrypt | `decrypt-bitexact` | graceful-reject for unsupported schemes |
| streaming-output | `reference-reimport` | duration-materialized property |
| robustness | strengthened `graceful-failure` (§5) | — |

## 3. Golden fixtures

- **Real media only** — no synthetic/empty/mock inputs as the subject under test.
- **Baked goldens** committed alongside fixtures: frame sha256 digests, golden packet manifests, golden metadata, cleartext twins for decrypt, reference re-imports.
- Goldens for **deterministic** paths (software decode, container layout, packets, crypto) are bit-exact. Goldens for **hardware** paths are tolerance-banded (SSIM/PSNR) because hardware output is platform-specific — and the *bit-exact* version is validated in `force-software`.

## 4. Test layers

1. **Unit** — per driver: encode→decode round-trips, edge dims, config handling.
2. **Contract conformance** — *every* driver of a kind runs the **same** suite (the `CodecDriver`/`ContainerDriver`/`FilterDriver` conformance harness), so a WASM-FLAC driver and a WebCodecs-H264 driver are held to identical seam/lifecycle/error behavior ([`05`](05-driver-contracts.md)).
3. **Integration** — full pipelines (`convert`, `trim`, `remux`, streaming) end-to-end against goldens.
4. **Property / metamorphic** — invariants that need no golden:
   - `decode(mux(x)) == decode(x)` (mux preserves frames),
   - duration preserved across container changes,
   - resize-to-same-size is idempotent,
   - trim additivity: `trim(a,b)+trim(b,c) ≈ trim(a,c)`,
   - probe duration consistent across containers,
   - double-remux is stable.
5. **Robustness / fuzz** — garbled/truncated/zeroed/bitflipped/empty inputs must reject cleanly (no crash, **no wrong output**).
6. **Performance** — multi-sample (`n>1`) wall/throughput/peakMemory/longtasks, re-measured fresh. **The benchmark's perf margins were cached single-sample [data: Finding 7]; we do not trust or reuse them — we re-measure.** The concrete harnesses (warmup + median + separate RSS pass + checksum sink + a `--check` regression gate) and the committed pure-TS baseline numbers are in [`14-benchmarks.md`](14-benchmarks.md); the WebCodecs/GPU tier is measured on the browser/target runtime (ADR-025).

## 5. Anti-cheat self-checks (lessons from the 3 SUSPECT findings)

These are CI gates on *our* code, derived from what we caught in the benchmark:

- **Oracles must be able to fail.** Mutation-test each oracle: feed it deliberately wrong output and assert it rejects. An oracle that always passes is a bug.
- **No input→output passthrough passing as work.** For `convert`/`remux`/`trim`, assert the output is genuinely re-laid-out / re-encoded — not the input with a few header bytes flipped (the `ftyp`-byte-flip SUSPECT case). Compare structural layout, not just "valid container."
- **No per-asset hardcoding.** Tests run on a *matrix* of fixtures (sizes, codecs, containers); a path that only works for one fixture id fails the matrix (the hardcoded-sample-table SUSPECT case).
- **No degenerate metrics.** A performance metric with no sample is **N/A**, never `0`/best (the empty-`peakMemory` SUSPECT case). The harness treats missing samples as N/A.
- **Plausibility checks.** Assert measurements are physically plausible for the real media (real packet/keyframe counts, durations, SSIM ranges, byte sizes).

## 6. Determinism in CI

- **Correctness CI runs in `force-software`** (ADR-007) for cross-machine-reproducible goldens; bit-exact gates apply there.
- **Hardware paths** are tested for *plausibility* (SSIM/PSNR within band + playback-smoke), not bit-identity, since they vary by GPU.
- Run across **real browsers** (Playwright/WebDriver: Chromium, Safari/WebKit, Firefox) so WebCodecs/GPU behavior is exercised, not mocked.

## 7. Relationship to the existing benchmark harness

The sibling `aibrush.lib/media-test/media-browser-test` suite (558 features, 13 families, the oracle implementations) is our **external regression battery**: we register `aibrush-media` as an engine and must (a) win in aggregate and (b) pass on the **strict** oracles, with our own additional anti-cheat gates from §5. It is the acceptance test for "did we actually build the best-of-the-best."
