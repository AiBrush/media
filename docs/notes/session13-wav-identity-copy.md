# Session 13 same-layout WAV multipart re-authoring

## Goal and baseline

Close the remaining fixed cost in `audio-dsp/meta_idempotent_resample_same_rate` without performing a fake
resample or returning the input. The fresh same-export baseline selected baked `wav_s16.wav` (240,000 sample
frames, 48 kHz, stereo): aibrush passed at 4.380 ms median (MAD 0.165, `n=5`) and mediabunny passed at
2.970 ms (MAD 0.430). Browser closure remains open until the final bundle is rerun on the same export.

ADR-138 already routed this shape through `rewriteWavPcmCopy`; the remaining work was full source/output
materialization and broad transform-module setup, not sample DSP.

## Design and edge cases

The copy parser now has two honest outputs:

- buffer callers receive a fresh contiguous canonical WAV, exactly as before;
- Blob/File/stream transform callers receive a fresh owned 44-byte canonical header plus a validated PCM
  payload view. Blob/File constructors snapshot both parts. Streams emit header and payload on separate pulls
  with `highWaterMark: 0`.

Every route still walks RIFF chunks, parses `fmt ` and bounded `data`, validates sample format, little-endian
wire order, channel count, and sample rate, and declines any mismatch into the real transform path. A JUNK
chunk is removed by canonical re-authoring. Existing bounded behavior for a declared `data` chunk truncated
by the actual file remains byte-identical. No source container/Blob/whole-file array is returned.

The two-part stream clears header, payload, controller, and abort listener at EOF, cancel, abort, enqueue
failure, or source error. Cancellation between header and payload therefore drops the remaining input view.
Raw PCM has no B-frame or VFR reorder, and this path creates no `AudioData`/`VideoFrame` lifetime.

## Validation

```text
bun test src/drivers/wav/pcm.test.ts src/drivers/wav/wav.test.ts
bun test src/api/pcm-trim.test.ts src/api/codec-ops.test.ts src/api/create-media.test.ts
bunx tsc -p tsconfig.json --noEmit
bunx biome check src/api/pcm-convert-plan.ts src/drivers/wav/pcm.ts \
  src/drivers/wav/wav-copy-stream.ts src/drivers/wav/wav-driver.ts \
  src/drivers/wav/transform-dependencies.ts scripts/bench-session13-wav-identity-copy.ts package.json
```

Focused tests prove canonical and noncanonical output equality, mismatch fallback, bounded truncation,
header-before-payload backpressure, cancellation between parts, and Blob snapshot stability after mutating the
caller's original input bytes.

## Product benchmark

`bun run bench-session13-wav-identity-copy` derives a 960,044-byte five-second/stereo/48 kHz/s16 input from
the real `stereo-48000.wav` corpus fixture, matching the public row's 240,000 sample frames. It alternates
fresh paths for `n=101` after seven warmups and compares complete canonical output bytes.

| Path | Median | MAD | JS output allocation before Blob snapshot |
| --- | ---: | ---: | ---: |
| contiguous rewrite, then Blob | 0.041 ms | 0.004 ms | 960,044 bytes |
| canonical header + PCM multipart Blob | 0.015 ms | 0.001 ms | 44 bytes |
| public multipart `convert()` (hinted) | 0.023 ms | 0.004 ms | 44 bytes |
| public multipart `convert()` (unhinted) | 0.029 ms | 0.005 ms | 44 bytes |

Multipart construction is 2.71x faster in the representative paired product benchmark (independent fresh
runs span 2.08-3.14x) and eliminates 960,000 bytes of temporary JavaScript output allocation. This is
general size-proportional work removal, not proof of browser
leadership. Qualified final wall and memory evidence is still required.

## Rejected

- Input passthrough or reusing the input container header.
- Fixture/frame-count/name/digest recognition.
- Treating explicit target metadata as validation without parsing the source.
- Weakening rate/channel/format/truncation truth.
- A generic engine or sink special case outside the WAV path.
- Retaining the payload after terminal stream edges.
- Claiming the row closed from this product benchmark.
