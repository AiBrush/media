# Image probe fixtures — real media + provenance

These are the strict-oracle corpus for `src/codecs/image/probe.test.ts`. Ground-truth dimensions and the
animated-GIF frame count come from **independent tools** (macOS `sips -g pixelWidth/pixelHeight`,
`ffprobe -count_frames`), never from our own probe — so the validation oracle can genuinely fail.

| file | format | source | truth (W×H, frames) |
|------|--------|--------|---------------------|
| `test.png`  | PNG  | https://httpbingo.org/image/png  | 100×100, 1 |
| `test.jpeg` | JPEG | https://httpbingo.org/image/jpeg | 239×178, 1 |
| `test.webp` | WebP | https://httpbingo.org/image/webp | 274×367, 1 |
| `anim2.gif` | GIF (animated) | https://upload.wikimedia.org/wikipedia/commons/d/d3/Newtons_cradle_animation_book_2.gif | 480×360, **36 frames** |
| `test.avif` | AVIF | OS-encoded (`sips -s format avif`) from `test.png` — a genuine libavif/AppleAVIF bitstream | 100×100, 1 |

All five are real-format bitstreams (downloaded, or OS-encoded by a real codec — never hand-forged). The
decode path is browser-only (`ImageDecoder`) and is exercised by the 558-feature harness, not here.
