# Session 13 WebCodecs decoder startup and bounded-decode profile

## Goal and design

This investigation tests whether the WebCodecs video driver's exact-configuration startup barrier or its
bounded queues explain the Session 13 decode/seek deficits. The seam is the public
`ReadableStream<VideoFrame>` returned by `decode()` plus the `VideoDecoder` selected by the existing exact
acceleration ladder. The diagnostic benchmark uses the five checksum-pinned real acceptance inputs that
exercise 1 fps H.264, 240 fps H.264, H.264 VFR, 120-second 1080p VP9, and a 30-second 1080p H.264 zero-time
seek. It measures public bounded/full drains, exact RGBA readback as a separate browser cost, a fresh
`configure()` + empty `flush()` barrier, fresh native decode, already-proved decoder reuse, and public seek.
The exported result's decoded-frame count is reproduced only in the benchmark; it is never imported by,
or used as a threshold in, product code.

The leading hypothesis was that the empty startup `flush()` added roughly 29 ms per operation. A bounded
exact-config decoder pool was the alternative considered: retain a fully flushed decoder, attach a
lease-local output sink, and reuse it only after the previous stream reached a normal flush. That design
was rejected after measurement. It saves almost nothing on throughput-bound media, while retaining scarce
hardware codec resources beyond the operation that owns them and increasing contested peak memory. Removing
the barrier was also rejected. WebCodecs configuration runs on the asynchronous control queue; ADR-203
requires proof of the accepted acceleration rung before packet submission so a stale hardware verdict can
fall back without replaying already-submitted packets.

## Correctness and lifecycle edges

- H.264 B-frames and VFR keep WebCodecs presentation order; the benchmark folds every output timestamp and
  never sorts or rewrites it.
- `flush()` establishes a new key-chunk boundary, so every reuse iteration starts at the real stream's first
  key packet. No packet or frame is fabricated.
- Every diagnostic `VideoFrame` is closed exactly once. Public early-stop rows cancel and unlock their
  reader; seek returns one caller-owned frame and closes it once.
- External cancellation, decoder error, stale support, a non-key first packet, backpressure, and closed
  readables retain the production ADR-203/040 behavior. No production lifecycle code changes in this lane.
- RGBA `copyTo()` is reported separately from close-only delivery. It is a browser surface-readback cost,
  not attributed to the product decoder unless the close-only native control also regresses.
- The benchmark verifies file length and SHA-256 before starting, uses headed Chromium to retain the same
  hardware WebCodecs class as acceptance, performs three discarded warmups, and reports medians from eleven
  samples. Its untimed oracle drains the complete 1 fps and 240 fps streams, records every exact
  `{ timestamp, duration }` pair, hashes every complete RGBA plane one frame at a time into a bounded
  digest chain, and compares the full clock sequence with a separately configured direct-native decoder.
  The larger VFR and VP9 controls retain a 12-frame prefix oracle so the diagnostic does not turn into an
  unbounded surface-readback benchmark. Every handed frame is closed exactly once. The timed path likewise
  reports delivered/closed counts; clock arrays and hashing never contaminate the wall samples.

## Fresh evidence

Headed Chromium 149 on Apple M4, integrated `dist/` built 2026-07-12 07:25 local time, three discarded
warmups and `n=11`:

| real input | full public median (MAD) | bounded close median (MAD) | bounded RGBA median (MAD) | fresh barrier | fresh native full | reuse |
|---|---:|---:|---:|---:|---:|---:|
| H.264 1 fps / 30 s | 7.600 (0.200) ms / 30 frames | 7.300 (0.200) ms / 30 | 25.900 (2.000) ms / 30 | 0.700 ms | 6.200 ms | 4.000 ms |
| H.264 240 fps / 2 s | 64.600 (1.500) ms / 480 frames | 34.700 (0.800) ms / 240 | 157.900 (2.900) ms / 240 | 0.900 ms | 59.400 ms | 57.100 ms |
| H.264 VFR / B-frames | 27.700 (1.300) ms / 111 frames | 16.000 (0.800) ms / 60 | 188.900 (3.800) ms / 60 | 1.000 ms | 23.200 ms | 20.500 ms |
| VP9 1080p / 120 s | 3,565.500 (0.800) ms / 3,600 frames | 71.600 (1.600) ms / 60 | 408.900 (9.400) ms / 60 | 3.700 ms | 3,559.700 ms | 3,554.600 ms |

The full untimed 1 fps oracle delivered and closed 30/30 frames, matched all 30 timestamp/duration pairs
against direct native output, and produced RGBA digest
`ccef2555976dc201c74299a094bf06208424101848939ed5d33687d39b91c7e8`. The 240 fps oracle likewise
delivered and closed 480/480 frames and matched every clock pair against direct native output. It computed
and emitted its full-frame RGBA digest, and the script completed only after that assertion; the command
transport truncated the middle of the large JSON log before the printed digest value, so the value itself
is deliberately not reconstructed or claimed here. The VFR 12-frame prefix digest is
`730adeb83dfa0cdb233b9c7bacf6e56640bc166b4078b835a50e35d8cf23436c`; the VP9 prefix digest is
`5d08a0b1bdaa8bf62f934372bb33e2189a6be05b4c9173d5d6bdd1d2c2332311`.

