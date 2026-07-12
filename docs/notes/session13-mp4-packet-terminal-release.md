# Session 13 MP4 packet-stream terminal ownership

The public large demux memory row passed packet truth but retained 189,426,678 bytes versus the leanest
passing rival at 85,555,893 bytes. MP4 packet streams kept their last read window and random-access closure
after ordinary EOF and errors; `Demuxer.close()` was a no-op whose packet-table and packet-stream closures
still captured the same source. A subarray into `cachedWhole()` could therefore keep the complete input
backing store alive as long as a completed stream object remained reachable. Two less obvious escapes
remained after the first state-cell repair: MP4A `esds` codec-private metadata was a small subarray of the
whole file, and V8 could give all methods returned directly from async `demux()` one shared closure context
that still contained the raw random-access local.

Each packet stream now owns a revocable state cell containing its source, sample vector, read plan, and current
window. EOF closes immediately after the final enqueue and clears the cell; synchronous enqueue/planning
errors, asynchronous read/short-read/abort failures, explicit abort, and cancellation clear the same cell.
Streams opened before `Demuxer.close()` keep independent source leases, so finishing video cannot invalidate
an active audio sibling. Closing the demuxer revokes only its central source cell and clears future lookup
maps; already-open streams remain valid. Packet-table closures capture the scalar source size, not random
access. In-memory packet streams omit optional `Packet.data` subarrays because the constructed host
`EncodedChunk` already owns the coded bytes; this prevents a delivered packet from pinning the whole source.
Range-backed streams retain `Packet.data` views into their bounded windows for packet-copy efficiency.
MP4A parsing now owns the few escaped `esds` bytes at the parse boundary. Public demuxer methods are built
by a synchronous factory that never receives raw random access except through the close-revocable cell;
retaining `close`, `packets`, `packetTable`, or `tracks` therefore cannot inherit the async activation's
unrelated source local.

The exact selected 74,425,089-byte large input drains 1,808 packets with stable checksum 1,438,865,538 in
10.945–11.415 ms across three fresh local processes. After both streams reach EOF and the demuxer closes,
the benchmark deliberately retains both completed `ReadableStream` objects plus `close`, `packets`,
`packetTable`, and `tracks`. A self-describing V8 heap snapshot finds the exact source-sized `ArrayBuffer`
with zero strong inbound retainers; only weak GC-root/`WeakRef` edges remain. Instantaneous `WeakRef.deref()`
is reported but is not the gate because JSC may legally defer clearing a weak target despite a forced
collection. The fail-first control deliberately retains the source buffer and the same oracle rejects its
strong `Array` element edge. Tests cover normal final enqueue/close without an extra pull, cancel,
abort-before-retained-read, abort racing an asynchronous miss, asynchronous short-read error, an already-open
audio stream completing after video EOF plus central demux close, and real-header `esds` backing-store
isolation. No packet timing, bytes, B-frame/VFR order, backpressure, or close-exactly-once raw-frame contract
changes. The public memory row remains open until a focused current-bundle browser rerun measures peak memory.

The same lifetime attribution was repeated over every non-baked large-file rotation through both a
caller-owned byte source and a range-backed `Blob`. The byte and Blob routes agreed exactly for each file:
`01.mp4` produced 9,982 packets, 6,133 keys, 28,774,514 payload bytes, and folded payload/timeline hash
993,752,762;
`02.mp4` produced 1,808 packets, 1,111 keys, 74,411,002 bytes, and hash 4,249,479,337; `03.mp4` produced
13,885 packets, 8,531 keys, 20,260,189 bytes, and hash 3,929,844,223. The fold covers every payload byte,
PTS, DTS, duration, and key flag, so the range and resident routes cannot conceal a B-frame/VFR or
packet-ownership divergence. Parsed movie/sample-table state added only about 0.1 MiB of `ArrayBuffer`
residency;
the range route's transient peak was unreachable Blob windows plus host-chunk copies awaiting collection,
not retained sample tables. After ordinary EOF, `Demuxer.close()`, and four diagnostic forced collections,
all three Blob runs reported 155 bytes of live `ArrayBuffer` storage and zero live copied chunks. The byte
route retained only its caller-owned input backing. This product-only evidence attributes the old loss but
does not replace the required positive same-export browser measurement.
