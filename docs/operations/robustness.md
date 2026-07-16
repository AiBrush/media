# Robustness — malformed / truncated input handling

> Shard S22 · benchmark family **`robustness`** · docPath `docs/operations/robustness.md`
> Owned code: `src/test-support/fuzz/corrupt.ts` (the corruption model + oracle) and its driver
> `src/test-support/fuzz/parser-robustness.test.ts`. Target: **engine‑wide** resilient handling of
> malformed/truncated input via the typed‑error contract of `src/contracts/errors.ts`.
>
> This document is the **target spec** (the best design) plus an **honest delta** against today's code.

## 1. Purpose & scope

**Robustness** is the guarantee that *no input can make the engine crash, hang, or silently emit wrong
output*. Fed **any** byte string — garbled, truncated, zeroed, bit‑flipped, empty, foreign‑magic, or a
recursion/allocation bomb — every entrypoint (`probe`, `demux`, `decodeFrames`, `remux`, `transcode`,
`trim`, `decrypt`, `mux`) must terminate **inside a bounded time and memory budget** and either (a) return
a correct result, or (b) throw a **typed `MediaError`** (`InputError` / `CapabilityError` / a stage
`demux-error`/`decode-error`/`mux-error`). It must **never** (c) let a non‑typed error escape — a
`RangeError` from a `DataView` read past EOF, a `TypeError`, a bare `Error`, or a `DOMException`; (d) hang
(infinite loop / unbounded watchdog); or (e) consume unbounded memory (OOM the tab). Classes (c)/(d)/(e)
are the *escapes* the harness detects (`src/test-support/fuzz/corrupt.ts:1`).

This family serves the benchmark family **`robustness`** (`../media-test/src/scenarios/robustness/index.ts`),
which has four sub‑batteries:

- **(a) EDGE** — gnarly‑but‑valid assets (open‑GOP/B‑frames, VFR, rotated, multi‑track, headerless
  MediaRecorder WebM, big‑endian/24‑bit PCM, cbcs boundaries, multi‑hour). These must **PASS** or honest‑NA.
- **(b) MALFORMED / FUZZ** — deterministic prebaked corrupt fixtures (bit‑flip, header truncation,
  random‑span zeroing). Must **fail gracefully** within `timeoutMs`. Oracle: `graceful-failure`. **This is the
  sub‑battery `corrupt.ts` directly serves** in the fast Node fuzz test.
- **(c) PROPERTY / METAMORPHIC** — invariants (`decode(remux(x))==decode(x)`, `probe` duration consistency,
  `trim(a..b)++trim(b..c)≈trim(a..c)`). Oracle: `property-invariant`.
- **(d) IMAGE NEGATIVES** — a still image fed to a video op → clean NA/graceful error, never a crash.

Sub‑batteries (a)/(c)/(d) are validated by other shards' oracles but scored under `robustness`. `corrupt.ts`
is the **in‑repo, browser‑free, deterministic** fuzz oracle that makes (b) reproducible without the browser
harness (`src/test-support/fuzz/corrupt.ts:14`). The current robustness leaderboard is **not** yet won —
mediabunny led robustness **31/60** in the harvested run, and robustness carries **29 WEAK‑GATE** cells
(`measured-evidence.md`, lines 493 & 80): the largest concentration of "didn't crash" gates in the whole suite. The
target below closes that gap with strict, falsifiable oracles.

## 2. Spec & references

There is no single ISO standard for "handling malformed media." The governing standards are (i) the **error
model** the engine must honor and (ii) the **weakness classes** a fuzz oracle must prove are absent.

- **W3C WebCodecs — error model.** A `VideoDecoder`/`AudioDecoder` surfaces runtime failure via its `error`
  callback carrying a **`DOMException`** (`EncodingError`), *not* a typed engine error.
  <https://www.w3.org/TR/webcodecs/#dom-videodecoderinit-error> — the engine MUST translate these into a
  typed `MediaError` at the codec seam (see `decoderErrorToCapabilityMiss`, `src/codecs/webcodecs-video.ts:240`).
