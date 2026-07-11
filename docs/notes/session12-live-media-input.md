# Session 12 — live `MediaStream` input

## Goal

Turn the already-declared `MediaStream` input into a genuine raw-frame source. A live input has no byte
container, encoded packet seam, finite duration, random access, or replay contract. Its valid operation is
`decode()` to caller-owned `VideoFrame`/`AudioData` streams; `convert()` can then compose those frames with
the existing encoder/muxer when the caller supplies an encodable target. Byte/container operations must
typed-decline rather than inventing metadata, packets, duration, keys, or seekability. Element
`{mode:'capture'}` is the same live source after calling the platform's real `captureStream()` method.

## Standards truth and approach

The current W3C Media Capture Transform draft specifies a demand-driven `MediaStreamTrackProcessor` for
raw video and says its readable exposes `VideoFrame`; it also explicitly records no working-group consensus
that audio-track processors must exist. The processor issues frames only for pending reads and accepts a
bounded internal `maxBufferSize`. Therefore the primary implementation creates one processor per selected
live track with `maxBufferSize:1`, then wraps its readable in a `highWaterMark:0` stream that performs one
upstream read per downstream pull. Video support is standards-backed. Audio support is runtime-probed and
accepted only if the platform processor produces actual `AudioData`; constructor rejection, missing
`AudioData`, or a wrong chunk type becomes a typed capability miss. This is honest platform capability,
not a declared software codec gap.

The eager normalizer imports only `live-source.ts`, a tiny brand/shape/capture module. Processor, probe,
and frame-lifecycle code remains in lazily imported `live-media.ts`; the default barrel deliberately does
not statically re-export those heavy helpers. The bundle heavy-artifact guard names both `live-media` and
`live-convert`, so either one entering the eager/default-probe static closure fails the budget gate.

The rejected alternatives are `MediaRecorder` (encoded, UA-selected container/codec and timeslice—not raw
frames), canvas polling (video-only copies with independent clock/drop behavior), and ScriptProcessor or a
hidden AudioWorklet recorder (cannot apply downstream backpressure to a real-time audio graph and would add
a second PCM transport/clock without an approved worklet asset). A future AudioWorklet tail can be additive
after cross-browser clock, queue/drop, same-origin asset, and lifecycle proof; it must not be implied now.

## Ownership, timing, and lifecycle

- The caller owns the original `MediaStreamTrack`; cancellation detaches/cancels the processor reader and
  never calls `track.stop()`.
- The adapter owns a processor frame until `controller.enqueue()` succeeds. Once enqueued, the public
  consumer owns and closes it. A wrong type, timestamp regression, abort/end race, enqueue failure, or late
  read result is closed exactly once by the adapter.
- Original microsecond timestamps and durations pass through unchanged. Audio and video are never
  independently rebased, so their platform clock relationship survives; VFR and gaps remain real. A
  decreasing timestamp is a typed decode error, not silently sorted or clamped.
- A live track ending closes its output normally. Call abort errors the output with
  `MediaError('aborted')`. Pending reads are cancelled and drained before their reader lock is released.
- Backpressure is one requested frame at a time. The UA may drop old live frames inside the processor's
  one-frame queue when a consumer is slower than real time; accumulating an unbounded backlog would be
  worse and would exhaust native frame pools.
- One audio plus one video track is the public dual-track shape. More than one live track of either kind is
  a typed input error because `MediaStreams` has only one slot and silently selecting/dropping tracks would
  be a false feature. Already-ended tracks are ignored; an input with no live tracks yields empty streams.

## Operation semantics

- `decode`: real raw-frame access through the platform track processor.
- `convert`: decode → existing filter/encoder/muxer, with explicit output target facts required wherever
  there is no source `TrackInfo`: the output container, video codec/width/height, and audio
  codec/sample-rate/channel layout are mandatory for each selected track. Two-pass is rejected because a
  live source is not replayable. Current source track settings must independently expose video width/height
  or audio sample-rate/channel count before any processor pull; output facts never substitute for unknown
  input facts. The coordinator uses one abort domain, owns zero-buffer relays it can cancel even while an
  encoder holds their public readers, cancels the sibling on any failure, preserves the primary typed
  error, and resolves only after all selected source tracks end and the engine runner finalizes its mux/sink.
- `from(MediaStream)` / `fromElement(...,{mode:'capture'})`: a branded live source, not a fake byte
  `Source`. Element capture raises a typed capability miss when `captureStream()` is unavailable.
- `probe`: current, non-consuming track truth. It reports `container:'media-stream'`, explicit
  `raw-video`/`raw-audio` codec-domain tokens (never a guessed upstream encoded codec), current
  width/height/frame-rate or sample-rate/channel settings, no byte size, and no per-track duration. The
  in-memory aggregate duration is `Infinity`, matching the platform convention for an unbounded live
  source, with `tags:{live:'true',duration:'unbounded'}`. JSON has no Infinity token and serializes that
  field to `null`; the pinned tags preserve the unbounded meaning in exported JSON instead of turning it
  into a guessed zero.
- `demux`, `packetInfo`, `remux`, `trim`, `seek`, `decrypt`, and ABR replay: typed capability misses. Their
  result contracts require finite/container/encoded/replay facts a live raw source does not possess. `mux`
  and `encode` remain valid when the caller supplies their existing packet/frame inputs directly.

## Validation and benchmark evidence

The fail-first source/lifecycle suite now has 16 focused cases and the live-convert coordinator has nine.
They deterministically force pending-read cancellation, track-end races, wrong chunk types, timestamp
regression, pull backpressure, multiple-track rejection, exact close counts, sibling failure, partial-output
discard, explicit target validation, and final-mux waiting. Together with the 48 source-normalization cases,
all 79 focused tests pass under Vitest; scoped Biome is clean.

The fresh Node-safe adapter benchmark runs two warmups plus seven measured samples, each consuming 10,000
fresh frames and forcing 200 pending-read cancellations. Median adapter time is **4.991 ms**
(**2,003,490 frames/s**); it performs exactly 10,001 pulls per sample. Median cancellation time is
**3.374 µs per cancellation**; every one of 1,400 measured late frames is closed exactly once. Post-GC RSS
retention is **3,817,472 bytes**, below the pinned 32 MiB allowance, and every RSS sample is positive.

`scripts/bench-session12-live-media.mjs` is the strict browser oracle: it plays five exact
manifest-hashed W3C/Chromium licensed videos, creates a direct element `VideoFrame` at time zero, and
requires the first real `captureStream()` → `MediaStreamTrackProcessor` frame to match its RGBA SHA-256
exactly. It also checks dimensions, monotonic timestamps, caller closure, track ownership, two warmups,
five measured samples, positive precise heap readings, and retained-memory/cancellation bounds. The local
Chromium launch is presently unexecuted because the desktop escalation reviewer rejected the launch after
the session hit its usage limit; this is recorded as an external evidence block, not converted to a PASS.
WebKit/Firefox must either pass the same oracle when their API exists or return the exact typed browser
capability miss—never a fabricated result.

The binding architecture decision is recorded as **ADR-236**.
