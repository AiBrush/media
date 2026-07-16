# Execution & Runtime

> Shard S02 · Owned code: `src/kernel/executor.ts`, `src/kernel/planner.ts`, `src/kernel/frames.ts`,
> `src/api/job.ts`, `src/api/job-runner.ts`, `src/api/chain.ts`, `src/api/chain-runner.ts`.
> This document is the **target spec** (the best design) **plus an honest delta vs today's code**.

## 1. Purpose & scope

The execution & runtime layer is the **cross-cutting engine that runs every operation** — probe, demux,
decode, transcode, mux, remux, trim, decrypt, audio-DSP, filters. It is the substrate all 13 benchmark
families execute on, so it serves **no single family and every family at once**. Concretely it owns four
concerns:

1. **The stage graph** — turn an op call into an ordered pipeline `source → demux → decode → filter →
   encode → mux → sink`, and decide copy-vs-re-encode per stream (`src/kernel/planner.ts:1-50`).
2. **The executor** — compose stages as WHATWG `TransformStream`s with automatic backpressure, wire a
   byte source into a sink or collect it to a `Uint8Array`, and map thrown values to the typed error model
   (`src/kernel/executor.ts:1-6`, `:23-133`).
3. **Frame lifetime** — release `VideoFrame`/`AudioData`/`ImageBitmap` handles exactly once on every path,
   including abort/error teardown (`src/kernel/frames.ts:1-28`).
4. **Op orchestration** — the two public multi-step drivers: the **declarative job** (a
   structured-clone-safe `MediaJob` executed op-by-op, `src/api/job.ts`, `src/api/job-runner.ts`) and the
   **fluent chain** (`media.load(input).trim().resize().blob()`, `src/api/chain.ts`,
   `src/api/chain-runner.ts`).

Capability routing itself (WebCodecs → GPU → WASM, miss-only) is **not** decided here — the developer never
names a backend, and none of these files names a codec or backend. Routing lives in the router (S01) and
codec pipeline (S13); this layer is deliberately **backend-agnostic** and carries only abstract stages and
opaque codec/container *tokens* (`src/kernel/planner.ts:18-19`). Keeping it agnostic is a correctness
property, not an accident (§3, §4).

## 2. Spec & references

Governing standards:

- **WHATWG Streams Standard** — backpressure, `TransformStream`, `ReadableStream`/`WritableStream`,
  `highWaterMark` queuing strategy, `pipeThrough`, and `pipeTo(dest, { signal })`.
  <https://streams.spec.whatwg.org/> (backpressure model: <https://streams.spec.whatwg.org/#pipe-chains>).
- **WHATWG DOM — `AbortController` / `AbortSignal`** — cooperative cancellation that threads from a public
  call to every stage and driver. <https://dom.spec.whatwg.org/#interface-abortcontroller>,
  <https://dom.spec.whatwg.org/#interface-AbortSignal>.
- **W3C WebCodecs** — `VideoDecoder`/`VideoEncoder`/`AudioDecoder`/`AudioEncoder`, the `dequeue` event and
  `decodeQueueSize`/`encodeQueueSize` used to pace codec backpressure, and `VideoFrame`/`AudioData.close()`.
  <https://www.w3.org/TR/webcodecs/>.

OSS exemplar to study & beat:

