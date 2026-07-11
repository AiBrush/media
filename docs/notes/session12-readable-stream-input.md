# Session 12 — direct `ReadableStream` media input

## Goal

Make a caller-owned `ReadableStream<Uint8Array>` a genuine public `MediaInput`: preserve `from(stream,
{ mime, size })` hints, route and probe from a bounded prefix without requiring random access, and transfer
the stream to exactly one downstream consumer with cancellation and backpressure intact. The same contract
must work after an ambiguous negative HLS/image sniff. Public `decode()` must never make its independent
audio and video outputs race to consume the one-shot byte stream.

## Design

`fromStream` owns a single lazy reader cursor. A routing peek pulls only enough whole chunks to cover the
requested prefix, retains those chunks, and leaves the reader locked; the source's sole later `stream()`
replays the retained chunks and then continues that same reader one pull at a time with a zero-sized
readable queue. Cancellation is forwarded to the owned reader and releases its lock once. Repeated bounded
peeks before ownership transfer reuse/extend the prefix and never open another reader. HLS and the engine
share this source-level primitive, so a negative manifest/image decision cannot consume the bytes needed by
the container driver. A re-readable custom source keeps its existing open/sniff/cancel/reopen behavior.

The rejected alternatives are (1) fully buffering every stream before routing, which violates bounded
startup memory and time-to-first-work, and (2) `ReadableStream.tee()`, which creates two independently
queued branches, weakens backpressure, and makes cancellation ownership ambiguous. The current container
decode seam opens a source independently per requested media track, so `decode()` uses the narrow safe
fallback for a true one-shot input: one memoized, abort-aware materialization to an immutable byte source,
shared by audio, video, and image routing. This costs whole-input memory only for that dual-output API and
prevents either branch from stealing bytes or making results pull-order dependent.

## Edge cases and failure modes

- Empty, split-signature, sub-prefix, huge first-chunk, and unknown-length inputs replay byte-exactly.
- A MIME-hinted stream skips unnecessary container magic routing but still remains single-use.
- HLS negative peeks, image-negative peeks, and container routing may request increasing prefix sizes; all
  see the same bytes and the driver receives the original sequence once.
- Abort during a pending prefix read or whole-input decode materialization cancels the upstream reader and
  raises typed `MediaError('aborted')`; downstream cancel is forwarded once.
- A locked input, second `stream()` acquisition, or peek after ownership transfer raises typed
  `InputError`, never a host `TypeError`.
- Backpressure is one upstream `read()` per downstream pull; retained sniff chunks are replayed one per
  pull rather than burst-enqueued.
- B-frames, VFR, seek, and frame ownership are unchanged after the byte-source seam. Seek on a one-shot
  input can demux sequentially but cannot claim random-access optimization. Decoded `VideoFrame` and
  `AudioData` ownership remains with the existing decoder/output streams and is not duplicated here.

## Validation and benchmark plan

Fail first on the existing typed rejection of a direct one-shot probe. Add source lifecycle tests for MIME
and size preservation, exact replay after multiple peeks, single acquisition, pull-count backpressure,
locked-input rejection, and cancel/abort propagation. Add public engine tests over real downloaded MP4 and
WAV corpus bytes chunked as one-shot streams: strict golden metadata for probe, real demux/packet facts,
and dual-output decode setup proving one upstream acquisition independent of pull order. Retain the
existing HLS replay/cancellation matrix. Benchmark warmup plus at least five samples over the real corpus,
recording bounded routing bytes, input acquisitions, wall time, and peak retained prefix bytes; the strict
gate is byte-identical input delivery and exact metadata/packet truth, never throughput alone.

## Recorded validation

The fail-first run produced five focused failures: dropped MIME/size, absent replay/cancel helpers, a raw
locked-stream acceptance, and the public real-media `need seekable` rejection. After implementation,
`source.test.ts` passes 48/48; the direct-stream, bounded-prefix, and dual-track engine selections pass 5/5;
and the complete HLS source matrix passes 19/19. Strict TypeScript and scoped Biome checks are green.

`bun run bench-session12-stream-input` runs two warmups and seven measured samples over five real corpus
files (H.264/MP4, VP9/WebM, s24/WAV, native FLAC, and MP3; 190,813 bytes total). Every byte-backed and
direct-stream sample matches the exact same public metadata digest
`19b614d3a47c35ad512a7dda53d51566f5a1f617c44b7eb09463e9999c2e539a`. The direct path performs exactly
194 pulls per sample. Its median is 0.569 ms versus 0.186 ms for replayable bytes; all seven separately
sampled direct-stream RSS deltas are positive (999,424–1,867,776 bytes). Fixture names, byte sizes, and
SHA-256 values are emitted with every benchmark run.
