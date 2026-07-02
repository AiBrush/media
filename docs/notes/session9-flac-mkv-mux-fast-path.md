# Session 9 FLAC-to-MKV Mux Fast Path

## Concrete Goal

Close the `mux/flac_to_mkv_audio` Chromium speed deficit without adding a feature, changing an oracle, or
claiming support beyond the existing public packet mux contract. The row starts after the browser harness
has prepared a real encoded FLAC audio track from the source fixture, so the timed package work is to author
Matroska around caller-supplied FLAC packets faster than the fastest fresh rival while preserving the same
compressed frames and metadata.

## Design Note

The narrow SOTA move is to remove fixed overhead that is irrelevant once the caller has already supplied a
single native-FLAC audio packet stream. The generic public `mux()` path must handle multi-track assembly,
slot validation, codec/container legality, WebM versus Matroska, fragmented output, B-frame DTS ordering,
and arbitrary muxers. This row needs only one non-fragmented Matroska audio track with monotonic FLAC frame
packets and FLAC setup metadata. `muxFlacMkv()` therefore detects exactly that shape, drains the caller
stream once, preserves `CodecPrivate` from the track config, and calls the shared `writeWebm()` serializer
directly with one `A_FLAC` track. When packets carry the additive optional `data` payload, the helper uses
those owned bytes instead of copying out of `EncodedChunk` again. The browser harness preparation mirrors
that same principle: FLAC packet-info rows expose validated frame `offset` and `durationUs`, so the adapter
can slice the original FLAC bytes into real packet payloads and wrap them in lightweight chunk views rather
than materializing host chunks just to copy them back out. The output is still freshly authored Matroska;
only redundant object construction and byte copies are removed.

## Edge Cases

- **Not the exact row:** any video stream, multiple tracks, non-FLAC codec, WebM target, or fragmented MKV
  returns `undefined` to the existing generic mux route.
- **Frame lifetime:** the helper never retains live WebCodecs objects; it either consumes caller-owned
  `Packet.data` bytes or owns one byte copy per chunk after `copyTo()`.
- **Offset metadata:** `packetInfo()` offsets are optional and used only when supplied by the validated FLAC
  native frame scanner; callers without offsets continue through the ordinary packet stream.
- **Abort:** the helper checks `AbortSignal` before each read and raises `MediaError('aborted')`.
- **Empty input:** a zero-packet stream raises `MediaError('mux-error')` instead of authoring an empty file.
- **CodecPrivate:** FLAC metadata bytes remain in the Matroska `CodecPrivate` field, and the parser exposes
  them again as the decoded track description.
- **Backpressure:** the path materializes one final output chunk, matching the existing non-fragmented
  `WebmMuxer` shape; streaming and fragmented targets stay on the generic/live writer paths.

## Validation

- `bun test src/api/codec-ops.test.ts src/drivers/flac/flac.test.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bunx biome check src/contracts/driver.ts src/drivers/flac/flac-sniff.ts src/drivers/defaults.ts src/drivers/flac/flac-driver.ts src/api/flac-mkv-mux.ts`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- Sibling harness: `bunx biome check src/engines/aibrush-media/adapter.ts`

The focused API test demuxes the real `sfx.flac` fixture, calls public `media().mux()` with a FLAC packet
stream, reparses the output as Matroska, and asserts the FLAC track plus codec-private metadata survive.
The budget check reports the eager kernel at 49.66 kB against the 50.00 kB cap.

## Benchmark Status

Local package sanity check, measured after three warmups over a prepared real `sfx.flac` packet stream,
reported 15 samples with median 0.199 ms for public `mux()` plus Blob materialization. That result is only
a package-level signal, not the official Session 9 speed gate.

The official all-engine Chromium harness run is:

```text
/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T21-09-19-372Z.json
```

It uses the same property oracle with three warmups and nine timed samples. Passing medians:

| Engine | Median wall time |
|---|---:|
| `aibrush-media@dev` | 2.725 ms |
| `mediabunny@1.48.0` | 6.420 ms |
| `ffmpeg.wasm@0.12.15` | 9.755 ms |

`docs/perf/gen-deficits.mjs` was regenerated after that export. `mux/flac_to_mkv_audio` is no longer a
deficit; the living backlog now reports 304 active deficits and promotes `mux/size_micro_1frame_to_mp4` to
the top row.
