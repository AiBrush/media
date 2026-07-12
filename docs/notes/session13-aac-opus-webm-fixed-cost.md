# Session 13 AAC-to-Opus WebM fixed-cost pass

## Goal and measured cause

Make short AAC-to-Opus WebM transcodes pay native codec work rather than avoidable JavaScript scheduling,
without changing a decoded sample, timestamp, Opus access unit, Matroska byte, error, or ownership edge. The
provisional passing row is 24.840 ms versus mediabunny at 21.185 ms. The pinned WPT AAC-LC product fixture is
2,078 bytes, ten ADTS frames, and 213,330 microseconds, while the retained ADTS packet walk is already
sub-millisecond. The remaining product graph crosses packet-to-decoder, decoder-to-encoder, and
encoder-to-mux streams; both WebCodecs transformers currently return an already-resolved promise for every
input even when their native queue is far below the bounded 128-item backpressure threshold. That adds two
promise continuations per coded/decoded unit without pacing or correctness value.

## Approach and rejected alternative

Keep the published decoder/encoder `TransformStream` seam and make its ordinary queue-below-threshold input
submission synchronous. A small pure helper runs the existing submission callback immediately when the queue
is below the bound and returns `void`; only a genuinely saturated queue creates the existing event-driven
dequeue promise. Decoder and encoder still configure once, flush once, and close once. Encoder input
`AudioData` remains closed in every synchronous throw, asynchronous rejection, abort, and success arm.

A fused private `AudioDecoder` -> `AudioEncoder` -> WebM path was considered and rejected before native
evidence: it would duplicate capability routing, stream cancellation, mux configuration publication, and
long-input backpressure to remove scheduling that can be removed inside the existing codec seam. Reusing
native coder objects was also rejected because WebCodecs flush/reset state, codec configuration, gapless
boundaries, and concurrent operations make cross-job ownership materially riskier than this local change.

## Edge cases and failure modes

Audio has no B-frames, but AAC priming, variable packet duration, non-zero timestamps, channel/rate changes,
gapless trim, empty streams, encoder metadata arriving on the first output, and delayed output until flush
must remain exact. The synchronous arm checks abort before calling native decode/encode. The saturated arm
retains dequeue-driven bounded memory and abort wakeup; it rechecks abort after waking. A synchronous native
throw remains the primary typed stage failure. An encoder input frame is closed exactly once whether native
submission succeeds, throws, waits then rejects, or observes abort. Decoder outputs already enqueued remain
consumer-owned; outputs racing cancellation are closed by the existing guard. No source bytes, answers, or
codec objects are cached, and eligibility never depends on a fixture, size, duration, packet count, or
scenario.

## Validation and benchmark plan

Fail-first pure tests require queue-below-threshold submission to complete before the call returns and return
no thenable; queue-at-threshold must remain pending until `dequeue`, and abort must prevent submission. Existing
driver lifecycle tests continue to cover enqueue/drop races and exact close ownership. A real-browser product
benchmark will use the independently licensed WPT `sfx.adts` fixture plus AAC tracks from the MP4 corpus, warm
at least three times and measure at least 21 alternating samples. It will require exact decoded frame/sample
counts and timestamps, exact Opus packet count/timestamps/durations/payload digest, independently reparsed
WebM track geometry/duration, cancellation with zero late output, and one close per `AudioData`. Until that
native benchmark and a same-export harness rotation run, the public ledger row remains `BEHIND` rather than
claiming closure from a JavaScript scheduling microbenchmark.

The committed WPT-corpus cadence control (warmup 7, alternating `n=51`, 2,000 complete ten-frame graphs per
sample) measures 0.000368 ms median for synchronous unsaturated submission versus 0.000521 ms for the former
resolved-promise cadence, a 1.42x scheduling win. Both arms consume the same exact ten ADTS rows and produce
the same timestamp/size checksum; the current arm closes exactly ten frame handles. This isolates a real
general reduction but is intentionally not promoted to a browser-row win without the native product run.