- **`@remotion/webcodecs`** (the Remotion `convertMedia()` pipeline).
  Repo: <https://github.com/remotion-dev/remotion/tree/main/packages/webcodecs/src>
  (`convert-media.ts`, `create/create-video-decoder.ts`, `create/create-audio-decoder.ts`,
  `webcodecs-controller.ts`, `processing-queue.ts`).
  Docs: `convertMedia()` <https://www.remotion.dev/docs/webcodecs/convert-media>; backpressure model
  <https://www.remotion.dev/docs/media-parser/webcodecs>.

  How the exemplar solves this family, and where the SOTA design must match or beat it:
  - **Backpressure via async callbacks.** In `parseMedia()` the `onVideoTrack`/`onAudioTrack` sample
    callbacks are asynchronous; parsing does not advance until the returned promise resolves — an elegant
    "await = throttle" model. `createVideoDecoder()`/`createAudioDecoder()` expose
    `waitForQueueToBeLessThan()` which the caller `await`s before feeding the next sample. *Match:* our
    executor achieves the same with `{ highWaterMark: 0 }` pull-one-at-a-time streams
    (`src/kernel/executor.ts:78`).
  - **Encoder-side gap.** Remotion's docs state encoder queue helpers "weren't yet available" — the caller
    hand-rolls encoder throttling. *Beat:* our drivers pace WebCodecs via the native `dequeue` event rather
    than polling (harvest: dequeue-event pacing was ~3× faster than `setTimeout(0)` polling on
    `opus_to_aac_mp4`, measured-evidence.md_).
  - **Frame lifetime.** `convertMedia()` `close()`s both input and output frames after each callback and
    requires `.clone()` to retain — a strict close-once contract. *Match:* `src/kernel/frames.ts` +
    the enqueue-or-close guard (§3, ADR-040 in measured-evidence.md_).
  - **Cancellation.** Remotion uses a `webcodecs-controller.ts` object with `pause()/resume()/abort()`.
    *Match:* we thread a single `AbortSignal` end-to-end (`pipeTo(sink, { signal })`,
    `src/kernel/executor.ts:129`) rather than a bespoke controller object.

  Note: Remotion is phasing `@remotion/webcodecs` out in favor of Mediabunny (per its docs); it remains the
  canonical *pipeline-shape* exemplar for backpressure and frame lifetime even so.

## 3. Target design

### 3.1 Data model

- **`StageKind`** = `'demux' | 'decode' | 'filter' | 'encode' | 'mux' | 'copy' | 'decrypt'`
  (`src/kernel/planner.ts:12`).
- **`PlannedStage`** — one node: `kind`, optional `mediaType`, an opaque `target` token (codec for
  decode/encode, container for demux/mux — a *token, never a backend name*), an optional `filter` spec, and
  a diagnostic `label` (`src/kernel/planner.ts:15-24`).
- **`StageGraph`** — the ordered `stages` plus a `copyOnly` flag that is true when every stream is a pure
  stream-copy (the remux / keyframe-trim fast path) (`src/kernel/planner.ts:27-31`).
- **`Planner.plan(request): StageGraph`** — the seam that compiles a normalized `PlanRequest` into a graph
  (`src/kernel/planner.ts:34-50`).
- **`MediaJob`** — a serializable, structured-clone/transfer-safe declarative job: `input`, ordered `ops`,
  and a plain-data `output` target (`src/api/job.ts:16-37`). `MediaJobInput` is deliberately narrower than
  the host-facing `MediaInput` — `ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array> |
  string` only — so it forms one portable worker-boundary contract (`src/api/job.ts:16-21`; rationale in
  measured-evidence.md_: excludes function-backed `Source`, `URL`, DOM elements, live `MediaStream`).

### 3.2 Seams

The layering is strict and one-directional:

```
public API (engine.load / engine.run)
  └─ orchestrators:  chain-runner.runMediaChain   job-runner.runMediaJob
        └─ flat-op seam:  JobEngine / ChainEngine  (convert | trim | remux | decrypt)
              └─ planner.plan → StageGraph
                    └─ executor:  composeChain / lazyPipeThrough / collect / runToSink
                          └─ driver stages (TransformStream<ByteChunk|Packet|Frame, …>)
```

- The **executor never imports a driver or codec** — it composes abstract `TransformStream`s
  (`src/kernel/executor.ts:23-32`). The `JobEngine`/`ChainEngine` interfaces
  (`src/api/job.ts:70-75`, `src/api/chain.ts:13-18`) are the *only* seam the orchestrators know; the engine
  implementation supplies the concrete ops. This is why no owned file names a backend.
- **Lazy loading is a seam property, not an executor feature.** The eager kernel must not statically import
  the runners; `engine.run` and `engine.load` dynamic-`import()` `job-runner.ts` / `chain-runner.ts` at the
  terminal (`src/api/engine.ts:304-305`, `:328-329`; `src/api/chain.ts:63-66`) to keep eager JS in budget
  (measured-evidence.md_: runners live behind literal dynamic imports).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

This layer routes **nothing** and that is the target: `target` on a `PlannedStage` is an opaque codec/
container *token* (`src/kernel/planner.ts:18-19`), not `'webcodecs'`/`'wasm'`. The router (S01) resolves a
token to a tier and only downloads heavy WASM on a *hardware miss*; a true miss surfaces as a typed
`CapabilityError` up through the executor's error mapping unchanged (`src/kernel/executor.ts:198-209` passes
a `MediaError` through untouched). **Target invariant:** grepping the owned files for a backend name
(`webcodecs`, `wasm`, `gpu`, `dav1d`, `libvpx`) must return zero hits (true today; §4).

