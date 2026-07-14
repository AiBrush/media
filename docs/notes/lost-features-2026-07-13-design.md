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

## Batch F — Bounded WebM packet-pull batching

Fresh browser measurements show the WebM packet seam pays one synchronous Web Streams pull per encoded
packet, unlike the existing MP4 seam. The packet payloads are already source-buffer views, so a bounded
batch can amortize stream scheduling without changing packet bytes, B-frame PTS/DTS reconstruction, VFR
timestamps, keyframe flags, or track order.

The WebM stream will enqueue at most 32 packets or 128 KiB of payload per pull, whichever comes first.
This is a bounded queue, not eager whole-track materialization: cancellation is checked before every packet,
the stream remains pull-driven, and a consumer that stops still releases its reader and source references as
before. No `VideoFrame` or `AudioData` is created by the demux seam, so close-once lifetime rules are
unchanged; source-backed views retain the existing operation lifetime and memory bound.

## Batch G — WebM packet fast path for ordinary VPx access units

The fresh WebM matrix confirms packet-table goldens are exact, but browser demux timing still loses on
the ordinary VP8/VP9 cases. Those packets have no reordered DTS and no alpha BlockAddition, yet the
generic emission path allocates conditional spread objects for fields that are absent. The fast path will
construct the same `Packet` shape directly when both facts are absent and retain the generic path for
B-frame/DTS reconstruction, VFR timestamps, and alpha side data.

Seeking continues to consume the same decode-order stream, cancellation is checked before every packet,
and pull batching remains bounded. No `VideoFrame` or `AudioData` is created or retained by this path;
`Encoded*Chunk` ownership and source-backed byte-view lifetime are unchanged. The optimization adds no
queue or payload copy, so memory and backpressure remain those of Batch F.

## Batch H — Payload-free WebM packet metadata

The browser harness uses the optional `Demuxer.packetTable()` contract when a container can enumerate
packet facts without constructing encoded chunks. WebM already parses every block into source-backed frame
views for its lazy packet stream, so it can expose the same exact metadata directly: track id, payload size,
PTS, DTS, duration, and keyframe verdict, sorted by source block position.

The table derives DTS from the same reorder timeline used by `packets()`, so B-frames and VFR are not
flattened or averaged. Seeking and cancellation remain on the payload stream and are unchanged; the table
is synchronous after the cancellable demux operation has completed. No `VideoFrame`, `AudioData`, or
`Encoded*Chunk` is created by the metadata path, and it adds no payload copy or queue, preserving the
existing source lifetime and memory/backpressure rules. If an exact duration cannot be proven, the optional
table raises a typed demux error rather than inventing a duration.

## Batch I — Payload-free ADTS and FLAC packet metadata

ADTS and FLAC already have exact pure packet-info enumerators that walk frame headers and produce source
offsets, sizes, PTS/DTS, durations, and sync flags. Their `demux()` objects will expose those same rows via
the additive `packetTable()` contract, avoiding browser `EncodedAudioChunk` construction when the caller
needs only strict demux metadata.

The existing packet streams remain the payload path for decode and remux consumers, so AAC/FLAC frame bytes
and audio timelines are unchanged. ADTS/FLAC have no B-frame reordering; VFR is not synthesized, and every
duration comes from frame sample geometry. Cancellation still applies during the source read and before
table publication. No `VideoFrame` or `AudioData` is created, no payload is copied, and the table adds no
queue or backpressure seam; an exact enumerator error remains typed rather than returning partial metadata.

The local multi-sample gate is `bench-session13-flac-packet-info` (warmup 5, 21 alternating samples) plus
the ADTS retained-layout axis in `bench-session13-audio-fixed-cost` (warmup 7, 51 samples). The fresh run
reported FLAC fused packet-info at 2.444 ms median versus 2.626 ms for the composed baseline, and ADTS
retained-layout at 0.000327 ms versus 0.000668 ms for a repeated frame walk; browser acceptance used the
strict six-engine export at `media-test/results/raw/chromium-2026-07-13T13-03-56-825Z.json` with `n=5`.

