# Session 11 eager codec-frame split

## Goal

Return the default-entry static JavaScript closure below the hard 50 KiB kernel budget with useful
margin, without changing any public operation, media result, cancellation behavior, or frame ownership.
The cold code in scope is the raw-PCM-to-`AudioData` bridge and post-decode frame adaptation: these
helpers are used only after a decode/encode/accurate-trim request has crossed the existing lazy codec
pipeline boundary.

## Approach

Keep the synchronous `decode()` facade and its deferred-stream pump eager, but move raw PCM framing into
the already-required `dsp/audio-data.ts` chunk and gapless adaptation into `codec-pipeline.ts`. Move the
accurate-trim `VideoFrame` restamper into the already-lazy `trim-streams.ts` module. This follows the
established codec-pipeline split (ADR-103), adds no fetch to the raw-PCM operation, and keeps the default
probe/demux kernel free of browser-native frame constructors. A rejected alternative was to
shorten or minify source manually: that would make the code harder to audit while retaining the same
eager behavior and would not enforce the architectural pay-for-use boundary.

## Invariants and edge cases

- Raw PCM is emitted in bounded 4,096-frame chunks with exact timestamps and `f32-planar` layout.
- A pre-aborted signal rejects before a frame is constructed; a cancel/enqueue race closes the newly
  constructed `AudioData` exactly once.
- Construction failures remain typed `MediaError`s, while a missing browser `AudioData` capability
  remains a typed `CapabilityError` before stream creation.
- Gapless AAC/Opus adaptation preserves the existing no-metadata identity fast path and delegates the
  trimmed path to the same close-once `trimAudioGaplessFrameStream` implementation.
- Accurate video trim returns the input frame unchanged when timing already matches and otherwise
  creates one replacement whose ownership remains with the trim stream.
- B-frames, VFR packet order, seek behavior, encoder backpressure, and force-software selection are not
  altered: the split moves frame helpers without changing their callers or routing decisions.

## Validation

Pin the raw-PCM bridge with constructor/cancel/abort/capability tests and retain the existing codec,
accurate-trim, metadata, and image suites: 339 focused tests pass. Strict typecheck, Biome, the production
build, vendored-WASM packaging, dist smoke, and `check-budgets` are green. The current settled combined eager
closure is 49.68 KiB versus the 51.26 KiB pre-split build, leaving 0.32 KiB below the 50 KiB ceiling after
the independent exact Router-cache serializer also landed. This is package-budget evidence, not browser
throughput or full-harness acceptance.
