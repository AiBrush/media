# Lost-feature remediation design note

Date: 2026-07-13

This note is the design gate for the 56 rows in `lost-features-chromium-2026-07-13.md`. A row is not
declared won from a typed result alone: the real corpus input, strict golden oracle, fresh multi-sample
timing, every applicable competitor, and the relevant browser gate must all pass.

## Shared media invariants

Video paths preserve decode timestamps and presentation timestamps separately, so B-frame reorder and
VFR cadence never become an accidental CFR or decode-order result. Seek starts from the nearest safe
keyframe and trims by presentation time. Every operation owns a cancellation scope and propagates its
`AbortSignal` through source reads, demux, codec work, transforms, mux, and sink writes. A produced
`VideoFrame` or `AudioData` has one owner and exactly one close; queues are bounded and their producer
waits for consumer demand. Large inputs stay range/lazy and bounded-memory; no feature may trade an
oracle failure for throughput. On cancellation, queued media is closed before the operation settles and
the source reader is cancelled.

These invariants are reviewed for every row below. The row-specific note names the primary risk and the
strict validation/benchmark axis.

## Batch A — selective MP4/WebM demux registration

The fresh demux/probe export shows a shared startup loss on definitive MP4/WebM inputs. The general fix
is to register only the matching demux module on a known extension/MIME miss, just as the existing audio
selectors do; ambiguous or malformed sources still take the complete fallback. The module boundary does
not alter packet parsing, B-frame/VFR timestamps, seek behavior, cancellation, frame/audio lifetime,
memory bounds, or stream backpressure. Validation covers the real MP4/WebM corpus and registration
invariants; the benchmark compares all affected demux/probe rows with fresh multi-sample runs.

## Batch B — Xing/LAME gapless MP3 propagation

The fresh `transcode/mp3_to_aac_mp4` export reproduced a correctness loss on the real LAME/Xing corpus:
the MP3 container exposed all coded frames but discarded the standard encoder-delay/padding tuple, so the
AAC encoder received the coded tail and the MP4 output exceeded the independent source duration. The fix
reuses the existing pure MP3 VBR parser, carries the exact sample window through `TrackInfo`, trims the
decoded `AudioData` stream before re-encode, and writes the same window into authored MP4/MP3 metadata. The
strict real-corpus test checks the baked `sound_5.mp3` LAME tuple and duration; the browser validation checks
the decoded-output metadata and fresh competitor timing. B-frames are not present on this audio-only row;
VFR, seek, cancellation, frame/audio lifetime, bounded memory, and sink backpressure remain governed by the
existing stream pipeline and close-once gapless trim.

Packet-copy trim is a separate boundary case: once a request selects a new coded-frame window, the source
Xing/LAME tuple is no longer valid for the output and is deliberately removed from the copied track metadata.
The real `sound_5.mp3` trim oracle therefore checks the exact complete-frame duration, while decode/re-encode
paths retain the source tuple and perform sample-accurate gapless trimming.

## Batch C — Opus output owns its own priming metadata

The fresh `transcode/mp3_to_opus_webm` result failed on a real MP3 corpus input because the source Xing/LAME
`totalSamples` count was expressed at 44.1 kHz but was copied verbatim into a 48 kHz Opus output track. The
resulting Matroska duration was exactly the source sample count divided by 48 kHz (12.9707 s for `02.mp3`),
not the 14.1177 s source program duration. The fix keeps source gapless facts on the decode side, where the
close-once `AudioData` trim consumes them, but omits them from an Opus re-encode track so the encoder's own
OpusHead/CodecDelay describes the output timeline. The real corpus helper test proves the source tuple is
present and the output selection omits it; the fresh browser export proves strict output metadata and playback.
B-frames and VFR do not apply to this audio-only row; seek, cancellation, AudioData lifetime, bounded memory,
and sink backpressure remain the existing stream invariants.

## Batch D — Preserve explicit relative provenance for detached HLS files

Fresh Chromium evidence reproduced `probe/hls_aes128` as a typed relative-resource fetch miss when the
manifest arrived as a detached `File`; the same real AES-128 playlist resolves and probes when its URL is
available. A `File` selected from a directory can carry `webkitRelativePath`, which is caller-supplied
provenance and may be used with the document base URL. Preserve that path as the source filename hint and
resolve it only when it is an explicit relative path; a basename-only detached file remains an honest
relative-resource miss because no segment directory can be inferred.

