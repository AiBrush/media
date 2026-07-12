# Session 13 WAV lifecycle and cache-memory pass

## Goal

Verify that the fused signed-24 decode stream and multipart same-layout WAV rewrite release source storage
at every terminal edge, then bound the only remaining cross-call retention: the raw PCM rewrite cache. The
targeted public rows are `audio-dsp/throughput_decode_s24`,
`audio-dsp/meta_idempotent_resample_same_rate`, and `audio-dsp/edge_longform_audio_probe`. Output samples,
bytes, metadata, public chunk cadence, and frame ownership must not change.

## Design

ADR-248/249/253 already clear range windows, deferred producers, copy-plan payloads, controllers, and abort
listeners at EOF, cancellation, and error. This pass keeps those seams unchanged and measures them with
retained completed/cancelled/errored streams and multipart Blob/File outputs. The remaining issue is the
module-global raw-source cache from ADR-152: its 32-entry, 8 MiB-per-entry shape can retain 256 MiB for 60
seconds after a sequence of distinct PCM rewrites. ADR-261 keeps the existing 8 MiB per-entry eligibility
but makes 8 MiB the total cache budget as well. Expired entries are removed before insertion; a hit refreshes
recency without extending its TTL; replacement accounts for the old value; and oldest entries are evicted
until the new exact source fits. Repeated work on one immutable source therefore remains a one-read hot path,
while unrelated sources cannot accumulate beyond one bounded total budget.

A rejected alternative was removing the cache. That would eliminate retained source bytes but reintroduce a
full URL range fetch on every warm iteration and regress the general AIFF/WAV no-DSP path. Weak references are
also unsuitable: browser collection is nondeterministic, so a warm hit could disappear arbitrarily. A strict
total-byte LRU gives deterministic performance and memory bounds.

## Edge cases and failure modes

- Cache identity remains the opaque exact `SOURCE_CACHE_KEY` plus known size; distinct snapshots never share.
- Unknown-size, oversized, short, aborted, failed, and declined reads are never inserted.
- Replacing an existing key cannot double-count bytes; expired entries contribute zero after lazy cleanup.
- An entry larger than the total budget is ineligible, preserving bounded memory.
- Blob/File constructors snapshot header and payload; completed, cancelled, aborted, and failed streams clear
  source references. Streams retain backpressure with `highWaterMark: 0`.
- Raw PCM has no B-frames, VFR, GOP reorder, or `VideoFrame` ownership. Browser `AudioData` keeps the existing
  exact-owned 4,096-frame transfer and close-exactly-once contract.

## Validation and benchmark plan

Fail-first tests fill the cache with several distinct real-derived WAV/AIFF payloads, refresh one hit, insert
past 8 MiB, and prove the least-recently-used entry is fetched again while the refreshed entry stays hot.
Separate controls cover replacement accounting and abort/error non-insertion. Every successful output is
compared byte-for-byte or sample-for-sample with the pre-budget reference. The product benchmark alternates
same-source warm hits with rotating distinct sources, records range-read counts and retained ArrayBuffer/heap
after forced collection, and verifies exact output digests. Public closure still requires same-export,
rotation-matched warm `n>=5` wall plus positive browser peak memory against the leanest passing rival.

## Current product evidence

The existing fused benchmark drains the exact real public `03.wav` source (7,904,256 bytes, 1,315,328
stereo frames) with checksum `2064061439`. Two fresh `n=7` runs measure 3.065-3.752 ms fused samples with
3.429 ms median versus 9.654-10.738 ms and 10.483 ms median for the canonical planar/interleave control.
Both paths read exactly 7,904,256 bytes in nine bounded ranges. Retaining the completed low-level fused
stream after forced collection retains zero source ArrayBuffer bytes. Blob, File, completed stream,
header-only-cancelled stream, aborted stream, and failed-source identity-copy probes each allow their exact
960,044-byte source buffer to collect while the terminal output object itself remains retained; a source
error is preserved by identity. Twenty repeated one-hour metadata probes make one 4 KiB range read, preserve
the exact 3,600-second duration, and retain only the bounded prefix while the source is live.