### 3.4 Edge cases

- **B-frames.** The execution layer is codec-agnostic and adds **no reorder buffer**: WebCodecs guarantees
  decoder output in presentation order, so a live PTS reorder here would be redundant and unbounded
  (measured-evidence.md_ ADR-026). Consequence for backpressure: a decoder that needs several in-flight packets to
  emit its first (reordered) frame must not be starved by the executor's one-item pull. The fix is that
  intra-codec queue depth lives **inside the driver stage** (bounded high-water mark of 8;
  measured-evidence.md_ ADR-026), while the executor applies backpressure only at the cross-stage *seam*
  (`{ highWaterMark: 0 }`, `src/kernel/executor.ts:78`). The executor must never assume one-packet-in →
  one-frame-out.
- **VFR (variable frame rate).** Timestamps are carried opaquely; nothing in this layer assumes constant
  cadence. Progress is computed from a monotonic clamp on `done/total`, never a frame count
  (`src/api/job-runner.ts:425-448`), so a VFR stream reports honest, non-decreasing progress.
- **Seek.** Primarily S10's family, but the *cancel-on-target* pattern is a runtime concern: a seek
  `cancel()`s its readable the instant it finds the target frame, racing an in-flight decoder output
  callback. The executor's composition primitive closes the losing value: `lazyPipeThrough` calls
  `closeValue(value)` if a downstream `enqueue` throws after cancellation (`src/kernel/executor.ts:34-37`,
  `:67-72`) and forwards `cancel(reason)` upstream (`:74-76`). This is the executor-level half of ADR-040's
  enqueue-or-close guard (measured-evidence.md_).
- **Cancel.** Fully in scope. One `AbortSignal` threads end to end. `runToSink` passes it straight to
  `pipeTo(sink, { signal })` (`src/kernel/executor.ts:129`); `collect` races every `read()` against the
  signal and cancels the reader on abort (`src/kernel/executor.ts:99`, `:152-169`, `:171-180`). The
  orchestrators link parent + terminal + internal signals into one: the job runner mirrors a parent abort
  and re-cancels the active op through a race-closed hook (`src/api/job-runner.ts:143-161`, `:196-197`); the
  chain runner merges three signals in `linkedSignal` (`src/api/chain-runner.ts:219-230`). Abort always maps
  to a single typed `MediaError('aborted', …)` (`src/kernel/executor.ts:182-184`, `:198-209`;
  `src/api/job-runner.ts:212-214`, `:821-823`).
- **Frame lifetime (`close()` exactly once).** `VideoFrame`/`AudioData`/`ImageBitmap` are ref-counted
  handles the GC will not reclaim in time; each is `close()`d exactly once by its last consumer
  (`src/kernel/frames.ts:1-6`). `closeFrame` is a no-op on non-closables (`:20-23`); `closeFrames` drains an
  iterable on teardown (`:26-28`). Two hazards the target must cover: **(a)** the check→enqueue race into a
  closed stream (close the frame instead of leaking — ADR-040), and **(b)** the worker boundary — the target
  transfers only *encoded bytes*, never a `VideoFrame`/`AudioData`, so close-once-across-threads never arises
  (measured-evidence.md_ ADR-019/ADR-010). Measured proof this works: the live-media path closed all 1,400 late frames
  exactly once (measured-evidence.md_).
- **Backpressure.** The target is strict, bounded memory everywhere:
  - Cross-stage seams pull one item at a time (`{ highWaterMark: 0 }`, `src/kernel/executor.ts:78`);
    `composeChain` uses native `pipeThrough` for steady-state same-type chains
    (`src/kernel/executor.ts:23-32`).
  - `lazyPipeThrough` defers the `pipeThrough` link until a downstream reader actually pulls, so a live
    graph can finish composing downstream filters/encoders before a decoder starts draining, without losing
    backpressure (one output per pull, `src/kernel/executor.ts:45-80`).
  - WebCodecs codec stages pace on the native `dequeue` event, not `setTimeout` polling (measured-evidence.md_:
    polling cost hundreds of macrotasks and was ~3× slower); queue high-water marks are 8 for video/generic
    and 128 for the audio drain (measured-evidence.md_ ADR-026; audio-drain measurement), and raising to 16 was
    rejected as a regression (measured-evidence.md_).
  - For catastrophic packet tables (e.g. 553,501 rows) the public drain amortizes with a **zero-high-water-
    mark 256 KiB / 256-packet batch**; larger batches are rejected because they break post-delivery abort
    (measured-evidence.md_ ADR-278). This batching primitive belongs to the execution family (§5 item 6).

