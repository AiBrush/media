# AIFF / AIFF-C / CAF derived fixtures (committed)

Small, **real Apple-native** audio files for the AIFF (`src/drivers/aiff`) and CAF (`src/drivers/caf`)
container drivers (`BUILD_INSTRUCTIONS.md` §6.1). They are produced by macOS **CoreAudio `afconvert`**
from a single corpus WAV — genuine AIFF/AIFF-C/CAF bitstreams, not hand-crafted bytes — and kept tiny
(≈0.21 s) so they commit cheaply while still covering every byte-order / sample-format variant the
drivers must parse.

## Source

All six are transcodes of **`fixtures/media/sfx-pcm-s16.wav`** (a corpus file in `../../manifest.json`:
web-platform-tests `webcodecs/sfx-pcm-s16.wav`, **W3C 3-Clause BSD**, 48 kHz mono s16, sha256
`2f4ee43d…`). Regenerate with, e.g.:

```bash
afconvert -f AIFF -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx.aiff
afconvert -f AIFF -d BEI24 fixtures/media/sfx-pcm-s16.wav sfx-s24.aiff
afconvert -f AIFC -d BEF32 fixtures/media/sfx-pcm-s16.wav sfx-fl32.aifc   # AIFF-C 'fl32'
afconvert -f AIFC -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx-twos.aifc   # AIFF-C 'twos'
afconvert -f caff -d LEI16 fixtures/media/sfx-pcm-s16.wav sfx.caf         # CAF little-endian (Apple default)
afconvert -f caff -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx-be.caf      # CAF big-endian
afconvert -f caff -d LEF32 fixtures/media/sfx-pcm-s16.wav sfx-f32.caf     # CAF float32
afconvert -f caff -d  I8   fixtures/media/sfx-pcm-s16.wav sfx-u8.caf      # CAF signed 8-bit (honest miss)
```

## Files (ground truth = `afinfo <file>`)

| File | Container | `compressionType` / ASBD flags | Codec token | Channels | Rate | Bits | Endian |
|---|---|---|---|---|---|---|---|
| `sfx.aiff` | AIFF | `NONE` (uncompressed) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `sfx-s24.aiff` | AIFF | `NONE` | `pcm-s24be` | 1 | 48000 | 24 | BE |
| `sfx-fl32.aifc` | AIFF-C | `fl32` (BE float) | `pcm-f32` | 1 | 48000 | 32 | BE |
| `sfx-twos.aifc` | AIFF-C | `twos` (BE int PCM) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `sfx.caf` | CAF | `lpcm`, flags `0x2` (little-endian) | `pcm-s16` | 1 | 48000 | 16 | LE |
| `sfx-be.caf` | CAF | `lpcm`, flags `0x0` (big-endian) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `sfx-f32.caf` | CAF | `lpcm`, flags `0x3` (float + LE) | `pcm-f32` | 1 | 48000 | 32 | LE |
| `sfx-u8.caf` | CAF | `lpcm`, flags `0x2`, 8-bit (signed) | — (honest miss) | 1 | 48000 | 8 | LE |

`sfx-u8.caf` is a deliberate **negative** fixture: CoreAudio writes integer PCM as signed two's-complement
at every depth (`afinfo` reports "8-bit signed integer"), and the dsp's only 8-bit format is offset-binary
`u8`, so the driver raises a typed `CapabilityError` rather than a 128-off mis-decode.

License of the derived files follows the source: **W3C 3-Clause BSD** (a lossless PCM transcode of
openly-licensed test audio). `sha256` of each is recorded inline below (re-pin after regenerating).

```
a8962dbf9f16f2bd4d8b3ea77345556f1cb6b8b68907ea27a27cd5b366694d3a  sfx.aiff
c8f198f5d83a4cb0507553520dc7b3640c65fd250038378db831018c18529a17  sfx-s24.aiff
b60687476641731517cff04e8b5911f3cdd88703597ff1d6323151f853bda5e2  sfx-fl32.aifc
acde342a82df3e454a67515adb1c1a4597c71a3f8f20d547994c576dd1ef13ce  sfx-twos.aifc
5c35e967f1621951cdc2539abe5b0b35fab16bbf4a9e8fb9cdcc10ffef9812d5  sfx.caf
898535a5fae1ffa9fbff55acc74b1335f5ac3b42468cbca239c99b580d6c1b61  sfx-be.caf
34d6cce21c93b78f2cc48a134cbf7026b67443ceba2922c523380984b1eff3be  sfx-f32.caf
88310732aff63ca52a3b702e06726162ced0fa67cee0c81283479d41928da992  sfx-u8.caf
```

## What they exercise

`sfx.aiff`/`sfx-s24.aiff` cover the canonical big-endian AIFF `COMM`/`SSND` walk (incl. the 80-bit IEEE
extended sample rate) at two integer depths. `sfx-fl32.aifc`/`sfx-twos.aifc` cover the AIFF-C dialect
(`FVER` + extended `COMM` with a `compressionType`) for BE float and BE int. `sfx.caf`/`sfx-be.caf`
cover the CAF `caff`/`desc`(ASBD)/`data` walk with the format-flag endianness bit set both ways. The
tests assert probe metadata against `afinfo` and round-trip the SSND/`data` samples **byte-exact**; an
AIFF(BE)↔CAF(LE) cross-check confirms both byte orders decode to identical samples. The larger real
harness AIFF/CAF assets (`pcm_s16be.aiff`, `pcm_s24be.aiff`, `pcm_s16.caf` under
`../../../../media-test/media-browser-test/fixtures/media/`, with committed `*.meta.json` goldens) are
also read by direct path for an independent oracle.
