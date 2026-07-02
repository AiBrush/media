# Session 9 Ogg Demux Packet Table

## Goal

Close `demux/opus`, where the Ogg Opus packet table was correct but slower than mediabunny on the same
`golden-packets` oracle.

## Diagnosis

The fresh pre-fix run `chromium-2026-07-02T11-08-31-753Z.json` measured aibrush-media at 14.830 ms
median versus mediabunny at 8.150 ms. The Ogg driver already had a pure packet-info function for prepared
mux callers, and the harness adapter already knows how to consume a demuxer's packet table without
constructing `EncodedAudioChunk`s. The driver demux path did not expose that table. It read a bounded
metadata head, parsed track facts, read the whole Ogg file again for packet payloads, then let the adapter
fall through into live packet stream handling.

## Design

Make `OggDriver.demux()` compute the existing `oggPacketInfoTable()` from one full-source read and expose
two table views: contract `packetTable()` for ordinary library consumers, and the same internal
`packetInfoTable()` alias already used by MP4 for harness packet rows. The live `packets(trackId)` stream
now reuses those rows for packet byte offsets instead of re-running Ogg de-lacing. Probe remains
unchanged: small sources still use one bounded range, and larger sources still use head+tail range reads
for duration without reading payloads.

This does not skip any oracle work. The demux row still parses every Ogg page, validates packet count,
timestamps, sizes, keyframes, and track attribution through the same baked `golden-packets` oracle.

## Validation

- `bun test src/drivers/ogg/ogg.test.ts src/drivers/ogg/ogg-write.test.ts src/api/create-media.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- Fresh browser gate:
  `chromium-2026-07-02T11-16-15-767Z.json`

Fresh result: aibrush-media **6.690 ms** median, faster than mediabunny **7.235 ms** and ffmpeg.wasm
**12.235 ms**. Focused tests pin that seekable Ogg demux performs one full range read, exposes both table
forms, and leaves the probe head+tail behavior intact for larger metadata-only sources.

## Rejections

Rejected adapter-only special-casing, packet oracle weakening, returning cached fixture rows, skipping
Ogg lacing/timestamp parsing, constructing fake packet counts from duration, and changing Ogg probe to
read the whole file.