### 3.5 The declarative job & fluent chain (best design)

The **best** job runner compiles the whole `MediaJob` into a **single heterogeneous `StageGraph`** the
executor runs once — one source open, one decode→filter→encode→mux pipe, zero intermediate `Blob`
materialization. Materialization between two ops is the *exception*, taken only when two ops genuinely
cannot fuse (e.g. an accurate-trim re-index feeding a re-encode), and when taken it is **explicit and
typed**, never the silent default. The fluent chain compiles to the same graph. Both keep exactly one linked
`AbortSignal`, emit monotonic clamped progress, and never fuse two transforms into a hidden pixel reordering.

## 4. Current state

What actually exists today (precise citations), and the smells.

**Executor — solid and backend-agnostic.** `composeChain` (`src/kernel/executor.ts:23-32`), `lazyPipeThrough`
with `{ highWaterMark: 0 }` and a `closeValue` race guard (`:34-80`), `collect` with abort race + progress +
reader-cancel-on-abort (`:83-111`, `:152-180`), `runToSink` with `pipeTo(…, { signal })` (`:114-133`), and
`mapError` that passes a `MediaError` through and only wraps unexpected values under a supplied `errorCode`
(`:186-209`). It is consumed widely (sinks, two-pass runner, codec-convert runner, remux-metadata). No
module-global mutable state; no backend names. This file is close to the target.

**Frames — canonical but under-used, and duplicated elsewhere.** `Closable`, `isClosable`, `closeFrame`,
`closeFrames` (`src/kernel/frames.ts:9-28`). `closeFrame` is used by `codec-pipeline.ts` and
`video-stream-plan.ts` and `worker-bridge.ts`. Two smells: **(a)** `closeFrames` is exported (`core.ts:37`)
but has **no production consumer** — only its test — so the "drain in-flight frames on teardown" use it was
built for is not wired anywhere. **(b)** `src/api/live-convert.ts:407` defines its **own local `closeFrame`**
that additionally swallows the `close()` throw, diverging from the canonical kernel helper (which does not
catch). Two definitions of "close a frame" is a layering/duplication smell.

**Planner — a type-only stub, not wired in.** `StageKind`, `PlannedStage`, `StageGraph`, `PlanRequest`,
`Planner` are exported (`src/core.ts:96`) but **nothing implements `Planner` and nothing constructs a
`StageGraph`** (grep of `src/` finds zero producers/consumers outside `planner.ts`). `PlanRequest` carries
only `op` (`src/kernel/planner.ts:34-45`) — a placeholder, not a normalized request. The file's own header
concedes the concrete planning logic is deferred to Phase 1 (`src/kernel/planner.ts:1-7`, ARCH-3→ARCH-1,
measured-evidence.md_ ADR-015). **This is the central gap: the graph seam is aspirational; the runtime does not use
it.**

**Job runner — a 1076-line god-file.** `src/api/job-runner.ts` mixes four unrelated concerns in one module:
1. **~620 lines of hand-rolled JSON-schema validation** (`validateJob`→`optionalEnum`,
   `src/api/job-runner.ts:452-1072`), including a prototype-pollution-hardened `plainRecord`
   (`:825-848`) and structured-clone input guard (`:886-897`).
2. **Rank-based transform fusion** — `compileMediaJob` collapses adjacent `crop/resize/pad/rotate/flip/
   colorspace/tonemap` ops into one `convert` by comparing filter ranks (`:227-370`, `:800-811`).
3. **Progress mapping** — `stageProgress` monotonic clamp (`:406-450`).
4. **Orchestration** — `runMediaJob` with the linked `AbortController`, the cancel-during-dispatch race
   close (`:196-197`), abort checkpoints (`:174-175`, `:200`), and `finally` cleanup (`:216-220`).

The orchestration itself is careful and correct (67/67 tests, ~219,883 jobs/s geomean, measured-evidence.md_), but
the single file is doing schema, compile, progress, and run at once — it should be four modules.

