# Session 12 H.264 two-pass design

## Goal and truth boundary

Implement a real two-pass H.264 bitrate path without pretending that WebCodecs exposes native pass files.
Pass one must consume the fully decoded and filtered output picture sequence, encode it at a fixed H.264
quantizer, and retain timestamped complexity evidence from the actual encoded chunk sizes. Pass two must
replay the same source and filter graph, convert that evidence into a per-picture quantizer schedule for the
requested video-byte budget, and perform a distinct final encode. A single encode with `bitrate` set once is
not two-pass and remains forbidden.

## Stream and lifetime design

The path is limited to `convert()` because it owns a replayable compressed source. Caller-owned one-shot
`encode()` frame streams cannot be replayed and must continue to raise a typed capability miss when
`twoPass:true`. A pure `ReadableStream` source is also single-use and must reject before decoding; byte,
Blob, URL, and OPFS sources can open a fresh stream for each demux pass.

Pass one uses the normal demux, WebCodecs decode, filter, frame-rate retime, and encoder routes. The encoder
consumes and closes every first-pass `VideoFrame` exactly once. Encoded chunks are reduced immediately to
small timestamp/size/type records; pixel frames and encoded payloads are never retained. The first demuxer is
closed before pass two opens, keeping memory proportional to frame count rather than pixels or source size.
On abort, decoder error, filter error, encode error, or consumer cancellation, the active stream is cancelled
and queued frames are closed through the existing stage ownership rules.

The retained pass-two schedule uses packed `Float64Array` timestamps plus `Uint8Array` QPs: nine bytes per
picture. Normal presentation-order replay advances an array cursor in O(1); diagnostic out-of-order lookups
fall back to binary search. No per-frame `Map` or object graph survives the allocator.

## Rate allocation

The first pass uses a fixed H.264 QP of 28. For each presentation timestamp it records encoded bytes,
duration, and key-frame status. Pass-two budgeting uses the complete filtered timeline and the requested
bitrate. Fixed-QP size is a direct complexity proxy; a 0.6 complexity-blur curve allocates more bits to hard
pictures without letting them consume the budget linearly. The H.264 six-QP-per-doubling model converts each
allocated picture budget into a QP, clamped to `[0, 51]`, with bounded adjacent-picture slew. Pass two runs
WebCodecs in quantizer mode and supplies the timestamped QP for every input frame. Missing, duplicated, or
changed timestamps are typed failures rather than falling back to single-pass behavior.

## Edge cases

- B-frames may make encoded callback order differ from presentation order; all evidence and lookup are keyed
  by PTS and sorted only for allocation.
- VFR uses each chunk's duration when present and neighboring PTS deltas otherwise. The declared track
  duration closes the last interval without inventing constant frame rate.
- Resize, crop, rotate, flip, colorspace, tonemap, and FPS conversion run identically in both passes, so the
  measured sequence is the sequence finally encoded.
- Keyframes keep their observed complexity and receive a small quality bias without bypassing the total
  budget model. Fragmented-output forced GOP decisions are identical across passes.
- Alpha-preserving VPx packet-plane transcode is outside this H.264-only path.
- Empty streams, zero-byte chunks, non-finite timestamps, and an unrepresentable target budget fail typed.
- Pass evidence is O(frame count), and backpressure remains bounded by the existing decoder/encoder queues.

## Validation and benchmark

Pure tests cover budget math, VFR/B-frame ordering, QP bounds, timestamp lookup, duplicate/missing evidence,
and invalid inputs. Focused Chromium validation has proved that a real licensed H.264 source executes two
distinct encodes, lands within the strict bitrate/structure oracle, closes all frames, and is deterministic;
typed cancellation is also covered. A fresh multi-sample benchmark records first-pass planning overhead and
evidence memory per frame. The remaining acceptance seam is the external capability declaration.

## Packaging boundary

The demux/decode/filter analysis pass and the pass-two quantizer installation live in the lazy
`video-two-pass-runner.ts` chunk. The public engine retains only typed routing, stage, and filter callbacks;
ordinary probe/demux startup therefore does not load browser-only WebCodecs orchestration or the replay
timestamp set. The runner's pure geometry and quantizer lifecycle helpers are Node-tested. The live encoder
body has focused Chromium proof covering bitrate/structure, deterministic repeated output, cancellation, and
frame lifecycle; the external harness capability declaration is the remaining acceptance seam.
