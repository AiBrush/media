# Session 13 first-party packet provenance fusion

Date: 2026-07-12  
Decision: ADR-282; implementation in progress

## Goal and measured cause

Close the public MP4/MOV mux boundary loss without changing output truth. Exact local reconstruction of the
31.26 MiB H.264 plus ADTS assembly attributes only about 12.7 ms to generic MP4 writing. The public browser
row is 203.115 ms. The dominant work precedes/falls between writer calls: first-party demux constructs 1,370
native `Encoded*Chunk` host objects over about 31 MiB, then promise-drains those packets into the muxer; an
in-memory MP4 additionally copies each host chunk back into writer-owned bytes. The 5.34 MiB MOV control is
likewise about 12.9 ms parse + 4.0 ms packet materialization + 9.3 ms mux locally, matching its 24.445 ms
browser result. Prepared writers start after this boundary and cannot remove it.

## Design

A module-private `WeakMap` associates an untouched first-party packet stream with a one-shot native packet
provider. No property or enumerable symbol is placed on the stream. Mux may claim provenance only when every
input stream is first-party, untouched/unlocked, and paired with the exact `TrackInfo` object emitted by its
demuxer. MP4 providers reuse the already-validated sample table and random-access snapshot; ADTS providers
reuse the parsed frame table and owned source bytes. They project exact `{data,PTS,DTS,duration,key}` structs
without constructing WebCodecs host chunks. External/custom/partially-read/one-shot streams decline and use
the unchanged generic path.

The non-fragmented MP4/MOV prepared writer consumes those structs directly. Per-track decode order, B-frame
composition offsets, VFR durations, edit/config/rotation facts, and cross-track presentation origin remain
the existing prepared-writer inputs. Providers are one-shot, poll abort around every read/sample, release
source state on success/error/cancel, reject short ranges typed, and use an operation-local sibling abort
domain. The output remains buffered exactly as the existing MP4/MOV mux contract requires.

## Validation plan

Fail first on exact real H.264+ADTS and MP4 A/V sources: prove byte-identical native/generic/prepared output,
packet payload/timing/key/config truth after reparse, zero `Encoded*Chunk` construction on the fused route,
and exact source pull/read counts. Cover B-frames, VFR, leading edits, separate audio clocks, wrong TrackInfo,
mixed external streams, partially pulled/locked streams, abort during random access, sibling failure, and
source release. Benchmark at least five real MP4/ADTS combinations with warmup and alternating `n>=21`; final
wall/memory closure remains a same-export browser requirement.

## Fresh local evidence

The real baked H.264+ADTS integration test forces the retained generic path with cloned `TrackInfo`, then
runs the fused path with exact demuxer-owned identities. Outputs are byte-identical; generic constructs host
chunks while fusion constructs zero. Transactional tests prove a missing second provider consumes the first
zero times, locked and cloned-track streams decline before claim, and a failing second claim aborts and
settles its sibling.

`bun run bench-session13-native-packet-fusion` runs five real MP4/ADTS combinations after three warmups for
`n=21`, reparsing every output and rejecting any host construction. Median fused mux+Blob+reprobe times are
5.005 ms for the 31.42 MiB baked input, 1.936 ms for the selected MOV shape, 0.397 ms tiny, 0.646 ms VFR, and
0.507 ms ordinary H.264. These are product attribution results; current-bundle browser wall and positive
memory samples remain required.