**Job runner materializes a `Blob` between every op.** `dispatchStage` gives every non-final op a
`toBlob()` sink and feeds that `Blob` into the next op (`src/api/job-runner.ts:381-404`, `:198-204`). This is
a *deliberate* stopgap "until the planner can carry a single heterogeneous stage graph" (measured-evidence.md_) — a
documented trim→resize job runs exactly two real stages with a `Blob` in between rather than one fused pipe.
Honest, but not the target: it re-encodes/re-muxes and re-opens the byte source once per op.

**Chain builder is duplicated.** `src/api/chain.ts:27-73` (`createMediaChain`/`runLazy`) is a complete
fluent-chain Proxy — but the production `engine.load()` **re-implements the identical Proxy inline**
(`src/api/engine.ts:287-324`) to avoid a static import of `chain.ts`. So `createMediaChain` is only exercised
by `chain.test.ts`; two copies of the same builder ship. `chain-runner.ts` (the real compiler:
`compileChain` `:62-148`, `runOp` `:171-190`, `linkedSignal` `:219-230`) is shared, but the builder is not.

**Cancellable plumbing is re-implemented three times.** The "promise with `.cancel()` + linked
`AbortController` + track the active op" pattern is written independently in `chain.ts:54-73`,
`chain-runner.ts:36`/`:219-230`, and `job-runner.ts:143-161`/`:223`. No shared primitive.

Positive facts to preserve: **no module-global mutable state in any owned file**; **no backend/codec name in
any owned file** (capability routing correctly lives elsewhere); the `MediaJobInput` worker-boundary contract
is correctly narrower than `MediaInput` (`src/api/job.ts:16-21`).

## 5. Delta / punch-list

Ordered for the coder. Each item = the change + a concrete acceptance test.

1. **Implement the `Planner` seam and run one heterogeneous graph (eliminate `Blob` intermediates).**
   Build a `Planner` that compiles a `MediaJob`/chain into a single `StageGraph`
   (`src/kernel/planner.ts:48-50`) and have `runMediaJob` execute it through the executor in one pipe instead
   of the per-op `toBlob()` loop (`src/api/job-runner.ts:198-204`, `:381-404`).
   *Acceptance:* a `trim → resize → mp4` job opens the byte **source exactly once** (assert one source
   `open`/`stream` call via a counting fake), invokes decode/encode **once total**, and the output SHA-256
   equals the two-stage golden; a metamorphic oracle asserts fused-graph output ≡ current staged output
   byte-for-byte on the documented fixtures.

2. **Split `job-runner.ts` (1076 lines) into four modules.** `job-schema.ts` (validators
   `src/api/job-runner.ts:452-1072`), `job-compile.ts` (`compileMediaJob` `:227-370`, `firstVideoTransformRank`
   `:800-811`), `job-progress.ts` (`stageProgress` `:406-450`), `job-run.ts` (`runMediaJob` `:137-225`).
   *Acceptance:* every new file < ~350 lines, no import cycle (assert with a cycle checker), and the existing
   `job-runner.test.ts` (67 tests) stays green with unchanged coverage.

3. **Collapse the duplicate chain builder.** Make `src/api/chain.ts:27-73` the single fluent-chain builder
   and have `engine.load()` delegate to it (lazily if the eager budget requires), deleting the inline Proxy
   at `src/api/engine.ts:287-324`.
   *Acceptance:* grep finds exactly one fluent-chain `Proxy` in `src/api`; `chain.test.ts` and the
   `engine.load(...).trim().blob()` integration test both pass; eager-bundle size does not regress past the
   documented ceiling.

4. **Unify frame close into one canonical helper.** Delete the local `closeFrame` in
   `src/api/live-convert.ts:407` and import `src/kernel/frames.ts:21`; settle the error-swallowing policy in
   one place (the kernel helper — decide catch-or-throw and document it).
   *Acceptance:* grep finds exactly **one** `function closeFrame`/`const closeFrame` definition under `src`;
   the live-media "all N late frames closed exactly once" oracle (measured-evidence.md_) still passes; a unit test
   pins the chosen double-close behavior.

5. **Wire `closeFrames` (or remove it).** `src/kernel/frames.ts:26-28` is exported-but-unused. Either use it
   on a real teardown path (drain the in-flight queue of a cancelled composed graph) or delete the export.
   *Acceptance:* either a cancellation test asserts `closeFrames` drained ≥1 in-flight frame on abort, or the
   symbol no longer appears in `core.ts` exports; no exported-unused symbol remains.

