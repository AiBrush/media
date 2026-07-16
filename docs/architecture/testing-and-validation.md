# Testing & Validation

> **Shard S33 — cross-cutting.** Target spec for the conformance harness, the baked-golden oracle
> strategy, the determinism-mode split, and the test-support encryptors/fixtures. This is the *best*
> design plus an honest delta against today's code. Owned code:
> `src/conformance/harness.ts`, `src/conformance/noop-driver.ts`, and `src/test-support/*.ts` except
> `fuzz/corrupt.ts` (→ S22): `cbcs-encrypt.ts`, `cenc-encrypt.ts`, `corpus.ts`, `decode-goldens.ts`,
> `decrypt-twins.ts`, `dsp-goldens.ts`, `hls-sample-aes.ts`, `mp4-builder.ts`, `packet-goldens.ts`.

## 1. Purpose & scope

This family is the **correctness spine** of aibrush-media: the machinery that decides whether a feature
is *done*. Its thesis, inherited from the sibling benchmark project, is blunt: **no green strict oracle
→ no admissible feature.** A loose gate (duration-only, "SSIM with exactFrames == 0", "didn't crash",
per-asset hardcoding) is treated as a defect, not a pass — that class of shortcut produced 206 WEAK-GATE
plus 3 SUSPECT "wins" and directly motivated this strategy (measured-evidence.md_, ADR-018).

It is **cross-cutting** — it serves *every* benchmark family (probe, demux, decode-seek, transcode,
audio-dsp, mux, remux, trim, encryption, metadata, robustness, streaming-output, performance) by
supplying the shared apparatus each family's own doc plugs into:

1. **A driver conformance harness** (`harness.ts`) — the *same* seam/lifecycle/error checks every
   driver of a kind must pass, so a WASM-FLAC codec driver and a WebCodecs-H264 driver are held to
   identical behavior. Runner-agnostic (plain throwing assertions, no test-framework dependency) so a
   third-party driver author can run it under any harness (`src/conformance/harness.ts:1-11`).
2. **A no-op reference driver** (`noop-driver.ts`) — three identity drivers that prove the harness runs
   and can fail, and let kernel/registry/router tests exercise registration + selection without real
   WebCodecs/WASM (`src/conformance/noop-driver.ts:1-6`).
3. **Baked-golden shared definitions** (`decode-goldens.ts`, `packet-goldens.ts`, `dsp-goldens.ts`) —
   the single source of truth imported by *both* the bake script and the asserting test, so writer and
   reader can never drift.
4. **Independent-tool cleartext twins + encryptors** (`decrypt-twins.ts`, `cenc-encrypt.ts`,
   `cbcs-encrypt.ts`, `hls-sample-aes.ts`) — real encrypted media authored by tools we did not write
   (openssl, ffmpeg, Bento4, `node:crypto`) so the decrypt path is validated against a foreign oracle.
5. **The verified corpus loader + MP4 fixture builders** (`corpus.ts`, `mp4-builder.ts`) — read-only
   access to the checksum-pinned local media cache and minimal synthetic MP4 structures for parser
   branch coverage.

Validation is **tier-split** (ADR-025): the CI/build sandbox is Node-only (no browser WebCodecs/WebGPU,
no C→WASM toolchain), so the **pure-TS tier** (containers, FLAC/PCM codecs, DSP, crypto, packet geometry)
is validated *exhaustively in Node*; the **WebCodecs/GPU tier** and the 558-feature harness run on a
target machine with a browser. Fabricating browser/WASM results to force green is forbidden and surfaces
as a typed `CapabilityError` until the real substrate runs (measured-evidence.md_, ADR-025).

## 2. Spec & references

There is no single ISO/W3C standard for "a media test harness"; this family is governed by the standards
each oracle *pins output against*, plus the internal oracle-strategy contract.

- **W3C WebCodecs** — the frame/chunk/lifetime contract the browser-tier facets enforce
  (`close()` exactly once, flush-on-close, `isConfigSupported`):
  <https://www.w3.org/TR/webcodecs/>.
