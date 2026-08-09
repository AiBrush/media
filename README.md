# @aibrush/media

`@aibrush/media` is a browser-first TypeScript media engine for inspecting, decoding, encoding,
converting, muxing, remuxing, trimming, and decrypting audio and video. Applications describe the
result they need; the engine selects an available browser, TypeScript, or WebAssembly implementation at
runtime.

## Install

```sh
npm install @aibrush/media
```

The package is ESM-only. Node.js 18 or newer is required for package tooling and server-side byte
operations. Browser codec and graphics support varies by browser and device, so applications should use
`canConvert()` for target preflight and handle `CapabilityError` at execution time.

## Quick start

```ts
import { createMedia } from '@aibrush/media';

const media = createMedia({ worker: true });

try {
  const info = await media.probe(file);
  console.info(info.container, info.durationSec, info.tracks);

  const output = await media
    .load(file)
    .video({ codec: 'vp9', height: 720, fit: 'contain' })
    .audio({ codec: 'opus', sampleRate: 48_000 })
    .to('webm')
    .blob();

  const url = URL.createObjectURL(output);
  video.src = url;
} finally {
  await media.dispose();
}
```

## Documentation

- [Documentation home](docs/README.md) — learning paths and reference map
- [Getting started](docs/getting-started.md) — installation, first conversion, progress, and cleanup
- [Inputs and outputs](docs/inputs-and-outputs.md) — files, URLs, streams, OPFS, and output sinks
- [Operations](docs/operations.md) — probe, convert, remux, trim, decode, mux, decrypt, and jobs
- [API reference](docs/api-reference.md) — exported functions, options, results, and package subpaths
- [Runtime and capabilities](docs/runtime-and-capabilities.md) — formats, codecs, workers, WASM, and preflight
- [Errors and resource ownership](docs/errors-and-lifecycle.md) — typed errors, cancellation, frames, and disposal
- [Driver authoring](docs/driver-authoring.md) — custom drivers and the `core` entry point
- [Development and release](docs/development.md) — repository commands and package verification

Runnable examples that import the published package surface are available in [`examples/`](examples/README.md).

## License

MIT. Bundled codec components retain their own licenses and attribution; see the `THIRD_PARTY_NOTICES`
and `BUILD.md` files under `src/codecs/wasm-*/`.
