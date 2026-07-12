# Session 13 MP4 multitrack packet-array crossover

The fresh public `mux/video_plus_audio_to_mp4` row remained correct but measured 228.685 ms warm median
(MAD 14.955) versus mediabunny at 49.785 ms (MAD 0.715). The input seam already supplied complete bounded
video and audio packet arrays. Multitrack MP4 nevertheless wrapped both arrays in promise-backed streams and
drained one packet per pull before invoking the same shared writer used by the prepared path.

The retained route is deliberately narrow and algorithmic: non-fragmented, default-faststart `mp4`; at least
two descriptors; every descriptor has `packetsArray`; no descriptor has a readable `packets` stream; at least
256 combined packets. Generated real-payload shapes at 2, 8, 16, 32, and 64 packets were within noise or
slower. Alternating warm `n=15` medians from the retained crossover were:

| Packets | Generic ms | Prepared ms | Speedup |
| ---: | ---: | ---: | ---: |
| 256 | 0.558 | 0.510 | 1.09x |
| 512 | 1.049 | 0.793 | 1.32x |
| 1,024 | 1.873 | 1.686 | 1.11x |
| 2,048 | 3.560 | 3.096 | 1.15x |

All nine generated sizes require byte-identical generic and prepared Blob output. A separate real 2,308-packet
30-second H.264/AAC oracle compares the selected prepared route byte-for-byte with the shared direct writer,
then reparses exact media types, packet count, PTS, DTS, duration, size, and keyframe truth. Conversion checks
the abort signal before each packet extraction and after the loop; a test aborts inside the first
`copyTo()` and proves the second packet is untouched.

MOV remains generic because its measured specialization regressed; so do fragmented MP4, explicit
non-faststart, small arrays, ordinary streams, and mixed stream/array inputs. The rule does not inspect an
asset name, digest, codec bitrate, dimensions, duration, rotation, or the contested row's packet count.
Browser closure remains pending the fresh qualified sweep and peak-memory comparison.
