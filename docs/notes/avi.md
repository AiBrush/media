# Design note — AVI container driver (RIFF `AVI `)

> Per `BUILD_INSTRUCTIONS.md` §4 (ULTRATHINK). Implements `src/drivers/avi/` — a pure-TS `ContainerDriver`
> (ADR-002: containers are ours). Not registered in `defaults.ts` (the parent owns that). Validated
> structurally against real `.avi` fixtures vs ffprobe ground truth.

## Goal (concrete)

`ContainerDriver` `id:'avi'`, `formats:['avi']`:

- **probe** `(ByteSource) → Demuxer` whose `.tracks` feed `toMediaInfo` (`engine.ts`): `container`
  becomes `formats[0]='avi'`; per track a `TrackInfo { id, mediaType, codec, durationSec, fps?, config }`
  — video `config:{ codec, codedWidth, codedHeight }`, audio `config:{ codec, sampleRate,
  numberOfChannels }` (exactly what `toInfoTrack` reads). Codec from the stream format chunk; `fps` from
  `strh` `dwRate/dwScale`; `durationSec` from `dwLength × dwScale/dwRate` (video) maxed across streams.
- **demux** `packets(trackId) → ReadableStream<EncodedChunk>` — read the `movi` data chunks for the
  stream, attach per-chunk PTS (chunk index × scale/rate, in WebCodecs µs), and emit
  `EncodedVideoChunk`/`EncodedAudioChunk`. Browser-gated exactly like `mpegts-driver.ts` /
  `mp4-driver.ts` `packetStream`: `typeof EncodedVideoChunk==='undefined'` → `CapabilityError`, body
  behind `/* v8 ignore */`.

## Ground truth (measured from real ffmpeg-written AVIs — the oracle, can fail)

`fixtures/media-derived/mjpeg_pcm_160p.avi` (real AVI; MJPEG 160×120 @24fps 24 frames + PCM s16 16 kHz)
and `mpeg4_mp3_160p.avi` (MPEG-4/XVID + MP3). RIFF tree (verbatim):
`RIFF('AVI ')` → `LIST(hdrl)`[`avih`(56B) + per-stream `LIST(strl)`(`strh`56B + `strf` + JUNK + `vprp`)]
→ `LIST(INFO)` → `JUNK` → `LIST(movi)`[`00dc`/`00db`=stream-0 video, `01wb`=stream-1 audio] → `idx1`.

- **avih** little-endian u32 @: 0 `dwMicroSecPerFrame`(41666→24fps), 16 `dwTotalFrames`(24/26), 24
  `dwStreams`(2), 32 `dwWidth`(160), 36 `dwHeight`(120).
- **strh** @: 0 `fccType`('vids'/'auds'), 4 `fccHandler`('XVID'/'MJPG'/…), 20 `dwScale`, 24 `dwRate`, 32
  `dwLength`, 44 `dwSampleSize`. Video: scale=1,rate=24 → 24 fps; audio PCM: scale=1,rate=22050,
  sampleSize=2; audio MP3: scale=1152/576-ish, sampleSize=0.
- **strf video = BITMAPINFOHEADER** @: 0 biSize(40), 4 biWidth, 8 biHeight, 14 biBitCount, **16
  biCompression (a 4CC: 'XVID'/'MJPG'/'H264'/0=RGB)**.
- **strf audio = WAVEFORMATEX** @: 0 `wFormatTag`(0x55=MP3, 0x1=PCM, 0xFF/0x1FF=AAC, 0x2000=AC-3), 2
  `nChannels`, 4 `nSamplesPerSec`, 8 nAvgBytesPerSec, 12 nBlockAlign, 14 wBitsPerSample.

Verified: ffprobe reports mjpeg/MJPG 160×120 24fps 24fr dur 1.000, pcm_s16le 16000/1; mpeg4/XVID
160×120 24fps, mp3 16000/1 dur 1.083 — my parser must reproduce these exactly.

## Approach

