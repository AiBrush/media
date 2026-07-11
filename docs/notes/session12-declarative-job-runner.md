# Session 12 declarative job runner — serializable composition boundary

## Goal

Implement the documented `media.run({ input, ops, output }, callOptions)` contract as a real composition
path over the shipped flat operations. The job and output remain plain structured-clone data; `run()` has no
host sink and returns the final default `Blob`. The runner must validate the complete plan before the input
is normalized or read, preserve declared operation order, use the minimum safe number of flat operations,
and expose one cancellation/progress timeline across every intermediate materialization boundary.

The worker-boundary input is deliberately narrower than the flat API's host-facing `MediaInput`:
`ArrayBuffer`, an `ArrayBufferView`, `Blob`/`File`, an unlocked transferable `ReadableStream<Uint8Array>`,
or a URL string. Function-backed `Source` objects, `URL` instances, DOM elements, and live `MediaStream`
handles are excluded because they do not form one portable structured-clone contract.

## Design

`MediaJobOperation` is a discriminated plain-data union covering the flat byte-boundary operations
(`trim`, `convert`, `remux`, `decrypt`) and the documented video transform intents (`resize`, `crop`, `pad`,
`rotate`, `flip`, `colorspace`, `tonemap`). `MediaJobOutput` maps its required `container` to the final
`ConvertOptions.to` and otherwise carries the serializable video/audio/layout fields of `convert`; it never
carries `Sink`, callbacks, DOM nodes, streams, or signals. A narrow `JobEngine` dependency interface keeps
the executor directly testable and lets `MediaEngineImpl` enter it through a lazy import without a second
codec/container implementation.

The compiler preflights the entire job, then turns it into flat stages. Adjacent transforms fuse only while
their order is the engine's canonical pixel order (`crop → resize → pad → rotate → flip → colorspace →
tonemap`) and no transform repeats. A decrease or repeat flushes an intermediate `convert`, preserving list
semantics instead of silently reordering pixels. Byte-boundary operations always flush pending transforms.
An explicit or final `convert` absorbs the pending group only when its own transform fields continue that
same strict canonical order; otherwise the compiler inserts a Blob boundary. The documented `trim → resize
→ output` job therefore executes exactly two real stages: a Blob trim and the final resize/encode/mux,
without making unsafe fusion a hidden reordering rule. Explicit `convert`, `remux`, and `decrypt` operations
likewise materialize exact Blob intermediates. A non-Blob at an intermediate or final default-sink boundary
is rejected as typed bad input rather than guessed.

One internal `AbortController` links the caller signal and the returned handle's `cancel()`. Its abort event
cancels whichever flat operation is active; abort is checked before the first stage and between stages, and
an abort always surfaces as typed `MediaError('aborted')`. Each stage receives a progress adapter. Known
local totals map to a fraction within that stage; unknown totals stay at the last proven boundary; explicit
stage completion advances exactly one unit. The resulting `{ done, total: stageCount, stage }` sequence is
globally monotonic even though each flat operation starts its own local clock.

## Edge cases and ownership

- B-frame DTS/PTS, open-GOP trim preroll, VFR frame durations, track selection, and mux timestamps remain
  owned by the existing flat operations. The runner never parses packets, retimestamps frames, or aliases
  an input as output.
- A one-shot `ReadableStream` input is consumed only by the first stage; every later stage receives the
  preceding owned Blob. Complete preflight means malformed later operations cannot consume that one shot.
- Preflight accepts only a declared structured-clone/transfer job input and snapshots every validated operation/output object.
  Caller mutation after `run()` begins therefore cannot alter a later stage or bypass nested validation.
- Every operation/output object and array must contain enumerable data properties only. Accessors, symbols,
  class instances, and host-only fields are rejected before a getter can run.
- Blob boundaries are deliberate until the planner/executor can carry a single heterogeneous stage graph.
  They bound ownership cleanly but may buffer between flat operations; inside each operation, existing Web
  Streams backpressure and bounded frame queues remain authoritative.
- The runner never owns `VideoFrame` or `AudioData`, so it has no frame-close branch. Flat decode/filter/
  encode stages retain exactly-once closure responsibility, including cancellation and failure.
- `video:false` combined with a video-transform operation is rejected before input consumption. Conflicting
  or earlier-ranked transform fields in `output.video` force a separate conversion boundary; compatible
  codec/rate-control fields remain fused into the last stage.
- Empty `ops` is valid and performs the final requested conversion. Unknown discriminants, malformed
  ranges/dimensions/enums, a missing input/output, non-plain operations, and host-only `sink` fields fail as
  typed `InputError`s during preflight.

## Validation and benchmark plan

Fail-first dependency-injected tests assert the exact compiled calls and Blob payload handoff, canonical
fusion versus unsafe-order flushes, all-operation preflight before an engine call, output merging, typed
boundary failures, already-aborted and in-flight cancellation, active-handle cancellation exactly once,
and globally monotonic progress. A real-engine fixture test will prove that the public integration produces
independently probeable media once the reserved `MediaEngine` seam is connected.

The focused benchmark will run a mixed, prevalidated job corpus through a no-media dependency host for
multiple fresh samples after warmup. It measures only declarative validation/compilation/dispatch overhead;
codec/container performance remains covered by the existing real-operation benchmarks and is not relabelled
as job-runner throughput.

## Validation result

- `src/api/job-runner.test.ts`: 67/67 green. Runner-only V8 coverage is 97.76% statements/lines,
  90.74% branches, and 100% functions.
- `src/api/job-runner.integration.test.ts`: green on the licensed real `sfx-pcm-s16.wav` corpus fixture.
  The `trim(0, 0.1)` job emits exactly 9,600 payload bytes (4,800 mono s16 frames), byte-for-byte equal to
  the independently parsed source sample range; public probe independently reports WAV, pcm-s16, 48 kHz,
  mono, and exactly 0.1 seconds.
- `bun run scripts/bench-session12-job-runner.ts --check`: green against the fresh 21-sample baseline after
  five warmups and 1,000 jobs per sample. The baseline geomean is 219,883 jobs/s across documented,
  canonical-fusion, unsafe-order, and typed-rejection cases; the confirmation run measured 199,077 jobs/s
  with positive 1.18–1.42 MB peak process-heap samples and no regression.
- The new source, tests, and benchmark pass isolated strict TypeScript, focused Biome, and whitespace checks.
  `MediaEngine.run`, `createMedia().run`, and the bare barrel export now enter the runner through a lazy
  import; the real integration test exercises that public engine seam. Canonical array-index validation also
  rejects named enumerable array properties before input consumption. The final aggregate package-budget
  and cross-browser gates remain part of the Session 12 exit proof.