The playlist parser still resolves every URI by RFC 3986 rules, fetches each key once, decrypts AES-128 with
the declared IV, and stitches the independently checked TS bytes. HLS has no B-frames in the source-level
stitch step; downstream TS decode retains the existing WebCodecs presentation-order guarantee and VFR/PCR
clock mapping. Seeking remains against the stitched source, cancellation stops fetch/decrypt immediately,
all temporary byte arrays remain operation-scoped, and segment fetches stay sequential to preserve bounded
memory and backpressure. No `VideoFrame` or `AudioData` is created by the resolver.

## Batch E — WebM full-demux traversal fusion

Fresh Chromium measurements on real VP9 corpus inputs show a performance loss in the full WebM demux
operation, while the strict packet goldens already match. The hot path currently parses metadata, performs
a complete Segment-boundary walk, and then walks every Cluster again to materialize packet views. The
optimization must preserve the same packet byte ranges, decode order, keyframe flags, B-frame presentation
timestamps/DTS reconstruction, VFR timestamps, and track-index mapping; no packet may outlive the source
buffer or be copied solely for speed.

The design is to fuse complete top-level Segment validation with the frame walk, retaining the existing
typed rejection for malformed IDs, sizes, truncated finite elements, and illegal unknown-sized elements.
The demux caller also avoids the metadata parser's full-cluster timing scan: bounded first-keyframe
qualification remains available, while the frame materialization pass supplies the authoritative cadence
and terminal timestamp for tracks whose declarations omit them. Public `parseWebm` probe behavior keeps its
existing complete scan semantics.
Cancellation is checked at the public operation boundary and before packet consumption; packet streams
remain pull-driven with bounded arrays and no decoder-frame allocation. Memory remains one source buffer plus
the existing per-track frame views, and backpressure is unchanged because the fusion happens before the
consumer-facing stream is created. HLS, seeking, audio `AudioData` lifetime, and `VideoFrame` lifetime are
unaffected; no `VideoFrame` or `AudioData` is created by the WebM demux parser.

