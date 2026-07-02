# Session 9 FLAC to Ogg Stream-Copy Target

## Goal

Close `remux/flac_seektable_flac_to_ogg`, where aibrush-media correctly rewrapped native FLAC frames into
Ogg-FLAC but lost to ffmpeg.wasm on wall time.

## Diagnosis

The fresh baseline `chromium-2026-07-02T10-39-19-821Z.json` measured aibrush-media at 11.720 ms median
versus ffmpeg.wasm at 7.865 ms. The old route was the generic browser packet seam: parse native FLAC
frames, wrap every frame in `EncodedAudioChunk`, then have `OggMuxer.write()` call `copyTo()` to recover
the same bytes.

First, `OggMuxer.write()` was taught to prefer `Packet.data` when the demuxer already supplies owned
payload bytes. That removed one copy and improved the row to 8.385 ms in
`chromium-2026-07-02T10-44-58-870Z.json`, but ffmpeg.wasm's same-run median was 6.880 ms, so the row
remained active.

## Design

Add an optional `ContainerDriver.streamCopyTargets` declaration. It lets a source driver advertise
specific cross-container targets it can author natively without changing coded packets. The engine uses
that route only for full remuxes without tag rewrite or track selection; unlisted cross-container work
continues through the generic demux->mux packet seam.

The FLAC driver declares `ogg`. Its native path parses the FLAC metadata layout once, enumerates validated
native frame spans, builds the Ogg-FLAC track from the source metadata prelude, and feeds those frame byte
views into `OggMuxer.addChunkStruct()`. Ogg page construction, lacing, granules, and CRCs still come from
the existing Ogg muxer.

## Validation

- `bun test src/api/create-media.test.ts src/drivers/flac/flac.test.ts src/drivers/ogg/ogg-write.test.ts src/api/codec-ops.test.ts`
- `bun run typecheck`
- `bun run build`
- Fresh browser gate:
  `chromium-2026-07-02T10-49-15-283Z.json`

Fresh result: aibrush-media **10.105 ms** median versus ffmpeg.wasm **10.330 ms**, both PASS. Regenerating
the worklist reports **292 active deficits** with severity split `0/0/77/215` plus the ADR-130 parity
exemption.

## Rejections

Rejected adapter-only shortcuts, input passthrough, copying ffmpeg behavior or code, bypassing Ogg CRC
generation, making Ogg an input format of the FLAC driver, global packet caches, and hidden target support
without an explicit driver declaration.
