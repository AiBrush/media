# Session 13 fused native-FLAC packet-info scan

## Goal

Investigate the fresh same-export `demux/flac_noseektable` loss without using benchmark implementation
details or weakening packet truth. The selected public rotation was `02.flac`, SHA-256
`c01f4a0ef99280beeab4766f918b5ede1ba1925127ada8cc846c0356f26364e1`, with eight golden packets.
Aibrush passed at 2.810 ms median (MAD 0.290, `n=5`) while remotion-webcodecs passed at 1.920 ms
(MAD 0.030). This is an open loss until fresh final-bundle browser evidence reverses it durably.

## Edge cases and ownership

- A no-SEEKTABLE stream must enumerate native frames; a SEEKTABLE is only a sparse seek index.
- Candidate sync inside compressed payload is rejected unless reserved fields, UTF-8-coded frame/sample
  number, explicit block/sample-rate fields, and header CRC-8 all validate.
- Fixed- and variable-block streams preserve sequential sample timing; the last nominal block is clipped to
  STREAMINFO `totalSamples` exactly as before.
- Native FLAC audio has no B-frame reorder. VFR does not apply, but variable audio block sizes do.
- The packet table owns its metadata prelude and therefore does not retain a borrowed whole-file backing.
- One-chunk stream input can be parsed without a same-sized copy because `Source` is an immutable snapshot;
  multi-chunk input still receives one exact concatenation allocation.
- Full-drain readers unlock at every terminal edge. Read failure cancels upstream before unlock. Abort is
  observed before and after the synchronous scan; packet-info creates no closable frame objects.

## Root cause and decision

ADR-124's next-frame search already validated each accepted candidate header, but the main loop parsed that
same header again. Packet-info then materialized a full frame-span array only to map it into a second full
row array. ADR-250 carries the validated header (including offset) into the next iteration and emits final
packet rows directly. Live demux retains frame spans and payload ownership because it has different needs.
The stream-only whole-source reader returns its sole chunk directly and cancels/unlocks rigorously on errors.

No fixture name, size, digest, frame count, rotation, threshold, or expected output is consulted.

## Validation

```text
bun test src/drivers/flac/flac.test.ts
bunx tsc -p tsconfig.json --noEmit
bunx biome check src/drivers/defaults.ts src/drivers/flac/flac-sniff.ts \
  src/drivers/flac/flac.test.ts scripts/bench-session13-flac-packet-info.ts package.json
```

The real-corpus test compares every fused packet row against decoder-backed frame spans, including exact byte
offset/size, PTS/DTS, duration, keyframe status, count, and bytes. Existing trim, Ogg remux, decode, malformed
header, ID3-prefix, variable-depth/channel, and browser packet-seam tests remain green.

## Product benchmark

`bun run bench-session13-flac-packet-info` alternates fresh composed and fused scans for `n=21` after five
warmups, using the real 959,681-byte `flac-blocksize-16.flac` (19,294 packets). It also executes the public
packet-info route over one-chunk and 64 KiB-chunk stream sources and applies the same strict row oracle.

| Path | Median | MAD | Result |
| --- | ---: | ---: | --- |
| composed frame array + row map | 2.560 ms | 0.077 ms | reference |
| fused final-row scan | 2.414 ms | 0.092 ms | 1.061x (6.1%; repeated run 6.4%) |
| public one-chunk stream | 2.453 ms | 0.065 ms | one source-sized copy removed |
| public 64 KiB chunks | 2.464 ms | 0.113 ms | exact bounded concatenation |

The rotated eight-frame parser is much smaller than this stress shape, so the browser gap is dominated by
transport/operation overhead and timing variance. The baseline included an aibrush 1.640 ms sample, but one
sample is not evidence of leadership. A focused same-export rerun on the final bundle is still required, as
is qualified rival memory evidence.

## Rejected

- SEEKTABLE-as-packet-oracle or sync-byte-only scanning.
- Parsed table/result caching: prohibited by the Session 13 mission and harmful to memory truth.
- Borrowing the metadata prelude and thereby retaining the complete input backing.
- Specializing for eight frames or the selected asset.
- Reporting this parser benchmark as closure of the public browser row.