## Batch J — Prime explicit H.264 ABR control without changing the target budget

The fresh `transcode/h264_bitrate_2mbps` matrix exposed a correctness loss on the real portrait 60-fps
source: Chromium's native H.264 variable-bitrate controller under-allocates the first pictures when the
caller supplies an explicit average bitrate, producing SSIM 0.9085 against the strict in-browser reference
at the requested 2 Mbps. The fix primes that controller with three disposable encodes of the first
decoded picture at ordinary cadence and eight at high cadence (>30.5 fps) before submitting the real first
keyframe. The warmups are never muxed, so the requested average bitrate remains the output contract rather
than a hidden quality override.

Warmup timestamps are derived backward from the first frame's own duration and cadence; no constant-FPS
assumption is made for VFR input. They are outside the output presentation timeline, so B-frame DTS/PTS
ordering and seek/keyframe behavior are unchanged. Cancellation is checked before each warmup and the
existing encoder queue drain remains the backpressure boundary. Each disposable `VideoFrame` is closed in
its own `finally`, the source frame is still closed exactly once by the ordinary encoder path, and only
one disposable frame is live at a time; no decoded frame or encoded payload is retained after priming.

The strict validation uses the real `h264_1080p_30s.mp4` corpus family and its baked packet/frame/metadata
goldens in the browser harness; the local structural gate asserts the real MP4's 1080×1920, 60-fps,
B-frame geometry drives the explicit-ABR warmup decision. The multi-sample benchmark is the same fresh
Chromium six-engine export (`n=5`) plus the existing video rate-control benchmark axis.

Fresh post-fix corpus coverage is recorded in `chromium-2026-07-13T14-02-05-308Z.json` (`01.mp4`, SSIM
0.9890/0.9884), `chromium-2026-07-13T14-08-47-421Z.json` (`02.mp4`, SSIM 0.9709/0.9556), and
`chromium-2026-07-13T14-11-46-525Z.json` (`03.mp4`, SSIM 0.9509/0.9435); all aibrush rows are strict
PASS and all six competitor cells are present in each export.

### Batch K — encrypted HLS probe must resolve before TS inspection

The fresh Chromium loss for `probe/hls_aes128` is a correctness/capability-routing defect, not a missing
AES implementation: the adapter's low-latency HLS probe shortcut fetched the first segment and sent it
directly to the MPEG-TS probe. On the AES-128 corpus this is ciphertext, so the TS driver correctly found
no sync run and the cell became `ERROR`, while the existing source-level HLS resolver already had the
manifest key, IV, relative-URI, and cancellation behavior needed to produce clear TS.

The fix classifies the parsed media playlist before taking the clear-first-segment shortcut. Any segment
with an inherited encryption key uses a bounded first-segment resolver, which fetches the key once,
decrypts only the first segment (and an fMP4 init section when present), and leaves playlist duration as
the authoritative metadata value; clear playlists keep the existing one-segment metadata fast path.
Master playlists already fall through because they do not contain media `EXTINF` rows in the shortcut, and
demux/decode/transcode continue to use the full resolver.
B-frames and VFR are downstream TS timing concerns and remain untouched; seeking starts from the resolved
source's normal keyframe/PCR path. The abort signal is passed through the resolver and checked before every
resource and segment, frame/audio lifetimes are unchanged because probe creates neither `VideoFrame` nor
`AudioData`, and memory remains bounded by the first segment plus parser metadata. Backpressure is
unchanged at the source boundary: the probe resolver returns a re-readable source and the existing TS
probe consumes it through the normal pull path.

The failing validation uses the real `hls_aes128.m3u8` and `hls_vod.m3u8` corpus playlists, the strict
byte-exact AES-to-clear stitched-stream oracle, and the parsed encryption classification. The fresh browser
gate must show `probe/hls_aes128` `PASS` with all competitor cells present and aibrush faster than every
passing competitor; a multi-sample no-reuse matrix remains the benchmark oracle.

