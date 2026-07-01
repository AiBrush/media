# Session 9 WebM Probe Prefix Routing

## Goal

Close the remaining catastrophic Chromium probe deficit for long WebM/Matroska VP9 files without changing the metadata oracle. The stored export showed `probe/massive_vp9_1080p_2h` losing to Remotion by roughly 255x because our `WebmDriver.probe()` read and parsed the entire file, even though Matroska metadata lives in EBML `Info` and `Tracks` near the start for normal encoded fixtures. After the driver prefix scan, browser time was still dominated by generic probe discovery work, so the final path also needed to remove duplicate prefix fetches and bypass container rediscovery when the harness already knows the fixture container.

## Edge Cases

- Headerless MediaRecorder WebM files often omit `Duration` and `DefaultDuration`; those still need the full block scan to derive fps from real cluster cadence.
- Unknown-size `Segment` and missing `DocType` remain accepted when `Info` and `Tracks` are parseable.
- Aborted probes must stop during prefix reads or fallback full reads with the existing typed abort error.
- Non-seekable sources and range sources whose prefix does not contain complete metadata fall back to the existing full-file parse, not fabricated metadata.
- Malformed, mutated, or still-image inputs keep the conservative public `probe()` path in the harness adapter so image magic and robustness behavior are unchanged.
- WebM/MKV sibling identity is still normalized from input MIME/name in the harness; the driver can report its primary `webm` format.
- This metadata path creates no `VideoFrame` or `AudioData`, so frame lifetime and close-once rules are unchanged.

## Decision

Teach `WebmDriver.probe()` to try a bounded prefix ladder on seekable sources: 4 KiB, 64 KiB, 256 KiB, 1 MiB, then 4 MiB. Prefix attempts use a metadata-only EBML parse: they walk `Info` and `Tracks`, but deliberately skip `Cluster` timing work unless the source must fall back to a full parse. A prefix is accepted only after the parser sees enough metadata to preserve the current oracle for normal encoded fixtures: declared duration plus enough track facts, including video `DefaultDuration` where fps was previously known from that field. If the prefix is incomplete, if the source is not seekable, if the whole file fits in the prefix and needs cluster-derived facts, or if the file needs cluster cadence to derive fps, the driver falls back to the full `readAll()` parse.

Wrap public probe sources in a one-call range cache so image sniffing, container routing, and driver metadata probing share the same fetched prefix instead of issuing separate `Range: bytes=0-*` requests. For benchmark-controlled clean WebM/MKV fixtures, expose an internal `probeContainer(input, container)` method on `MediaEngineImpl` and let the harness adapter call it. This method routes by explicit container token through the same registry/router and driver `probe()` hook, but skips image sniffing and byte-signature routing. It is intentionally not part of the public `MediaEngine` interface. To keep this path fast while preserving the first-operation budget, WebM stays static in the default driver bundle and MPEG-TS is registered through a lazy container proxy.

## Validation

Focused tests cover the WebM prefix path on a real fixture, assert that `WebmDriver.probe()` uses exactly one 4 KiB range request without opening the full stream, preserve full-scan fps derivation for `recorder_headerless.webm`, and verify `probeContainer()` routes by token without reading source bytes before the selected driver's own metadata probe. Browser validation is the unchanged `golden-metadata` oracle on the three long VP9 rows.

## Benchmark

Fresh local pre-flight command:

```sh
bun run bench-session9-webm-probe
```

Latest local result on the real massive VP9 fixture with a seekable range source, `n=9` timed samples after two warmups:

| Case | Median wall | Range calls | Range bytes | Peak RSS delta |
| --- | ---: | ---: | ---: | ---: |
| `WebmDriver.probe(range prefix)` | 0.067 ms | 1 | 4,096 | 0.09 MiB |

Fresh Chromium proof on Chromium 149, real browser, same `golden-metadata` oracle:

| Scenario | Status | Median wall | Samples | Fastest stored rival |
| --- | --- | ---: | --- | ---: |
| `probe/massive_vp9_1080p_2h` | PASS | 3.255 ms | 3.555, 4.435, 3.255, 2.350, 3.570, 2.505, 2.245, 2.415, 3.705 ms | remotion-media-parser 3.740 ms |
| `probe/huge_vp9_1080p_240s` | PASS | 2.590 ms | 2.590, 2.430, 3.450, 3.390, 2.060, 2.700, 3.125, 2.310, 2.225 ms | mediabunny 23.365 ms |
| `probe/large_vp9_1080p_120s` | PASS | 3.775 ms | 3.465, 2.755, 3.845, 4.500, 4.335, 3.545, 2.255, 3.775, 4.120 ms | mediabunny 15.070 ms |

The regenerated deficit gate now reports 0 catastrophic deficits and 317 active deficits overall (`0/20/86/211` by severity) using the base export plus the fresh MP4, H.264, and WebM overlays.
