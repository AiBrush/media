# Getting started

## Requirements

- An ESM project
- Node.js 18 or newer for installation, builds, and server-side byte operations
- A current browser for WebCodecs, WebGPU, media elements, live `MediaStream`, and OPFS features

Codec availability is runtime-dependent. A browser may support a container but not a requested encoder,
or may expose a codec only for particular dimensions, profiles, or bit depths. See
[Runtime and capabilities](runtime-and-capabilities.md) before choosing a fixed production target.

## Install

```sh
npm install @aibrush/media
```

Import from the package root for normal application work:

```ts
import { createMedia, probe } from '@aibrush/media';
```

## Inspect media

Every operation accepts the same `MediaInput` family. A browser `File` can be passed directly:

```ts
import { probe } from '@aibrush/media';

const info = await probe(file);

console.table(
  info.tracks.map((track) => ({
    id: track.id,
    type: track.type,
    codec: track.codec,
    duration: track.durationSec,
  })),
);
```

`probe()` reads only the media structure needed to report the container, duration, size when known,
tracks, and tags. URL sources use range requests by default when the server supports them.

## Convert a file

The fluent API gives the terminal output a precise type. This example returns a `Blob`:

```ts
import { load } from '@aibrush/media';

const output = await load(file)
  .video({ codec: 'h264', height: 720, fit: 'contain' })
  .audio({ codec: 'aac', sampleRate: 48_000 })
  .to('mp4')
  .convert({ faststart: true })
  .blob();

const downloadUrl = URL.createObjectURL(output);
```

The flat API is useful when options are assembled as data:

```ts
import { convert, toFile } from '@aibrush/media';

const output = await convert(file, {
  to: 'webm',
  video: { codec: 'vp9', width: 1280, height: 720, fit: 'contain' },
  audio: { codec: 'opus', bitrate: 128_000 },
  sink: toFile('output.webm'),
});
```

Flat operations return the `Output` union because the selected sink controls the concrete result. The
default sink is a `Blob`; helper sinks can return a `File`, return a `ReadableStream`, or write directly
to a destination.

## Check a target before showing it

Use `canConvert()` to decide whether to offer a target in the current runtime:

```ts
import { canConvert } from '@aibrush/media';

const canCreateWebm = await canConvert({
  to: 'webm',
  video: { codec: 'vp9' },
  audio: { codec: 'opus' },
});
```

Preflight does not consume source bytes. Runtime conditions can still change, so execute inside typed
error handling as shown in [Errors and resource ownership](errors-and-lifecycle.md).

## Progress and cancellation

All long-running flat operations return a cancellable promise and also accept an `AbortSignal`:

```ts
import { convert } from '@aibrush/media';

const controller = new AbortController();
const operation = convert(
  file,
  {
    to: 'mp4',
    video: { codec: 'h264' },
    audio: { codec: 'aac' },
  },
  {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.total !== undefined) {
        console.info(progress.stage, progress.done / progress.total);
      }
    },
  },
);

// Either cancellation form is valid:
operation.cancel();
// controller.abort();
```

Cancellation is cooperative. The promise rejects with a `MediaError` whose `code` is `aborted` after
active readers, streams, frames, codecs, and worker work are released.

## Use an engine for application lifetime

The bare functions share one lazily created engine. Create an instance when your application needs
explicit options, custom drivers, isolated caches, or deterministic cleanup:

```ts
import { createMedia } from '@aibrush/media';

const media = createMedia({
  worker: { pool: 2 },
  determinism: 'auto',
  onLog(event) {
    console.debug(event.level, event.message, event.detail);
  },
});

try {
  await media.preload({
    op: 'convert',
    container: 'mp4',
    video: 'h264',
    audio: 'aac',
    level: 'compile',
  });

  const output = await media.load(file).to('mp4').blob();
  void output;
} finally {
  await media.dispose();
}
```

Worker execution is opt-in. `worker: true` enables one worker when supported;
`worker: { pool: number }` requests a bounded pool. If `Worker` or the required worker-side codec is not
available, the engine runs the operation inline.

## Next steps

- Learn every supported source and sink in [Inputs and outputs](inputs-and-outputs.md).
- Find task-specific examples in [Operations](operations.md).
- Review browser and codec requirements in [Runtime and capabilities](runtime-and-capabilities.md).
