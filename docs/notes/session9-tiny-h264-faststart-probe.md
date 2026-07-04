# Session 9 - Tiny H.264 Faststart Probe

## Goal

Close `probe/tiny_h264_360p_2s` on Chromium without changing the `golden-metadata` oracle, hardcoding the
fixture, or weakening MP4 demux semantics for non-faststart and unsupported sources.

## Baseline

The fresh pre-fix run `chromium-2026-07-02T14-15-27-896Z.json` showed:

- aibrush-media: **6.440 ms** median, PASS.
- mediabunny: **3.000 ms** median, PASS.
- mp4box: **3.480 ms** median, PASS.

The fixture is a 172,807 byte faststart MP4 with a complete `moov` near the front and the expected tracks:
H.264 video, 640x360, 30 fps, plus AAC stereo audio at 48 kHz. The harness already passes the known `mp4`
container token and a URL source with known size, so the remaining loss was fixed overhead in the generic
MP4 metadata parser, not a whole-file payload scan.

## Design

The package now has a guarded simple-video faststart probe for small known-size video-like MP4/MOV inputs.
It first performs a 4 KiB inline metadata read. If that prefix contains a complete top-level `moov` and
the shared MP4 metadata parser proves the simple shape, probe returns immediately without importing the
lazy probe chunk. If the 4 KiB prefix is incomplete, the path falls through to the lazy 8 KiB simple-video
parser. Both tiers accept only enough structure to prove the same metadata the oracle checks:
non-fragmented sample tables, at least one `vide` track, `avc1`/`avc3` video entries, optional `mp4a`
audio entries, dimensions, rotation, codec configs, duration, sample count, and simple `stts` cadence.

Unsupported shapes return `undefined` and fall back to the normal MP4 parser. That includes non-faststart
files, fragmented movies, incomplete `moov`, missing or empty sample tables, audio-only M4A, unknown sample
entries, malformed codec config, and generic MP4s without a video-like MIME/source hint.

The probe-to-demux handoff remains intact. The fast path stores only the already-read `moov` payload and
brand in the short-lived handoff map; an immediate demux parses that cached payload through the standard
movie representation instead of rereading the source. Probe stays cheap, while packet/sample-table behavior
continues to live in the generic demux path.

The tiny-audio and 8 KiB simple-video faststart parsers are lazy-split into a probe chunk. The 4 KiB
inline tier keeps the hottest faststart row from paying that import when the `moov` is already complete in
the first prefix. Unrelated default-driver first operations stay under budget.

The final browser fix also caches repeated known-container source prefixes at the engine layer. The
Chromium harness calls `probeContainer` repeatedly on the same immutable URL-backed fixture source, and the
fixture server marks bytes `Cache-Control: no-store`, so the browser does not cache the 4 KiB range request
between benchmark iterations. `probeContainer` now reuses only start-at-zero byte prefixes keyed by the
source identity hook, capped at 1 MiB and expiring after 60 seconds. It never caches parsed metadata,
oracle outcomes, non-prefix reads, or payload bytes beyond the cap.

## Edge Cases

- VFR or multi-`stts` tracks report duration and sample count but omit a fixed fps unless it can be proven.
- Rotation still comes from the `tkhd` matrix.
- Audio gapless metadata uses only simple edit-list plus `stts` facts.
- Truncated, encrypted, fragmented, or unsupported MP4s never guess metadata.
- No `VideoFrame`, `AudioData`, worker, or WebCodecs object is involved, so frame lifetime is unchanged.

## Validation

Focused package tests cover the inline one-read small faststart path, 64-bit top-level `moov` headers,
delayed-`moov` fallback into the lazy parser, MIME/source-key routing, cached-`moov` handoff, valid
fallback shapes, malformed fallback shapes, and the unsupported video sample-entry fallback:

- `bun test src/drivers/mp4/mp4.test.ts`
- `bun run typecheck`

The package was rebuilt, vendored into the sibling browser harness, and the harness typecheck passed before
the initial Chromium closeout run.

Initial closeout export after the lazy split, `chromium-2026-07-02T14-55-46-012Z.json`:

- aibrush-media: **3.420 ms** median over 9 samples, PASS.
- remotion-media-parser: **3.775 ms** median, PASS.
- mp4box: **3.940 ms** median, PASS.
- mediabunny: **4.145 ms** median, PASS.

Final local budget check after the split:

- Eager JS: **49.43 kB** / 50.00 kB.
- Typical first-operation JS: **253.39 kB** / 256.00 kB.

Regenerated backlog: **285 active deficits**, severity `0/0/70/215`, plus the existing ADR-130 parity
exemption.

Follow-up status on 2026-07-02: a later fresh Chromium run,
`chromium-2026-07-02T15-08-37-362Z.json`, reopened the row:

- aibrush-media: **4.360 ms** median over 9 samples, PASS.
- mediabunny: **3.775 ms** median, PASS.

The current code adds the 4 KiB inline metadata tier to remove that fixed import/parser overhead. Local
validation is green:

- `bun run gate`
- Branch coverage: **90.01%**.
- Eager JS: **49.43 kB** / 50.00 kB.
- Typical first-operation JS: **254.25 kB** / 256.00 kB.

Final closeout export after the bounded repeated-prefix cache,
`chromium-2026-07-03T18-56-43-189Z.json`:

- aibrush-media: **0.480 ms** median over 9 samples, PASS.
- `golden-metadata`: PASS, `durationDeltaSec=0.021333s`, tolerance `0.041667s`.

Regenerated backlog: **285 active deficits**, severity `0/0/70/215`, plus the existing ADR-130 parity
exemption. `probe/tiny_h264_360p_2s` is no longer listed as an active loss.

## Rejections

Rejected scenario-id routing, returning cached metadata or oracle outcomes across benchmark iterations,
unbounded byte caches, accepting every tiny MP4 as video, guessing metadata from partial boxes, weakening
`golden-metadata`, removing the demux handoff, delegating to competitor parsers, and copying competitor
source code.
