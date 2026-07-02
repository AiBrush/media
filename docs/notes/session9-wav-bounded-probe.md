# Session 9 WAV Bounded Metadata Probe

## Goal

Close `audio-dsp/edge_longform_audio_probe`, where aibrush-media was correct on a one-hour PCM WAV probe
but lost wall time to mediabunny on the same golden-metadata oracle.

## Diagnosis

The fresh pre-fix run `chromium-2026-07-02T10-54-32-760Z.json` measured aibrush-media at 4.115 ms median
versus mediabunny at 3.145 ms. The harness adapter already passed the known `wav` container token, so the
hot path was the library's container probe. WAV did not expose `ContainerDriver.probe()`, which meant
`probeContainer()` fell back to `demux()`. That fallback was still bounded, but it read the 64 KiB demux
header window and constructed a live demux object even though the metadata oracle only needs `fmt ` plus
the `data` chunk length.

## Design

Add a real `WavDriver.probe(src, o)` that parses only WAV header metadata and returns `TrackInfo[]`.
The common parser now reports whether the `data` chunk was visible inside the bytes it received. Probe
first reads 4 KiB, which covers ordinary RIFF/WAVE `fmt ` + `data` headers, computes duration from the
declared data size clamped by the real source length, and returns without constructing packet state. If a
valid `fmt ` chunk is present but the `data` chunk sits behind a larger metadata chunk, probe falls back
once to the existing 64 KiB demux header window. Files whose metadata is still outside that bounded window
continue to fail through the typed parser path instead of scanning a multi-hundred-megabyte PCM payload.

No fixture name, scenario id, or benchmark cache is involved. The demux path still uses the 64 KiB window
because it must support the existing packet/PCM operations, while probe pays only the metadata window.

## Validation

- `bun test src/drivers/wav/wav.test.ts src/api/create-media.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- Fresh browser gate:
  `chromium-2026-07-02T11-02-48-670Z.json`

Fresh result: aibrush-media **4.570 ms** median, faster than mediabunny **5.490 ms** and all other
same-run passing rivals. The focused tests prove the one-range 4 KiB metadata path and the bounded 64 KiB
fallback when `data` follows a large chunk.

## Rejections

Rejected whole-file WAV scans, harness-only WAV metadata parsing, caching the longform fixture metadata,
hardcoding RIFF offsets beyond the chunk grammar, weakening the golden metadata oracle, and changing PCM
demux or frame ownership for a metadata-only speed row.
