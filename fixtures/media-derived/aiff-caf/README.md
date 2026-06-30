# AIFF / AIFF-C / CAF derived fixtures (committed)

Small, **real Apple-native** audio files for the AIFF (`src/drivers/aiff`) and CAF (`src/drivers/caf`)
container drivers (`BUILD_INSTRUCTIONS.md` §6.1). They are produced by macOS **CoreAudio `afconvert`**
from committed corpus WAVs — genuine AIFF/AIFF-C/CAF bitstreams, not hand-crafted bytes — and kept tiny
while still covering every byte-order / sample-format variant the drivers must parse.

## Source

The original eight are transcodes of **`fixtures/media/sfx-pcm-s16.wav`** (a corpus file in
`../../manifest.json`: web-platform-tests `webcodecs/sfx-pcm-s16.wav`, **W3C 3-Clause BSD**, 48 kHz mono
s16, sha256 `2f4ee43d…`). `stereo.aiff` and `stereo.caf` are transcodes of
**`fixtures/media/stereo-48000.wav`** (Chromium `media/test/data/stereo_48000.wav`, **BSD-3-Clause**,
48 kHz stereo s16, sha256 `facd5fe…`). Regenerate with, e.g.:

```bash
afconvert -f AIFF -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx.aiff
afconvert -f AIFF -d BEI24 fixtures/media/sfx-pcm-s16.wav sfx-s24.aiff
afconvert -f AIFC -d BEF32 fixtures/media/sfx-pcm-s16.wav sfx-fl32.aifc   # AIFF-C 'fl32'
afconvert -f AIFC -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx-twos.aifc   # AIFF-C 'twos'
afconvert -f caff -d LEI16 fixtures/media/sfx-pcm-s16.wav sfx.caf         # CAF little-endian (Apple default)
afconvert -f caff -d BEI16 fixtures/media/sfx-pcm-s16.wav sfx-be.caf      # CAF big-endian
afconvert -f caff -d LEF32 fixtures/media/sfx-pcm-s16.wav sfx-f32.caf     # CAF float32
afconvert -f caff -d  I8   fixtures/media/sfx-pcm-s16.wav sfx-u8.caf      # CAF signed 8-bit
afconvert -f AIFF -d BEI16 fixtures/media/stereo-48000.wav stereo.aiff    # stereo AIFF
afconvert -f caff -d LEI16 fixtures/media/stereo-48000.wav stereo.caf     # stereo CAF
```

## Files (ground truth = `afinfo <file>`)

| File | Container | `compressionType` / ASBD flags | Codec token | Channels | Rate | Bits | Endian |
|---|---|---|---|---|---|---|---|
| `sfx.aiff` | AIFF | `NONE` (uncompressed) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `sfx-s24.aiff` | AIFF | `NONE` | `pcm-s24be` | 1 | 48000 | 24 | BE |
| `sfx-fl32.aifc` | AIFF-C | `fl32` (BE float) | `pcm-f32` | 1 | 48000 | 32 | BE |
| `sfx-twos.aifc` | AIFF-C | `twos` (BE int PCM) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `stereo.aiff` | AIFF | `NONE` (uncompressed) | `pcm-s16be` | 2 | 48000 | 16 | BE |
| `sfx.caf` | CAF | `lpcm`, flags `0x2` (little-endian) | `pcm-s16` | 1 | 48000 | 16 | LE |
| `sfx-be.caf` | CAF | `lpcm`, flags `0x0` (big-endian) | `pcm-s16be` | 1 | 48000 | 16 | BE |
| `sfx-f32.caf` | CAF | `lpcm`, flags `0x3` (float + LE) | `pcm-f32` | 1 | 48000 | 32 | LE |
| `sfx-u8.caf` | CAF | `lpcm`, flags `0x2`, 8-bit (signed) | `pcm-s8` | 1 | 48000 | 8 | LE |
| `stereo.caf` | CAF | `lpcm`, flags `0x2` (little-endian) | `pcm-s16` | 2 | 48000 | 16 | LE |

`sfx-u8.caf` is deliberately named after the `afconvert -d I8` source command, but CoreAudio writes
integer PCM as signed two's-complement at every depth (`afinfo` reports "8-bit signed integer"). It is
therefore a positive `pcm-s8` fixture, distinct from WAV's offset-binary `pcm-u8`.

License of each derived file follows its source: **W3C 3-Clause BSD** for the `sfx-*` set and
**BSD-3-Clause** for the `stereo.*` set (lossless PCM transcodes of openly licensed test audio).
`sha256` of each is recorded inline below (re-pin after regenerating).

```
a8962dbf9f16f2bd4d8b3ea77345556f1cb6b8b68907ea27a27cd5b366694d3a  sfx.aiff
c8f198f5d83a4cb0507553520dc7b3640c65fd250038378db831018c18529a17  sfx-s24.aiff
b60687476641731517cff04e8b5911f3cdd88703597ff1d6323151f853bda5e2  sfx-fl32.aifc
acde342a82df3e454a67515adb1c1a4597c71a3f8f20d547994c576dd1ef13ce  sfx-twos.aifc
73fad51ac88b78f54179ef54493a0b5eeedcb22a8e23ea092d4a27419bc15260  stereo.aiff
5c35e967f1621951cdc2539abe5b0b35fab16bbf4a9e8fb9cdcc10ffef9812d5  sfx.caf
898535a5fae1ffa9fbff55acc74b1335f5ac3b42468cbca239c99b580d6c1b61  sfx-be.caf
34d6cce21c93b78f2cc48a134cbf7026b67443ceba2922c523380984b1eff3be  sfx-f32.caf
88310732aff63ca52a3b702e06726162ced0fa67cee0c81283479d41928da992  sfx-u8.caf
12f4433871b878bffe00adaa390b1eb507c46859e87eada743a9586b82c2ff95  stereo.caf
```

## What they exercise

`sfx.aiff`/`sfx-s24.aiff` cover the canonical big-endian AIFF `COMM`/`SSND` walk (incl. the 80-bit IEEE
extended sample rate) at two integer depths. `sfx-fl32.aifc`/`sfx-twos.aifc` cover the AIFF-C dialect
(`FVER` + extended `COMM` with a `compressionType`) for BE float and BE int. `sfx.caf`/`sfx-be.caf`
cover the CAF `caff`/`desc`(ASBD)/`data` walk with the format-flag endianness bit set both ways.
`stereo.aiff`/`stereo.caf` add a second real source and 2-channel PCM coverage. The tests assert probe
metadata against `afinfo` and round-trip the SSND/`data` samples **byte-exact**; an AIFF(BE)↔CAF(LE)
cross-check confirms both byte orders decode to identical samples. The larger real harness AIFF/CAF
assets (`pcm_s16be.aiff`, `pcm_s24be.aiff`, `pcm_s16.caf` under
`../../../../media-test/media-browser-test/fixtures/media/`, with committed `*.meta.json` goldens) are
also read by direct path for an independent oracle.