- **WHATWG Streams Standard** — the backpressure model every driver `TransformStream` must honor
  (one-frame high-water mark), asserted by the harness: <https://streams.spec.whatwg.org/>.
- **W3C Web Cryptography API (`crypto.subtle`)** — the digest primitive (`SHA-256`) that makes every
  bit-exact oracle a browser-and-Node-reproducible hash: <https://www.w3.org/TR/WebCryptoAPI/>.
- **ISO/IEC 23001-7 (Common Encryption / CENC)** — the `cenc`/`cens`/`cbc1`/`cbcs` schemes the
  encryptors invert; §9.4.2 mandates the **contiguous keystream** the twins rely on:
  <https://www.iso.org/standard/68042.html>.
- **RFC 8216 (HTTP Live Streaming)** — AES-128 full-segment and SAMPLE-AES, inverted by
  `hls-sample-aes.ts` / `decrypt-twins.ts`: <https://datatracker.ietf.org/doc/html/rfc8216>.
- **ISO/IEC 14496-12 (ISO-BMFF)** — the box grammar `mp4-builder.ts` emits and `packet-goldens.ts`
  reads: <https://www.iso.org/standard/83102.html>.
- **RFC 9639 (FLAC)** — the STREAMINFO MD5 that makes the pure-TS FLAC decoder self-validating and lets
  `decode-goldens.ts` pin bit-exact PCM: <https://datatracker.ietf.org/doc/html/rfc9639>.
- **Independent oracle tools** — the goldens are cross-checked at bake time against tools we did not
  author: **ffmpeg/ffprobe** (decode PCM, packet tables), **openssl** (AES-128-CTR/CBC ciphertext),
  **Bento4** (`mp4fragment` + `mp4encrypt` for the fragmented `cbcs` layout), and **`node:crypto`**.
  This is anti-self-confirmation (ADR-085); openssl is preferred over ffmpeg for the cipher-level twins
  because ffmpeg's `cenc-aes-ctr` muxer realigns the AES-CTR counter at each *subsample* boundary, which
  self-round-trips but is non-conformant with CDMs (ADR-086; ffmpeg also cannot open the fragmented
  `cbcs` layout — "error reading header", ADR-182). All three are cited in code
  (`src/test-support/decode-goldens.ts:15-22`, `src/test-support/decrypt-twins.ts:5-18`).

### OSS exemplar — the benchmark harness oracles

