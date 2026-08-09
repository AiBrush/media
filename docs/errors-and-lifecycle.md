# Errors and resource ownership

Media pipelines own streams, native frames, codec sessions, workers, object URLs, and sometimes
cryptographic material. Correct cleanup is part of the operation contract.

## Typed errors

Every engine error extends `MediaError` and has a machine-readable `code`:

| Code | Meaning |
| --- | --- |
| `capability-miss` | No available route can satisfy the request |
| `unsupported-input` | The source or options are invalid, empty, damaged, or unrecognized |
| `decode-error` | A decoder failed after accepting the route |
| `encode-error` | An encoder failed |
| `demux-error` | Container parsing or packet extraction failed |
| `mux-error` | Output container authoring or destination writing failed |
| `constraint-unsatisfied` | Valid hard rate/quality constraints could not all be met |
| `aborted` | The operation was cancelled |
| `driver-incompatible` | A custom driver's API version is not supported |

Specialized classes make common cases easier to distinguish:

- `CapabilityError` always has code `capability-miss` and may report the attempted route in `detail`;
- `InputError` always has code `unsupported-input`;
- `ConstraintUnsatisfiedError` includes bounded rate/quality attempt evidence.

```ts
import {
  CapabilityError,
  ConstraintUnsatisfiedError,
  InputError,
  MediaError,
  convert,
} from '@aibrush/media';

try {
  await convert(file, {
    to: 'mp4',
    video: { codec: 'h264' },
    audio: { codec: 'aac' },
  });
} catch (error) {
  if (error instanceof CapabilityError) {
    showUnsupportedTarget(error.detail);
  } else if (error instanceof InputError) {
    showInvalidMedia(error.message);
  } else if (error instanceof ConstraintUnsatisfiedError) {
    showConstraintAttempts(error.detail.attempts);
  } else if (error instanceof MediaError && error.code === 'aborted') {
    // User cancellation needs no error notification.
  } else {
    throw error;
  }
}
```

Do not branch on message text. Use the class, `code`, and structured `detail`.

## Cancellation

Long-running operations accept `CallOptions.signal` and return a promise with `cancel()`:

```ts
const controller = new AbortController();
const operation = media.convert(input, options, { signal: controller.signal });

controller.abort('navigation');
// or: operation.cancel();

await operation;
```

Both forms converge on the operation's cleanup path. Cancellation closes active readers and native
resources, then rejects with `code: 'aborted'`. If the output is a lazy `ReadableStream`, cancel its
reader or stream when the consumer stops early.

## Engine disposal

Dispose every explicitly created engine when its application or request scope ends:

```ts
const media = createMedia({ worker: true });

try {
  await media.probe(input);
} finally {
  await media.dispose();
}
```

`dispose()` is idempotent. It clears instance-owned decoder pools, worker-pool references, preload work,
and source caches. Calls made through a disposed instance reject with `MediaError` code `aborted`.

Runtimes with explicit resource management can use `await using`:

```ts
await using media = createMedia();
const info = await media.probe(input);
```

The bare functions use a shared lazy engine. Server request handlers and tests that require a fresh
shared instance can call `resetDefaultMedia()` after their work.

## Demux and packet-batch ownership

A `Demuxed` session remains live until `close()`:

```ts
const demuxed = await media.demux(input);
try {
  // Consume packet streams.
} finally {
  await demuxed.close();
}
```

A `PacketInfoBatchStream` is single-use. Completing or breaking `for await` releases it; call `cancel()`
when abandoning it outside iteration.

## VideoFrame and AudioData ownership

The consumer owns every `VideoFrame` or `AudioData` emitted by a decoded stream. Close each object exactly
once, including error and early-return paths:

```ts
const reader = streams.audio?.getReader();

if (reader !== undefined) {
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const audio = result.value;
      try {
        processAudio(audio);
      } finally {
        audio.close();
      }
    }
  } finally {
    await reader.cancel();
  }
}
```

The same rule applies to `seek()` and `decodeImageFrames()`. Encoded chunks and packet metadata do not
hold closeable frame resources.

## Blob URLs and media elements

If your application creates an object URL from a Blob output, revoke it when the element or download no
longer needs it:

```ts
const url = URL.createObjectURL(blob);
video.src = url;

video.addEventListener('emptied', () => URL.revokeObjectURL(url), { once: true });
```

When you use `toElement(element)`, the sink owns attachment setup. Your application still controls the
element lifecycle.

## Output destination failures

`toStreamTarget()` and OPFS sinks propagate destination write failures as typed media errors. A callback
promise applies backpressure, so rejecting it stops further producer pulls. For lazy `toStream()` output,
read and cancellation errors surface while consuming the stream rather than when the operation first
returns it.

## Key material

Decrypt options contain raw keys. Keep them out of logs, analytics, persisted error detail, and URLs.
Abort and discard decryption work when its authorization scope ends.