### Batch L — resize VPx alpha planes independently

The fresh `transcode/vp9_alpha_to_vp9_keepalpha` matrix showed a real cost in the general alpha path:
colour and alpha packets were decoded separately, merged into a full RGBA `VideoFrame`, resized, then
split back into two frames before the dual VPx encoders. The packet-plane route is safe for resize-only
targets because resize preserves plane identity; crop, pad, rotation, flip, colour, tonemap, and FPS
changes remain on the merged path until their alpha semantics have their own proof.

The new route decodes colour and alpha independently, applies the same resize stage to each plane, and
pairs the two encoder outputs by exact timestamp. A one-frame alpha read-ahead overlaps the independent
branches without changing bounded backpressure: no more than the pending encoder/stream high-water mark
and one encoded alpha result are retained. B-frame/DTS and VFR/PTS values are never reconstructed or
restamped, and seek behavior remains the container packet path. Abort cancels both branch readers and
their pending read promise; the encoder stages close every input `VideoFrame` exactly once, while the
pairer owns only encoded chunks. Memory avoids the intermediate RGBA copy and remains proportional to the
bounded stream queues.

The strict validation uses the real `vp9_alpha.webm` corpus family and the baked alpha-plane/playback
oracles, with the existing unit oracle asserting timestamp pairing, missing-alpha failure, and frame
close-once behavior. Fresh Chromium matrices are recorded at
`media-test/results/raw/chromium-2026-07-13T15-09-45-110Z.json`,
`...15-13-50-343Z.json`, and `...15-14-41-134Z.json`; the exhaustive all-corpus run remains the
acceptance gate. The multi-sample benchmark uses warmup 1, five measured iterations, no result reuse,
and all six competitor cells.

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

### Batch M — Copy untouched audio during video transcodes

**Goal.** Remove the avoidable audio decode/filter/encode leg when `convert()` changes video but leaves
audio unspecified. The fresh Chromium measurements for `transcode/av1_to_vp9_webm` and
`transcode/extreme_fps_240` both passed strict output oracles but paid the full audio codec cost even
though the source audio codec/config was legal for the requested output container.

**Design note.** Add a pure destination-contract predicate over the output container, source audio codec,
and decoder config. Only an unencrypted, configured audio track with `opts.audio === undefined` may use
the copy route. The engine then feeds the demuxer's real `Packet` stream to the muxer beside the video
decode/filter/encode task; unsupported codec/container pairs retain the existing audio WebCodecs path.
Packets carry their source PTS/DTS, duration, and payload view, so B-frame video timing is independent and
unchanged, while VFR video and audio clock timelines remain exactly as demuxed. Seeking is not introduced
into convert: a future trim/seek path must still select a keyframe and rebase packets through its own
contract. Cancellation cancels the packet drain with the same operation signal and aborts sibling video
tasks. No `VideoFrame` or `AudioData` is created by the copy branch, so no new frame lifetime exists; the
demuxer and muxer continue to own packet bytes according to their existing contracts.

Backpressure remains bounded by the mux drain's reader and the demuxer's zero-high-water packet stream;
there is no whole-track audio buffer. Peak memory drops by removing decoded audio frames and encoder
queueing, while the muxer still buffers only its existing output representation. Gapless metadata,
codec-delay, channel/rate config, and container-side descriptions are passed through the original
`TrackInfo`, not reconstructed. Strict validation uses real AV1/Opus WebM and H.264/AAC MP4 corpus inputs
with baked SSIM/duration/playback oracles; the benchmark is warmup 1 plus five fresh wall samples for all
registered competitors. The affected unit test proves legal/illegal destination contracts and packet
drain ownership; the browser matrix is the acceptance gate.

**Rejected:** copying audio for an explicit audio target; assuming a codec is legal from its family token
without checking the destination contract/config; buffering audio packets to synchronize tracks; dropping
gapless or codec-delay metadata; or creating an adapter-only audio shortcut.

