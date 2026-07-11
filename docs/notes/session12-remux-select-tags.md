# Session 12 remux track-selection plus metadata design

## Truth before change

`RemuxOptions` publicly exposes `trackSelect` and `tags` on the same object, and each option independently
runs real work. The engine nevertheless rejects their combination before demux. Applying tags to the input
before selection is wrong for a cross-container remux, while rewriting the selected target bytes is both
well-defined and already supported by every target-native metadata writer in the declared tag envelope.

## Design and edge cases

Run the normal remux planner exactly once. A request without selection may still use the native
same-container stream-copy path; a selected request uses the existing packet-info/packet seam, preserving
track order, codec-private data, DTS/PTS, B-frame composition offsets, VFR cadence, attachments, and every
selected payload byte. When `tags` is present, drain that completed target stream into one bounded byte
buffer, then invoke the target container's existing metadata writer and materialize the caller's sink.
Random access is inherent to these tag writers, so buffering is explicit rather than pretending to remain
incremental. Unsupported target metadata remains a typed capability miss after the remux output is formed;
malformed tags remain typed writer failures.

The shared operation signal covers demux, mux drain, metadata rewrite, and final sink. A failure or abort
must cancel the active packet/byte stream before rejecting. No `VideoFrame` or `AudioData` is created, and
no selected encoded payload is decoded or re-encoded. Empty selection, duplicate/invalid selectors,
single-track selections, aliases, cross-container targets, attachment side data, and a writer that changes
header size without changing payload bytes are all explicit validation cases.

## Proof result

The fail-first public oracle selects Vorbis audio from a real multitrack WebM, remuxes it to Ogg, writes a
target-native title, reparses the Ogg codec/duration, and reads the exact comment back. The implementation
snapshots only plain enumerable string tag records before reading the source; accessors, symbols, custom
prototypes, non-string values, and unsupported target writers fail typed. Selection precedes target-native
rewrite, and the two underlying progress clocks project to one monotonic two-phase public timeline.

Focused evidence is green: 38/38 metadata-composition tests, 52/52 public codec-operation tests, and 4/4
remux-runner helper tests. The raw-PCM full-track case independently proves `audio:0`, writes fresh WAV
metadata, and preserves every `data` byte exactly; a true subset stays on the normal packet seam. The real
WebM/Vorbis→Ogg oracle proves codec, duration, and exact target comment recovery after selection.

`bun run bench-session12-remux-metadata -- --check` is green on fresh real-media samples. WAV full-track
selection plus tags measured 0.1525 ms baseline / 0.135 ms confirmation median (675.59 MB/s) with a 1.97 MB
positive process-heap sample. WebM Vorbis selection→tagged Ogg measured 0.884 ms baseline / 0.827 ms
confirmation (516.84 MB/s) with a 6.23 MB positive process-heap sample. The benchmark reparses structure,
checks exact WAV payload bytes and Vorbis comments, and does not relabel a no-op as remux work.
