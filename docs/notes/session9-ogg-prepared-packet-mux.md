# Session 9 - Ogg Prepared Packet Mux

## Goal

Close `mux/opus_to_ogg` on Chromium without changing the oracle, adding fixture shortcuts, or weakening
the public mux contract. The cell is done only when a fresh multi-sample median is fastest or tied-fastest
against other passing engines on the same workload.

## Baseline

After the tiny M4A probe row closed, the Ogg mux row surfaced in the active deficit backlog. The first
fresh run exposed a public parser bug: callers using the documented bounded `{ track, packetsArray }`
shape were rejected as `invalid mux packet stream`. Fixing that made the cell pass, but still slow:
aibrush-media was **14.545 ms** median while mediabunny was **8.350 ms**. The remaining cost was not page
writing itself; it was representation overhead. The prepare step was de-lacing Ogg into data we already
owned, wrapping packets in host `EncodedAudioChunk`s, and then copying those bytes back out before
`writeOgg()` could lay pages.

## Design

The implementation keeps one public authoring path. `media.mux()` now accepts both documented packet
stream forms, including bounded `packetsArray`, and the lazy mux module recognizes the exact single-track,
non-fragmented Ogg audio case. That path drains the caller's packet iterable once, preserves abort and
empty-input errors as typed media errors, and calls the same `writeOgg()` page writer used by `OggMuxer`.

The browser harness adapter no longer builds live chunks when it can prepare an Ogg source from bounded
bytes. It calls the package's `oggPacketInfoFromBytes()` helper, then creates public packet descriptors
with owned `Packet.data` views and the same track config. The final bytes are still produced by
`engine.mux()`, so the adapter does not become a second muxer and the reference-reimport oracle remains a
real container check.

## Edge Cases

- Bounded `packetsArray` and streaming `packets` both remain accepted by public mux.
- Empty prepared streams still reject with typed errors.
- Opus packet durations remain derived from packet TOC before host hints.
- Vorbis and FLAC codec-private headers still flow through the existing Ogg writer state.
- Ogg page lacing and CRCs are still produced by `writeOgg()`, not a shortcut.
- Unknown, fragmented, multi-track, or unsupported codec/container shapes fall back or reject through the
  existing mux validation.

## Validation

Package tests cover public Ogg `packetsArray` mux against a real fixture and prove the prepared array path
uses the same page writer without calling `EncodedChunk.copyTo()` when `Packet.data` is present. The writer
test independently scans Ogg pages, validates CRCs, and de-laces payloads so the layout check can fail if
the writer drifts.

Fresh Chromium export `chromium-2026-07-02T13-18-33-377Z.json` closed the cell:

- aibrush-media: **9.655 ms** median, PASS.
- mediabunny: **11.765 ms** median, PASS.
- ffmpeg.wasm: **15.965 ms** median, PASS.

Regenerated backlog: **287 active deficits**, severity `0/0/72/215`, plus the existing ADR-130 parity
exemption.
