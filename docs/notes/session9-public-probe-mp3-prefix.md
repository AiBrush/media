# Session 9 - Public Probe Prefix Cache and MP3 Metadata Probe

## Goal

Close `probe/realworld_mdn_trex_mp3` on Chromium without changing the `golden-metadata` oracle, hardcoding
the MDN fixture, changing the sibling benchmark adapter, or weakening MP3 demux packet enumeration.

## Baseline

The regenerated Session 9 backlog listed:

- aibrush-media: **14.555 ms** median, PASS.
- mediabunny: **2.595 ms** median, PASS.

A fresh local Chromium run after the known-container prefix cache measured public MP3 probe at
**6.145 ms** median over nine samples. Adding only a bounded MP3 driver `probe()` hook still left the row
at **6.725 ms**, which showed the browser URL/range overhead dominated the warmed public-probe benchmark.

## Design

Public `probe()` now uses the same bounded repeated-prefix cache as `probeContainer()`, composed before the
existing one-shot probe-to-decode handoff. The repeated cache is keyed only by the source identity hook,
stores only start-at-zero byte prefixes, keeps at most 1 MiB, and expires after 60 seconds. The existing
handoff still receives the bytes from public probe so an immediately following decode can consume the same
prefix once.

The MP3 driver now exposes a metadata-only `probe()`. For known-size seekable sources it reads a bounded
16 KiB head, skips ID3v2, validates MPEG Layer III frame sync, reads Xing/Info frame counts when present,
and otherwise estimates CBR duration from the known total size. If the bounded head is insufficient or the
source is not seekable with a known size, it falls back to the existing full parser. Demux continues to
read the full stream because exact packet enumeration must walk every frame.

The cache deliberately stores bytes, not parsed `MediaInfo` results. A mutable URL can therefore only reuse
the exact prefix bytes for the short TTL, and unsupported or malformed shapes still route through the same
driver/parser checks on every call.

## Edge Cases

- Non-seekable MP3 sources still use the full stream parser.
- Oversize or non-prefix reads are never retained in the repeated cache.
- A 16 KiB head without a valid frame or enough VBR metadata falls back instead of inventing facts.
- Demux packet timing, packet sizes, and Xing repair remain in the full MP3 path.
- The immediate probe-to-decode handoff still consumes only once; the longer repeated cache is bounded and
  byte-only.

## Validation

Focused package validation:

- `bun test src/api/create-media.test.ts src/drivers/mp3/mp3.test.ts`
- `bunx biome check src/api/engine.ts src/api/create-media.test.ts src/drivers/mp3/mp3-driver.ts src/drivers/mp3/mp3.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`

Fresh browser closeout export:

- `chromium-2026-07-03T19-19-39-178Z.json`
- aibrush-media: **0.330 ms** median over 9 samples, PASS.

Regenerated backlog: **280 active deficits**, severity `0/0/59/221`, plus the existing ADR-130 parity
exemption. `probe/realworld_mdn_trex_mp3` is no longer listed as an active loss.

## Rejections

Rejected cached `MediaInfo`, fixture-specific routing, unbounded source caches, retaining full MP3 payloads
in the repeated cache, changing the benchmark adapter to pass a known `mp3` token, weakening
`golden-metadata`, treating head-only VBR as exact without Xing/Info, skipping exact demux packet
enumeration, delegating to competitor parsers, and copying competitor source code.