### Batch N — Use realtime latency for implicit AV1→VP9 VOD encodes

**Goal.** Reduce the remaining `transcode/av1_to_vp9_webm` loss after untouched Opus packet copy removed
the unrelated audio work. Fresh Chromium strict samples still measured 8.819 s for aibrush-media versus
7.383 s for Mediabunny and 5.699 s for Remotion, with SSIM and playback passing.

**Design note.** When the caller does not specify bitrate mode, bitrate, CRF, or two-pass allocation, and
the source is AV1, the target is ordinary-cadence VP9 VOD, select WebCodecs `latencyMode: 'realtime'`.
Keep quality mode for explicit rate controls, high-cadence targets, unknown cadence, other source codecs,
and fragmented output. This is an encoder scheduling choice, not a pixel or timestamp shortcut: decoded
B-frame presentation order and VFR PTS remain untouched, the encoder still receives every frame, and the
output mux uses the published decoder config. Seeking stays outside convert and retains keyframe semantics.
Abort closes the same encoder/frame pipeline; every `VideoFrame` remains owned by the encoder stage and is
closed exactly once. The existing positive stream high-water marks bound frames in flight and realtime
mode lowers encoder scheduling latency without growing memory. The codec request high-water mark is raised
from 8 to 16 only as a bounded pipeline constant, so native scheduling can overlap decode and encode without
turning the stream into an unbounded queue. Strict AV1 WebM→VP9 SSIM/playback oracles
and fresh five-sample Chromium competitor timings are the acceptance gate; explicit-rate and high-cadence
unit cases prove the optimization does not broaden beyond its evidence.

**Rejected:** lowering bitrate/CRF to win wall time; skipping AV1 frames; rewriting timestamps; applying
realtime mode to explicit quality contracts or high-FPS output; or declaring the row won without strict
pixel/playback validation.

### Batch O — Bound implicit VP9 rate control by trustworthy source evidence

**Goal and diagnosis.** The fresh exhaustive Chromium run for `transcode/av1_to_vp9_webm` measured every
candidate WebM input with all six competitor cells present. The three longer 1080p AV1 files remained
strict PASS, but aibrush-media was approximately 20% slower than Mediabunny and Remotion. The common
cause is the implicit video-rate policy: the generic VP9 path requested `20 bits/pixel/second`, or about
33 Mb/s at 1920×1080, although the source AV1 files and reference engines produce a materially smaller
quality-preserving envelope. This is a general policy correction for implicit lossy output, not a
fixture-path or codec-specific exception.

**Design note.** Only the absence of explicit `bitrate`, `bitrateMode`, `crf`, and two-pass controls may
use the bounded implicit rate. Explicit controls remain unchanged. The bound is derived from a finite,
positive source video bitrate when it is trustworthy, scaled for output pixel rate and target codec
efficiency, and clamped to a conservative floor and codec level ceiling; if no source bitrate is
available, the existing dimension-based fallback remains. B-frames and VFR retain their input PTS/DTS
and are not flattened by the rate change. Seeking still uses the original keyframe/timestamp structure.
Cancellation aborts the same decoder/encoder/mux task group. Every `VideoFrame` and `AudioData` ownership
path is unchanged and still closes exactly once. Memory stays bounded by the existing decoder/encoder
queue limits (the current fixed queue budget is 16), and backpressure still waits on `dequeue` before
submitting more work. Strict validation is the real AV1 WebM corpus with baked SSIM/playback goldens plus
exhaustive real-file structural/playback checks; the benchmark is five fresh wall samples per candidate
and competitor.

**Acceptance boundary.** The optimization must preserve strict SSIM/playback PASS for every AV1→VP9
corpus candidate and must not change explicit rate-control config tests. It is accepted only if the fresh
exhaustive Chromium aggregate closes the measured loss without adding an NA, changing scoring, or
weakening any oracle.