- **WHATWG DOM — `AbortSignal` / aborting ongoing activities.** Cancellation must resolve to a typed
  `aborted` error, never a dangling promise or a `DOMException` leak.
  <https://dom.spec.whatwg.org/#abortcontroller-api-integration>
- **ECMAScript (TC39) — `GetViewValue`.** A `DataView` read whose `getIndex + elementSize` exceeds the
  buffer throws a **`RangeError`**. This is the exact escape ADR‑073 caught in five parsers; the fix is
  bounds‑checking declared fixed‑width reads, not a blanket `try/catch`.
  <https://tc39.es/ecma262/#sec-getviewvalue> (`measured-evidence.md` line 540).
- **MITRE CWE — the weakness classes the oracle disproves.** CWE‑125 Out‑of‑bounds Read
  (<https://cwe.mitre.org/data/definitions/125.html>), CWE‑400 Uncontrolled Resource Consumption
  (<https://cwe.mitre.org/data/definitions/400.html>), CWE‑674 Uncontrolled Recursion
  (<https://cwe.mitre.org/data/definitions/674.html>), CWE‑789 Memory Allocation with Excessive Size Value
  (<https://cwe.mitre.org/data/definitions/789.html>), CWE‑835 Loop with Unreachable Exit Condition
  (<https://cwe.mitre.org/data/definitions/835.html>). Classes (c)=CWE‑125, (d)=CWE‑835/674, (e)=CWE‑400/789.

**OSS exemplar — FFmpeg error resilience.** FFmpeg is the reference for "survive any input":

- **Typed error codes, never crashes.** Demuxers/decoders return negative `AVERROR` codes
  (`AVERROR_INVALIDDATA`, `AVERROR_EOF`) rather than aborting.
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavutil/error.h>
- **Tunable strictness (`-err_detect` / `AV_EF_*`).** `AV_EF_CRCCHECK`, `AV_EF_BITSTREAM`, `AV_EF_BUFFER`,
  `AV_EF_EXPLODE`, `AV_EF_CAREFUL`, `AV_EF_COMPLIANT`, `AV_EF_AGGRESSIVE` select *reject vs. conceal*.
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/defs.h>
- **Error concealment in decode.** `error_resilience.c` conceals damaged macroblocks (motion‑vector
  guessing, slice interpolation) so a corrupt frame degrades instead of crashing.
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/error_resilience.c>
- **Fuzz harness with bounded resources.** `tools/target_dec_fuzzer.c` (the OSS‑Fuzz entrypoint) caps
  decoded pixels/samples and total allocation so a fuzz input cannot OOM the fuzzer — the same discipline
  `corrupt.ts` applies with a capped head window + per‑case time budget.
  <https://github.com/FFmpeg/FFmpeg/blob/master/tools/target_dec_fuzzer.c>

**Where the SOTA design must match or beat FFmpeg.** FFmpeg's dichotomy is *reject vs. conceal* per the
`AV_EF_*` flags. The aibrush target adopts the same **op‑specific policy**: **reject** at the container tier
(`probe`/`demux` on a broken box tree → typed `demux-error`), **conceal‑or‑reject** at the decode tier (a
corrupt payload the container accepted → the decoder errors or emits a bounded number of frames), and
**never author output** from malformed mux/encode input. Where aibrush must *beat* FFmpeg: FFmpeg's typing
is a C `int` return that callers routinely ignore; aibrush's typed `MediaError` hierarchy is
non‑ignorable in TypeScript and machine‑classifiable (`instanceof MediaError`, `.code`), and its fuzz
oracle is **bit‑exact deterministic** (a seeded PRNG, `corrupt.ts:54`) rather than coverage‑guided/flaky.

## 3. Target design

### 3.1 Data model

The corruption model is a **matrix generator + a classifying watchdog**, both pure and deterministic.

- **`CorruptClass`** — the eleven matrix columns: `empty | truncate | bitflip-magic | wrong-magic |
  oversize-field | zero-field | dup-atom | missing-atom | nested-bomb | random-with-magic | bitflip-sweep`
  (`corrupt.ts:77`).
- **`Family`** — the structural scanner selector: `isobmff | riff | iff | caf | ebml | ogg | ts | framed`
  (`corrupt.ts:98`). Per family a *best‑effort, approximate* boundary/size‑field scanner (`corrupt.ts:116`
  through `:271`) discovers where truncations should land (real box/chunk/page starts) and which bytes are
  length fields to mutate. **These scanners are not a second parser** — a wrong offset still yields a valid
  corrupt input; breadth is the goal (`corrupt.ts:92`). The family enum is closed with an exhaustive
  `never` switch (`corrupt.ts:291`) — a capability leak check: adding a family without a scanner is a
  compile error.
- **`CorruptCase`** = `{ label, cls, bytes }` (`corrupt.ts:68`) — a single labeled input with a precise,
  reproducible label (`truncate@boundary:188`, `oversize-field@4`, `dup-atom:fmt `).
- **`corruptMatrix(seedFull, opts)`** (`corrupt.ts:361`) derives *every* case from **real fixture bytes**
  (never synthetic‑only, except the magic‑prefixed `nested-bomb` and random buffers so they still route to
  the target parser). Bounded by `seedCap` (default **64 KiB**, `corrupt.ts:362`), `truncateStride` (prime
  **17**, desynchronizes from any field, `corrupt.ts:365`), `randomCount` (24), `bitflipCount` (96). Same
  seed ⇒ same matrix.
- **`Outcome`** = `typed | ok | crash | hang` (`corrupt.ts:685`); **`CaseResult`** records `outcome`,
  `errorName`, `message`, and wall `ms` (`corrupt.ts:688`).
- **The oracle** = `escapes(results)` (`corrupt.ts:765`) — the `crash`/`hang` cases. The test asserts this
  is **empty** (`parser-robustness.test.ts:96`). Crucially the oracle is **not** "every corrupt input must
  throw" — that would be an oracle that cannot fail (forbidden by the integrity rule, `corrupt.ts:7`). It is
  the *typed‑error contract*: return, or throw a `MediaError`; never escape (c)/(d)/(e).

### 3.2 Seams & the typed‑error contract

The single seam is `src/contracts/errors.ts`. Every escape maps to exactly one typed throw:

- **Malformed/empty/foreign bytes** → `InputError('unsupported-input', …)` (`errors.ts:57`) or a stage
  `MediaError('demux-error', …)` (`errors.ts:10`). Example real behavior: WAV rejects non‑RIFF with
  `InputError('unsupported-input','not a RIFF/WAVE file')` and a truncated `fmt ` with
  `MediaError('demux-error','WAVE: truncated fmt chunk')` (`src/drivers/wav/pcm.ts:83`, `:95`).
- **A true capability miss** (no eligible driver for a *valid* input) → `CapabilityError('capability-miss')`
  with `{ op, tried, suggestion }` (`errors.ts:50`). **A capability miss is not a corruption class** — the
  target keeps them distinct so the harness can score NA vs. FAIL correctly.
- **Cancellation** → `MediaError('aborted', …)` (`errors.ts:17`).
- **WebCodecs `DOMException`** — translated at the codec seam so it never escapes as a raw `DOMException`
  (`webcodecs-video.ts:240`). See the delta §5 for the *precision* fix (decode‑error vs. capability‑miss).

The classifier `runCase` (`corrupt.ts:716`) is the executable contract: `await parse(bytes)`; a thrown/
rejected `MediaError` ⇒ `typed`; any other throw ⇒ `crash`; over `CASE_TIME_BUDGET_MS` (**1500 ms**,
`corrupt.ts:706`) ⇒ `hang`; a normal return ⇒ `ok`. `runMatrix` runs the whole matrix serially, preserving
order (`corrupt.ts:747`).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss‑only) for malformed input

Robustness has a **routing‑correctness rule the rest of the engine must obey: reject at the earliest tier
that can prove the input is malformed, and never download heavy WASM to reject a broken container.**

1. **Sniff/parse tier (TS, always resident).** A foreign magic, a broken box tree, or a truncated header is
   provably malformed from the container bytes alone → throw `InputError`/`demux-error` here. No WebCodecs,
   no GPU, **no WASM chunk import.** The `wrong-magic` column (`corrupt.ts:407`, cross‑container magics at
   `:321`) exists precisely to prove a parser rejects foreign magic at the door.
2. **Decode tier (WebCodecs first).** A container that *parses* but carries a corrupt codec payload reaches
   the decoder. WebCodecs is tried first; its `DOMException` on the bad payload is translated to a typed
   error (`webcodecs-video.ts:240`). Only on a genuine hardware **miss** (config unsupported) does the
   engine fall to the WASM tail — never merely because the payload is corrupt.
3. **The developer never names a backend**; a corrupt input surfaces the same typed `MediaError` regardless
   of which tier caught it.

### 3.4 Edge cases

- **B‑frames / open‑GOP.** Applies at the decode tier: a truncated/zeroed span inside a B‑frame's reference
  chain must make the decoder **error or emit a bounded, PTS‑ordered subset**, never reorder into garbage or
  crash. The EDGE case `edge_open_gop_bframes_decode` proves the *valid* path stays PTS‑ordered
  (`../media-test/src/scenarios/robustness/index.ts`); the FUZZ case `fuzz_mp4_zeroed_spans_decode` proves
  the *corrupt* path errors or conceals **bounded in time and memory**. `corrupt.ts` today only fuzzes
  container parsers, so this is a **delta** (§5‑1).
- **VFR.** A malformed timeline (non‑monotonic/absurd timestamps, zeroed sample‑duration tables) must not
  hang demux. The `oversize-field`/`zero-field` columns mutate the very `stts`/`stsz`/size fields that carry
  timing (`corrupt.ts:415`); the parser must clamp/reject, never loop. Valid‑VFR reporting is `edge_vfr_probe`.
- **Seek.** A seek target past EOF or into a zeroed region must **clamp or throw typed**, never hang or read
  OOB. Robustness includes a seek‑clamp edge; the corrupt matrix reaches the seek index via `stco`/`stsz`
  mutation (`atomsFor` includes `stco`,`stsz`, `corrupt.ts:487`).
- **Cancel.** A malformed parse interrupted by `AbortSignal` mid‑flight must reject with `MediaError('aborted')`
  (`errors.ts:17`). **`corrupt.ts` has no abort path today** (the watchdog is a post‑hoc time budget, not a
  cooperative cancel) — a **delta** (§5‑3).
- **Frame lifetime — `close()` exactly once.** On a malformed decode, *every* `VideoFrame`/`AudioData`
  produced before the error must be `close()`d exactly once (no leak, no double‑close). The parser‑only
  matrix produces no frames, so this is untested at the fuzz layer today — a **delta** (§5‑1 acceptance
  asserts `close`‑count == produced‑count).
- **Backpressure.** N/A to the pure `runMatrix` (serial, non‑streaming, `corrupt.ts:747`). It *does* apply to
  the streaming decode/remux fuzz path (§5‑1): a malformed stream that never yields a keyframe must not
  buffer unboundedly — the reader must stay demand‑driven and reject once the head window is exhausted
  without a decodable unit.

## 4. Current state

**What exists (owned code).** `src/test-support/fuzz/corrupt.ts` (779 lines) is a complete, well‑reasoned,
`any`‑free corruption model + oracle:

- Real‑fixture seeding with a **hard no‑network guarantee**: `fuzzFixture` reads only from `fixtures/media`
  / `fixtures/media-derived` and throws with the fetch command if absent (`corrupt.ts:31`). The head window
  (`corrupt.ts:47`) and `seedCap` bound work + memory.
- Deterministic PRNG `mulberry32` (`corrupt.ts:54`); the whole matrix is reproducible.
- Eight family scanners (`corrupt.ts:116`–`:296`), each guarded to **4096 iterations** and depth‑capped, so
  the *generator itself* can never hang on a hostile seed.
- `corruptMatrix` builds ~9 numbered case groups including a magic‑prefixed **`nestedBomb`** (DEPTH=800,
  bounded to 16 KiB, `corrupt.ts:566`) — the recursion/stack‑bound probe.
- The watchdog `runCase`/`runMatrix` (`corrupt.ts:716`,`:747`) and reporters `escapes`/`tally`/`hexPreview`
  (`corrupt.ts:757`–`:778`).

The driver `src/test-support/fuzz/parser-robustness.test.ts` wires the matrix to **11 real parsers** — MP4
`parseMovie` on the isolated `moov` payload, full‑file MP4 `readMovie`, plus 10 pure container parsers
(WAV/MP3/Ogg/FLAC/ADTS/AIFF/CAF/AVI/MPEG‑TS/WebM) (`parser-robustness.test.ts:38`, `:119`), asserting
`formatEscapes(...) === ''` (`parser-robustness.test.ts:96`).

The **typed‑error seam** is real and already used by the drivers: `InputError`/`demux-error`/`CapabilityError`
in `wav/pcm.ts:83`,`:95`,`:254`, `mp4/parse.ts:194`, etc. ADR‑073 already hardened five parsers (MP4 tables,
WAV `fmt`, Ogg short pages, AIFF `SSND` prefix, AVI `avih`/`strh`/`strf`) from raw `RangeError` leaks to typed
rejects, **structurally** (bounds‑checked reads, not blanket `try/catch`) (`measured-evidence.md` line 540). ADR‑112
added a metadata‑light probe hook so `edge_longform_probe` (one‑hour AAC) dropped from a **479 957 ms timeout
to ~178 ms** (`measured-evidence.md` line 27) — a DoS class closed.

**Smells / gaps (ruthless):**

1. **Coverage stops at the container tier.** `corrupt.ts` is only wired to *parsers*
   (`parser-robustness.test.ts:38`). The harness robustness family fuzzes **decode, remux, transcode, mux,
   and decrypt** of malformed input (`fuzz_mp4_zeroed_spans_decode`, `fuzz_remux_zeroed_spans`,
   `fuzz_encrypted_mp4_ciphertext_decode` in `../media-test/src/scenarios/robustness/index.ts`), but the fast
   in‑repo oracle does not — so frame‑lifetime, decode‑conceal, and mux‑refusal robustness are only validated
   in the slow browser harness, not in the deterministic Node test.
2. **Class (e) "unbounded memory" is claimed but unmeasured.** The docstring lists (e) among detected classes
   (`corrupt.ts:10`), but `runCase` measures only wall time and the thrown error's type (`corrupt.ts:716`) —
   there is **no allocation/RSS probe**. In Node a huge allocation happens to throw `RangeError` ("Array
   buffer allocation failed") → caught as `crash`, but a *slow* linear over‑allocation under the ceiling
   passes silently. The claim outruns the check.
3. **The `ok` outcome can never fail the oracle.** `escapes` only flags `crash`/`hang` (`corrupt.ts:765`);
   an `ok` on `empty`, `wrong-magic`, or a magic‑overwriting `bitflip-magic` input is *always accepted*. A
   parser that **silently accepts foreign‑magic garbage as valid** passes today — this is exactly the
   WEAK‑GATE pattern (robustness = 29 WEAK‑GATE, `measured-evidence.md` line 80). The oracle needs a *positive
   rejection expectation* for structurally‑impossible inputs.
4. **No cooperative cancel.** The watchdog cannot interrupt a *true* input‑independent infinite loop
   in‑process (`corrupt.ts:706` comment); it relies on the Vitest `testTimeout` backstop. There is no
   `AbortSignal` threaded through, so the `aborted` typed path is untested by the fuzz battery.
5. **Cross‑repo survival aids mask engine weaknesses (harness, not this repo).** The aibrush adapter installs
   a page‑error suppressor + a 30 s per‑op abort + synthesized graceful‑rejections, and infers NA from a
   **message regex** `MISS_RE` rather than solely from a typed `CapabilityError`
   (`../media-test/src/engines/aibrush-media/adapter.ts:123`, `:195`). A real bug emitting a
   capability‑miss‑matching sentence can silently become NA instead of FAIL (`measured-evidence.md` lines 434, 615).
   These are harness concerns (Open Questions), but they hide engine‑side escapes.
6. **`gracefulAllowOutput: true` weakens the harness oracle.** Many fuzz cells set it
   (`../media-test/src/scenarios/robustness/index.ts` and `../media-test/src/core/oracles.ts:2703`), which
   lets a malformed input **return partial output and still PASS**. Acceptable for decode *concealment*,
   dubious for demux/probe *reject*. The policy is not codified per op.

## 5. Delta / punch-list (ordered)

Each item: the change, the `path:line` anchor, and a concrete acceptance oracle.

1. **Wire the corrupt matrix past parsers — decode / mux / remux / decrypt.** Extend
   `parser-robustness.test.ts:38` with a second table that feeds `corruptMatrix` (family per source) to a
   WebCodecs‑backed `decodeFrames`, a muxer, `remux-runner`, and `decrypt-runner`.
   *Acceptance:* for every table, `escapes(runMatrix(...))` is empty (`corrupt.ts:765`), **and** for the
   decode path a frame‑lifetime counter asserts `closed === produced` (every `VideoFrame`/`AudioData`
   `close()`d exactly once) even when decode errors mid‑stream. A leaked/double‑closed frame fails the test.

2. **Add a memory/allocation ceiling to the watchdog (make class (e) real).** Give `runCase`
   (`corrupt.ts:716`) a bounded‑allocation guard (Node: `process.memoryUsage().heapUsed`/`arrayBuffers`
   delta or `--max-old-space-size` child; browser: `performance.measureUserAgentSpecificMemory` where
   available) and classify an over‑budget case as `crash`/`hang`. Add a `memory-bomb` column: an
   `oversize-field` whose declared size, if honored, would allocate `> ceiling`.
   *Acceptance:* the new case is caught as a non‑`ok` outcome **without** OOM‑ing the process; a parser that
   pre‑allocates `declaredSize` bytes before validating it fails, one that validates against `bytes.length`
   first passes. Softens the docstring claim at `corrupt.ts:10` into an enforced check.

3. **Thread `AbortSignal` and test the `aborted` path.** Add an optional `signal` to `runCase`
   (`corrupt.ts:716`) and a fuzz case that aborts a streaming malformed parse mid‑flight.
   *Acceptance:* the rejection is a `MediaError` with `code === 'aborted'` (`errors.ts:17`), classified
   `typed` (not `crash`/`hang`), and the parser stops reading within one budget tick.

4. **Positive‑rejection expectation for structurally‑impossible inputs (kill the un‑failable `ok`).** Extend
   the oracle (`escapes`/a new `expectReject` set, `corrupt.ts:765`) so that for classes `empty`,
   `wrong-magic`, and magic‑overwriting `bitflip-magic`, an `ok` outcome is an **escape**, not a pass.
   *Acceptance:* a deliberately‑lax stub parser that `return`s on foreign magic **fails** the test; the real
   parsers (which reject foreign magic, e.g. `wav/pcm.ts:83`) pass. Proves the oracle *can* fail (integrity
   rule, `corrupt.ts:7`) and closes the 29 WEAK‑GATE robustness cells (`measured-evidence.md` line 80).

5. **Reject malformed containers in the TS tier before any WASM import.** Add a fuzz assertion that a
   corrupt/foreign‑magic input to the public `probe`/`createMedia` path throws `InputError`/`demux-error`
   **without** dynamically importing any `src/codecs/wasm-*` chunk.
   *Acceptance:* spy on dynamic `import()` (or `wasm-loader-runtime`) during a `wrong-magic` run
   (`corrupt.ts:407`); assert zero `wasm-*` imports occurred and the throw is a typed `MediaError`. Enforces
   the routing rule §3.3‑1.

6. **Make WebCodecs decode failure on *malformed* input a `decode-error`, not `capability-miss`.** Today
   `decoderErrorToCapabilityMiss` (`webcodecs-video.ts:240`) maps **every** decoder `DOMException` to
   `CapabilityError('capability-miss')`. For a payload the decoder's own `isConfigSupported` *approved* and
   that then fails on corrupt bytes, that is a **corruption** (`decode-error`/`InputError`), not "this
   browser can't decode this codec." Split the classifier by whether the config was approved.
   *Acceptance:* a zeroed‑span H.264 stream whose config `isConfigSupported` approved throws
   `code === 'decode-error'`; a genuinely‑unsupported profile throws `code === 'capability-miss'`. Both stay
   `MediaError` (graceful‑failure still passes), but the harness can now score corruption as FAIL‑if‑output
   vs. NA correctly. (Log the trade‑off — see OQ‑1.)

7. **Add malformed *encode/mux* input coverage (the write direction).** The matrix only corrupts *read*
   bytes; extend it to reject malformed mux/encode requests: zero coded samples, mismatched dimensions, a
   codec‑config field bit‑flipped.
   *Acceptance:* each throws a typed `mux-error`/`encode-error`/`InputError` and **authors no output**
   (assert the sink received zero bytes) — matching the harness negative cases (`zero-sample mux` in
   `../media-test/src/scenarios/robustness/index.ts`) in the fast Node test.

8. **Enforce an explicit recursion/nesting bound in the real parsers.** `nestedBomb` (DEPTH=800,
   `corrupt.ts:566`) must hit an *engine* depth guard, not a JS stack overflow.
   *Acceptance:* feeding `nestedBomb` to each container driver throws a typed `demux-error` (assert
   `errorName === 'MediaError'` and message names the depth limit) — never `RangeError: Maximum call stack
   size exceeded` — within `CASE_TIME_BUDGET_MS` (`corrupt.ts:706`).

9. **Persist the minimal repro on an escape.** `hexPreview` (`corrupt.ts:757`) is logged but not saved.
   *Acceptance:* on any `escape`, write the exact bytes to a deterministic artifact keyed by the case
   `label` (the seed is deterministic, `corrupt.ts:368`), so a CI failure is reproducible offline by
   replaying that file. Assert the artifact round‑trips to the same `escapes` verdict.

## 6. Open questions

1. **Decode‑error vs. capability‑miss for malformed payloads (OQ‑1).** Should a WebCodecs `DOMException` on a
   *corrupt* payload map to `decode-error` or `capability-miss`? (`webcodecs-video.ts:240`) The current
   all‑to‑capability‑miss mapping is safe for the graceful‑failure oracle but semantically imprecise and lets
   corruption be scored NA. Decide the split criterion (config‑approved ⇒ decode‑error) and log an ADR.

2. **Concealment policy per op (OQ‑2).** `gracefulAllowOutput: true` (`oracles.ts:2703`) permits partial
   output from malformed input. FFmpeg conceals in *decode* (`error_resilience.c`) but rejects in *demux*.
   Codify: which ops may emit concealed/partial output on corrupt input (decode) and which must always reject
   (probe/demux/mux/trim/remux)? Log the per‑op table.

3. **Memory ceiling & measurement substrate (OQ‑3).** What is the per‑case allocation ceiling, and how is it
   measured portably (Node child‑process `--max-old-space-size` vs. browser
   `measureUserAgentSpecificMemory`)? Needed to make delta §5‑2 non‑UNVERIFIED.
   `UNVERIFIED: the exact allocation cap FFmpeg's target_dec_fuzzer.c enforces` — cite the file
   (<https://github.com/FFmpeg/FFmpeg/blob/master/tools/target_dec_fuzzer.c>) and pick our own number.

4. **Move harness survival aids into the shared runner (OQ‑4).** The page‑error suppressor + 30 s abort +
   `MISS_RE` message‑regex are aibrush‑adapter‑only advantages (`adapter.ts:123`, `:195`; `measured-evidence.md`
   lines 434, 615). Decide whether to (a) move them to the shared runner for all 7 engines, or (b) delete the
   regex and make a typed `CapabilityError` the *sole* NA signal. Log the decision; it changes what "won
   robustness" means.

5. **Keep or close the entropy‑coded trim can't‑detect (OQ‑5).** ADR‑043 documents that a lossless
   keyframe‑copy trim cannot detect an entropy‑coded H.264/AAC bit‑flip without a full decode (128 seeded
   flips leave the box tree byte‑identical, all sample ranges in‑bounds) (`measured-evidence.md` lines 319, 539). The
   engine keeps a graceful pass‑through rather than faking a filename match. Decide whether to add an
   *optional* full‑decode verify for the `trim/robust_bitflipped_source` cell or keep the honest can't‑detect.
