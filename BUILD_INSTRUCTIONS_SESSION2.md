# BUILD_INSTRUCTIONS — Session 2 (finish aibrush-media to DoD-green)

> Companion to `BUILD_INSTRUCTIONS.md` (the original, still binding for §2 Definition of Done) and
> `CLAUDE.md` + `docs/architecture/`. Read all of them first. This file is the **remaining-work plan**.

## 0. Where Session 1 left off

`aibrush-media` is ~80% to the Definition of Done. **main is GREEN** (typecheck 0 errors, `biome ci` 0,
~1436 node tests pass, eager-bundle budget 37.8 kB ≤ 50 kB). The gap is **coverage / the aggregate win**
plus a handful of FAILs and the ≥90%-coverage + cross-browser + full-run gates.

### Already DONE — verify and build on, do NOT redo

- **Phase 0** scaffold; **Phase 1** MVP — WebCodecs codec tier (decode/encode/transcode/seek, hw→sw
  `isConfigSupported` fallback), GPU + CPU video filters.
- **Phase 2** WASM tails — real Symphonia **Vorbis / AAC / MP3** decoders, registered in
  `src/drivers/defaults.ts`, co-vendored via `scripts/vendor-wasm.ts` (ADR-042). Opus/VPx are honest
  core-less scaffolds (libopus/libvpx need emcc — out of scope).
- **Containers** (probe + demux): mp4 (+ fragmented/CMAF), mov, wav, mp3, ogg, webm/mkv, flac, adts,
  mpegts, hls, aiff, caf, avi.
