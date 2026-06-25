# Derived test fixtures (committed)

Small, real-media artifacts derived from corpus/acceptance assets for a focused validation test, where
adding the full multi-hundred-MB source to the git-ignored `fixtures/media/` corpus would be wasteful.
Each is either a **verbatim byte slice** of a source file, or — for a container we have no small sample of
— a **real container losslessly remuxed/transcoded from a public-domain source** with `ffmpeg` (the
container bytes are genuine; the content is real licensed media). Never synthetic, never hand-crafted.

| File | Derived from | What | Provenance |
|---|---|---|---|
| `big_buck_bunny_1080p_h264.header.mov` | `big_buck_bunny_1080p_h264.mov` (725 MB) | verbatim `ftyp` + `moov` only (a valid probe input; probe reads no `mdat`) | Big Buck Bunny © Blender Foundation, [CC BY 3.0](https://peach.blender.org/about/); the harness asset under `../../../media-test/media-browser-test/fixtures/media/` |
| `h264_1080p_5s.header.mov` | `h264_1080p_5s.mov` (4.4 MB) | verbatim `ftyp` + `moov` only | harness asset under `../../../media-test/media-browser-test/fixtures/media/` |
| `h264_720p.head.ts` | `h264_ts.ts` (4.4 MB) | the first 860 verbatim 188-byte transport packets (PAT + PMT + the first few video/audio PES) — a valid standalone TS probe input | Big Buck Bunny © Blender Foundation, [CC BY 3.0](https://peach.blender.org/about/); the harness asset under `../../../media-test/media-browser-test/fixtures/media/` |
| `mjpeg_pcm_160p.avi` | `fixtures/media/movie_5.mp4` (WPT) | a real RIFF/`AVI ` container: MJPEG 160×120 @24fps (1 s) + PCM s16 16 kHz, transcoded by ffmpeg | web-platform-tests `media/movie_5.mp4` ([W3C 3-Clause BSD test license](https://github.com/web-platform-tests/wpt/blob/master/LICENSE.md), public test media) |
| `mpeg4_mp3_160p.avi` | `fixtures/media/movie_5.mp4` (WPT) | a real RIFF/`AVI ` container: MPEG-4/XVID 160×120 @24fps + MP3 16 kHz, transcoded by ffmpeg | web-platform-tests `media/movie_5.mp4` (W3C 3-Clause BSD test license, public test media) |

Both carry a QuickTime (`qt  `) major brand and a `mp4a` audio entry: the bunny header is a **version 2**
sound sample description (5.1ch, f64 sample rate, `wave`-nested `esds`); the 5 s header is a **version 1**
entry (stereo, 16 extra bytes before the sub-boxes). They exercise `parse.ts` `parseAudioEntry` for the
v1/v2 QuickTime layouts (`audio-entry.test.ts`).

Expected metadata (the test's oracle) comes from the harness goldens, not a guess:
`media-browser-test/fixtures/golden/big_buck_bunny_1080p_h264.mov.meta.json` and `…/h264_1080p_5s.mov.meta.json`
→ audio `aac`, 48000 Hz, 6 and 2 channels respectively.

`h264_720p.head.ts` carries program 1 → PMT PID `0x1000` → `stream_type 0x1b` (H.264) @ PID `0x100` and
`0x0f` (ADTS AAC) @ PID `0x101`; the first video PES has PTS 127920 (90 kHz = 1.421333 s, == ffprobe
`start_time`) and the first audio PES PTS 126000 (1.4 s). It drives `ts-parse.ts` PAT/PMT/PES reassembly,
H.264-SPS dims (1280×720), and ADTS sample params (48000 Hz / 2 ch) in `mpegts.test.ts`. The full-length
`.ts`/`.m3u8` assets (used directly by path for the duration + monotonic-PTS spans and the HLS playlist
oracle) stay in the harness corpus.

The two `.avi` files are genuine AVI containers (RIFF `AVI ` → `hdrl`(`avih`+`strl`) → `movi` → `idx1`):
`mjpeg_pcm_160p.avi` exercises the intra-only MJPEG path (every frame a keyframe) + PCM s16 audio
(sample-accurate byte-based timing); `mpeg4_mp3_160p.avi` exercises a compressed inter-coded codec (MPEG-4
via the `XVID` `biCompression` 4CC) + chunked MP3 audio. The oracle (codecs, 160×120 dims, 24 fps,
16 kHz/1 ch, duration 1.000 / 1.083 s) is ffprobe ground truth in `avi.test.ts` — can-fail. `sha256`:
`mjpeg_pcm_160p.avi` = `13f718c0f73e1251b5ac98644b8fb0f671455f4321d25ab4beb4dc906efac301`,
`mpeg4_mp3_160p.avi` = `992254dcf4b6b10e57cf4a1941c49cb7b5603e9956a81a0deb328f07fcc196a8`.

To regenerate the MOV headers, extract the first top-level `ftyp` and `moov` boxes from the source asset
and concatenate them (no re-encoding, no field edits). To regenerate `h264_720p.head.ts`, take the first
`860 × 188` bytes of `h264_ts.ts` verbatim (no re-encoding, no field edits). To regenerate the AVIs:
`ffmpeg -i fixtures/media/movie_5.mp4 -t 1 -vf scale=160:120 -c:v mjpeg -q:v 8 -c:a pcm_s16le -ar 16000 mjpeg_pcm_160p.avi`
and `… -c:v mpeg4 -vtag XVID -q:v 8 -c:a libmp3lame -b:a 64k -ar 16000 mpeg4_mp3_160p.avi`.
