# aibrush-media examples

Build the package first so the package self-reference resolves to `dist/`:

```sh
bun run build
bun run vendor-wasm
```

Then run any example with Bun:

```sh
bun examples/probe.ts ./fixtures/media/movie_5.mp4
bun examples/convert.ts ./fixtures/media/movie_5.mp4 ./out.mp4
bun examples/trim.ts ./fixtures/media/movie_5.mp4 ./clip.mp4 1.5 4.0 keyframe
bun examples/mux.ts ./fixtures/media/movie_5.mp4 ./muxed.mp4
```

The scripts intentionally use the public `@aibrush/media` package entry. They do not import repo internals,
so they exercise the same surface a consumer gets after `bun run build`.
