# Golden references index

Checksum-pinned, committed oracle references baked from the verified real-media corpus
(`scripts/bake-goldens.ts`, `bun run bake-goldens`). The large media stays git-ignored under
`fixtures/media/`; **only these small goldens + `fixtures/manifest.json` are committed**
(BUILD_INSTRUCTIONS §6.1, docs/architecture/11). Every per-op golden is gated by a test that re-runs the
engine and asserts an exact match, and — where the unit admits — is **independently corroborated** by a
tool we did not write (so a golden can never be a self-confirming round-trip; doc 11 §5, ADR-085).

| Family | Path | Oracle (doc 11 §1) | Baked from | Independent corroboration | Gated by |
|---|---|---|---|---|---|
| corpus index | `corpus-index.json` | structural | manifest + sha256 re-verify | — | `src/test-support/corpus.test.ts` |
| golden-metadata | `metadata/<id>.json` | structural / metadata-exact | engine `probe` | ffprobe truth informs which fields are deferred | `src/drivers/mp4/golden-metadata.test.ts`, `corpus.test.ts` |
| audio-dsp | `dsp/<id>.json` | sample-exact | pow-free PCM transforms | exact IEEE-754 (deterministic) | `src/dsp/golden.test.ts` |
| **golden-packets** | `packets/<id>.json` | **bit-exact structural** (demux) | engine demuxer (`packetTable` / pure framers) | **ffprobe** `-show_packets` per-track count+bytes (baked-in `ffprobe` field) | `src/conformance/golden-packets.test.ts` |
| **decoded-frames-bitexact** | `decoded/<id>.json` | **bit-exact** (decode, force-software) | pure-TS FLAC + WAV/PCM decode | **ffmpeg** raw-PCM decode, byte-identical (`ffmpegCrossChecked`) | `src/conformance/decoded-bitexact.test.ts` |
| **decrypt cleartext twins** | `decrypt/*.json` (+ `*.bin`/`*.cenc.mp4`) | **decrypt-bitexact** | clear original (twin) | **openssl** (HLS AES-128 ciphertext) + **ffmpeg** (`cenc-aes-ctr` MP4) | `src/conformance/decrypt-twins.test.ts` |
| bench baselines | `bench/<name>.json` | perf regression | multi-sample benches | — (perf, not correctness) | `scripts/anti-cheat.ts` (no-degenerate-metric gate) |

## How the independent twins were produced (exact commands)

These are baked once by `scripts/bake-goldens.ts`; the tests then read the committed cache (no runtime
shell-out, no network). Key/KID/IV are fixed test material, not secrets.

```sh
# golden-packets corroboration (per fixture, per stream):
ffprobe -hide_banner -loglevel error -select_streams a:0 -show_packets -of csv=p=0 \
  -show_entries packet=size <fixture>

# decoded-frames-bitexact corroboration (FLAC, matching the native depth's wire layout):
ffmpeg -hide_banner -loglevel error -i <flac> -f s16le -acodec pcm_s16le -   # 16-bit (s8/s24le for 8/24-bit)

# decrypt HLS AES-128 twin (ciphertext from openssl, decrypted back to the committed plaintext):
openssl enc -aes-128-cbc -K 000102030405060708090a0b0c0d0e0f \
  -iv 00112233445566778899aabbccddeeff -in fixtures/media/sfx.adts -out decrypt/sfx.adts.aes128.bin

# decrypt CENC (cenc-aes-ctr) twin (encrypted MP4 from ffmpeg; engine decrypt must recover the clear audio):
ffmpeg -hide_banner -loglevel error -y -i fixtures/media/movie_5.mp4 -c copy \
  -encryption_scheme cenc-aes-ctr -encryption_key 000102030405060708090a0b0c0d0e0f \
  -encryption_kid 00112233445566778899aabbccddeeff decrypt/movie_5.mp4.cenc.mp4
```

## Deferred (documented honestly, not faked)

- **12-bit FLAC** decode: ffmpeg scales the 12-bit sample to s16 full-scale while we keep the literal
  value (a representation choice). Its golden is self-validated by FLAC's STREAMINFO MD5 (checked inside
  the decoder) and flagged `ffmpegCrossChecked:false`.
- **CENC *video* subsample twin** from ffmpeg: ffmpeg keeps the IDR keyframe's parameter-set NALs clear
  with a sample-0 boundary our decryptor splits differently; 119/120 video samples already match. The
  **audio** CENC twin (whole-sample AES-CTR) is committed and byte-exact. (Reported for follow-up.)