| # | Feature | Design note / strict oracle / benchmark axis |
|---:|---|---|
| 1 | `demux/aac_adts` | Parse sync/header/frame boundaries without scanning beyond a truncated frame; golden packet table and packets/s across short and long ADTS files. |
| 2 | `demux/av1_720p_5s` | Preserve AV1 temporal-unit order and timestamps; decode only when the browser capability exists; structural packet/config golden and frames/s. |
| 3 | `demux/h264_4k_10s` | Range-read the index and keep NAL payloads bounded; B-frame DTS/PTS remain distinct; packet-table golden and bytes/s. |
| 4 | `demux/h264_multitrack` | Keep track identity/order and per-track timestamps; drain each bounded queue independently; multi-track packet golden and packets/s. |
| 5 | `demux/h264_rotated90` | Preserve coded dimensions and expose the display matrix/rotation; no width-height swap; metadata golden and repeated probe/demux timing. |
| 6 | `demux/h264_vfr` | Preserve sample PTS deltas and report nominal/average FPS only where defined; VFR-specific timestamp golden and demux throughput. |
| 7 | `demux/hls_vod` | Resolve a finite playlist, relative resources, segment order, and aggregated duration before container routing; cancellation stops segment fetches; segment-list golden and resolution latency. |
| 8 | `demux/metamorphic_flac_seektable_invariance` | Seektable presence may change seek cost, never packet/sample identity or duration; compare two real corpus variants bit-exactly and benchmark seek latency. |
| 9 | `demux/realworld_mdn_flower_mp4` | Exercise remote-origin-style MP4 range reads and moov placement; strict packet/metadata oracle and cold/warm probe timing. |
| 10 | `demux/realworld_mdn_flower_webm` | Exercise real WebM cues/cluster ordering and bounded range reads; packet golden and demux throughput. |
| 11 | `demux/size_large_large_vp9_1080p_120s` | Keep large VP9 demux lazy and memory-bounded; timestamp order and track golden, multi-sample long-input benchmark. |
| 12 | `demux/size_micro_micro_audio_short` | Avoid fixed startup overhead dominating a tiny audio source; exact packet/sample golden and many-repetition latency distribution. |
| 13 | `demux/size_tiny_tiny_h264_360p_2s` | Fast path must retain strict H.264 packet identity and B-frame timestamps; tiny-input benchmark with fresh samples. |
| 14 | `demux/size_tiny_tiny_vp9_360p_2s` | Same bounded/lifetime rules for WebM VP9; packet golden and startup-normalized throughput. |
| 15 | `demux/vp8_720p_10s` | Preserve VP8 frame boundaries and timestamps; strict packet table and frame/packet throughput. |
| 16 | `demux/vp9_1080p_10s` | Preserve VP9 superframe boundaries and config; golden packet structure and bytes/s under bounded memory. |
| 17 | `probe/aac_adts` | Probe must be header-only and cheap while rejecting malformed sync/frame lengths; metadata golden plus fresh latency samples. |
| 18 | `probe/empty-audio-wav` | Return the typed empty-audio result without division-by-zero or fake duration; exact metadata/error oracle and repeated micro-benchmark. |
| 19 | `probe/flac_noseektable` | Derive duration from STREAMINFO total samples without assuming SEEKTABLE; metadata golden and header-read timing. |
| 20 | `probe/h264_multitrack` | Enumerate every track with stable order/language and no sample walk; metadata golden and repeated probe timing. |
| 21 | `probe/hls_aes128` | Detect the manifest before TS routing, resolve relative key/segments, decrypt RFC AES-128 with WebCrypto, then probe clear TS; strict container/track/duration golden and fresh browser latency. |
| 22 | `probe/hls_vod` | Same source-level HLS route without decryption; verify relative resources and finite duration; metadata golden and latency benchmark. |
| 23 | `probe/mp3_cbr_notoc` | Estimate duration from validated bitrate/frame count when no Xing TOC exists; metadata tolerance is corpus-baked, with fresh probe samples. |
| 24 | `probe/mp3_xing` | Prefer validated Xing/Info duration and gapless fields; metadata golden and cold/warm probe benchmark. |
| 25 | `probe/realworld_mdn_trex_mp3` | Handle a real MP3 header/frame layout and encoder delay; narrow duration oracle plus repeated probe timing. |
| 26 | `probe/recorder_headerless` | Treat unknown WebM duration honestly and avoid scanning forever; structural metadata oracle, cancellation test, and bounded probe benchmark. |
| 27 | `probe/wav_s16` | Validate RIFF chunks and PCM format without copying the payload; exact metadata golden and micro-latency benchmark. |
| 28 | `probe/wav_s24` | Preserve 24-bit sample width and byte alignment; exact metadata golden and repeated header benchmark. |
| 29 | `remux/aac_adts_adts_to_mp4` | Rewrap ADTS frames with correct AudioSpecificConfig and timestamps; re-import/packet golden and mux throughput with bounded sink backpressure. |
| 30 | `remux/av1_720p_5s_webm_to_mp4` | Preserve AV1 config, timestamps, and B-frame order while changing container; strict re-import packet golden and bytes/s. |
| 31 | `remux/h264_1080p_5s_mov_to_mp4` | Keep MOV timing/edit-list semantics in MP4 and preserve rotation metadata; re-import golden and remux latency. |
| 32 | `remux/opus_ogg_to_webm` | Map Ogg granule/timestamp and Opus pre-skip exactly into WebM; packet/audio-duration golden and sink-throughput benchmark. |
| 33 | `remux/vp9_1080p_10s_webm_to_mp4` | Preserve VP9 codec private/config and timestamps; strict re-probe/packet golden and long-input throughput. |
| 34 | `transcode/av1_to_vp9_webm` | Select hardware codecs when supported, otherwise typed capability miss; B-frame/VFR timestamps and frame oracle, multi-sample frames/s. |
| 35 | `transcode/extreme_fps_240` | Bound queue depth and avoid timer/backpressure collapse at 240 FPS; exact frame-count/timestamp oracle and sustained frames/s/peak memory. |
| 36 | `transcode/h264_bitrate_2mbps` | Apply bitrate control through the selected encoder without weakening frame oracle; preserve B-frame timestamps and close frames under backpressure; bitrate/metadata golden and multi-sample encode timing. |
| 37 | `transcode/h264_fps_15_to_30` | Duplicate/resample by presentation time, not decode order; exact output cadence and frame oracle with fresh frames/s. |
| 38 | `transcode/h264_fps_30_to_60` | Generate the 60 FPS cadence without leaking source frames; exact count/timestamp oracle and sustained throughput. |
| 39 | `transcode/h264_resize_4k_to_1080p` | Route resize to GPU when available, preserve timestamps and color, and bound intermediate surfaces; frame SSIM/metadata golden and pixels/s/memory. |
| 40 | `transcode/h264_rotate_180` | Apply a true pixel rotation with exact dimensions/timestamps; frame oracle and GPU/CPU throughput. |
| 41 | `transcode/h264_rotate_90_dimswap` | Rotate pixels and swap output dimensions exactly once; no metadata-only shortcut; frame golden and multi-sample timing. |
| 42 | `transcode/h264_to_hevc_mp4` | Use capability-routed HEVC encode and typed miss only where unsupported; strict re-probe/frame oracle and encode throughput. |
| 43 | `transcode/h264_vfr_to_cfr_30` | Resample VFR by PTS to a deterministic 30 FPS grid; frame count/timestamp golden and sustained throughput. |
| 44 | `transcode/hdr10_to_sdr_tonemap` | Apply a real HDR transfer/tonemap path with explicit color metadata; frame/color oracle and pixels/s/peak memory. |
| 45 | `transcode/hevc_to_vp9_webm` | Capability-route HEVC decode and VP9 encode, preserving presentation timing; strict frame/metadata oracle and multi-sample throughput. |
| 46 | `transcode/ladder_large_h264_1080p_120s_resize_720p` | Stream a long input through GPU resize and encoder with bounded queues; periodic frame oracle, duration/count golden, sustained throughput and memory. |
| 47 | `transcode/ladder_tiny_h264_360p_resize_180p` | Avoid startup overhead and preserve exact tiny output dimensions; frame/metadata golden and repeated micro-benchmark. |
| 48 | `transcode/ladder_tiny_vp9_360p_to_h264_180p` | Cross-codec tiny ladder with correct timestamps and encoder flush; strict frame golden and startup-normalized throughput. |
| 49 | `transcode/metamorphic_duration_preserved_h264_to_vp9` | Duration must remain invariant across codec change within the baked tolerance; compare independent outputs and benchmark. |
| 50 | `transcode/mp3_to_aac_mp4` | Decode MP3 gapless timing and encode AAC with correct priming/container metadata; re-probe/audio golden and multi-sample throughput. |
| 51 | `transcode/mp3_to_opus_webm` | Preserve audio sample timeline through MP3 delay into Opus pre-skip; strict sample-count/duration golden and throughput. |
| 52 | `transcode/multitrack_select_default_audio` | Select the declared default audio track without dropping video or misordering tracks; metadata/frame/audio oracle and bounded pipeline benchmark. |
| 53 | `transcode/opus_to_aac_mp4` | Map Opus pre-skip/end trim into AAC priming and MP4 timing; strict audio oracle and multi-sample throughput. |
| 54 | `transcode/roundtrip_leg2_vp9_to_h264` | Preserve duration/frame cadence across the second codec leg and close every decoded frame; strict frame/metadata oracle and chained throughput. |
| 55 | `transcode/vp9_alpha_to_vp9_keepalpha` | Preserve alpha plane and color metadata through decode/encode; alpha-aware frame golden and pixels/s/memory benchmark. |
| 56 | `transcode/wav_to_aac_mp4` | Convert PCM sample format/channels with exact duration and AAC container metadata; decoded-audio golden and throughput under sink backpressure. |

## Evidence policy

The authoritative status table is `docs/perf/lost-features-2026-07-13-checklist.md`. Fresh results are
recorded only from a no-reuse Chromium export, with the suite version, corpus checksum, browser/GPU,
competitor cells, timings, and raw JSON path. Any architecture change is recorded in
`docs/architecture/02-decision-records.md` in the same green commit.
