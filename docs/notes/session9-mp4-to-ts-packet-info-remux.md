# Session 9 Note - MP4 packet-info to MPEG-TS remux

## Problem

After the lazy muxer race was fixed, `mux/h264_aac_to_ts` passed but lost badly on speed. The fresh
Chromium proof `chromium-2026-07-05T01-02-04-386Z.json` measured aibrush-media at **333.285 ms** median and
mediabunny at **85.360 ms** median on the same passing `property-invariant` workload. A later proof after
the MP4 packet-info remux shortcut still lost at **267.965 ms** vs mediabunny **87.130 ms** because the
measured mux scenario prepares packet tracks first and then calls `mux()`.

The generic remux seam was doing extra work for this shape: it constructed per-track packet streams,
created WebCodecs `Encoded*Chunk` wrappers, copied bytes out again through the mux drain, and coordinated
multiple async drains. MP4 packet-info already contains the exact source byte spans and timing facts the
MPEG-TS writer needs.

## Design

`MediaEngineImpl.#remuxViaSeam()` now tries a lazy MP4 packet-info route before the generic seam when
`opts.to === 'ts'`, and the public packet-array `mux(..., { container: 'ts' })` path now has a prepared
MPEG-TS writer.

The helper applies only when all proof is present:

- source container is MP4-family;
- output is not fragmented;
- source has known `size` and `range()`;
- source size is at most **64 MiB**;
- the container exposes `packetInfo()`;
- selected tracks have codec configs;
- selected packet rows have finite, in-bounds offsets and sizes.

The remux route reads the bounded source once, selects tracks through the existing selector helper, and
feeds `MpegTsChunk.data` views from packet-info offsets. The prepared mux route accepts the exact
`TrackInfo` + packet arrays produced by the mux preparation step and uses `Packet.data` directly when it is
present and byte-exact. The MPEG-TS writer still owns all codec/container semantics: H.264 AVCC samples
become Annex B, SPS/PPS are emitted before keyframes, AAC payloads get ADTS headers, packets are ordered by
DTS, and PES timestamps use the existing rebase rules.

To make the route competitive, `TsPacketChunkWriter` writes each 188-byte transport packet directly into
the current output chunk buffer. This removes one tiny `Uint8Array` allocation per transport packet and the
group `concatBytes()` pass while preserving packet-aligned output chunks.

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
- Public mutable chunks: `addChunkStruct()` still copies defensively; the borrow-only route is the
  synchronous prepared helper whose caller already owns immutable packet bytes.

## Validation

- `bun test src/api/mpegts-prepared-mux.test.ts src/api/mpegts-packet-info-remux.test.ts src/drivers/mpegts/mpegts.test.ts`
- `bun test src/api/codec-ops.test.ts --test-name-pattern "MPEG-TS|packet-info|mp4 -> ts|muxes caller-supplied demux packets"`
- `bunx biome check src/api/mpegts-packet-info-remux.ts src/api/engine.ts src/api/codec-ops.test.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`

The focused Node test installs throwing `EncodedVideoChunk` and `EncodedAudioChunk` constructors, then
remuxes real `movie_5.mp4` to TS. That proves the fast path does not silently fall back to host chunk
construction while still reparsing real H.264 and AAC TS output.

The prepared mux test additionally uses packet objects whose `copyTo()` throws while `Packet.data` is
present, proving the prepared TS path uses owned packet bytes instead of falling back to WebCodecs copying.

Fresh Chromium proof closed the row: `chromium-2026-07-05T10-05-35-799Z.json` measured aibrush-media
**PASS** at **71.880 ms** median over samples `[82.585, 61.805, 78.200, 62.865, 71.880]`; mediabunny
**PASS** on the same oracle at **87.500 ms** median over `[101.725, 78.240, 91.500, 78.585, 87.500]`.
Both outputs preserved the duration invariant with `deltaSec=0.037333333333332774` under the
`0.041666666666666664` tolerance. `docs/perf/gen-deficits.mjs` regenerated
`docs/perf/performance-deficits.md` with the fresh overlay and removed `mux/h264_aac_to_ts`, reducing
active deficits from **165** to **164**.

## Rejected

- Returning the MP4 input bytes.
- Authoring a fake TS shell.
- Bypassing MPEG-TS H.264/AAC normalization.
- Trusting packet-info rows without offsets.
- Applying the path to fragmented, encrypted, over-64-MiB, non-MP4, non-seekable, or unsupported-codec
  sources.
- Caching completed TS outputs, packet tables, timings, or oracle facts.
- Routing by scenario id, fixture filename, byte count, or timing.
- Increasing chunk size alone while keeping per-packet allocations.
