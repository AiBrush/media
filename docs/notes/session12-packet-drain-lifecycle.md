# Session 12 — packet-drain preflight and sibling teardown

## Design

A packet-copy track is already fully described by `TrackInfo`, so its target muxer must validate that
codec/container pair before the source is pulled. Encoder output is different: its decoder configuration
is published with the first encoded chunk, so that track stays lazily allocated on the first read. The
shared drain accepts those two cases explicitly. It owns its reader until completion; config/write failure
or operation abort cancels the locked producer before releasing it. Concurrent video/audio or multi-track
drains use a child abort domain linked to the caller signal: the first failure remains the public error,
aborts every sibling, waits for all teardown, then returns. Packet payloads are not closable and are never
retimed or reordered, so B-frame DTS/PTS, VFR cadence, stream backpressure, and encoded-byte ownership are
unchanged. The group never aborts the caller-owned controller and removes its parent listener on dispose.

## Fail-first validation

The focused drain tests failed before implementation in three distinct ways: a known illegal track pulled
and then hung on its first packet, a mux write rejection left its locked source uncancelled, and an abort
during write left the reader live. A fourth matrix holds one valid producer open while a sibling track is
rejected; the task group must settle both streams, preserve the `CapabilityError`, pull the invalid stream
zero times, and cancel each producer exactly once. The public `mux()` integration repeats that oracle with
an Opus track followed by an illegal H.264-to-Ogg track.

## Fresh benchmark

`bun run bench-session12-packet-drain -- --check` uses three warmups and eleven fresh samples. On the
Session 12 M4 machine, the median known-track drain is **1.055334 ms for 5,000 packets**
(**4,737,837 packets/s**). A sample of 250 fail-first sibling groups is **1.571459 ms**
(**159,088 groups/s**), and 1,000 complete public task handles attach and remove their caller-signal
listeners in **5.174792 ms** (**193,244 handles/s**). A separate post-JIT, three-run GC bracket records a
positive **2,509,178-byte peak process heap** and **160,677,888-byte peak RSS**, with **20,195 retained
heap bytes** and **999,424 retained RSS bytes**, below the explicit 64 MiB retention bound.
