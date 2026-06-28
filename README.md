# aibrush-media

`@aibrush/media` is a browser-first media engine with a flat, intent-only API. You ask for work such as
`probe`, `convert`, `trim`, or `mux`; the engine chooses the best available route internally
(WebCodecs -> GPU -> WASM -> TypeScript) and raises typed errors when the runtime cannot satisfy the job.

## Quickstart

Install and build the package before running the local examples:

```sh
bun install
bun run build
bun run vendor-wasm
```

In an app, import the package entry and call the operation you need:

```ts
import { convert, probe, trim } from '@aibrush/media';

const info = await probe(file);
const mp4 = await convert(file, {
  to: 'mp4',
  video: { codec: 'h264', height: 720 },
  audio: { codec: 'aac' },
  faststart: true,
});
const clip = await trim(file, { start: 1.5, end: 4.0, mode: 'keyframe' });
```

All async operations return cancellable promises:

```ts
const controller = new AbortController();
const job = convert(file, { to: 'mp4' }, { signal: controller.signal });

controller.abort();
job.cancel();
```

## Common Tasks

Probe metadata without decoding the whole file:

```ts
import { probe } from '@aibrush/media';

const info = await probe(file);
console.log(info.container, info.durationSec, info.tracks);
```

Convert or transcode to an MP4 target:

```ts
import { convert } from '@aibrush/media';

const output = await convert(file, {
  to: 'mp4',
  video: { codec: 'h264', height: 720, fit: 'contain' },
  audio: { codec: 'aac', sampleRate: 48_000 },
  faststart: true,
});
```

Change frame rate, preserve VPx alpha, or write container metadata with the same intent-only surface:

```ts
import { convert, remux } from '@aibrush/media';

const cfr = await convert(file, {
  to: 'mp4',
  video: { codec: 'h264', fps: 30 },
  audio: { codec: 'aac' },
});

const alphaWebm = await convert(file, {
  to: 'webm',
  video: { codec: 'vp9', alpha: 'keep' },
  audio: { codec: 'vorbis' },
});

const tagged = await remux(file, {
  to: 'mp4',
  tags: { title: 'Review cut', artist: 'aibrush-media' },
});
```

Trim a clip on keyframes for a fast stream-copy edit:

```ts
import { trim } from '@aibrush/media';

const clip = await trim(file, {
  start: 10,
  end: 20,
  mode: 'keyframe',
});
```

Mux explicit packet streams after demuxing:

```ts
import { createMedia } from '@aibrush/media';
import type { PacketStreams } from '@aibrush/media';

const media = createMedia();
const demuxed = await media.demux(file);

try {
  const video = demuxed.tracks.find((track) => track.mediaType === 'video');
  const audio = demuxed.tracks.find((track) => track.mediaType === 'audio');
  const streams: PacketStreams = {};

  if (video) streams.video = { track: video, packets: demuxed.packets(video.id) };
  if (audio) streams.audio = { track: audio, packets: demuxed.packets(audio.id) };

  const output = await media.mux(streams, { container: 'mp4', faststart: true });
} finally {
  await demuxed.close();
}
```

## Runnable Examples

The `examples/` directory contains complete scripts for the same common tasks:

```sh
bun examples/probe.ts ./fixtures/media/movie_5.mp4
bun examples/convert.ts ./fixtures/media/movie_5.mp4 ./out.mp4
bun examples/trim.ts ./fixtures/media/movie_5.mp4 ./clip.mp4 1.5 4.0 keyframe
bun examples/mux.ts ./fixtures/media/movie_5.mp4 ./muxed.mp4
```

Video decode/encode examples use browser media APIs where the current runtime provides them. Pure
TypeScript container and PCM paths run in Bun; unavailable capabilities fail with `MediaError` subclasses
instead of silent passthrough output.

## Package Checks

Before publishing or vendoring the package, run the focused packaging gates:

```sh
bun run build
bun run vendor-wasm
bun run test:dist
bun run check-budgets
```

`vendor-wasm` co-locates the built WASM tails with the emitted chunks after `tsup` cleans `dist/`.
`test:dist` imports through the published `exports` map and exercises the built package.
`check-budgets` inspects `dist/` for the eager kernel budget, typical first-operation JS budget,
code-splitting, and lazy same-origin WASM asset loading.

## Loading Model

The default entry stays small and lazy-loads first-party drivers on demand. WASM codec assets are emitted
as same-origin files and addressed with `new URL('./core.wasm', import.meta.url)` from lazy driver code;
they are not statically imported by the default entry or probe-only path. The common path does not require
COOP/COEP. Threaded/SIMD WASM remains an explicit isolation-profile opt-in.