6. **Host the batched zero-HWM packet drain in this family.** Provide the executor-level primitive for the
   256 KiB / 256-packet zero-high-water-mark batch (measured-evidence.md_ ADR-278) so huge tables amortize `read()`
   steps without breaking abort.
   *Acceptance:* draining a 553,501-packet table performs ≤ `ceil(N/256)` `read()` steps (assert the pull
   count), **and** a `cancel()` after a delivered batch aborts before the next batch (assert zero packets
   delivered post-abort). Reference the `{ highWaterMark: 0 }` seam `src/kernel/executor.ts:45-80`.

7. **Flesh out `PlanRequest` into a real normalized request.** `src/kernel/planner.ts:34-45` carries only
   `op`; add the input descriptor, per-stream targets, sink, and signal so `plan()` can decide `copyOnly`.
   *Acceptance:* a same-codec remux `plan(request)` returns `copyOnly:true` with **zero** decode/encode
   stages; a codec-changing convert returns `copyOnly:false` with a decode+encode pair; unit-tested against
   both.

8. **Unify the `Cancellable` + linked-signal plumbing.** Extract one helper (in the executor family) for
   "promise with `.cancel()` linked to parent + terminal + internal `AbortController`, tracking the active
   op" and use it in all three runners (`src/api/chain.ts:54-73`, `src/api/chain-runner.ts:219-230`,
   `src/api/job-runner.ts:143-161`).
   *Acceptance:* one shared helper is imported by all three; the cancel-during-dispatch race
   (`src/api/job-runner.ts:196-197`) is covered by one shared test that all three runners exercise; each
   runner's own cancellation test still passes.

9. **Assert the backend-agnostic invariant as a test.** Encode "the execution layer names no backend/codec"
   as a lint/test.
   *Acceptance:* a test greps the seven owned files for `/webcodecs|wasm|\bgpu\b|dav1d|libvpx|libopus/i` and
   asserts **zero** matches, so a future capability leak into this layer fails CI.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **Single heterogeneous graph vs typed materialization boundary.** When the planner runs one graph
   (delta 1), what is the *typed* rule for when two ops may **not** fuse and must materialize (e.g.
   accurate-trim re-index → re-encode; a container that needs a full moov before the next op)? Today the
   `Blob` boundary is unconditional and deliberate (measured-evidence.md_). Decide the fusion predicate and its error
   type. Ref `src/api/job-runner.ts:381-404`.

2. **Double-close semantics of `closeFrame`.** `src/kernel/frames.ts:21-23` calls `close()` unconditionally;
   `src/api/live-convert.ts:407` swallows the throw. `UNVERIFIED:` whether `VideoFrame.close()`/
   `AudioData.close()` is idempotent (a no-op on an already-closed handle) per the WebCodecs spec across UAs.
   Decide: forbid double-close (rely on close-once discipline) or make the helper defensively idempotent.

3. **Where the batched packet-drain primitive lives, and its max batch.** Execution-family primitive vs
   per-driver. Current bound is 256 KiB / 256 packets because larger breaks post-delivery abort
   (measured-evidence.md_ ADR-278). Confirm the bound and the owner. Ref delta 6.

4. **One backpressure knob vs per-media-type constants.** High-water marks today are 8 (video/generic,
   measured-evidence.md_ ADR-026), 128 (audio drain), with 16 rejected as a regression (measured-evidence.md_). Should the
   executor expose a single tunable or keep per-media-type constants owned by each driver? Decide the seam.

5. **Is `Cancellable<T>` (promise + `.cancel()`) the right public shape,** or should cancellation be a pure
   `AbortSignal` argument with a plain `Promise` return? The current shape is re-implemented three times
   (delta 8); unifying it forces this decision. Ref `src/api/chain.ts:54-73`, `src/api/job-runner.ts:221-224`.

6. **`UNVERIFIED:` exact signature/behavior of Remotion's `waitForQueueToBeLessThan()`** on
   `createVideoDecoder()`/`createAudioDecoder()` (from docs, not source-read). Confirm against
   `packages/webcodecs/src/create/*.ts` before citing it as the precise pacing mechanism we match; our
   equivalent is the native `dequeue` event (measured-evidence.md_), which we believe strictly beats an awaited
   polling helper — validate that belief with a fresh multi-sample benchmark.
