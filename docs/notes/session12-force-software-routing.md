# Session 12 force-software routing closure

## Truth before change

`force-software` currently removes every `tier:'hardware'` codec before probing. The two WebCodecs drivers
use that tier for normal hardware-first ranking but already configure `prefer-software` when the stage runs,
so the router makes their deterministic branches unreachable. Native-only H.264/HEVC configurations can
therefore miss even when the browser advertises an exact software WebCodecs configuration. Video filters
have the inverse defect: Canvas2D survives the filter predicate and outranks native CPU for non-tiny work,
although the architecture records `drawImage` as GPU-accelerated. Image decode is a separate browser-native
path and cannot honestly claim bit-exact force-software behavior without a software decoder.

## Edge cases and ownership

- Capability declaration and execution must use the same acceleration preference. A successful
  `no-preference` or hardware result is not proof of deterministic software support.
- A hardware-tier third-party driver that ignores the new optional support context must not become eligible
  accidentally. Under `force-software`, hardware-tier support is accepted only with an explicit
  `hardwareAccelerated:false` verdict.
- GPU codec tiers and WebGPU/WebGL/Canvas2D filter substrates remain ineligible. Native CPU and WASM remain
  eligible, with native first. Auto ranking and tiny-work ranking must not change.
- Exact cache keys already include determinism. Software verdicts must never reuse an auto/hardware verdict,
  and a rejected software probe must not poison later auto recovery.
- B-frames, VFR, seek ordering, stream backpressure, cancellation, and frame close ownership are downstream
  of selection and remain unchanged; this change must not construct a coder or retain a frame during probe.
- A force-software image decode request must raise a typed capability miss before browser `ImageDecoder`
  work, not silently run a platform-native decoder.

## Design

Extend `CodecDriver.supports` compatibly with an optional determinism-only context; existing one-argument
drivers remain structurally valid. The router passes that context, retains `tier:'hardware'` for a software
probe, rejects GPU tiers, and accepts a hardware-tier result only when it explicitly reports
`hardwareAccelerated:false`. WebCodecs audio/video probe only `prefer-software` in this mode and report an
honest non-hardware verdict; normal hardware-first probing is untouched. Filter selection removes
Canvas2D together with WebGPU/WebGL. Image decode declines force-software until a licensed software image
decoder exists. Fail-first tests pin selection, probe arguments, cache isolation, typed misses, and the
absence of GPU/canvas calls; a multi-sample pure-router benchmark guards routing overhead.

## Implemented result and validation

`CodecDriver.supports` now accepts an additive optional determinism context. The router retains a
hardware-ranked codec only long enough to demand an explicit non-hardware verdict, while GPU codec tiers
and WebGPU/WebGL/Canvas2D filters remain ineligible. WebCodecs video and audio probe only their exact
`prefer-software` configurations in forced mode and reject rewritten platform verdicts. Auto mode and its
exact-config cache remain separate.

Image decode now sniffs the resolved source before the replayable dual-track materialization. A matched
image in forced mode raises `CapabilityError`, cancels the one-shot cursor, and does not read beyond the
4 KiB routed prefix or invoke the decoder. A negative image decision preserves that prefix and then
materializes a non-image stream exactly once for independently pulled audio/video outputs. Focused router,
WebCodecs acceleration, engine, one-shot, and image tests are green; the lifecycle test observes exactly
one producer pull and one cancellation.

The fresh benchmark command is `bun run bench-session12-deterministic-routing` (three warmups plus 21
measured samples). It reports 1.640 us per uncached forced-software selection, 0.744 us per exact cached
selection, and 14.607 us per public bounded image-decline operation (100 operations per sample, each
asserting one pull, one cancel, and no decoder construction).