The exact output frame count and timestamp fold matched public, fresh-native, and reused-native full drains
for all four decode inputs. Public seek on the VFR source at 4,250,000 us landed at 4,433,333 us in
16.200 ms median (0.400 ms MAD); zero-time seek on the 30-second H.264 source landed at zero in 5.500 ms
(0.200 ms MAD). The old exported bundle reported 48.215 ms and 38.780 ms respectively, while its best passing
rivals reported 29.485 ms and 32.190 ms. The current source therefore provisionally closes both seek rows,
subject to the root-owned same-export black-box rerun.

The 240 fps current public close-only path is also already below the old best passing wall (34.700 ms for
the exported 240-frame work shape versus 119.815 ms), while the current full 480-frame product drain is
64.600 ms. The large VP9 full drain differs from direct native decode by about 0.16%; its remaining cost is
the browser codec, not packet promises, queue depth, or the startup barrier. RGBA readback dominates every
bounded visual row but is deliberately not optimized here: it is browser work performed by the consumer,
and changing decoded pixel truth or output surfaces to fit one oracle would violate the public frame
contract and anti-overfit rules.

## Decision

No production change and no ADR are warranted. Preserve ADR-203's exact accepted acceleration rung, empty
configuration barrier, queue bounds, prompt cancellation, and close-exactly-once ownership. Do not add a
decoder pool: the measured warm savings are 2-5 ms for these shapes, proportionally negligible for long
VP9, and do not justify retained native/GPU resources or a peak-memory risk. A bespoke demux-to-decoder
pump and a wider
decode/frame queue are rejected for the same measured reason: the complete 3,600-frame VP9 public drain is
already within about 0.1% of direct native decode, while either change would duplicate Web Streams
cancellation/backpressure or retain more GPU-backed frames. Final closure belongs to a fresh current-bundle,
same-export, rotation-on `n>=5` benchmark against every passing rival. This local browser API has no honest
per-operation native/GPU peak-memory counter, so the profile deliberately does not turn JS heap or a missing
sample into a memory claim; positive peak-memory closure remains with the public same-export sweep.

## Public-shape attribution design

A fresh integrated public run still measured 79.980 ms (2.825 ms MAD) for the 1 fps row despite the
7.600 ms full close-only and 25.900 ms full-RGBA product controls above. A second read-only diagnostic
therefore attributes only public API boundary costs, without reading the acceptance implementation. On the
same pinned real input it crosses reused versus per-iteration `createMedia`, default versus `worker:false`,
raw bytes versus copied bytes, Blob, File, `fromBytes`, `fromBlob`, and an ordinary public random-access
`Source`. It separately times synchronous `decode()` setup, first-frame delivery, the remaining drain,
full RGBA copy, per-frame SHA-256, and contiguous RGBA materialization. Every cohort uses three discarded
warmups and eleven samples, preserves the exact 30-frame timestamp/duration sequence, closes every handed
frame once, and reports random-access call/byte counts. The alternatives rejected up front are changing the
decoder barrier, pooling a native decoder, or inferring the acceptance implementation: the first two are
already disproven above, and the third violates the black-box rule. Any observed fixed cost must generalize
across input and engine lifecycles before it can justify product work.

The headed matrix completed with exact 30-frame clocks and 30/30 handed/closed parity in every cell. Every
close-only source/lifecycle cohort landed between 7.800 and 9.300 ms; per-iteration `createMedia` rounded to
0 ms median, synchronous `decode()` setup to 0-0.100 ms, and first-frame delivery to roughly 4.000-5.700 ms.
Bytes, copied bytes, Blob, File, `fromBytes`, `fromBlob`, and random-access view/copy sources overlap. The
custom source performs exactly one 183,419-byte `range()` and zero `stream()` calls per decode. Default and
`worker:false`, and fresh and reused engines, likewise establish no durable difference.

Full RGBA copy, per-frame SHA-256, and contiguous 9.2 MB RGBA materialization land at roughly 33-49 ms total,
with 27-43 ms attributed directly to pixel work. Every per-frame digest equals
`ccef2555976dc201c74299a094bf06208424101848939ed5d33687d39b91c7e8`; every contiguous RGBA digest equals
`1a1b3ed42fa5f6b6f64287ea586f2909df97dea43ae078c0b1d1cf5e51619a46`. Consumer pixel projection is
therefore the dominant measured public-boundary cost, but even the slowest exact product/full-digest cohort
does not explain the fresh public 79.980 ms median. At least about 31 ms remains outside the product API
shapes tested here; black-box discipline forbids assigning that remainder to an acceptance implementation
detail. No product lifecycle, source, worker, setup, or frame-ownership change is justified by this evidence.

Static/focused verification after hardening the benchmark is green: Node syntax, Biome, 250 focused
WebCodecs/acceleration/seek/codec-pipeline tests, `git diff --check`, and all 50 anti-cheat integrity checks.
The headed product diagnostic is now complete; the two ledger rows remain `BEHIND` only because final closure
requires the root-owned current-bundle, same-export, rotation-on wall and positive-memory comparison against
every passing rival.
