# Session 11 — exact MP4 demux range reuse and allocation bounds

## Goal

Reduce the general MP4 demux setup and packet-iteration cost without changing packet truth. The fresh
black-box result output reports 986.1 ms for the huge MP4 demux cell, 615.4 ms for huge packet iteration,
447.8 ms for the paired huge demux measurement, and 2,836.3 ms for massive packet iteration. Static audit
of the public driver found three independent sources of avoidable work:

1. a range-backed `RandomAccess` remembers a complete prior read but does not serve later covered reads
   from it, so fragmented MP4 can fetch the whole source twice and then fetch sample windows again;
2. progressive demux materializes a seven-field `SampleData` object for every sample solely to prove that
   its byte range belongs to an `mdat`; and
3. `packetStream` declares every pull `async`, allocating a fulfilled promise even when the requested
   sample already resides in the current read window.

The selected huge rotation declares 42,276 packets and the massive rotation declares 438,577. The storage
validation array and resident-pull promise therefore scale with packet count even though neither performs
new I/O or changes output.

## Chosen approach

The random-access layer serves a read from `cachedWhole` only when a complete retained view already covers
the requested non-negative, safe-integer half-open interval. It returns a zero-copy subarray and never
causes a full read, extends a partial cache, or shares bytes across source identities. `readWholeFile`
applies the same exact-coverage check before falling back to the existing read.

Progressive storage validation uses a dedicated sample-range cursor over normalized `stsz`, `stsc`, and
`stco`/`co64` facts. The cursor emits only `(index, offset, size)` and preserves the same chunk-run
transitions and early chunk exhaustion as `buildSampleData`; it does not inspect or allocate timing,
composition, or sync-sample state. Fragmented tracks retain their already-built merged sample arrays.
Every range must contain non-negative safe integers, have a safe exclusive end, and lie wholly inside one
declared top-level `mdat`.

The packet stream keeps one packet per pull and the default stream high-water mark. A resident-window pull
enqueues synchronously and returns `void`; only a genuine window miss returns the range-read promise. The
same sample is advanced once, abort is checked before every pull and after every asynchronous read, short
reads retain their typed error, and packet data/type/PTS/DTS/duration/order are unchanged.

## Rejected alternatives

- Treating `stss` as the complete set of H.264 picture boundaries is not valid for files containing
  non-IDR I/SI pictures. Payload classification remains exhaustive unless independently authoritative
  metadata proves otherwise.
- Caching a new whole-file read would exchange latency for unbounded memory. This change reuses only bytes
  already retained by the same random-access instance.
- Reusing `walkSamples` would avoid the result array but still traverse timing, composition offsets, and
  sync tables and may allocate a `Set` for malformed unsorted `stss`; storage ownership needs none of it.
- Batching multiple packets into one pull could alter backpressure and cancellation observability. The
  first optimization keeps the one-packet contract and removes only the redundant async-function promise.
- Sorting or rewriting sample order is outside this change. Decode order, B-frame composition offsets,
  VFR deltas, edit-list bounds, and fragmented merge order remain authoritative.

## Edge cases and failure behavior

- Negative, fractional, non-finite, overflowing, or out-of-`mdat` sample ranges reject with a typed
  `MediaError('demux-error', ...)`; zero-byte samples remain valid only at an owned `mdat` position.
- A cached view that is shorter than the known source, or a read extending one byte past it, falls through
  to the source range method and preserves its clipping/error behavior.
- Progressive faststart and tail-`moov`, multiple `mdat` boxes, empty tracks, `stsc` run changes, `stco`,
`co64`, B-frames, VFR, edit lists, hybrid fragments, and fully fragmented CMAF retain their existing
packet tables and order. A table that declares more `stsz` rows than its chunk layout can place rejects
instead of silently validating only its prefix.
- Abort before a resident read errors the stream without emitting a packet. Abort or truncation during a
  range miss emits no packet. Cancellation does not start another pull or retain a decoder/frame resource.
- ADR-200's authoritative fragmented-audio initialization-duration predicate and both metadata early
  returns are untouched.

## Validation and benchmark

Fail-first public-driver tests counted progressive reads growing from four to six, two complete reads of a
real hybrid-fragmented MP4, and 183 driver pull promises for a B-frame track with one genuine range miss.
After the change, the progressive drain adds zero reads, the fragmented file has one complete read and no
later underlying I/O, and the B-frame track has one promise-returning pull. Packet bytes, key flags,
PTS/DTS/duration, one-packet pull count, cancellation, abort-before-retained-read, abort-during-miss,
short-read failure, safe-integer overflow, outside-`mdat`, zero-size boundary, and unplaced-`stsz` rejection
are pinned independently.

`scripts/bench-session11-mp4-demux.ts` measures public `demux()` setup and full packet drain separately.
Fresh Bun 1.3.14, warmup two plus seven measured samples, across all eight real huge/massive rotations
(4.86 GiB total):

```text
demux setup median=42.033 ms; peakRSS+=14.52 MiB
samples=[46.098, 37.748, 41.625, 42.598, 38.037, 42.033, 43.891]

drain packets median=3452.371 ms; packets=2,045,145; packetRanges=2,878
rangeGiB=8.70; pullPromises=2,878; synchronousPulls=2,042,283; peakRSS+=14.94 MiB
samples=[3483.512, 3312.897, 3464.046, 3265.179, 3452.371, 3285.088, 3642.831]
```

The selected huge/massive pair (`02.mov` + `01.mp4`, 480,852 packets) measures 10.015 ms setup and
384.000 ms drain median over the same sample count. Browser leaderboard closure remains a fresh lead-owned
black-box run; these local numbers establish repeatable algorithmic and memory bounds.
