# wasm-vorbis-enc build recipe

This directory vendors the permissive Vorbis encoder tail used when Chromium has no native
`AudioEncoder` support for `codec: "vorbis"`.

## Source inputs

- libogg 1.3.6, BSD-3-Clause compatible Xiph license
  - URL: `https://ftp.osuosl.org/pub/xiph/releases/ogg/libogg-1.3.6.tar.gz`
  - SHA-256: `83e6704730683d004d20e21b8f7f55dcb3383cdf84c0daedf30bde175f774638`
- libvorbis 1.3.7, BSD-3-Clause compatible Xiph license
  - URL: `https://ftp.osuosl.org/pub/xiph/releases/vorbis/libvorbis-1.3.7.tar.xz`
  - SHA-256: `b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b`

Licenses are preserved in `LICENSE.libogg` and `LICENSE.libvorbis`.

## Rebuild

The current artifact was built with Homebrew Emscripten from a clean scratch directory:

```sh
mkdir -p /private/tmp/aibrush-vorbis-enc-build
cd /private/tmp/aibrush-vorbis-enc-build

curl -L -o libogg-1.3.6.tar.gz https://ftp.osuosl.org/pub/xiph/releases/ogg/libogg-1.3.6.tar.gz
printf '%s  %s\n' \
  83e6704730683d004d20e21b8f7f55dcb3383cdf84c0daedf30bde175f774638 \
  libogg-1.3.6.tar.gz | shasum -a 256 -c -
tar -xf libogg-1.3.6.tar.gz
cd libogg-1.3.6
emconfigure ./configure --host=wasm32-unknown-emscripten \
  --prefix=/private/tmp/aibrush-vorbis-enc-build/prefix \
  --disable-shared --enable-static
emmake make -j8
emmake make install

cd /private/tmp/aibrush-vorbis-enc-build
curl -L -o libvorbis-1.3.7.tar.xz https://ftp.osuosl.org/pub/xiph/releases/vorbis/libvorbis-1.3.7.tar.xz
printf '%s  %s\n' \
  b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b \
  libvorbis-1.3.7.tar.xz | shasum -a 256 -c -
tar -xf libvorbis-1.3.7.tar.xz
cd libvorbis-1.3.7
PKG_CONFIG_PATH=/private/tmp/aibrush-vorbis-enc-build/prefix/lib/pkgconfig \
  emconfigure ./configure \
  --prefix=/private/tmp/aibrush-vorbis-enc-build/prefix \
  --with-ogg=/private/tmp/aibrush-vorbis-enc-build/prefix \
  --disable-shared --enable-static
emmake make -j8
emmake make install

cd /Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media
emcc src/codecs/wasm-vorbis-enc/aibrush_vorbis_enc.c \
  /private/tmp/aibrush-vorbis-enc-build/prefix/lib/libvorbisenc.a \
  /private/tmp/aibrush-vorbis-enc-build/prefix/lib/libvorbis.a \
  /private/tmp/aibrush-vorbis-enc-build/prefix/lib/libogg.a \
  -I/private/tmp/aibrush-vorbis-enc-build/prefix/include \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sNO_EXIT_RUNTIME=1 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_ab_vorbis_create,_ab_vorbis_headers,_ab_vorbis_feed,_ab_vorbis_finish,_ab_vorbis_packet_count,_ab_vorbis_packet_data,_ab_vorbis_packet_bytes,_ab_vorbis_packet_granulepos,_ab_vorbis_packet_eos,_ab_vorbis_clear_packets,_ab_vorbis_destroy \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -o src/codecs/wasm-vorbis-enc/vorbis-enc-wasm.js
```

`vorbis-enc-wasm.js` is intentionally generated and ignored by Biome. The handwritten seam lives in
`vorbis-enc-core.js`, `vorbis-enc.ts`, and `wasm-vorbis-enc-driver.ts`.
