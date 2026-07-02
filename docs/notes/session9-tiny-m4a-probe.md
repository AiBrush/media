# Session 9 Tiny M4A Probe Fast Path

## Goal

Close `probe/micro_audio_short`, a tiny AAC-in-M4A metadata row where all engines passed the same oracle
but aibrush-media lost on fixed per-operation overhead.

## Diagnosis

The fresh pre-fix Chromium run `chromium-2026-07-02T11-18-11-221Z.json` measured aibrush-media at
7.620 ms median while mp4box passed at 4.540 ms and mediabunny at 4.585 ms. Later local iterations got the
generic MP4 path closer but still left the row exposed to fetch/setup noise.

The fixture is only 1,369 bytes. The harness supplies the known source size and a URL ending in `.m4a`,
but our URL `range(0, size)` still used a Range request, and the generic MP4 metadata parser still built
more structure than the oracle needs for a tiny audio-only file.

## Design

The fix has two narrow pieces:

- Known-size URL sources at or below 16 KiB satisfy a full-window range read with a plain GET. The source
  still memoizes size honestly, using `Content-Length` when present and the body length otherwise, and
  typed `InputError` failures remain intact.
- MP4 probe tries a tiny audio-only parser only for sources with an `audio/mp4` or `audio/x-m4a` MIME hint,
  or an internal source key ending in `.m4a`. It reads the small source once, finds a complete top-level
  `moov`, accepts only `soun`/`mp4a`, parses `esds`, `mdhd`, `tkhd`, `hdlr`, and simple edit-list plus
  `stts` gapless facts, then returns exact `TrackInfo`.

Unsupported shapes return `undefined` and fall back to the ordinary MP4 metadata parser. There is no
scenario id, filename special case beyond the generic `.m4a` hint, cross-run cache, or oracle shortcut.

The source module was also split so OPFS and URL-size probing load only on demand; this preserved the
eager and first-operation JS budgets despite the new tiny transport branch.

## Validation

- `bun run test -- src/sources/source.test.ts src/sources/cache.test.ts src/api/create-media.test.ts src/drivers/mp4/mp4.test.ts`
- `bun run gate`
- Fresh browser gate: `chromium-2026-07-02T12-59-35-544Z.json`

Fresh same-run result for `probe/micro_audio_short`:

- aibrush-media: 2.275 ms median over 9 samples
- remotion-media-parser: 3.100 ms
- mediabunny: 4.205 ms
- mp4box: 4.495 ms

Regenerated `docs/perf/performance-deficits.md` and `docs/perf/_deficit-data.json`: 288 active losses,
289 raw losses, 1 ADR-backed exemption.

## Rejections

Rejected hardcoded fixture routing, applying the tiny parser to generic tiny MP4/video sources, fabricating
gapless facts, cross-iteration metadata caches, competitor delegation, unbounded whole-file reads, and
moving OPFS or URL-size helpers into the eager source closure.
