# Session 13 — fused MP4 cold-demux layout scan

## Loss and root cause

The fresh same-export Chromium row `performance/size-ladder-iterate-packets-large` selected `01.mp4`
(`05f832e490e9e0750748c5fecdc60b329670d69d9376b638768cd2cc4590f3f9`) and passed the strict golden for
9,982 packets. Aibrush measured 71.285 ms median (MAD 1.380), while the passing `mp4box@2.3.0` comparator
measured 45.550 ms (MAD 1.895). The 25.735 ms gap is larger than the summed MAD and is a real loss.

Product profiling separated parser, table expansion, stream, and transport work. On an 11,050-packet
profile shape derived from product-owned real media, full parsing measured 0.206 ms median and
`mp4PacketMetadata` measured 0.298 ms. The cold URL-like demux nevertheless issued seven range reads:

```text
[0,16], [32,48], [32,138778], [0,16], [32,48], [138778,138794], [138786,138802]
```

Only 138,842 bytes moved. The duplicated top-level header walk—not packet-row allocation, payload copying,
or stream scheduling—was the measured cause. `readMovie()` stopped once it parsed `moov`; strict demux then
restarted at zero to collect every `mdat` range before validating sample ownership.

## Design and invariants

Cold demux now walks the top level once and returns `{ movie, mediaDataRanges }`. The scan uses declared box
sizes to jump over `mdat` payloads, parses the first `moov` in full mode, and validates the complete top-level
layout through EOF before exposing a demuxer. URL/element inputs larger than 512 KiB get a short-lived 256 KiB
read-ahead window; a miss reads the exact required box plus no more than that bounded slack. Small remote and
all local source kinds keep exact reads or their existing complete zero-copy byte view, preventing a metadata
operation from becoming an eager payload materialization.

Probe handoff remains intentionally asymmetric. Probe may retain an exact owned raw `moov`, but demux reparses
it and independently walks every top-level header to discover `mdat`; no probe-time storage claim is trusted.
Fragmented and hybrid inputs still recover `moof`/`trun` samples from the complete file where required. The
packet-table math and live packet stream are unchanged, so decode-order DTS, composition PTS, VFR durations,
edit-list preroll, keyframe flags, byte views, one-packet backpressure, cancellation, and frame ownership are
identical.

The shared top-level validator covers ordinary and 64-bit headers, safe integer overflow, size-zero-to-EOF,
multiple `mdat`, nonzero unknown boxes, truncated 8/16-byte headers, boxes extending beyond EOF, zero box
types, and samples outside all declared media ranges. A bounded read may incidentally include the beginning
of `mdat`, but the driver never retains or expands a whole payload and never recognizes an asset property.

## Validation

`src/drivers/mp4/demux-resident-ranges.test.ts` compares remote cold demux with byte-input truth on two
untouched real files:

- faststart `bear-1280x720.mp4`: one read, exact tracks and packet table, exact B-frame packet drain;
- tail-`moov` `obs-remux-variable-aac.mp4`: two reads, exact tracks, B-frame PTS/DTS, and varying VFR packet
  durations.

Structural mutations append a second `mdat`, a legal extended-size `free`, and a legal size-zero final
`mdat`; each preserves the exact packet table. Unsafe 64-bit size, truncated trailing header, and unknown
demux size reject through typed `MediaError`. The complete MP4 test directory passes 694 tests and 12,212
assertions, including the existing corruption matrix, fragment/CENC truth, range-miss abort, cancellation,
short-read behavior, edit lists, and real ffmpeg/ffprobe rotation corpus.

## Fresh product benchmark

`bun run bench-session13-mp4-demux-layout --check` uses warmup three plus eleven measured samples on the two
real fixtures. Each range read carries an injected 3 ms latency so the benchmark is stable and measures the
transport-round-trip mechanism rather than Bun timer noise.

```text
faststart: median 3.941 ms, reads=[1 × 11], bytes/read-set=262,144, checksum=3362505813
tail-moov: median 7.872 ms, reads=[2 × 11], bytes/read-set=277,143, checksum=3789828454
```

Every timed sample recomputes the public packet table and must match the independently established byte-input
packet count/checksum. This is product evidence only. The public row remains open until the final bundle is
measured in a fresh same-export, rotation-matched, warm `n>=5` all-engine run and also satisfies the memory
criterion.

## Rejected

- Packet bursts or a larger stream high-water mark: the public row uses payload-free `packetTable()`, and a
  burst would alter cancellation/backpressure without addressing the cause.
- Packet-row/object micro-tuning: measured below 0.3 ms at the target packet scale.
- Whole-file append/prefetch: reads unnecessary `mdat` bytes and raises peak memory.
- Reusing probe storage claims: violates independent demux corruption validation.
- Fixture name/hash/size/count/offset branches or a window chosen from the selected asset.