`../media-test/src/core/oracles.ts` (the sibling project's conformance gate; 4,353 lines). It is the
canonical statement of *"validate only observable output"*: every oracle checks bytes/metadata/frames
in → out using **only** the browser itself (`crypto.subtle`, `ImageData`, `OffscreenCanvas`), committed
golden JSON **baked offline by independent tools** (ffprobe/ffmpeg/Bento4), injected platform helpers,
and a **no-engine byte reader** over the engine's *own* output — it imports no adapter and no heavy
library and runs in page or Worker contexts alike (`../media-test/src/core/oracles.ts:1-24`). Its 16
oracle IDs are the taxonomy we must be able to satisfy: `golden-metadata`, `golden-packets`,
`decoded-frames-bitexact`, `decoded-audio-pcm`, `reference-reimport`, `playback-smoke`, `ssim-psnr`,
`mp4-box-layout`, `webm-live-layout`, `fanout-renditions`, `alpha-plane`, `seek-accuracy`,
`trim-boundaries`, `decrypt-bitexact`, `graceful-failure`, `property-invariant`
(`../media-test/src/core/scenario.ts:35-51`). Two design points to **match**: (a) `loadGolden` tolerates
a missing artifact (404 → field `undefined`) so a scenario may carry only a subset of golden kinds
(`../media-test/src/core/oracles.ts:57`); (b) the exemplar keeps a *per-container duration band* because
some containers (MPEG-TS/ADTS/HLS) have no precise global duration and two correct demuxers legitimately
disagree — a `±1 frame` gate is wrong there (`../media-test/src/core/oracles.ts` header, "Per-container
probe duration tolerance"). Two points to **beat**: the exemplar is a **strict black box** to us from
Session 10 on — the engine team may never read its scenario/oracle/tolerance/runner source, because
reading how the test grades is how overfitting starts (measured-evidence.md_, Session 10); our Node tier must
therefore re-derive equivalent strict oracles *independently* against ffmpeg/ffprobe/openssl and our own
baked goldens. And the exemplar's NA classification historically leaned on a message regex, which lets a
real bug that emits a capability-miss-shaped sentence silently become NA instead of FAIL — our design
makes **typed `CapabilityError` the sole NA signal** (measured-evidence.md_, competitive-gaps).

## 3. Target design

### 3.1 Data model — three layers, one direction of dependency

```
contracts/driver.ts  (types: DriverBase, CodecDriver, ContainerDriver, FilterDriver, Tier, Determinism)
        ▲                                   ▲
        │ imports types only                │ imports types only
   conformance/harness.ts            test-support/*-goldens.ts        test-support/*-encrypt.ts
   (seam + lifecycle oracle)         (bit-exact shared definitions)   (independent-tool twins)
        ▲                                   ▲                                ▲
        │                                   │                                │
   conformance/*.test.ts  ────────  scripts/bake-goldens.ts (writer)  ──  conformance/*.test.ts (asserter)
```

The invariant: **the harness and the golden definitions depend only on the driver *contract*, never on a
concrete driver, codec, or backend.** A golden definition (`decode-goldens.ts`, `packet-goldens.ts`,
`dsp-goldens.ts`) is a *pure function of bytes* imported by both the bake script and the asserting test,
so writer and reader are the same code and can never drift (`src/test-support/decode-goldens.ts:2-5`,
`src/test-support/packet-goldens.ts:2-5`, `src/test-support/dsp-goldens.ts:2-3`).

### 3.2 The strict-oracle ladder (strongest first)

The design ranks oracles by strength and always uses the strongest one that is *feasible* for the path.
Each is anti-self-confirmed by an independent tool at bake time, and each ships with a **can-fail (mutation)
arm** that proves the oracle rejects wrong data — an oracle that cannot fail is banned (ADR-018).

| Rung | Oracle | What it pins | Independent corroboration | Owned code |
|------|--------|--------------|---------------------------|------------|
| 1 | `decoded-frames-bitexact` | sha256 of decoded interleaved PCM (force-software, pure-TS FLAC/PCM) | ffmpeg decode byte-identical at bake; FLAC STREAMINFO MD5 | `decode-goldens.ts:46,63` |
| 1 | `decrypt-bitexact` | decryptor recovers openssl/ffmpeg cleartext byte-exact | openssl AES-128-CTR/CBC; ffmpeg CENC-audio twin | `decrypt-twins.ts:84,98` |
| 1 | `dsp` exact-arithmetic | sha256 of format-convert / channel-copy PCM | (target: ffmpeg `f32le`/`s24le` — see delta) | `dsp-goldens.ts:25` |
| 2 | `golden-packets` | per-packet {trackId, size, PTS µs, duration µs, keyframe} table + sha256 | ffprobe `-show_packets` count + payload bytes | `packet-goldens.ts:97` |
| 2 | `golden-metadata` | container/duration/track probe vs committed JSON | ffprobe/mediainfo at bake | `corpus.ts:91` (loader) |
| 3 | `property-invariant` | metamorphic laws (`decode(mux(x))==decode(x)`, resize-idempotence, trim-additivity) | none needed — self-referential invariant with a wrong-comparison arm | (`metamorphic.test.ts`) |
| 4 | tolerance-banded (`ssim-psnr`, `seek-accuracy`, `trim-boundaries`) | lossy/hardware paths in the browser tier | golden reference frames | browser harness |

**Determinism gate.** The bit-exact rungs are only meaningful in **`force-software`** determinism:
hardware/GPU decode is platform-specific and bit-exact wins there are M1-specific (ADR-007). The design
therefore pins bit-exact goldens under `force-software` (`decode-goldens.ts` header: "baked in
force-software"), and `auto` (hardware allowed) is validated by tolerance bands, not hashes. Guaranteed
bit-identical hardware output across machines is an explicit non-goal (measured-evidence.md_).

### 3.3 The conformance harness — seams, capability routing, honesty

`harness.ts` is the *contract* half. It asserts, for every driver kind, the seam shape and the
**honesty of `supports()`** without naming any codec or backend:

- **Identity + versioning + kind** via `assertDriverBase` — id non-empty, `apiVersion` inside the
  supported window (`isApiVersionSupported`), `kind` correct (`src/conformance/harness.ts:51-61`).
- **Valid tier/substrate** from the closed sets `TIERS = ['hardware','gpu','native','wasm']` and
  `SUBSTRATES = ['webgpu','webgl','canvas2d','native','wasm']` (`src/conformance/harness.ts:39-40`) —
  the *only* place a tier/substrate string is legal, because it is a contract-level ranking token, not a
  capability leak. **Capability routing is never named by the developer**: a driver declares a tier and
  answers `supports()`; the router picks WebCodecs → GPU → WASM. The harness only checks the declaration
  is well-formed and honest.
- **`supports()` is a total function** — it never throws (browser API probes are wrapped) even on a
  garbage config, and returns a well-typed `{ supported: boolean }`
  (`src/conformance/harness.ts:83-91,167-181`).
- **Honest miss (the miss-only rule made testable)** — a browser/WASM-tier driver with no API/core
  present in Node must answer `supported:false` for *every* query, never a phantom yes
  (`src/conformance/harness.ts:177-180`). This is exactly the "download heavy WASM only on a hardware
  miss, fail loudly on a true miss" philosophy expressed as an assertion.
- **Factory shape** — `createDecoder`/`createFilter` return a `TransformStream`; `createEncoder`/
  `createMuxer` return a stream *or throw a typed `MediaError`*, never a bare string
  (`src/conformance/harness.ts:93-104,138-143,321-333`).

The harness is deliberately split into **Node-checkable facets** (`assertCodecDriverNodeFacets`,
`assertFilterDriverNodeFacets`) and the **full facets** (`assertCodecDriverConforms`,
`assertContainerDriverConforms`, `assertFilterDriverConforms`). Container drivers are pure TS and run the
full check in Node; codec/filter drivers are environment-dependent and run only the Node facets in CI,
with the browser harness layering the true-support + frame-flow facets on top
(`src/conformance/harness.ts:145-159,184-216`).

### 3.4 Edge-case treatment (mandatory)

- **B-frames (PTS/DTS reorder).** The `golden-packets` oracle pins each packet's PTS, duration, and the
  video keyframe flag (`src/test-support/packet-goldens.ts:37-44`), and `mp4-builder.ts` emits a `ctts`
  composition-offset box so a synthetic reordered stream can be built
  (`src/test-support/mp4-builder.ts:108`). **Gap:** the golden row carries `ptsUs` but **not** `dtsUs`,
  so a B-frame stream's decode-order timeline is not pinned (delta §5.8). The browser-tier frame-flow
  facet must additionally assert the decoder emits frames in *presentation* order after reorder.
- **VFR (variable frame rate).** Captured structurally: each golden packet carries its own `durationUs`
  (`src/test-support/packet-goldens.ts:40`), so a variable cadence is pinned exactly rather than
  collapsed to an average fps. Duration *oracles* for containers with no global duration
  (MPEG-TS/ADTS/HLS) must use the per-container band, mirroring the exemplar
  (`../media-test/src/core/oracles.ts`, per-container duration tolerance), not the `±1 frame` gate.
- **Seek.** Not exercised in the Node test-support tier (seek needs `VideoDecoder`); the `seek-accuracy`
  oracle is a browser-tier facet (exemplar `../media-test/src/core/scenario.ts:47`). The Node-feasible
  proxy is `trim-diversity`: a keyframe stream-copy trim must **start on a keyframe** so the output
  decodes (`src/conformance/trim-diversity.test.ts:5-9`).
- **Cancel.** Largely **N/A** to the baked-golden Node tier (a golden is a pure byte→hash function with
  no long-lived pipeline). It applies to the *browser* frame-flow facet, which must prove an aborted
  decode/encode drains and closes every in-flight frame — see frame lifetime.
- **Frame lifetime (`close()` exactly once).** This is the **most important not-yet-built facet.** The
  harness header already declares it: "The deep frame-flow checks (close-once discipline, flush-on-close)
  require real WebCodecs and run under browser-mode… layered on top of these"
  (`src/conformance/harness.ts:8-11`) — but **no owned code implements it**. The target design adds
  `assertCodecDriverFrameFlow` / `assertFilterDriverFrameFlow` that pump real `VideoFrame`/`AudioData`
  through the driver's `TransformStream`, wrapping each frame's `close()` with a counter and asserting
  every input frame is closed **exactly once** (never zero, never twice), including on flush and on
  cancel/abort (delta §5.1).
- **Backpressure.** The harness currently only checks the factory *returns* a `TransformStream`
  (`isTransformStreamLike`, `src/conformance/harness.ts:42-49,95`); it does **not** yet assert the
  one-frame high-water mark. Target: writing a second frame without reading the first must leave
  `writer.desiredSize ≤ 0` (delta §5.2), enforcing the WHATWG Streams backpressure the whole engine
  relies on.

## 4. Current state

**No god-files, no layering inversions** — every owned file is small (harness.ts is 338 lines; the
largest test-support file, `hls-sample-aes.ts`, is 319) and depends only on `contracts/`, the SUT it
inverts, and `util/digest`. That is genuinely good. The smells are specific and enumerable.

- **`conformance/harness.ts`** — the seam/honesty oracle. `ConformanceError`
  (`src/conformance/harness.ts:31`); `assertDriverBase` (`:51`); the full checks
  `assertCodecDriverConforms` (`:72`), `assertContainerDriverConforms` (`:114`),
  `assertFilterDriverConforms` (`:225`); the Node facets `assertCodecDriverNodeFacets` (`:160`),
  `assertFilterDriverNodeFacets` (`:191`); probe matrices `nodeCodecProbes` (`:251`), `nodeFilterProbes`
  (`:274`). **Smells:** (a) the browser frame-flow facet is *declared* (`:8-11`) but **absent**; (b) the
  garbage-probe in the full codec check is a single `video/decode` query (`:88-92`) while the Node facet
  uses a richer decode+encode+garbage matrix (`:251-271`) — the two paths test `supports()` totality
  unevenly.
- **`conformance/noop-driver.ts`** — the reference identity drivers `NOOP_CODEC` (`:39`),
  `NOOP_CONTAINER` (`:50`), `NOOP_FILTER` (`:74`), and `NoopDriverModule` (`:84`). Honest: explicitly
  identity passthroughs, "never presented as doing real work" (`:1-6`). `NOOP_FILTER.createFilter`
  returns an **empty** `TransformStream<VideoFrame, VideoFrame>()` (`:80`) — fine as a shape stub, but it
  never receives frames, so it cannot exercise a real close-once facet (relevant to delta §5.1).
- **`test-support/decode-goldens.ts`** — `DecodeGolden` (`:31`), `flacDecodeGolden` (`:46`),
  `wavDecodeGolden` (`:63`). Carries the anti-self-confirmation flag `ffmpegCrossChecked` (`:42`) and
  documents the one exception (12-bit FLAC full-scale shift, `:57-58`). This is the exemplary pattern.
- **`test-support/packet-goldens.ts`** — `GoldenPacketRow` (`:37`), `GoldenPackets` (`:54`),
  `goldenPacketsFor` (`:97`), `rowsFor` (`:116`, with a **no-silent-fallthrough** `default: throw`,
  `:162-163`), `perTrackTallies` (`:69`). ffprobe-corroborated (`:20-24`). **Smell:** row has no
  `dtsUs` (B-frame gap, delta §5.8).
- **`test-support/dsp-goldens.ts`** — `DspGolden` (`:16`), `dspGoldenDigests` (`:25`). Correctly pins
  only pow-free exact-arithmetic transforms and *excludes* `gain` because `10**x` is not spec-required to
  be correctly-rounded (`:6-9`). **Smell:** unlike decode/packet goldens, it carries **no independent
  cross-check field** (no `ffmpegCrossChecked`) — it is currently a round-trip of our own `encodePcm`
  (delta §5.6).
- **`test-support/cenc-encrypt.ts`** / **`cbcs-encrypt.ts`** — `encryptCenc` (`cenc-encrypt.ts:76`),
  `encryptCens` (`:108`), `encryptCbcs` (`cbcs-encrypt.ts:90`). These are exemplary inverse-of-SUT
  oracles: `cryptBlockOffsets` re-derives the *exact* byte offsets the decryptor uses, so a disagreement
  fails the byte-exact round-trip — "a genuine oracle, not a self-fulfilling mirror"
  (`src/test-support/cbcs-encrypt.ts:8-11`). Both import `AES_BLOCK` from `../crypto/aes.ts` (no
  constant duplication).
- **`test-support/decrypt-twins.ts`** — the shared cleartext-twin definition: `opensslCtr` (`:57`),
  `opensslCbcNoPad` (`:66`), `opensslCbcPkcs7` (`:75`), `cencCtrTwin` (`:84`), `cencCbcsTwin` (`:98`).
  Documents *why openssl, not ffmpeg* (contiguous keystream, ADR-086, `:5-18`). Exemplary.
- **`test-support/hls-sample-aes.ts`** — `encryptHlsSampleAesTs` (`:38`), the SAMPLE-AES TS encryptor.
  **The outlier.** It has **no file-header docstring** (contrast every sibling); it **redefines
  `AES_BLOCK = 16`** (`:3`) instead of importing it from `../crypto/aes.ts` as `cenc`/`cbcs` do; it uses
  `node:crypto` `createCipheriv` directly (`:1,310`); and it inlines its own TS-framing constants
  (`H264_CLEAR_LEAD=32`, `H264_SKIP_BYTES=144`, `AAC_CLEAR_LEAD=16`, `:10-12`) rather than mirroring the
  SUT's deframer or documenting an external anti-self-confirmation twin. It is not wired into the
  shared-definition pattern the way `decrypt-twins.ts` is (delta §5.4).
- **`test-support/corpus.ts`** — the verified-cache loader: `loadManifest` (`:49`), `loadFixture`
  (`:62`, fails loudly if uncached, `:64-68`), `fixtureSource` (`:73`), `fixturesByTrait` (`:86`),
  `loadGoldenMetadata` (`:91`). **Smell:** `manifestCache` is **module-global mutable state**
  (`src/test-support/corpus.ts:46`) — idempotent and test-only, but a cross-test cache with no reset seam.
- **`test-support/mp4-builder.ts`** — pure box builders (`box`/`full` `:19-24`, `moovBox` `:90`,
  `ftyp` `:154`, `moovBoxLargesize` `:159`) for parser-branch fixtures the real corpus doesn't cover.
  Clean; no smells.

**Coverage anti-rot exists for drivers but not for goldens.** `real-drivers.test.ts` has a coverage-map
test asserting every *registered* first-party driver appears in a conformance list, so a new driver
can't silently escape the suite (`src/conformance/real-drivers.test.ts:327-355`). There is **no
equivalent map for goldens** — a new golden-eligible fixture can ship un-validated (delta §5.10).

## 5. Delta / punch-list

Ordered by leverage. Each item names the change, the `path:line`, and a concrete acceptance test /
oracle that proves it.

1. **Build the browser-mode frame-flow facet (close-once, flush, cancel).** Add
   `assertCodecDriverFrameFlow(driver, frames)` and `assertFilterDriverFrameFlow(...)` beside the Node
   facets in `harness.ts` (declared but absent, `src/conformance/harness.ts:8-11`). Pump N real
   `VideoFrame`/`AudioData` through the driver `TransformStream`.
   *Acceptance:* wrap each input frame's `close()` with a counter; after the stream drains, assert
   **every input frame closed exactly once** (a fresh `Map<frame, count>` where every value === 1); a
   mutation arm using a driver that double-closes or leaks a frame throws `ConformanceError`. Repeat with
   an `AbortSignal` aborted mid-stream and assert all in-flight frames are still closed exactly once.
2. **Assert one-frame backpressure in the harness.** Today the codec/filter factory check stops at
   `isTransformStreamLike` (`src/conformance/harness.ts:42-49,95,239`). Extend it to verify the readable
   side's high-water mark is bounded.
   *Acceptance:* obtain a writer on `createDecoder(...).writable`; write one frame, do not read; assert
   `writer.desiredSize <= 0` (a second write would block). A driver whose readable strategy sets
   `highWaterMark > 1` fails.
3. **Add a determinism-conformance facet.** Add `assertDeterminismReproducible` proving `force-software`
   (a) drops hardware/GPU/WebGPU/WebGL/canvas2d tiers from selection and (b) yields cross-machine
   identical bytes. This encodes ADR-007 and the router fix (measured-evidence.md_ line: "accept a hardware-tier
   result only with an explicit `hardwareAccelerated:false` verdict").
   *Acceptance:* decode a fixture twice under `determinism:'force-software'` on the same code path →
   identical sha256; and assert the router, given `force-software`, returns no driver whose tier is in
   `['hardware','gpu']` / substrate in `['webgpu','webgl','canvas2d']`. A driver that returns a
   hardware-tier result under `force-software` without `hardwareAccelerated:false` fails.
4. **Normalize `hls-sample-aes.ts` to the sibling-encryptor pattern.** Add a file-header docstring;
   import `AES_BLOCK` from `../crypto/aes.ts` instead of redefining it (`src/test-support/hls-sample-aes.ts:3`);
   and make it a *genuine* inverse-of-SUT oracle by either mirroring the decrypt path's offsets (as
   `cbcs-encrypt.ts:8-11` does) or wiring an external twin.
   *Acceptance:* a test asserts the SAMPLE-AES ciphertext produced here for a fixed key/IV and the RFC 8216
   clear-lead geometry (H.264 clear-lead 32 / crypt 16 / skip 144; AAC clear-lead 16,
   `src/test-support/hls-sample-aes.ts:10-12`) is **byte-identical** to a Bento4/openssl-authored
   SAMPLE-AES twin, and our decryptor recovers the clear PCM byte-exact — proving it is not a self-mirror.
5. **Unify the garbage-probe matrix in the full harness.** `assertCodecDriverConforms` probes one
   `video/decode` garbage query (`src/conformance/harness.ts:88-92`) while the Node facet uses the richer
   `nodeCodecProbes()` (`:251-271`). Have the full check reuse `nodeCodecProbes()` so both paths test
   `supports()` totality over decode+encode+audio+garbage identically.
   *Acceptance:* a driver that throws on the `audio/encode` or empty-codec probe fails
   `assertCodecDriverConforms`, not only `assertCodecDriverNodeFacets`.
6. **Give `dsp-goldens.ts` an independent cross-check.** It currently hashes our own `encodePcm` output
   with no foreign corroboration (`src/test-support/dsp-goldens.ts:25-45`). Add an `ffmpegCrossChecked`
   field baked by comparing the exact-arithmetic conversions (`identity`, `to_f32`, `to_s24`,
   `remix_stereo_s16`) against ffmpeg `-f f32le`/`s24le` output at bake time; keep `gain` excluded
   (`:6-9`).
   *Acceptance:* the bake refuses to commit unless our bytes equal ffmpeg's for the lossless conversions;
   the committed golden records `ffmpegCrossChecked: true` and a later drift from ffmpeg fails the test.
7. **Remove module-global mutable state in `corpus.ts`.** `manifestCache`
   (`src/test-support/corpus.ts:46`) is a hidden singleton. Replace with an explicit
   `createCorpus()` returning bound loaders, or an injectable cache, so tests cannot leak state.
   *Acceptance:* a test that creates two independent corpus instances, changes the manifest on disk
   between them, and reads via a fresh instance observes the change; the shared-singleton path is gone.
8. **Pin DTS as well as PTS in `golden-packets`.** `GoldenPacketRow` has `ptsUs` but no `dtsUs`
   (`src/test-support/packet-goldens.ts:37-44`), so B-frame decode order is unvalidated. Add `dtsUs` to
   the row, the serialization (`:83-90`), and the ffprobe cross-check.
   *Acceptance:* for a B-frame MP4 fixture (built via `moovBox` with a non-trivial `ctts`,
   `src/test-support/mp4-builder.ts:108`), the golden pins both `ptsUs` and `dtsUs`; a demuxer that drops
   the composition offset (PTS == DTS) fails against the ffprobe-corroborated table.
9. **Add a golden coverage-map (anti-rot for oracles).** Mirror `real-drivers.test.ts:327-355` for
   fixtures: every fixture carrying a golden-eligible trait must have a committed golden.
   *Acceptance:* `fixturesByTrait('lossless-audio')` (via `src/test-support/corpus.ts:86`) is a subset of
   the fixtures with a committed `fixtures/golden/decoded/<id>.json`; adding a lossless fixture without a
   golden fails the map.
10. **Make typed `CapabilityError` the sole NA signal.** The exemplar's message-regex NA classifier lets
    a real bug that emits a miss-shaped sentence become NA instead of FAIL (measured-evidence.md_,
    competitive-gaps). Our conformance suite must assert every honest miss is a typed `CapabilityError`
    (`src/contracts/errors.ts:50`), never a string or a plain `MediaError`, so the adapter can classify
    NA on the *type* alone.
    *Acceptance:* the anti-cheat mutation suite asserts a missing-key decrypt and a force-software image
    decline both reject with `instanceof CapabilityError`; a path that returns wrong output instead of
    throwing fails (`src/conformance/anti-cheat.test.ts:240` is the seed).

## 6. Open questions

Each is a decision to be logged under `docs/decisions/`.

1. **Where do the browser frame-flow facets live?** Delta §5.1 adds `assertCodecDriverFrameFlow` — should
   it live in `src/conformance/harness.ts` (guarded so the WebCodecs-dependent body is dead-code-eliminated
   in Node builds) or a sibling `harness-browser.ts`? The runner-agnostic promise (`harness.ts:1-11`)
   argues for one file; bundle-purity argues for a split. **Decide and ADR.**
2. **Should the Node tier gain a pure-TS software VideoFrame shim to close-once-test without a browser?**
   A minimal fake `VideoFrame` with a real `close()` counter would let the close-once facet run in Node
   for driver *contract* coverage, leaving only true pixel decode to the browser. Risk: a shim that
   diverges from the real WebCodecs lifetime is a false oracle (the ADR-018 trap). **Decide.**
3. **Determinism gate ownership.** Delta §5.3's determinism facet overlaps the capability-router doc
   (S01, `tier-thresholds.ts`). Does the *conformance* harness own the "force-software drops
   hardware/GPU" assertion, or does it consume a router-exported predicate? **Log the seam.**
4. **`dsp-goldens` cross-check tool (§5.6).** ffmpeg's float PCM is IEEE-754 exact, but its `s24` packing
   endianness/alignment must be pinned. Confirm the exact `ffmpeg -f s24le` byte layout matches our
   `encodePcm(a,'s24')` before adopting it as the oracle, or the cross-check itself becomes the bug.
   **UNVERIFIED** until run on the target host — record the decision with the observed layout.
5. **How many fixtures satisfy the "≥5 real fixtures" anti-overfitting rule per family?** `decrypt-diversity`
   and `trim-diversity` require a MATRIX of ≥5 real fixtures (`src/conformance/trim-diversity.test.ts:1-4`).
   The decode/dsp/packet goldens have no explicit minimum. **Decide a per-family floor** and enforce it in
   the golden coverage-map (§5.9).
6. **AAC decode oracle isolation (ADR-039).** Vitest's V8 coverage instrumentation corrupts the
   wasm-bindgen heap-object table, so the real AAC decode oracle must run in a clean Node child process
   (`decode-fixture.mjs`) with the geometry getters read once and cached (measured-evidence.md_, ADR-039). This
   child-process seam is not in owned code — **decide whether S33 owns the child-process golden harness or
   it lives with the codec shard (S31).**
