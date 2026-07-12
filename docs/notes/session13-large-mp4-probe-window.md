# Session 13 large MP4/MOV metadata-window probe

## Goal

Make metadata-only probe cost depend on the ISO-BMFF top-level layout and `moov` size, not on the
media-payload size. The affected seam is `Mp4Driver.probe(ByteSource) -> TrackInfo[]`: known-size,
video-hinted MP4/MOV sources should discover an ordinary progressive `moov` with bounded range reads and
return exactly the same metadata as the full demux parser. This is a general large-file optimization for
faststart and tail-`moov` media; it must not recognize a fixture, filename, dimension, duration, or benchmark
row.

## Design

The existing simple-video admission rule rejects every source above 256 KiB, even though sample payload size
has no bearing on whether `moov` is cheaply discoverable. Remove that payload-size gate. Extend the existing
16 KiB metadata proof into a top-level layout walker: validate each declared box against the known source size,
consume headers already present in the current window, jump over `mdat` without reading it, and fetch another
bounded window only at the next top-level offset. Once `moov` is found, parse it with the authoritative
metadata parser and accept only a progressive movie whose exposed audio/video track shapes are fully proven.
Local Blob/byte sources use 16 KiB windows; URL/media-element sources retain their source-aware 128 KiB window
because one remote round trip dominates the bounded overfetch, while still jumping across payload boxes.
The proof already accepts AVC and AAC; add HEVC `hvc1`/`hev1`, whose codec configuration, geometry, bit depth,
color facts, timing, edits, and rotation are produced by that same authoritative parser. AV1/VP9 are left on
the conservative fallback in this change because the contested evidence is AVC/HEVC and broadening an
unmeasured codec surface would add no necessary speed proof. A rejected alternative was increasing the
generic 32 KiB prefetch: it still reads unrelated bytes, retains payload-size coupling, and cannot jump over a
large leading `mdat`. Another rejected alternative was a tail-only footer guess: ISO-BMFF permits legal boxes
after `moov`, so top-level declared-size traversal is both faster and structurally honest.

## Correctness, lifecycle, and failure modes

- B-frames and VFR remain metadata-only concerns here: duration/fps come from the complete `moov` timing
  tables, not packet payloads or constant-frame-rate assumptions. A real AVC VFR file and real B-frame AVC/
  HEVC files are equality-tested against `Mp4Driver.demux()` track truth.
- Faststart and tail-`moov` are both handled. Unknown boxes are skipped by their validated declared size;
  64-bit top-level sizes remain supported. Size-zero, overflowing, truncated, or out-of-source ranges decline
  the proof and fall through to the typed full parser, which remains responsible for the public error.
- Fragmented/CMAF and hybrid-fragmented movies never return from this path because their final duration/fps
  may depend on `moof`/`sidx`; they retain the existing whole-file fragment-timing scan.
- The operation produces no `VideoFrame`, `AudioData`, packet stream, or decoder state. Range views are held
  only until the parsed metadata result is returned. There is no new frame-ownership or backpressure surface.
- Cancellation is checked before and after the bounded proof just as it is around the generic parser. An
  abort after a range read raises the existing typed `MediaError('aborted')`; the proof never emits partial
  metadata.

## Validation and benchmark

The fail-first test uses real corpus media covering large tail-`moov` HEVC 8-bit 4K, HEVC Main10 HDR, AVC VFR,
and AVC B-frames/faststart. It requires probe track truth to equal demux track truth and requires the probe to
read only bounded metadata windows plus the exact `moov`, never `mdat`. A real fragmented open-GOP control,
malformed top-level range, and cancellation control prove conservative fallback and typed failure behavior.
The product benchmark alternates the optimized bounded proof with the unchanged authoritative metadata parser
over at least five real faststart/tail-`moov`, AVC/HEVC/VFR/B-frame shapes after warmup, reporting per-shape
median wall time, reads, and bytes. Browser acceptance remains the public same-export warm `n >= 5` probe rows
against the fastest passing rival; output must continue passing the strict golden-metadata oracle.
