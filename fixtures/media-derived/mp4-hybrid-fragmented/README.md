# Hybrid-fragmented MP4 AAC corpus

These five committed files are real ISO-BMFF movies written by FFmpeg 8.1.2 from the repository's pinned,
licensed corpus. They exercise the legal shape where the initial `moov/stbl` indexes a real prefix and
`mvex` announces later `moof/trun` runs that continue the same track. A demuxer must consume both indexes;
treating “fragmented” as synonymous with “empty `stbl`” loses all audio after the first fragment.

Sources and licenses:

- `fixtures/media/speech.wav`: Mozilla/WPT public test media, W3C 3-Clause BSD (manifest-pinned).
- `fixtures/media/stereo-48000.wav`: Chromium media test data, Chromium BSD (manifest-pinned).
- `fixtures/media-derived/adts/speech-vbr-44k-stereo.aac` and `speech-heaac-sbr.aac`: real Mozilla
  `speech.wav` transcodes; same W3C 3-Clause BSD provenance.

Reproduction commands (run from the repository root):

```sh
ffmpeg -y -stream_loop -1 -i fixtures/media/speech.wav -t 60.14 -map 0:a:0 -c:a aac -profile:a aac_low -ar 48000 -ac 1 -b:a 96k -movflags +frag_keyframe+default_base_moof -frag_duration 1000000 -use_editlist 1 fixtures/media-derived/mp4-hybrid-fragmented/lc48-mono-long.m4a
ffmpeg -y -stream_loop -1 -i fixtures/media/stereo-48000.wav -t 12.345 -map 0:a:0 -c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 128k -movflags +frag_keyframe+default_base_moof -frag_duration 700000 -use_editlist 1 fixtures/media-derived/mp4-hybrid-fragmented/lc48-stereo.m4a
ffmpeg -y -stream_loop -1 -i fixtures/media/speech.wav -t 7.137 -map 0:a:0 -c:a aac -profile:a aac_low -ar 44100 -ac 1 -b:a 80k -movflags +frag_keyframe+default_base_moof -frag_duration 500000 -use_editlist 1 fixtures/media-derived/mp4-hybrid-fragmented/lc441-mono.m4a
ffmpeg -y -i fixtures/media-derived/adts/speech-vbr-44k-stereo.aac -map 0:a:0 -c:a copy -bsf:a aac_adtstoasc -movflags +frag_keyframe+default_base_moof -frag_duration 800000 -use_editlist 1 fixtures/media-derived/mp4-hybrid-fragmented/lc441-stereo-copy.m4a
ffmpeg -y -i fixtures/media-derived/adts/speech-heaac-sbr.aac -map 0:a:0 -c:a copy -bsf:a aac_adtstoasc -movflags +frag_keyframe+default_base_moof -frag_duration 1000000 -use_editlist 1 fixtures/media-derived/mp4-hybrid-fragmented/he441-stereo-copy.m4a
```

Independent FFprobe 8.1.2 + top-level-box truth:

| file | profile | Hz/ch | stbl samples | trun samples | combined | final ticks | program samples |
|---|---|---:|---:|---:|---:|---:|---:|
| `lc48-mono-long.m4a` | AAC-LC | 48000/1 | 47 | 2774 | 2821 | 2887744 | 2886720 |
| `lc48-stereo.m4a` | AAC-LC | 48000/2 | 33 | 547 | 580 | 593584 | 592560 |
| `lc441-mono.m4a` | AAC-LC | 44100/1 | 22 | 287 | 309 | 315766 | 314742 |
| `lc441-stereo-copy.m4a` | AAC-LC | 44100/2 | 35 | 704 | 739 | 756736 | 756736 |
| `he441-stereo-copy.m4a` | HE-AAC | 44100/2 | 22 | 350 | 372 | 761856 | 761856 |

For this FFmpeg hybrid layout, `ffprobe -count_packets` enumerates one edit/priming prefix packet plus all
`trun` packets, while `nb_frames` reports the initial `stbl` count. The independent box walk confirms the
two disjoint indexes are contiguous in native DTS: `Σ(stbl durations) + Σ(trun durations) == final ticks`
for all five files. The AAC-LC encoded files carry a provisional zero-duration initial edit with a 1024
sample media-time; completing that edit at the final fragment end yields the exact source program counts.

SHA-256:

```text
0f6410a5c04761147966e06fc60d14c7e8332f8ef579f56093007df72684342a  he441-stereo-copy.m4a
fc38612a9b22a1669d57159aefd285b46dd1f7bb11a29df9320020b4b38bab8c  lc441-mono.m4a
91afa68a49fef8119b1e8c68825a0a3a97121a925674b405bd340ea6ac25249b  lc441-stereo-copy.m4a
e4df96b50344fb56a21d1c82a254c1b171ee06b989bf5204e4a79cfaea7a78a2  lc48-mono-long.m4a
8d4318aacedb07ada78e998127eacf53f6607336ecb8cd9644681e1226211b06  lc48-stereo.m4a
```
