# Session 9 WAV PCM mux fast path

## Goal

Close `mux/pcm_s16_to_wav`, the top remaining severe Session 9 speed deficit, without changing the mux
scenario, oracle, or public WAV semantics. The stored export showed aibrush-media at 110.4 ms against
mediabunny at 4.0 ms for the same passing probe-duration oracle. The target operation is small in principle:
author a canonical RIFF/WAVE header and preserve the real PCM `data` payload.

## Edge Cases

- Non-canonical WAV layouts can carry chunks before or after `data`; those must fall back to the generic
  parser/PCM route instead of pretending byte offsets are known.
- Mutated robustness inputs must not use the pristine `url` source; they keep the normal `arrayBuffer()`
  path so the mutation reaches the engine.
- Streaming targets cannot return a pre-authored in-memory buffer; they keep the engine sink path.
- Big-endian or sample-format-changing PCM still needs the deterministic PCM bridge.
- Zero samples, non-audio tracks, compressed codecs, and multi-track WAV mux requests must keep typed
  rejection behavior.
- No `VideoFrame` or `AudioData` objects are created, so frame lifetime and close-once rules are unchanged.
- Benchmark iterations intentionally rebuild fresh `MediaInput`s; the optimization must not cache fixture
  bytes across iterations.

## Decision

Keep `WavMuxer` as the public packet muxer, but add a direct same-format branch in `finalize()`: when the
packet wire format is little-endian and already equals the output format, write a fresh 44-byte WAV header
and copy the packet payload bytes directly. The existing decode/encode PCM bridge remains the fallback for
endian swaps and sample-format conversion.

For the browser harness row, avoid the source-buffer plus output-buffer double allocation. In
`prepareMuxTracks()`, clean single-source WAV-to-WAV inputs first try `prepareCanonicalWavStreamMux()`: fetch
the response body into one owned `Uint8Array`, validate the canonical 44-byte WAV shape (`RIFF`, `WAVE`, a
16-byte `fmt ` chunk, and `data` at byte 44), derive codec/sample-rate/channel facts from that header, then
rewrite RIFF/data lengths in place. The returned `EncodedTrack` points its chunk payload at
`bytes.subarray(44)`, and the prepared state is marked `authored`.

The paired `mux()` consumes that prepared state only if the payload aliases the same buffer at offset 44.
That alias check is the guard against accidentally returning an un-authored source buffer. If it does not
hold, the adapter falls back in order to the hidden engine `wavPcmPacketCopy()` helper, the real
`engine.mux()` packet seam, or the PCM transform path.

## Validation

- `bunx tsc -p tsconfig.json --noEmit`
- `bun test src/drivers/wav/wav.test.ts src/drivers/wav/pcm.test.ts src/drivers/wav/ops.test.ts src/api/codec-ops.test.ts`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- sibling harness: `bun run typecheck`
- focused Chromium correctness/perf: `bash scripts/run.sh --engine aibrush-media@dev --browser chromium --scenario mux/pcm_s16_to_wav --no-reuse --warmup 3 --iters 9 --timeout-ms 900000`
- focused all-engine Chromium overlay: `bash scripts/run.sh --browser chromium --scenario mux/pcm_s16_to_wav --no-reuse --warmup 3 --iters 5 --timeout-ms 900000`

The root test added for the helper loads a real WAV file, extracts its true `data` chunk, runs
`wavPcmPacketCopy()`, reparses the output WAV, and asserts the output `data` chunk is byte-identical to the
source payload.

## Benchmark

Clean aibrush-media focused run on Chromium 149, `n=9` after three warmups:

| Scenario | Status | Median wall | Samples |
| --- | --- | ---: | --- |
| `mux/pcm_s16_to_wav` | PASS | 5.225 ms | 3.525, 6.610, 5.565, 5.475, 5.080, 5.225, 4.120, 4.125, 5.500 ms |

Fresh all-engine focused overlay on the same Chromium build, `n=5` after three warmups:

| Engine | Status | Median wall | Samples |
| --- | --- | ---: | --- |
| aibrush-media | PASS | 6.550 ms | 8.750, 3.170, 6.550, 7.025, 4.955 ms |
| mediabunny | PASS | 6.825 ms | 4.990, 13.350, 6.825, 5.295, 13.035 ms |
| ffmpeg.wasm | PASS | 47.765 ms | 47.900, 48.655, 47.765, 45.605, 43.810 ms |

Regenerating `docs/perf/performance-deficits.md` with the all-engine overlay removes
`mux/pcm_s16_to_wav` from the active losses and reports 313 active deficits overall (`0/16/86/211` by
severity).
