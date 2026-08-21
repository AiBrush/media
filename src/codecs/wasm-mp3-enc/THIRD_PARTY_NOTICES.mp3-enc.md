# Third-party notices — `wasm-mp3-enc`

This codec tail redistributes the **LAME** MP3 encoder compiled to WebAssembly.

## LAME (libmp3lame)

- Project: LAME — the LAME Ain't an MP3 Encoder project
- Version: **3.100** (the version string the vendored `mp3_enc_wasm_bg.wasm` reports internally)
- Home: <https://lame.sourceforge.io/>
- Source: <https://sourceforge.net/projects/lame/files/lame/3.100/lame-3.100.tar.gz>
- Source SHA-256: `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`
- License: **LGPL-2.0-or-later** — LAME 3.100's own headers and `README` state the GNU **Library** General
  Public License, version 2, "or (at your option) any later version". The verbatim text LAME ships as
  `COPYING` is preserved here as `LICENSE.lame`
  (SHA-256 `bfe4a52dc4645385f356a8e83cc54216a293e3b6f1cb4f79f5fc0277abf937fd`).

LAME is **unmodified**. It is redistributed as a separately loaded, self-contained WebAssembly module
(`mp3_enc_wasm_bg.wasm`) that this package fetches same-origin at runtime — the WebAssembly analogue of
LAME's own "link to LAME as a separate library" guidance (`LICENSE` in the LAME distribution). Replacing it
with another build of LAME requires no change to this package: drop in a `.wasm` exporting the ABI
documented in `BUILD.md`, or hand `mp3-enc-core.js`'s init a `WebAssembly.Module`, raw bytes, or a URL.

## `wasm-media-encoders` (the build that produced the `.wasm`)

- Package: npm `wasm-media-encoders@0.7.0`
- Repository: <https://github.com/arseneyr/wasm-media-encoders>
- Tarball: <https://registry.npmjs.org/wasm-media-encoders/-/wasm-media-encoders-0.7.0.tgz>
- Tarball SHA-256: `1ffcadae8dd439253148dfc5e73dd1a0be89b61ba342886707d8b39123f26adc`
- License: **MIT**, preserved here as `LICENSE.wasm-media-encoders`

Only `package/wasm/mp3.wasm` is vendored (as `mp3_enc_wasm_bg.wasm`, SHA-256
`85e81719250b9a667b1258143f689dda70e3e57a7e7c29ab0b4cef65c8f6eb9a`, 132,999 bytes). **None** of the
package's JavaScript is used: `mp3-enc-core.js` is this repository's own hand-written loader, and every
encoding decision lives in `mp3-enc.ts`.

## Patents

MP3's patents expired worldwide in 2017 and the Fraunhofer/Technicolor licensing program was terminated
that year, so distributing an MP3 encoder no longer carries a royalty obligation. This does not waive the
LGPL obligations above.
