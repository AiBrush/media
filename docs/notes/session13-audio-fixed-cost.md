# Session 13 audio fixed-cost pass

## Goal

Remove general fixed overhead from short compressed-audio work while preserving exact packet and decoded
sample truth. The motivating qualified rows are AAC-to-Opus WebM transcode and an MP4 audio packet-table
demux, but eligibility must never depend on a fixture name, digest, byte length, packet count, rotation, or
benchmark scenario. The seams in scope are ADTS `Demuxer.packets()`, the packet-to-codec projection, and
payload-free MP4 packet-info; WebCodecs remains the real decoder/encoder and the ordinary WebM writer remains
the output authority.

## Measured root cause and approach

Product timing on five independently downloaded MP4 corpus files puts complete byte-backed MP4 parsing plus
packet-info construction at 0.014-0.164 ms median (27-671 packets); parsing itself therefore cannot explain a
7.2 ms browser deficit. A 1,296-row packet projection does expose a smaller general cost: the current
`TransformStream` packet-to-chunk wrapper measures 0.809 ms versus 0.326 ms for a direct pull projection with
the same high-water mark and explicit lock teardown. The shared `unwrapPackets()` seam now uses that direct
high-water-mark-zero pull stream: it performs exactly one upstream read for each downstream demand, forwards
the original chunk object, and releases its reader exactly once after EOF, cancellation, or failure. For raw
AAC, `AdtsDriver.demux()` performed the exact full-stream header walk to build its track, discarded the
resulting frame table, then repeated the same walk when `packets()` was opened. It now retains that
operation-owned immutable frame table and has the packet stream consume it. Both changes remove duplicated
stream machinery or validated work without caching across operations or changing a single emitted chunk.

A fused WebCodecs decoder-to-encoder object was considered and rejected for this pass: it would bypass the
published `TransformStream` codec seam, duplicate the browser capability ladder, and carry materially more
lifecycle risk than the measured fixed-cost gap justifies. Raising the 128-packet WebCodecs queue bound was
also rejected: ADR-165 already measured 512 packets slower and the larger native burst would worsen peak
memory. MP4 packet-row arithmetic and corruption checks stay unchanged because the product parser is already
sub-millisecond; transport/wrapper closure requires fresh browser evidence rather than unmeasured parser
micro-tuning.

The qualified Ogg-Opus to Matroska remux loss has a separate, larger fixed cost. The Ogg driver already
reads and de-laces the complete source into exact packet-info rows, but cross-container remux discards that
payload-free representation, constructs one host `EncodedAudioChunk` per packet, pulls those packets through
the generic async drain, and copies every host chunk back into JavaScript before the WebM writer buffers it.
The chosen fix is an Ogg-declared `streamCopyTargets` route for WebM/Matroska: after the same complete Ogg
validation, project exact packet byte views and timing directly into the existing prepared WebM writer. The
lazy default proxy advertises the target set before loading the Ogg module so routing remains truthful. A
new remux-runner special case was rejected because the source driver would otherwise be read twice or the
runner would duplicate Ogg de-lacing; a new EBML serializer was rejected because the existing writer is
already the validated authority.

## Edge cases and lifetime

ADTS headers with CRC, multiple raw data blocks, rate changes, leading or mid-stream ID3, resynchronization
after junk, and a truncated final frame retain the exact `AdtsFrameWalker` result. Audio has no B-frames or
VFR reorder: DTS remains PTS and frame order is unchanged. The retained table belongs only to one demuxer and
contains scalar offsets/timing, not copied payloads or closable frames. Each `EncodedAudioChunk` still receives
the same raw AAC payload view and the decoder/encoder keep their existing close-exactly-once ownership.
One-pull-at-a-time backpressure, abort-before-enqueue, typed invalid-track errors, WebCodecs capability misses,
and source lifetime remain unchanged. The direct packet projection cancels its inner reader before releasing
the lock, memoizes concurrent teardown, preserves the primary read failure if cancellation also fails, and
propagates an upstream cancellation failure while still unlocking. Encoded chunks are immutable host values,
not closeable frames, so the projection neither closes nor duplicates their lifetime.

For Ogg cross-container copy, Opus pre-skip, Vorbis Xiph-laced setup, FLAC metadata, multi-page lacing,
continued packets, negative initial Opus PTS, per-packet duration, and target codec legality remain owned by
the existing Ogg parser and WebM writer. The direct path supports the same optional packet-copy trim by
selecting overlapping packets and rebasing the first kept PTS; invalid/empty ranges remain typed. Abort is
checked before parsing, during packet projection, and before exposing output. Packet bytes are immutable
views until the writer copies them into a fresh output, so caller mutation cannot race after operation
completion. No `AudioData`, decoder, encoder, or closable frame is created; removing host chunks reduces
memory and cannot change B-frame/VFR behavior because the route is audio-only.

## Validation and benchmark plan

Focused tests compare the retained-layout packet stream with the independent public ADTS packet-info table on
the real AAC corpus: packet count, raw payload bytes, PTS, duration, full on-disk size, codec/private config,
and duration must be exact. A fail-first call-count test proves `demux()` performs one header walk rather than
two while still constructing every host chunk. Cancellation/abort coverage proves no late chunk enqueue.
The product benchmark alternates retained-layout and repeated-walk implementations after warmup, checksums all
frame geometry, and reports median wall over multiple real ADTS files where available; missing corpus is a
failure rather than a zero metric. Final closure requires a fresh same-export browser run, warm `n>=5`, the
same selected rotation and passing oracle, plus qualified positive memory.

The packet-projection control alternates the direct pull stream with the former `TransformStream` over 1,296
independently consumed packets, after warmup for `n=51`. Both variants must produce the same packet count and
timestamp/size checksum. Focused lifecycle tests additionally require exact chunk identity, one source read
per downstream demand, EOF unlock, cancellation-before-unlock with the original reason, primary read-error
preservation, and upstream cancellation-failure propagation with final unlock.

Ogg-to-WebM/Matroska validation runs over the real Opus, Vorbis, and FLAC-in-Ogg corpus. It reparses each
fresh output independently, requires the same coded packet count and byte payloads, preserves codec-private
headers and duration/timestamps within the target container clock, and proves output is newly authored rather
than input passthrough. Cancellation before projection must emit nothing. The benchmark alternates direct
packet-info authoring with the former host-chunk-shaped preparation using the same real inputs, warmup plus a
multi-sample median, a checksum sink, and a separate allocation/peak-memory observation.
