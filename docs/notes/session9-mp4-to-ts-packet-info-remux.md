# Session 9 Note - MP4 packet-info to MPEG-TS remux

## Problem

After the lazy muxer race was fixed, `mux/h264_aac_to_ts` passed but lost badly on speed. The fresh
Chromium proof `chromium-2026-07-05T01-02-04-386Z.json` measured aibrush-media at **333.285 ms** median and
mediabunny at **85.360 ms** median on the same passing `property-invariant` workload.

The generic remux seam was doing extra work for this shape: it constructed per-track packet streams,
created WebCodecs `Encoded*Chunk` wrappers, copied bytes out again through the mux drain, and coordinated
multiple async drains. MP4 packet-info already contains the exact source byte spans and timing facts the
MPEG-TS writer needs.

## Design

`MediaEngineImpl.#remuxViaSeam()` now tries a lazy MP4 packet-info route before the generic seam when
`opts.to === 'ts'`.

The helper applies only when all proof is present:

- source container is MP4-family;
- output is not fragmented;
- source has known `size` and `range()`;
- source size is at most **64 MiB**;
- the container exposes `packetInfo()`;
- selected tracks have codec configs;
- selected packet rows have finite, in-bounds offsets and sizes.

The route reads the bounded source once, selects tracks through the existing selector helper, registers them
on `MpegTsMuxer`, and feeds `ChunkStruct.data` views from packet-info offsets. The MPEG-TS muxer still owns
all codec/container semantics: H.264 AVCC samples become Annex B, SPS/PPS are emitted before keyframes, AAC
payloads get ADTS headers, packets are ordered by DTS, and PES timestamps use the existing rebase rules.

If eligibility is absent, the helper returns `undefined` before output and the existing generic packet seam
handles the job. If a selected packet row becomes invalid after the path starts, the helper raises a typed
`MediaError` or `CapabilityError`.

## Edge Cases

- B-frames: preserve packet DTS and PTS from MP4 packet-info rows.
- VFR: preserve per-packet durations where available.
- Track selection: use the existing `selectTrackInfos()` semantics; empty selection is typed.
- Short source reads: reject as `demux-error`.
- Unsupported codecs: let `MpegTsMuxer.addTrack()` reject; do not author partial output.
- Large or non-seekable sources: fall back to the existing seam before output.

## Validation

- `bun test src/api/codec-ops.test.ts --test-name-pattern "MPEG-TS|packet-info|mp4 -> ts"`
- `bunx biome check src/api/mpegts-packet-info-remux.ts src/api/engine.ts src/api/codec-ops.test.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`

The focused Node test installs throwing `EncodedVideoChunk` and `EncodedAudioChunk` constructors, then
remuxes real `movie_5.mp4` to TS. That proves the fast path does not silently fall back to host chunk
construction while still reparsing real H.264 and AAC TS output.

Fresh Chromium proof is still pending because the required harness sync writes to the sibling benchmark
repo and escalation was unavailable in this session window.

## Rejected

- Returning the MP4 input bytes.
- Authoring a fake TS shell.
- Bypassing MPEG-TS H.264/AAC normalization.
- Trusting packet-info rows without offsets.
- Applying the path to fragmented, encrypted, over-64-MiB, non-MP4, non-seekable, or unsupported-codec
  sources.
- Caching completed TS outputs, packet tables, timings, or oracle facts.
- Routing by scenario id, fixture filename, byte count, or timing.
