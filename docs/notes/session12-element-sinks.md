# Session 12 element sinks — streamed attachment and lifecycle

## Goal

Make the documented `toElement(el, { via })` contract real at the byte-output seam. `via:'blob'` must
materialize exact bytes into a Blob URL without leaking that URL. `via:'mse'` must attach a `MediaSource`
through its object URL and incrementally append the produced byte stream. `via:'stream'` must use the HTML
media-provider seam (`el.srcObject = mediaSource`) where the platform supports it, and otherwise report a
typed capability miss. All three modes still return `void`; the element owns playback after attachment.

## Approach

Use one Media Source Extensions append pump for both streaming modes. It waits for `sourceopen`, creates one
`SourceBuffer` from the exact output MIME, pulls one byte chunk, calls `appendBuffer`, and waits for
`updateend` before pulling again. This makes the SourceBuffer the pace-setter and preserves Web Streams
backpressure. The `mse` mode attaches the MediaSource with a library-owned object URL; the `stream` mode
attaches the same provider directly through `srcObject`, the standards-supported `MediaProvider` path. A
per-element session supersedes and aborts an older in-flight writer so a detached MediaSource cannot leave
its producer pending forever. Blob and MSE object URLs are tracked per element and revoked on readiness,
failure, or replacement without ever revoking a caller-owned URL.

Rejected alternatives: assigning `ReadableStream<Uint8Array>` to `srcObject` (not a valid `MediaProvider`);
collecting the stream before feeding MSE (defeats streaming and backpressure); concurrent `appendBuffer`
calls (violates SourceBuffer state); immediately revoking a Blob URL before the element has opened it; and
silently falling back from a requested streaming mode to whole-file Blob materialization.

The public sink descriptors and constructors remain in the eager kernel, but byte-drain implementations
are loaded only when a sink is actually materialized. `sink.ts` lazily enters `materialize.ts`; the generic
materializer then lazily enters the element pump, while the stream-target descriptor independently enters
its callback/`WritableStream` writer. Keeping public types and constructors in the light wrappers avoids
duplicating declarations in lazy chunks and preserves the 50 kB default-entry budget without changing any
runtime sink semantics.

## Edge cases and ownership

- B-frames, VFR, open GOP, and A/V interleave remain container/muxer responsibilities; the sink preserves
  byte order and chunk boundaries and never parses or retimestamps media.
- The MIME is mandatory for MSE and must pass `MediaSource.isTypeSupported`; malformed or non-MSE byte
  streams fail as typed `mux-error`s from the platform rather than being relabelled or passed through.
  The producing operation must request a registered segment layout (normally `fragmented:true`).
- Empty chunks are ignored. Normal ArrayBuffer-backed chunks are appended without a copy; a shared backing
  is copied to the platform-safe BufferSource form.
- Each append owns exactly one update cycle. The producer is not read again until `updateend`, so a slow
  SourceBuffer exerts backpressure. No `VideoFrame` or `AudioData` crosses this byte-only sink seam.
- Caller abort, a newer attachment, source close, SourceBuffer failure, and element failure all cancel the
  upstream reader. The pump awaits asynchronous producer cancellation before rejecting; an updating
  SourceBuffer is then aborted best-effort, and an open MediaSource is ended on normal EOF only. Cleanup
  never hides the primary typed error. A malformed element is rejected and cancelled before the first pull.
- Blob URLs are revoked after `loadedmetadata` or `error`; MSE URLs are revoked as soon as `sourceopen`
  proves attachment. Replacing an element sink revokes any still-owned earlier URL immediately.

## Validation and benchmark plan

Fail-first unit validation uses strict event-capable MediaSource/SourceBuffer doubles to prove byte-exact
ordered appends, one-append-at-a-time backpressure, source-open gating, direct-vs-URL attachment, EOF,
cancellation while waiting for `sourceopen` and `updateend`, supersession, typed platform failures, and URL
revocation. The existing real downloaded H.264 MP4 corpus fixture remains the byte oracle for whole-file
materialization; the streaming pump is payload-agnostic and its exact concatenated bytes are asserted.

Element attachment adds no media transform and therefore has no independent codec throughput claim. Its
relevant performance oracle is the existing multi-file `bench-streaming` suite: incremental writes, first
byte latency, bounded producer pull-ahead, and total drain wall time. The focused sink test records the
stronger mechanical requirement directly: the next read cannot occur before the prior `updateend`.

## Validation result

- `src/sinks/element-sink.test.ts` and `src/sinks/sink.test.ts`: 34/34 green. Focused materializer
  coverage is 98.06% statements/lines, 92.92% branches, and 96.15% functions. The suite includes exact
  reconstruction of the downloaded `h264.mp4` fixture across the append pump.
- `bun run scripts/bench-streaming.ts --check`: green against the 2026-06-25 baseline, 14 real corpus
  files (7 MP4 + 7 TS/HLS), 21 measured iterations after 3 warmups. Aggregate MP4 output measured
  108.5 MB/s through `WritableStream` and 142.6 MB/s through callback targets; TS measured 1,318.3 MB/s
  and 1,439.0 MB/s respectively, with no regression.
- Targeted Biome checks and the integrated production/test/scripts TypeScript build are green after the
  shared-tree edits settled.
- The production package budget gate is green after splitting the materializers: the eager static closure
  is 48.68 kB (1.32 kB below its 50 kB limit), the typical first-operation closure is 222.75 kB (33.25 kB
  below 256 kB), and both lazy-frontier plus same-origin WASM separation checks pass.
- A live browser check was attempted through the required in-app browser workflow, but this agent had no
  available browser runtime. Cross-browser MSE playback therefore remains an explicit parent-session gate;
  no browser-playback claim is inferred from the deterministic event doubles.
