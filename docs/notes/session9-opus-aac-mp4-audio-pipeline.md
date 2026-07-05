# Session 9 Note - Opus to AAC MP4 Audio Pipeline

## Goal

Close `transcode/opus_to_aac_mp4` on Chromium without adding a feature, changing the source asset,
changing the output container, weakening the `property-invariant` or `playback-smoke` oracles, or faking an
MP4. The workload decodes Opus from Ogg, encodes AAC with WebCodecs, and muxes one audio track into MP4.

## What Was Slow

A fresh pre-fix Chromium n=5 run measured:

- aibrush-media: 274.290 ms median, samples `[281.210, 274.290, 270.310, 273.720, 274.870]`, PASS
- mediabunny: 91.670 ms median, samples `[91.670, 89.735, 95.510, 90.385, 94.980]`, PASS
- Both engines passed `property-invariant` with `durationDeltaSec=0.08366666666666767`, tolerance `0.12`,
  one audio track, and `playback-smoke`.

The useful work is real and unavoidable: Ogg packetization, native Opus decode, native AAC encode, AAC
decoder-config capture, and MP4 sample-table authoring. The avoidable cost was fixed pipeline overhead:

- the WebCodecs audio driver polled `decodeQueueSize` / `encodeQueueSize` with `setTimeout(0)` while a
  tiny-packet stream was backpressured, paying hundreds of macrotasks;
- codec/bitrate-only audio transcodes imported the lazy audio-filter planner just to discover that no
  `AudioData -> AudioData` filter stage was required.

Studying mediabunny's behavior showed the important technique, not code to copy: WebCodecs exposes a native
`dequeue` event for queue-drain pacing. We reimplemented that idea inside our typed stream driver and kept
the rest of the engine topology intact.

## Technique

The WebCodecs audio driver now uses `awaitAudioCodecQueueDrain()` to wait on the coder's native `dequeue`
event instead of macrotask polling. The helper is pure enough to unit-test with a fake `EventTarget`, honors
abort, removes all listeners on every settle path, and rechecks the queue after listener attachment to avoid
missing a drain race. The high-water mark is **128** packets: fresh runs showed 8 and 32 still lost narrowly,
while 512 made burstiness and median time worse.

The engine now also skips the lazy audio-filter planner for targets with no audio-shaping fields:
`gainDb`, `fade`, `channels`, `sampleRate`, `biquad`, and `dynamics` must all be absent. Codec and bitrate
changes still proceed normally. If any shaping field is present, even an apparent no-op such as `gainDb: 0`
or a same-source `channels` value, the request still imports and runs `audioFilterSpecs()` so validation and
exact no-op semantics remain centralized.

This is not an output cache and not a special case for `opus.ogg` or the scenario id. Every sample still
decodes and encodes through WebCodecs and then muxes fresh MP4 bytes. The optimization only removes
avoidable scheduling and lazy-planner fixed cost from a real codec-seam transcode.

## Edge Cases

- Backpressure remains bounded: the driver pauses only while the native queue is at or above the threshold.
- Abort while waiting for `dequeue` resolves the wait and lets the existing typed abort path run.
- Encoder input `AudioData` is still closed exactly once in the encoder transform `finally` block.
- Decoder output ownership is unchanged: emitted `AudioData` belongs to the downstream consumer; late output
  after cancellation is closed by the existing enqueue guard.
- Filter-bearing audio targets keep the full lazy planner route, including validation for malformed gain,
  fade, sample-rate, channel, dynamics, and biquad requests.
- The 512-packet threshold was measured and rejected: it produced a slower aibrush median of
  112.870 ms versus mediabunny 101.295 ms in
  `chromium-2026-07-04T23-13-43-860Z.json`.

## Proof

Focused package validation:

```bash
bun test src/api/codec-pipeline.test.ts src/codecs/webcodecs-audio.test.ts
bunx biome check src/api/codec-routing.ts src/api/codec-pipeline.ts src/api/codec-pipeline.test.ts src/api/engine.ts src/codecs/webcodecs-audio.ts src/codecs/webcodecs-audio.test.ts
bunx tsc --noEmit
bun run build
bun run vendor-wasm
bun run check-budgets
```

Harness validation:

```bash
bash scripts/run.sh --browser chromium \
  --engine aibrush-media,mediabunny \
  --scenario transcode/opus_to_aac_mp4 \
  --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Fresh result:
`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T23-17-16-669Z.json`.

- aibrush-media: 99.835 ms median, samples
  `[99.835, 88.035, 96.165, 107.245, 104.610]`, PASS
- mediabunny: 101.110 ms median, samples
  `[106.100, 92.530, 105.355, 98.820, 101.110]`, PASS
- Both engines passed `property-invariant` with `durationDeltaSec=0.08366666666666767`, tolerance `0.12`,
  one audio track, and `playback-smoke`.
- aibrush-media reported 100.235x median realtime throughput, 28,406,438 bytes median peak memory, and
  0 ms median long tasks.
- `bun run check-budgets` stayed green: eager kernel 47.90 kB / 50.00 kB, default/probe first-operation
  closure 255.22 kB / 256.00 kB.
