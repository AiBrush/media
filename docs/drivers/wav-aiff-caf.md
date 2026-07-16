# WAV / AIFF / CAF Drivers (S27)

> Target spec for the three raw-PCM container drivers: RIFF/WAVE, AIFF/AIFF-C, and Apple CAF.
> This is the **best** design plus an honest delta against today's code. Owned code:
> `src/drivers/wav/*.ts`, `src/drivers/aiff/*.ts`, `src/drivers/caf/*.ts`.

## 1. Purpose & scope

This family demuxes, muxes, and converts the three **linear-PCM containers** the engine ships:

- **WAV** — RIFF/WAVE, little-endian, `fmt ` + `data` chunk walk (`src/drivers/wav/wav-driver.ts`, `src/drivers/wav/pcm.ts`).
- **AIFF / AIFF-C** — Electronic Arts IFF, big-endian `FORM…AIFF`/`AIFC`, `COMM` + `SSND` (`src/drivers/aiff/aiff.ts`, `src/drivers/aiff/aiff-driver.ts`).
- **CAF** — Apple Core Audio Format, big-endian `caff` header + typed chunks with signed-64-bit sizes, `desc` (ASBD) + `data` (`src/drivers/caf/caf.ts`, `src/drivers/caf/caf-driver.ts`).

The defining property: **PCM is not a WebCodecs codec.** There is no `AudioDecoder`/`AudioEncoder` for raw LPCM, so this family never touches the WebCodecs codec seam. Instead it flows through the pure-TS **audio-dsp path** (ADR-022): the container driver parses its own bytes and either (a) re-serializes raw PCM directly, or (b) decodes to canonical planar Float64 (`decodePcm`, `src/dsp/pcm.ts:142`), applies a `PcmTransform`, and re-encodes. The codec token is `pcm-u8`/`pcm-s8`/`pcm-s16`/`pcm-s16be`/`pcm-s24`/`pcm-f32`/… (`src/drivers/wav/wav-driver.ts:98`, `src/drivers/aiff/aiff.ts:234`, `src/drivers/caf/caf.ts:157`).

**Benchmark families served** (per `docs/architecture/COVERAGE.md`):
- **demux** — track facts + a byte-offset packet table without materializing payload (`demux/wav_s24`, `probe/pcm_s16be`).
- **mux** — author a legal container from raw PCM packets (`mux/pcm_s16_to_wav`, `mux/pcm_s24_to_wav`).
- **convert** — sample-format / endianness / channel / sample-rate / gain / fade / trim in the PCM domain (`audio-dsp/pcm_s16be_to_s16le`, `audio-dsp/pcm_s24be_to_s16le`, `audio-dsp/gain_half_f32`, `transcode/aac_to_pcm_wav_extract`, `trim/audio_wav_pcm_copy`).

These are containers the router should reclaim natively: of ffmpeg.wasm's WASM-tier wins, ~112 of 139 are container/demux/remux/probe/trim/PCM/mux glue a WebCodecs+TS engine reclaims without WASM (`measured-evidence.md`). PCM conversion is exactly that glue.

## 2. Spec & references

**Governing standards**