The ADR-261 benchmark derives twelve distinct 1,048,576-byte canonical WAVs from the real
`stereo-48000.wav` corpus fixture. Same-source warm construction is 0.085 ms median/MAD 0.008 (`n=21`) with
one range read. Every distinct output matches its own SHA-256 reference. Rotating all twelve retains
7,340,816 ArrayBuffer bytes under the 8 MiB plus 64 KiB regression limit; revisiting the oldest source causes
one real reread and revisiting the newest causes none.

The last qualified positive public memory comparison for selected `02.wav` predates the final bundle:
aibrush passed at 14.255 ms but measured 32,392,187 bytes versus mediabunny's 23,956,253 bytes. The current
product's transfer seam has zero terminal source retention, but this historical browser peak remains an open
row until a current-bundle, same-export positive-memory rerun proves it at or below 23,956,253 bytes.

## Sequential decode follow-up (ADR-277)

**Goal.** Remove whole-source materialization from range-less WAV decode while preserving the exact public
4,096-frame `AudioData` cadence and
bit-identical interleaved Float32 samples. **Approach.** Give the WAV driver a local sequential PCM reader.
It consumes one owned `ReadableStream` reader, retains at most one producer chunk plus one exact wire chunk,
discards bytes before `data`, and assembles exactly the same frame-aligned byte spans as the range reader.
Range-less sources use it because buffering the whole file is never required for raw PCM. In-memory byte,
Blob, URL, and OPFS sources retain bounded ranges and their useful random
access/network policy. A generic shared-source buffering rewrite was rejected because the ownership and
frame-alignment facts are WAV-specific, and reducing the public chunk size was rejected because it changes
frame-digest truth and increases fixed cost.

**Edge cases and failure modes.** RIFF chunks may split at every byte seam, `fmt ` may precede unrelated
chunks, `data` may begin after the first producer chunk, source chunks may be empty, and the last PCM byte
span may end mid-frame. Parsing therefore grows only a bounded header prefix until `data` is known, then
the reader drops trailing partial frames exactly as the existing range path does. A premature EOF raises the
same typed demux error. Consumer cancel, live abort, source read failure, decode failure, and enqueue failure
cancel the owned upstream reader at most once, release its lock exactly once, and clear pending byte views.
One pull emits at most one 4,096-frame chunk, so upstream remains demand-driven. Raw PCM has no B-frames,
VFR, seek reorder, or GOP state; cumulative frame timestamps and consumer-owned `AudioData` close-exactly-once
semantics remain unchanged.

**Validation and measurement.** The fail-first suite streams the pinned real signed-24 fixture through
adversarial producer chunk seams, compare every output Float32 bit and every chunk frame count with the
range-backed control, assert only one producer read is outstanding, and cover cancellation during a pending
read, abort, source error, truncated payload, unlocked EOF, and terminal retention. A fresh warm multi-sample
benchmark compares sequential decode with the former whole-buffer control and reports wall,
positive peak ArrayBuffer bytes, retained bytes, sample checksum, producer bytes, and chunk cadence. Browser
same-export closure remains owned by the central sweep and is not inferred from this product benchmark.

The initial Blob selection was rejected after measurement. Bun's `Blob.stream()` delivers chunks as large
as 2 MiB, making its positive peak 500,288 bytes worse than the one-MiB range window; Chrome sequential
delivery was 4-13% faster across five real WAV shapes, but the available `performance.memory` sampler
returned zero deltas and therefore could not provide admissible memory evidence. Seekable Blob/range
behavior remains unchanged.

The accepted range-less path has positive product evidence on the real 7,904,256-byte public `03.wav`.
Warmup three/`n=11` measures 3.438 ms median versus 3.428 ms for the former whole-buffer control (wall
parity), while median positive ArrayBuffer peak falls from 18,463,056 to 10,558,688 bytes, exactly one
7,904,368-byte source allocation. Both return 1,315,328 frames in 322 chunks, checksum `658366885`, and
retain zero ArrayBuffer bytes after terminal collection. This closes the range-less lifecycle/memory seam,
not the historical seekable public-row memory result; only the central same-export sweep may close that row.