- **Muxers**: mp4 (faststart, huge-file-safe, mov `qt` brand), webm/ebml, ogg (CRC-verified), wav,
  aiff/caf; **cross-container remux** (#74 `remuxViaSeam` → webm/mkv/ogg).
- **decrypt**: CENC `cenc` + `cbcs` + HLS-AES (NIST-vector validated); EME/ClearKey → immediate
  CapabilityError (no hang).
- **Harness 0-crash blocker FIXED**: decode + encode enqueue-into-closed-stream guards; adapter per-op
  **30 s timeout** + AbortController cancellation + page-error safety net (no run can hang/zero again).
- **Budget gate GREEN** (tsup `minify` + `keepNames`). **Lint/format gate GREEN**.
- **Image probe** (`src/codecs/image/probe.ts`) validated on 5 real downloaded images
  (`fixtures/media-derived/img/`, sips/ffprobe oracles) + `scripts/bench-image.ts`; 82% stmts.
- **Adapter `containersOut`** widened to webm/mkv/ogg → remux 7→25 PASS, mux 8→14 PASS (+24).
- **Leaderboard**: `bun scripts/aggregate.mjs` (in the media-test repo).
- **Last fresh chromium leaderboard: 214 PASS / 96.4% conformance / 39.8% coverage** vs mediabunny
  91.4%. **Coverage is THE gap** — we tie 100% conformance in 9/13 families but win none.

## 1. Definition of Done (unchanged — `BUILD_INSTRUCTIONS.md` §2)

Every box green: all ops + full codec/container set; strict-oracle validation on ≥5 real **downloaded**
diverse files; **aggregate benchmark WIN vs all 7 engines** in the 558-feature harness, measured fresh,
**cross-browser**; typecheck / lint / format / **coverage ≥ 90% (all 4 metrics)** / cross-browser green;
budgets met; ESM + `.d.ts` packaged; docs in sync (every change → doc + ADR same commit); CI green.
Never stop at "mostly done"; never skip a test; never weaken an oracle; never fake.

## 2. Remaining work — priority order (the path to the aggregate win is COVERAGE)

336 scenarios are NA because the engine doesn't yet declare/implement them. Closing those IS the win.

### A. Engine capability gaps — biggest coverage levers

1. **#61 DTS packet-seam** (flips 6 FAILs: 2 mkv-remux + 4 demux golden-packets). The seam
   `packets(): ReadableStream<EncodedChunk>` and `Muxer.write(chunk: EncodedChunk)` use **sealed
   WebCodecs chunks** (only `timestamp`=PTS). Carry DTS: a `{ chunk, dtsUs? }` packet view (or a parallel
   field) in `src/contracts/driver.ts`. The mp4 driver already computes `sample.dtsUs` (`samples.ts`) —
   stop dropping it at `mp4-driver.ts:~286`; webm/mp4 muxers must write DTS; the harness adapter reads
   `dtsUs` for the golden-packets decode-order sort. **This is a cross-cutting cascade** (~11 drivers +
   muxers + engine + adapter): do it as ONE coordinated workflow + an **ADR**, keep main green.
2. **Gap#5 audio `packets()`** — `adts/mp3/ogg` drivers still throw CapabilityError from `packets()` →
   unblocks aac→pcm, mp3→aac, opus→aac audio-extract transcodes.
3. **Streaming-output wiring** (26 NA) — `convert/encode/remux { fragmented: true }` →
   `fragmentMp4` → `writeToStreamTarget` (both built, on `/core`). Wire the selection in
   `src/api/codec-pipeline.ts` + map the streaming-output scenarios in the adapter.
4. **ogg/ts `createMuxer`** accept foreign demuxed packets (#75) — ogg: opus/vorbis/flac; ts: h264/hevc/aac.
5. **Transcode targets** — confirm hw→sw (#76) flips VP8/VP9/AV1 software-encode on chromium/FF; wire
   video filters (resize/crop/colorspace) into the convert plan.
6. **Image decode in-browser** — wire `ImageDecoder` (`decode.ts`), register the image driver in
   `defaults.ts`, advertise it in the adapter.

### B. FAILs

7. `mux/mp4_progressive_buffer` — `fastStart:false` box-layout (mdat-before-moov); forward the fastStart
   knob through the mux op.
8. **#62 trim corrupt-source** — entropy-coded bitflip is undetectable at the container level without a
   full decode (the bounds-hardening for detectable corruption already landed); **record an ADR** of the
   honest limitation rather than fake a filename match.
9. **#65 worker isolation** + **#66 fuzz battery** — finish + validate (real tests).

### C. Coverage gate ≥90% (currently 88.37% branch)

10. Lift `src/codecs/wasm-mp3/mp3.ts` (br66) + `src/codecs/wasm-aac/aac.ts` (br70) with real MP3/AAC
    frame-header branch tests (MPEG-1/2/2.5, VBR/CBR, free-format); mark genuinely browser-only image
    decode/driver paths `/* v8 ignore */` and node-test their pure parts.

### D. Measurement (the acceptance gate)

11. **Re-vendor → fresh full 558 chromium run → `bun scripts/aggregate.mjs`** to confirm the coverage
    climb; then **webkit + firefox** full runs (WebKit gating already fixed → Errors should be NA).
    Iterate A–C until the aggregate **WIN** vs all 7 engines holds.

### E. Docs + CI

12. Every change → doc update + ADR (`docs/architecture/02-decision-records.md`, ~ADR-043+). Final
    `biome ci` + full `bun run test` with coverage + the CI workflow green.

## 3. HOW TO WORK — opus agents, Workflows mode, ULTRATHINK (MANDATORY)

- **Drive this with the Workflow tool (multi-agent orchestration) using opus agents at MAX reasoning
  effort (ULTRATHINK), as much as possible.** Author a workflow per phase; fan out parallel opus agents
  on **strictly disjoint files** (one per driver/feature).
- Per agent: ULTRATHINK (restate goal; enumerate edge cases — B-frames, VFR, seek, cancel, frame
  lifetime, backpressure; design note) → write the **failing** strict-oracle test on ≥5 real downloaded
  files → implement to SOTA → pass → add a fresh multi-sample benchmark → green.
- **Pattern**: understand (parallel readers) → implement (fan-out, disjoint) → **adversarially verify**
  (independent skeptic agents per finding) → integrate (the LEADER runs the harness — single serial
  oracle — and re-vendors).
- Keep agents **WARM**: on finish, reassign the next backlog item; never cold-start while backlog remains.
- The one cross-cutting change (**#61 DTS seam**) must be ONE coordinated workflow — never parallel edits
  to the shared `driver.ts` contract.

## 4. Mechanics (env + harness)

- **bun 1.3.14** (NOT npm/npx). Gate: `bun run typecheck` (3 tsconfigs), `bunx biome ci .`,
  `bunx vitest run [path] --coverage`, `bun run build` (tsup ESM + `.d.ts`), `bun run vendor-wasm`.
- **Re-vendor for the harness** (engine dist → harness): `bun run build && bun run vendor-wasm` then copy
  `dist/*.js dist/*.d.ts dist/*.wasm` → `../media-test/media-browser-test/src/engines/aibrush-media/vendor/`.
- **Run the harness**: `cd ../media-test/media-browser-test && rm -rf results/.browser-cache/chromium &&
  bash scripts/run.sh --engine aibrush-media --browser chromium [--feature <family>]`. **Clear the
  browser profile before each run** (stale-session "Opening in existing browser session" bug). Results in
  `results/raw/chromium-*.json`; score with `bun scripts/aggregate.mjs`. Families: transcode, robustness,
  mux, probe, remux, demux, decode-seek, trim, audio-dsp, performance, streaming-output, metadata,
  encryption (558 total).
- The **harness adapter** (`media-test/.../engines/aibrush-media/adapter.ts`) is the harness's OWN file
  (edits are live — NOT vendored). Its `capabilities()` / `containersOut` / `MUX_FAITHFUL_TARGETS` gate
  what scenarios are attempted vs NA. Declaring a capability the engine already does is a cheap coverage
  lever (e.g. the containersOut widen = +24 PASS) — but never advertise unverified output (§15 honesty).
- **Real fixtures**: download ≥5 diverse to `fixtures/media-derived/` with provenance; use INDEPENDENT
  oracles (ffprobe / sips / afinfo) so the test can genuinely fail.
- **NEVER run git** (the user commits). Keep `main` green at every step.