- **RIFF / WAVE** — Microsoft/IBM *Multimedia Programming Interface and Data Specifications 1.0* (RIFF) and the WAVE form; PCM/float layout in `WAVEFORMATEX` / `WAVE_FORMAT_EXTENSIBLE`.
  - RIFF/WAVE registration: [RFC 2361 — WAVE and AVI Codec Registries](https://www.rfc-editor.org/rfc/rfc2361)
  - WAVE_FORMAT_EXTENSIBLE (`0xFFFE`, SubFormat GUID): [Microsoft — Extensible Wave-Format Descriptors](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/extensible-wave-format-descriptors)
  - Broadcast Wave `bext`: [EBU Tech 3285](https://tech.ebu.ch/docs/tech/tech3285.pdf); RF64 (>4 GiB): [EBU Tech 3306](https://tech.ebu.ch/docs/tech/tech3306.pdf)
- **AIFF / AIFF-C** — Apple *Audio Interchange File Format AIFF-1.3* (1989) and the *AIFF-C* addendum (1991); IFF from EA's *"EA IFF 85" Standard for Interchange Format Files*. Sample rate is an **80-bit IEEE 754 extended-precision float** in `COMM`.
  - AIFF-1.3 / AIFF-C spec (archived): [Apple AIFF-1.3.pdf](https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/AIFF/Docs/AIFF-1.3.pdf), [AIFF-C.9.26.91.pdf](https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/AIFF/Docs/AIFF-C.9.26.91.pdf)
- **Apple CAF** — *Apple Core Audio Format Specification 1.0*. Chunk sizes are **signed 64-bit** big-endian; the final `data` chunk may declare `-1` ("to EOF"). Layout comes from the ASBD (`desc`).
  - [Apple — Core Audio Format Specification 1.0](https://developer.apple.com/library/archive/documentation/MusicAudio/Reference/CAFSpec/CAF_intro/CAF_intro.html)
- **IEEE 754** extended precision (the 80-bit `COMM` rate): [IEEE 754-2019](https://standards.ieee.org/ieee/754/6210/)

**OSS exemplar — ffmpeg PCM demuxers** (study & beat)

- WAV: [libavformat/wavdec.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/wavdec.c)
- AIFF: [libavformat/aiffdec.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/aiffdec.c) — `MAX_SIZE = 4096`; `size = (MAX_SIZE / block_align) * block_align` (4 KiB payload rounded down to whole interleaved frames). AIFF-C detected by `MKTAG('A','I','F','C')`; `compressionType` read as a 4cc in COMM.
- CAF: [libavformat/cafdec.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/cafdec.c) — `desc` validated as exactly 32 bytes; on `data`: `avio_skip(pb, 4) /* edit count */; data_size = size < 0 ? -1 : size - 4;`
- Generic raw PCM packetizer: [libavformat/pcm.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/pcm.c) — `ff_pcm_default_packet_size()` targets ~1/10 s (`PCM_DEMUX_TARGET_FPS = 10`): `nb_samples = clip(bitrate/8/10/block_align, 1, max); nb_samples = 1<<log2(nb_samples); return block_align * nb_samples;` — always block-aligned, a power-of-two frame count.

Where SOTA must **match** the exemplar: bit-exact PCM round-trips, byte-offset packet tables aligned to whole frames, big-endian 80-bit rate parsing, CAF `-1` size handling. Where SOTA must **beat** it: no WASM download for PCM (pure TS in-tier), bounded header probe (not a full-file scan), range-backed streaming decode with a fixed memory ceiling, and typed `CapabilityError`/`InputError` instead of `AVERROR_*` ints.

## 3. Target design

### Data model & seams

Three layers, cleanly separated:

1. **Pure PCM bridge** (`wav/pcm.ts`, `aiff/aiff.ts`, `caf/caf.ts`) — Node-validatable, no I/O. `parse*` reads the header into a layout struct; `read*Pcm` decodes samples to canonical planar Float64 (`PcmAudio`, `src/dsp/pcm.ts:21`); `write{Wav,Aiff,Caf}` serializes. The invariant oracle: `write*(read*(file), sourceFormat)` reproduces the sample payload **byte-exact** (the `decoded-audio-pcm` oracle). WAV writes a canonical 44-byte header (`src/drivers/wav/pcm.ts:123`); AIFF writes `FORM`/`COMM`(+`FVER` for AIFF-C)/`SSND` (`src/drivers/aiff/aiff.ts:295`); CAF writes `caff`/`desc`/`data` (`src/drivers/caf/caf.ts:205`).
2. **Container driver** (`wav-driver.ts`, `aiff-driver.ts`, `caf-driver.ts`) — implements the `ContainerDriver` seam (`src/contracts/driver.ts:411`): `probe`, `packetInfo`, `demux`, `transformPcm`, `decodePcmAudio(Stream)`, `decodePcmInterleavedStream`, `createMuxer`. It owns byte acquisition (`ByteSource`, `src/contracts/driver.ts:184`) and the streaming lifecycle.
3. **Convert fast paths** (WAV: `s16-resample.ts`, `format-convert.ts`, `f32-gain.ts`, `aiff-rewrite.ts`, `pcm-slice.ts`, `pcm-range-slice.ts`, `flac-s16.ts`; AIFF: `aiff-slice.ts`, `aiff-wav-rewrite.ts`) — narrow, allocation-lean routes gated behind a dynamic import (`wav/transform-dependencies.ts`) so raw probe/decode never pays for the general DSP graph.

The container↔codec `Packet` seam intentionally **raises `CapabilityError`** for all three: `demuxer.packets()` throws "PCM flows through the TS audio-dsp path (browser seam), not WebCodecs" (`src/drivers/wav/wav-driver.ts:887`, `src/drivers/aiff/aiff-driver.ts:262`, `src/drivers/caf/caf-driver.ts:74`). This is deliberate, not a gap: PCM has no `EncodedChunk`.

### Codec-token & 8-bit sign policy (correctness-critical)

Tokens carry endianness for AIFF/CAF big-endian integers (`pcm-s16be`) but LE integers and floats do not (`pcm-s16`, `pcm-f32`) (`src/drivers/aiff/aiff.ts:234`, `src/drivers/caf/caf.ts:157`). WAV emits LE tokens only (`src/drivers/wav/wav-driver.ts:97`).

**8-bit PCM sign differs by container** (ADR-075): WAV 8-bit is **unsigned** offset-binary (`pcm-u8`); AIFF and CoreAudio CAF integer LPCM are **signed** (`pcm-s8`, verified via `afinfo`). Treating either as the other shifts every sample by 128. Enforced structurally: `writeWav` rejects `s8` (`src/drivers/wav/pcm.ts:253`), `writeAiff`/`writeCaf` reject `u8` (`src/drivers/aiff/aiff.ts:300`, `src/drivers/caf/caf.ts:210`), and `resolvePcmSampleFormat` maps a source `s8`→`u8` for WAV and `u8`→`s8` for AIFF/CAF, otherwise throws a typed `CapabilityError` (`src/drivers/pcm-output.ts:27`).

### Capability routing (WebCodecs → GPU → WASM, miss-only)

For this family the ladder **collapses to native TS**, and that is the correct SOTA answer, not a shortcut:

- **WebCodecs**: N/A — no `AudioDecoder`/`AudioEncoder` config exists for raw LPCM. The router never constructs a coder here.
- **GPU**: N/A — sample-format/endian/gain math is memory-bound scalar work; a GPU round-trip loses to a tight typed-array loop (`gain_half_f32` closes at 10.235 ms / 488× realtime in pure TS, `measured-evidence.md`).
- **WASM**: **not downloaded**. PCM format conversion and the pure-TS band-limited resampler (Kaiser windowed-sinc, ADR-022) stay in-tier; heavy WASM (soxr, an OfflineAudioContext tail) is intentionally *not* a fallback. The one true miss — non-LPCM AIFF-C `compressionType` or CAF `formatId` — raises `CapabilityError('capability-miss', … needs a codec tier)` and hands off to the codec drivers (`src/drivers/aiff/aiff.ts:114`, `src/drivers/caf/caf.ts:53`). The developer never names a backend; the driver picks the fast path or the canonical path and fails loudly on a real miss.

Registration is **lazy**: WAV/AIFF/CAF load via `ContainerDriver` proxies on the first matching capability query (`src/drivers/default-container-registration.ts:50`, `:70`, `:75`; `src/drivers/defaults.ts:295`, `:351`, `:361`), keeping the eager kernel bundle small while MP4/WebM stay statically registered (`measured-evidence.md`, ADR-285/290).

### Edge cases (explicit treatment)

- **B-frames** — **N/A.** PCM is intra-only; every sample is independent, no inter-frame prediction, no reorder. `Packet.dtsUs` is always the PTS. The packet tables set `keyframe: true` on every row (`src/drivers/wav/wav-driver.ts:309`, `src/drivers/aiff/aiff-driver.ts:136`).
- **VFR** — **N/A.** LPCM is constant-rate by construction; one sample rate governs the whole `data`/`SSND` payload. Duration is `dataBytes / byteRate` (WAV, `src/drivers/wav/wav-driver.ts:268`) or `frames / sampleRate` (AIFF/CAF, `src/drivers/aiff/aiff.ts:252`, `src/drivers/caf/caf.ts:182`). There is no per-packet duration variance.
- **Seek** — trivial and exact: sample *N* lives at `dataOffset + N * blockAlign`. `packetInfo` exposes a byte-offset table so a consumer can range-read any window without a scan (`src/drivers/wav/wav-driver.ts:293`, `src/drivers/aiff/aiff-driver.ts:94`). The range-backed reader seeks by issuing a new `range()` window (`src/drivers/wav/wav-driver.ts:471`). **Target:** AIFF and CAF must expose the same byte-offset table and range-backed seek WAV already has (see delta).
- **Cancel** — every `await` boundary and hot loop re-checks `signal.aborted` and throws `MediaError('aborted', 'operation aborted')` (`src/drivers/wav/wav-driver.ts:761`, `src/drivers/wav/s16-resample.ts:131`, `src/drivers/wav/format-convert.ts:31`). Streams release their reader on `cancel()` (`src/drivers/wav/wav-driver.ts:792`, `src/drivers/wav/wav-copy-stream.ts:56`). **Target:** WAV's `readAll` is abort-aware (`src/drivers/wav/wav-driver.ts:410`); AIFF's (`src/drivers/aiff/aiff-driver.ts:64`) and CAF's (`src/drivers/caf/caf-driver.ts:35`) are **not** and must be (see delta).
- **Frame lifetime (`close()` exactly once)** — **this shard never constructs a `VideoFrame`/`AudioData`.** Drivers return plain `PcmAudio` (planar Float64), `InterleavedPcmF32` (`src/dsp/pcm.ts:29`), or `Uint8Array`. The engine (S02) wraps those into browser `AudioData` and owns `close()` exactly once (contract note, `src/contracts/driver.ts:478`). The correctness obligation here is the inverse: **never retain the source `ArrayBuffer`** beyond the stream (ADR-249 dropped externally-retained backing on `03.wav` from 8,238,493 → 334,237 bytes by nulling the chunk reader on terminal close, `measured-evidence.md`); the streaming reader releases its window on completion/cancel (`src/drivers/wav/wav-driver.ts:752`).
- **Backpressure** — WAV's streaming decode and copy paths are pull-driven with `highWaterMark: 0`, so no chunk is produced until the consumer pulls (`src/drivers/wav/wav-driver.ts:797`, `src/drivers/wav/wav-copy-stream.ts:60`), and each chunk is capped at `WAV_PACKET_FRAMES = 4096` frames (`src/drivers/wav/wav-driver.ts:84`, `:749`) — larger chunks are rejected because they change the public frame-digest truth (ADR-249). **Target:** AIFF and CAF `transformPcm` currently enqueue the entire output in a single `start()` chunk (`src/drivers/aiff/aiff-driver.ts:308`, `src/drivers/caf/caf-driver.ts:95`) — no backpressure; they must move to the WAV pull model (see delta).

### Memory & probe discipline (target)

- **Bounded probe.** WAV reads a 128-byte head for local sources and 16 KiB for URL/element sources (`src/drivers/wav/wav-driver.ts:80`, `:171`), parses `fmt `+`data` synchronously, and only falls back to a sparse declared-offset walk (≤8 windows, `WAV_PROBE_MAX_SPARSE_WINDOWS`) or a 64 KiB read when metadata precedes `data` (`src/drivers/wav/wav-driver.ts:185`, `:864`). It never scans a multi-hundred-MB payload (`measured-evidence.md`, ADR-311: baked WAV profile issues only `bytes=0-127`). AIFF probes a 64-byte head with a single 64 KiB fallback (`src/drivers/aiff/aiff-driver.ts:242`). **CAF probes by reading the whole file** (`src/drivers/caf/caf-driver.ts:61`) — a defect (see delta).
- **Range-backed streaming decode** keeps one ~1 MiB window (`WAV_DECODE_RANGE_BYTES`, `src/drivers/wav/wav-driver.ts:85`); range-less sources use a sequential pull cursor (ADR-277: median peak on `03.wav` cut from 18.4 MB → 10.6 MB, one source allocation, `measured-evidence.md`). `decodePcmAudioStream` reads one 64 KiB prefix so header + first PCM chunk share one round trip (ADR-226, `src/drivers/wav/wav-driver.ts:1003`).

## 4. Current state

### WAV — `src/drivers/wav/` (16 files; `wav-driver.ts` is the god-file, 1081 lines)

- `wav-driver.ts` — the `WavDriver` object plus, inlined in one file: the RIFF parser (`parseWavHeader`/`parseFormat`/`pcmCodec`/`pcmSampleFormat`, `:98`–`:164`), the sparse probe reader (`:185`), a range-backed chunk reader (`:471`), a sequential byte cursor + decode (`:535`, `:653`), the decoded/interleaved chunk streams (`:737`), and the URL packet-info helper with its **module-global cache** `wavPacketInfoPrefixCache` (`:95`, 64 entries / 60 s TTL). `probe` `:837`, `demux` `:881`, `packetInfo` `:897`, `transformPcm` `:912`, `decodePcmAudio` `:983`, `decodePcmAudioStream` `:992`, `decodePcmInterleavedStream` `:1026`, `createMuxer` `:1068`, `validatesPcmTrim: true` `:836`.
- `pcm.ts` — a **second, independent** RIFF/WAVE parser: `parseWavPcmData`/`parseFmt`/`sampleFormat` (`:31`–`:110`), `readWavPcm` `:113`, the canonical `writeWavHeader` `:123`, `writeWav` (rejects `s8`, `:253`), and the copy-plan helpers `planWavPcmCopy` `:192` / `rewriteWavPcmCopy` `:223`.
- Convert fast paths: `s16-resample.ts` (cached rational polyphase FIR, 6 zero-crossings β=8.6, `FAST_BANK_CACHE` module-global `:31`), `format-convert.ts` (s16/s24/f32 → s16/f32, `:136`), `f32-gain.ts` (`:75`), `aiff-rewrite.ts` (WAV→AIFF-BE byte-swap, `:102`, with its own `writePlainAiffHeader` `:43`), `flac-s16.ts` (WAV/s16 → verbatim FLAC, `:49`), `pcm-slice.ts` (`planByteSlice`/`slice` `:80`), `pcm-range-slice.ts` (range-window trim ≥1 MiB, `:37`), `wav-copy-stream.ts` (pull-driven copy `:7`), `wav-mux.ts` (`WavMuxer` `:52`), `url-trim.ts` (URL trim + **module-global** `wavTrimUrlByteCache` `:23`), `transform-dependencies.ts` (dynamic-import boundary `:1`).

### AIFF — `src/drivers/aiff/` (3 non-test files)

- `aiff.ts` — the pure bridge: `readExtendedFloat80` `:58` / `writeExtendedFloat80` `:69`, `formatFromCompression` (`NONE`/`twos`/`in16`/`in24`/`in32`→BE, `sowt`/`lpcm`→LE, `fl32`/`fl64`→float-BE, else `CapabilityError`, `:94`), `locate` (COMM/SSND, `:176`), `parseAiff` `:242`, `readAiffPcm` `:257`, `writeAiff` (rejects `u8`, forces AIFC for float/LE, writes a Pascal name `'aibrush-media'`, `:295`).
- `aiff-driver.ts` — `AiffDriver`: `probe` `:240`, `demux` `:257`, `packetInfo` `:272` (4096-**byte** target packets, `:36`/`:125`), `transformPcm` `:285`, `decodePcmAudio` `:315`, `createMuxer`→`rejectRawPcmChunkMux` `:320`. Module-global `aiffPacketInfoPrefixCache` `:53`; `readHead`/`readAll` **not abort-aware** (`:55`, `:64`). **No** `decodePcmAudioStream`, `decodePcmInterleavedStream`, or `validatesPcmTrim`.
- `aiff-slice.ts` — `trySliceAiffPcm` (AIFF-only, BE, s16/s24/s32, `:96`) with a `writePlainAiffHeader` (`:69`) that is **byte-identical** to `wav/aiff-rewrite.ts:43`. `aiff-wav-rewrite.ts` — `rewriteAiffPcmToWav` (AIFF→WAV, s24→s16 narrow, declines `s8`, `:20`).

### CAF — `src/drivers/caf/` (2 non-test files)

- `caf.ts` — the pure bridge: `formatFromAsbd` (flags `FLAG_FLOAT=0x1`/`FLAG_LITTLE_ENDIAN=0x2`, `lpcm` only, `:52`), `getInt64` (signed-64, `:75`), `cafChunks` (no even-padding; `-1`→last chunk, `:86`), `parseDesc` (`:98`), `locate` (`desc`/`data`, `mEditCount`+4, `-1`→EOF, `:113`), `parseCaf` `:171`, `readCafPcm` `:187`, `writeCaf` (rejects `u8`, minimal `caff`+`desc`+`data`, `:205`).
- `caf-driver.ts` — `CafDriver`: `readAll` **reads the whole file, not abort-aware** (`:35`); **no `probe`** (falls back to `demux` which reads the whole file, `:61`); `transformPcm` (`:84`, **no trim/slice fast path**); `decodePcmAudio` `:102`; `createMuxer`→`rejectRawPcmChunkMux` `:107`. **No** `packetInfo`, `decodePcmAudioStream`, `decodePcmInterleavedStream`, or `validatesPcmTrim`.

### Smells (ranked)

1. **`wav-driver.ts` is a 1081-line god-file** mixing parsing, three reader strategies, streaming, and a URL cache — while the *transform* concerns were correctly split into small files. The reader/probe/packet-info concerns were not.
2. **Two independent RIFF/WAVE parsers** with duplicated `WAVE_FORMAT_EXTENSIBLE` and even-pad logic: `wav-driver.ts:135` (`parseWavHeader`) vs `pcm.ts:81` (`parseWavPcmData`); duplicated format-tag→`SampleFormat` maps at `wav-driver.ts:104` vs `pcm.ts:31`. They can drift.
3. **Module-global mutable caches** in the driver layer: `wavPacketInfoPrefixCache` (`wav-driver.ts:95`), `aiffPacketInfoPrefixCache` (`aiff-driver.ts:53`), `wavTrimUrlByteCache` (`url-trim.ts:23`), `FAST_BANK_CACHE` (`s16-resample.ts:31`). Process-lifetime state living beside pure driver logic.
4. **Capability/layering leak:** `wavPacketInfoFromUrl` (`wav-driver.ts:360`), `aiffPacketInfoFromUrl` (`aiff-driver.ts:193`), and `wavTrimFromUrl` (`url-trim.ts:98`) call `fromURL` directly (`src/sources/source.ts`), doing their own source acquisition + caching inside the driver — the source/probe layer (S06) should own that.
5. **CAF and AIFF are second-class**: CAF has no bounded probe, no packet table, no streaming decode, no trim; AIFF has no streaming decode and no `validatesPcmTrim`. Only WAV is complete.
6. **Duplicated I/O helpers**: `readAll`/`readHead`/`byteStream` re-implemented in `wav-driver.ts`, `aiff-driver.ts`, `caf-driver.ts`, `pcm-range-slice.ts`, `url-trim.ts` — five copies, while the `ByteSource.readAll?()` contract hook (`src/contracts/driver.ts:189`) exists and is unused.
7. **Two byte-identical `writePlainAiffHeader`** (`aiff/aiff-slice.ts:69`, `wav/aiff-rewrite.ts:43`) and a third AIFF writer in `aiff.ts:295`.
8. **Inconsistent packet granularity**: WAV = 4096-**frame** rows (`wav-driver.ts:299`); AIFF = 4096-**byte** rows (`aiff-driver.ts:125`). Neither matches ffmpeg's ~0.1 s power-of-two policy, and the AIFF comment claiming to match "FFmpeg's PCM demuxers" only matches `aiffdec.c`, not `pcm.c`/`wavdec.c`.

## 5. Delta / punch-list (ordered)

1. **Give CAF a bounded probe + packet table.**
   Add `CafDriver.probe` reading only enough head to locate `desc` (+`data` header), and `CafDriver.packetInfo` emitting a byte-offset table like AIFF. Today `demux` reads the whole file (`src/drivers/caf/caf-driver.ts:61`).
   *Acceptance:* a probe on a large CAF issues a bounded range (assert bytes read ≪ file size), and the `demux`/CAF packet-table oracle matches ffprobe frame count/first-PTS-zero on `sfx-*.caf` fixtures. A `-1`-sized trailing `data` chunk still probes correct duration (`src/drivers/caf/caf.ts:131`).

2. **Streaming decode for AIFF and CAF.**
   Implement `decodePcmAudioStream` + `decodePcmInterleavedStream` for AIFF (`aiff-driver.ts`) and CAF (`caf-driver.ts`) mirroring `wav-driver.ts:992`/`:1026` (range-backed 1 MiB window + range-less sequential cursor), so they stop materializing the whole file in `decodePcmAudio` (`src/drivers/aiff/aiff-driver.ts:315`, `src/drivers/caf/caf-driver.ts:102`).
   *Acceptance:* range-less AIFF/CAF decode returns identical frames/checksum to the whole-file path with a bounded median peak (assert ≤ one source allocation, per ADR-277); each emitted chunk ≤ 4096 frames.

3. **Make AIFF/CAF `transformPcm` respect backpressure.**
   Replace the single-`start()`-enqueue (`src/drivers/aiff/aiff-driver.ts:308`, `src/drivers/caf/caf-driver.ts:95`) with the pull-driven `highWaterMark: 0` stream used by WAV (`src/drivers/wav/wav-driver.ts:797`).
   *Acceptance:* a slow consumer causes ≥2 `pull`s and no eager full-output allocation before the first pull (assert enqueue count / RSS ceiling).

4. **Thread `signal` through every `readAll`.**
   AIFF (`src/drivers/aiff/aiff-driver.ts:64`) and CAF (`src/drivers/caf/caf-driver.ts:35`) `readAll` ignore the abort signal and never cancel the source reader mid-drain; adopt WAV's abort-aware drain (`src/drivers/wav/wav-driver.ts:410`).
   *Acceptance:* aborting a large AIFF/CAF `transformPcm` rejects with `MediaError('aborted')` promptly and the source `ReadableStreamDefaultReader.cancel()` is observed.

5. **Add PCM-native trim to AIFF (finish) and CAF (new); set `validatesPcmTrim`.**
   AIFF has `trySliceAiffPcm` but the driver never sets `validatesPcmTrim`; CAF has no slice path. Wire both `timeBounds` byte-slice paths through `transformPcm` and set `validatesPcmTrim: true` (contract `src/contracts/driver.ts:460`) as WAV does (`src/drivers/wav/wav-driver.ts:836`).
   *Acceptance:* `trim/audio_aiff_pcm_copy` and a new `trim/audio_caf_pcm_copy` produce frame-exact byte slices (`round(sec*rate)` frame math, `src/drivers/wav/pcm-slice.ts:51`) and the engine skips its generic duration demux.

6. **Unify the two RIFF/WAVE parsers.**
   Collapse `wav-driver.ts` `parseWavHeader`/`parseFormat`/format maps (`:120`–`:164`) into the `pcm.ts` `parseWavPcmData`/`parseFmt`/`sampleFormat` family (`:31`–`:110`) (or vice-versa), exposing one parser that returns both the packet-info layout and the copy-plan.
   *Acceptance:* a property test over the WAV corpus asserts both entry points yield identical `{codec, channels, sampleRate, dataOffset, dataSize}`; deleting one parser leaves the suite green.

7. **Reconcile packet-table granularity across the family.**
   Pick one policy — the recommendation is a **byte-target** rounded down to whole frames (matches `aiffdec.c` `MAX_SIZE=4096`) — and apply it to WAV (today 4096 **frames**, `src/drivers/wav/wav-driver.ts:84`/`:299`), AIFF (`:36`/`:125`), and CAF (new). Fix the AIFF comment that over-claims a match to all of "FFmpeg's PCM demuxers" (`src/drivers/aiff/aiff-driver.ts:121`).
   *Acceptance:* one shared `packetFrames(blockAlign)` helper; goldens updated so mono s16 = 2048 frames/packet, stereo s16 = 1024, mono s24 = 1365 (4095 bytes), consistent for all three containers. If the `demux/wav_s24` golden (4096-frame rows, `measured-evidence.md`) must stay, document the exception explicitly.

8. **De-duplicate `writePlainAiffHeader` and the AIFF header writers.**
   `aiff/aiff-slice.ts:69` and `wav/aiff-rewrite.ts:43` are byte-identical; export one from `aiff/aiff.ts`.
   *Acceptance:* one 54-byte writer; a byte-parity test against `writeAiff`'s COMM/SSND framing; both call sites import it.

9. **Consolidate `readAll`/`readHead`/`byteStream` onto the `ByteSource` seam.**
   Five copies (`wav-driver.ts:397`/`:410`, `aiff-driver.ts:55`/`:64`, `caf-driver.ts:35`, `pcm-range-slice.ts:17`, `url-trim.ts:25`) → one abort-aware helper that prefers `src.readAll?()` (`src/contracts/driver.ts:189`) when present.
   *Acceptance:* a single helper module; drivers import it; the unused `readAll` contract hook is exercised by at least one source implementation.

10. **Move URL fast-path helpers + caches out of the driver layer.**
    Relocate `wavPacketInfoFromUrl`/`aiffPacketInfoFromUrl`/`wavTrimFromUrl` and their module-global caches (`wav-driver.ts:95`/`:360`, `aiff-driver.ts:53`/`:193`, `url-trim.ts:23`/`:98`) behind a source/probe-cache seam (S06), so the driver never imports `sources/source.ts` directly. Align the cache budget with ADR-261 (8 MiB total-byte LRU, raw input bytes only).
    *Acceptance:* `grep -L "sources/source" src/drivers/{wav,aiff,caf}/*.ts` shows the driver files no longer import `fromURL`; cache behavior tests move with the code; `demux/wav_s24` cached-prefix win (0.210 ms, `measured-evidence.md`) is preserved.

11. **Split the `wav-driver.ts` god-file.**
    Extract `wav-probe.ts` (sparse/bounded probe, `:171`–`:252`, `:837`), `wav-pcm-stream.ts` (range + sequential readers and chunk streams, `:471`–`:799`), and `wav-packet-info.ts` (`:293`–`:395`), leaving `wav-driver.ts` as a thin `ContainerDriver` object.
    *Acceptance:* `wav-driver.ts` ≤ ~300 lines; each extracted module has its own unit test; the eager kernel/closure byte budgets stay within their ceilings (`measured-evidence.md`, eager ≤ 50 KiB, first-op closure ≤ 256 KiB).

12. **RF64 / BW64 (> 4 GiB) support decision.**
    Both WAV parsers read a `u32` `data` size and clamp to file length (`src/drivers/wav/pcm.ts:100`, `wav-driver.ts:155`); an RF64 `ds64` chunk with a 64-bit size is unhandled, so a > 4 GiB WAV reports truncated/`0xFFFFFFFF` duration. Add `ds64` parsing or emit a typed `InputError`.
    *Acceptance:* an RF64 fixture either probes the correct duration (ffmpeg parity) or fails with `InputError('unsupported-input', 'RF64 …')` — never a silently wrong duration.

13. **RIFX / big-endian WAV decision.**
    `pcmCodec` emits LE tokens only and the parser assumes LE (`src/drivers/wav/wav-driver.ts:97`, `pcm.ts:81`); a `RIFX` file would be misidentified as "not a RIFF/WAVE file". Decide: parse `RIFX` (BE) or raise a typed miss.
    *Acceptance:* a `RIFX` fixture parses correctly or raises `InputError`/`CapabilityError` — asserted, not misparsed.

## 6. Open questions (seed `docs/decisions/`)

1. **Canonical packet granularity.** Frames vs bytes vs ffmpeg's ~0.1 s power-of-two (`pcm.c` `ff_pcm_default_packet_size`)? Decision fixes item 5-delta goldens and whether the `demux/wav_s24` 4096-frame golden is grandfathered.
2. **RF64/BW64 scope.** Support > 4 GiB WAV (EBU Tech 3306) natively, or typed miss? Affects long-form recording ingestion.
3. **RIFX / WAV-BE scope.** Parse big-endian WAV, or leave it a typed miss? (Distinct from AIFF/CAF BE, which are supported.)
4. **AIFF-C `lpcm` compressionType.** `formatFromCompression` maps `lpcm`→little-endian (`src/drivers/aiff/aiff.ts:106`), but `lpcm` is a CoreAudio/CAF format id, not a spec'd AIFF-C `compressionType` — `UNVERIFIED: real AIFF-C files use 'lpcm'`. Keep for robustness or drop? Needs a real-file survey.
5. **URL fast-path caches vs a unified source cache.** Should driver-owned caches (items 3, 10-smell) be replaced entirely by the ADR-261 source-byte LRU, or do per-op prefix caches (packet-info, trim) earn their keep? The measured wins (`demux/wav_s24` 0.210 ms; `trim/audio_wav_pcm_copy` 0.595 ms warm, `measured-evidence.md`) must survive the move.
6. **WAV ancillary chunks (`bext`, `cue `, `LIST`/`INFO`, `fact`).** The chunk walk skips everything but `fmt `/`data`. Metadata rewrite is owned by S20, but decode/convert should preserve or intentionally drop these — decide the passthrough contract for `convert` outputs.
7. **CAF variable-packet / `pakt` chunk.** Out of scope while PCM-only (`framesPerPacket=1`), but if a compressed CAF ever routes here the `pakt` table is required — confirm the boundary with the codec drivers (S28/S31).
