# Session 12 WAV frame encode

## Goal

Make the documented public `encode()` raw-frame operation accept one `ReadableStream<AudioData>` and
author a genuine PCM WAV when `to:'wav'` and the audio codec is `pcm` or a legal `pcm-*` token. The output
must reuse the first-party WAV muxer, preserve the source samples at the requested wire precision, infer
omitted rate/channel facts from the first frame, close every consumed `AudioData` exactly once, and leave
video and compressed-audio WAV requests as typed capability misses.

## Approach

Add a lazy operation runner that pulls exactly one audio frame at a time, validates a stable sample rate,
channel count, and contiguous timestamp clock, converts the frame through the existing canonical
`AudioData` → PCM and PCM wire-format kernels, and hands each bounded PCM byte chunk to the existing
`WavMuxer`. The engine routes the real WAV muxer first, so driver pins and mux validation remain authoritative.
Omitted or generic `pcm` selects `pcm-f32`, the lossless representation of the canonical `AudioData`
copy seam; explicit depth/endian tokens select that exact input wire representation and the WAV muxer
authors the legal little-endian WAV equivalent. A direct second RIFF writer was rejected because it would
duplicate format/endian/multi-track validation and drift from the already strict-tested muxer. Wrapping raw
bytes in a fake `EncodedAudioChunk` was also rejected because PCM samples are not a coded WebCodecs chunk.

## Edge cases and failure modes

WAV accepts one non-empty audio stream only. Video, compressed codecs, fragmentation, missing targets,
rate/channel mismatch, mid-stream layout changes, non-finite timestamps, timeline gaps/overlap, and empty
PCM input reject with typed `InputError`, `CapabilityError`, or `MediaError`; none is guessed or silently
reshaped. The first timestamp is rebased to zero and later timestamps must match the cumulative sample clock
within integer-microsecond rounding. Audio has no B-frames or VFR, but arbitrary frame boundaries are legal.
The pull loop never prefetches, so upstream backpressure remains one frame; the buffered WAV muxer retains
only encoded PCM chunks plus one transient canonical frame. Abort/error cancels the upstream reader, closes
the currently owned frame in `finally`, and relies on the source's cancel contract to release unpulled frames.
Every frame handed off by `read()` is therefore closed exactly once; no caller-owned source track is stopped.

## Validation and benchmark plan

The fail-first public test uses the five downloaded WPT PCM WAV fixtures (`u8`, `s16`, `s24`, `s32`, and
`f32`) recorded in `fixtures/manifest.json`. It frames their independently parsed real samples at deliberately
uneven boundaries, runs `media.encode()`, reparses the result, and checks exact layout plus the strongest
applicable sample oracle (bit-exact for values representable by `AudioData`; explicit bounded precision for
the unavoidable 32-bit-integer → float frame seam). Separate lifecycle tests cover close-once, cancellation
while a read is pending, reader error, geometry/timestamp rejection, no-prefetch, and unsupported video or
compressed requests. A warm multi-sample benchmark spans the same five real files, consumes a checksum,
and records wall throughput plus positive heap/RSS samples.

## Results

The fail-first public suite now passes 24/24, the codec-operation matrix passes 55/55, and the existing WAV
driver/mux matrix remains green. The five-format corpus checks every output sample after the unavoidable
`AudioData.copyTo('f32-planar')` precision boundary, all explicit endian/depth aliases, arbitrary chunk
boundaries, first-clock rebasing, exact output geometry, close-once, reader/copy failure, pending abort,
no-prefetch, and typed no-pull declines for video/compressed targets.

`bun run bench-session12-wav-frame-encode` runs two discarded warmups and seven fresh samples over 143,834
input bytes / 51,200 frames per sample. The fresh median is **1.566 ms / 91.863 MB/s**, with stable output
checksum `2910552623`. Three separate 12-corpus memory passes each retain genuine output buffers while
sampling: peak ArrayBuffer growth is **7,771,680 bytes** in every pass and positive RSS growth ranges from
**1,736,704 to 6,651,904 bytes**; process heap is sampled at 7.84–11.12 MB. Post-GC heap, ArrayBuffer, and
RSS retention stay below the explicit 64 MiB bound. The memory checksum is stable at `589612457`; no
missing memory observation is converted to zero.