## Fixed-cost follow-up design (ADR-262)

**Goal.** Separate FLAC parser work from public source transport and first-use module routing on the real
no-SEEKTABLE corpus, then make the full `FlacDriver` whole-source reader obey the one-chunk ownership and
terminal-release contract already used by its lazy default proxy. The output remains the exact same packet
table: validated native frame boundaries, byte sizes, PTS/DTS, duration, and owned codec metadata.

**Approach.** Measure three product-only layers independently: direct fused parsing, a reused public engine,
and a new engine's first lazy-driver resolution. For URL-like sources, inject a deterministic 3 ms range
transport and record request count plus transferred bytes rather than inferring I/O from wall time. In the
full driver, read the first two stream chunks before allocating: return the immutable first chunk directly
when it is the complete source; concatenate only genuinely multi-chunk streams; cancel on producer failure;
and release the reader lock in `finally`. A shared eager reader helper was rejected because this path is lazy
and keeping the change local avoids expanding unrelated default-driver closures.

**Edge cases and failure modes.** Empty and fragmented streams retain exact concatenation behavior. A read
failure preserves its primary error even if cancellation rejects, then unlocks. An already-aborted public
operation still observes the existing checks before and after the synchronous scan. Variable FLAC block
sizes, ID3 prefixes, malformed header CRCs, and final-block clipping remain scanner concerns and do not
change. Native FLAC has no B-frame/VFR ownership, decoded frames, seek queue, or backpressure stage; the only
ownership change is releasing the byte-stream reader and avoiding a redundant copy of a complete immutable
chunk.

**Test and benchmark plan.** A fail-first direct-`FlacDriver.packetInfo` test must show that normal EOF unlocks
the source reader, and a producer-failure test must show cancellation plus unlock without masking the source
error. Existing decoder-backed corpus comparisons remain the strict output oracle. The benchmark alternates
old composed-copy and new one-chunk behavior for at least 21 samples over several real FLAC shapes, reports
the selected eight-frame source separately, and records URL-like 3 ms request/byte evidence. Browser victory
is not inferred from these product measurements; it remains gated on the final same-export focused rerun.

## Fixed-cost follow-up evidence

The retained full-driver change is a lifecycle repair plus a general payload-dense win. Alternating warm
`n=21` measurements on real `flac-192khz.flac` (6,611,359 bytes, 376 frames) measure the exact former
one-chunk-copy control at 0.901 ms median (MAD 0.070) and direct immutable chunk ownership at 0.623 ms
(MAD 0.008), a 1.45x win. Two additional runs measure 1.39x and 1.58x. On the packet-dense
`flac-blocksize-16.flac`, the scan dominates and the copy difference is within noise; no speed claim is made
for that shape. Forty-six focused FLAC tests pass with 146,139 assertions, including independent FLAC/ffmpeg
authoring oracles and the fail-first reader terminal-edge tests.

With `SESSION13_FLAC_SELECTED` pointing at the independently identified real 30,105-byte/eight-frame
rotation, the same `n=21` benchmark separates the public layers:

| Selected-source layer | Median | MAD / note |
| --- | ---: | --- |
| fused parser | 0.0038 ms | 0.0006 ms |
| reused public engine | 0.0121 ms | 0.0024 ms |
| fresh engine after module cache | 0.0672 ms | 0.0227 ms |
| URL-like source with injected 3 ms latency | 3.7732 ms | 0.0056 ms |

The URL-like path makes exactly one range request, transfers exactly 30,105 bytes, and opens zero streams on
every sample. The selected source's first lazy driver resolution is 9.694 ms and immediate reuse is 0.058 ms;
the qualified browser protocol performs a warmup, so that first resolution is not a timed-row explanation.
This isolates the remaining old browser gap to transport/runtime measurement rather than FLAC parsing. It is
not an exemption or a closure claim; the current bundle still needs the focused browser rerun.