- **One little-endian RIFF chunk walker** over the fully-read source. AVI's `movi` sample offsets are
  byte positions, and duration needs `strh`/`avih`, so probe reads the head; demux needs the whole
  `movi`. Reading the whole (bounded) file is simplest and correct; the `idx1` index is *optional* and we
  do not require it (broken/absent `idx1` still demuxes by walking `movi` chunk headers — more robust).
  **Rejected:** an `idx1`-only demux — many real AVIs (and all streamed ones) omit/corrupt `idx1`.
- **Codec mapping:** video from BITMAPINFOHEADER `biCompression` 4CC (case-insensitive: XVID/DIVX/DX50/
  MP4V→mpeg4, MJPG→mjpeg, H264/AVC1/X264→h264, HEVC/HVC1→hevc, VP80/VP90→vp8/vp9, 0→rawvideo); audio
  from WAVEFORMATEX `wFormatTag`. Unknown → the lowercased 4CC / `0x%04x` tag (honest, never dropped).
- **Stream id ↔ track:** the `movi` chunk id's first 2 ASCII digits are the stream number (`00`,`01`,…);
  the suffix (`dc`/`db`/`wb`/`pc`/`tx`) is the data kind. We attribute a chunk to the stream whose
  declared `strh` type matches; `pc`(palette)/`tx`(text)/`ix##`(OpenDML index) chunks are skipped.
- **Timing:** stream sample N's PTS = N × `dwScale/dwRate` seconds → µs. For PCM audio (`dwSampleSize>0`),
  a "sample" is a block; ffmpeg packs many PCM samples per `wb` chunk, so audio PTS is accumulated by
  *bytes ÷ nBlockAlign × scale/rate* (sample-accurate) rather than chunk index. Video PTS = frame index
  × scale/rate (CBR cadence — AVI video is constant frame rate by construction).

## Edge cases (enumerated)

- Odd chunk sizes → padded to even (RIFF word alignment); a chunk straddling EOF (truncated) → stop, no
  crash. `JUNK`/`vprp`/`INFO`/`idx1` and unknown chunks inside `hdrl`/top-level → skipped. `LIST` recursion
  for `hdrl`→`strl`→(strh/strf) and the `movi` list.
- OpenDML 2.0: a second `RIFF('AVIX')` with more `movi` after the first; `dwTotalFrames` may be 0 (the real
  count is `dwLength`/the actual chunk count) → we trust the walked `movi` chunks, not just the header.
- `dmlh`/`indx`/`ix##` OpenDML super-index chunks → ignored (we walk `movi` directly).
- Video-only or audio-only AVI; >2 streams; a stream with `strh` but no `movi` data → an empty packet
  stream, still a valid track. `dwScale==0`/`dwRate==0` → guard against divide-by-zero (fps omitted).
- Not a RIFF/`AVI ` file, truncated header, zeroed `hdrl` → `InputError`/`demux-error`, never wrong output.
- demux `packets(badId)` → `demux-error`; aborted `signal` → `aborted`.

## Failure modes → typed errors

`InputError('unsupported-input')`: not `RIFF…AVI `, or a header too short to hold `avih`.
`MediaError('demux-error')`: a valid RIFF/AVI with no `strl`/decodable stream, or a bad `trackId`.
`CapabilityError('capability-miss')`: WebCodecs `Encoded*Chunk` absent (the packet seam).
`MediaError('aborted')` on signal. Never a silent wrong result.

## Test plan (strict structural oracle, real media)

Two committed real `.avi` (transcoded from the public-domain WPT `movie_5.mp4`; container bytes are
genuine AVI, content is real licensed media) + ffprobe ground truth as a can-fail oracle. Assert: RIFF/AVI
recognition; `avih` width/height/streams; per-stream codec (mjpeg/MJPG + pcm; mpeg4/XVID + mp3), dims
(160×120), fps (24), audio sampleRate/channels (16000/1), duration (1.000 / 1.083 ±1 frame); `movi`
chunk→stream attribution (video `00dc`, audio `01wb`); demux packet seam is a typed gap in node. Anti-cheat:
flipping the `biCompression` 4CC changes the reported codec (oracle can fail); a non-RIFF input rejects;
truncated `movi` survives. Validate: `bun run typecheck` + `bun test` on the AVI test file.
