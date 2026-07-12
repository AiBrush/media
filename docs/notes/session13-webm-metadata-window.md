# Session 13 WebM metadata first-window evidence

Date: 2026-07-11  
Decision: ADR-258

## Root cause

The fresh same-export `probe/realworld_mdn_flower_webm` row passed exact two-track metadata but measured
3.280 ms against remotion-webcodecs at 1.895 ms. The selected 541,606-byte WebM has `Info` wholly in the
front and a finite `Tracks` element ending at byte 4,749. The former 4 KiB first window therefore stopped
653 bytes early, rejected the deliberately incomplete track declaration, and restarted from byte zero with
the next 64 KiB ladder step. This was correct but paid a second range latency and transferred 69,632 bytes
in total. The related selected VP9-alpha input is only 6,663 bytes, so an 8 KiB request is clamped to the
whole small source.

## Change and invariants

The first WebM/MKV metadata window is now 8 KiB. Every acceptance rule is unchanged: a prefix still needs
complete declared duration, complete `Tracks` and `Attachments`, all video geometry/fps facts, and qualified
VP9/AV1 decoder configuration. Files that need a larger finite declaration continue through 64 KiB, 256 KiB,
1 MiB, and 4 MiB before the full fallback. Headerless MediaRecorder inputs still scan Clusters for duration
and cadence. Truncated and malformed EBML still reject through the same parser. Probe creates no decoded
frames, so B-frame/VFR order, seek, frame lifetime, and close-exactly-once ownership are outside this read
policy; cancellation remains checked before and after each awaited range.

Focused real-corpus tests pin the flower input to one `[0,8192)` range and retain exact VP8/Vorbis track
truth. The existing VP9/Opus, AV1, VP9-alpha, H.264 Matroska, attachment, recorder-fps, malformed-container,
and exact packet suites remain green: 69 tests and 8,089 assertions.

The public engine performs a separate 4 KiB image/container sniff before invoking the WebM metadata
reader. Reissuing `[0,8192)` after retaining `[0,4096)` would transfer the first half twice, and a later
`[0,65536)` fallback would repeat both earlier prefixes. The exact-source ADR-246 cache therefore extends
a retained prefix by requesting only its missing suffix, constructs one exact owned response, and replaces
the smaller retained interval. This is a general range-cache rule rather than WebM routing: any request
whose leading bytes are already owned benefits; distinct source snapshots remain isolated; returned bytes
cannot mutate the cache; short reads preserve their actual length; concurrent replacements remain
canonical; and the one-MiB/eight-interval/60-second bounds are unchanged. The public flower path consequently
reads `[0,4096)` then `[4096,8192)`, transferring 8 KiB total. A VP9-alpha fallback adds only
`[8192,65536)`, transferring 64 KiB total.

## Benchmark

`bun run bench-session13-webm-metadata-window` alternates 21 timed samples after three warmups through the
same production `WebmDriver.probe()` code. A range source injects 3 ms latency. The current route receives
the requested 8 KiB; the former control returns only the historical 4 KiB on the first read, causing the
unchanged production ladder to request 64 KiB next. Both outputs must serialize to identical `TrackInfo`.

| route | median | reads | transferred |
|---|---:|---:|---:|
| current 8 KiB first window | 3.867 ms | 1 | 8,192 B |
| former 4 KiB then 64 KiB | 7.791 ms | 2 | 69,632 B |

The same benchmark now also exercises the full public engine route, including its image sniff and
ADR-246 cache. Fresh warmup-three/`n=21` samples measure an 8.051 ms median with exactly two underlying
reads, `[0,4096)` and `[4096,8192)`, and 8,192 transferred bytes. This corrects the driver-only evidence:
the public route still pays two transport round trips, but no longer retransfers either prefix and parses
8 KiB rather than the former 64 KiB fallback. Browser leaderboard closure remains pending.

The 8 KiB policy is a general EBML-front-metadata bound, not a filename, digest, duration, codec, track-count,
or fixture rule. A 64 KiB first request was rejected because it transfers eight times the retained bound for
ordinary front-loaded files; keeping 4 KiB was rejected because a modest legal `Tracks` declaration crosses
that boundary and deterministically adds a transport round trip. Browser leaderboard and memory closure still
require the final same-export rotated sweep.
