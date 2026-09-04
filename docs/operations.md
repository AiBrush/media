# Operations

The package exposes both bare functions and the same methods on a `MediaEngine` returned by
`createMedia()`. Bare functions are convenient for isolated calls; an engine instance provides explicit
configuration and disposal.

## Inspect media

### `probe`

`probe(input, options?)` reports container-level information without decoding frames:

```ts
import { probe } from '@aibrush/media';

const info = await probe(file);

console.info({
  container: info.container,
  durationSec: info.durationSec,
  sizeBytes: info.sizeBytes,
  tracks: info.tracks,
  tags: info.tags,
});
```

A wrong MIME type or extension on an in-memory input is corrected by the file's own magic bytes (an
MPEG-TS payload named `.mp4` probes as `ts`). Each track reports its id, type, codec, duration when known, and media-specific geometry. Video tracks
may report width, height, rotation, and frame rate; audio tracks may report sample rate and channel count.
When the container carries a default-selection flag (`tkhd` Track_enabled, Matroska `FlagDefault`) the
track also reports `defaultDisposition`; `language` is the container's declared ISO-639-2 code.

### `packetInfo` and `packetInfoBatches`

Use packet inspection when you need encoded timeline metadata without packet payloads:

```ts
import { packetInfo } from '@aibrush/media';

const table = await packetInfo(file);
for (const packet of table.packets) {
  console.info(packet.trackIndex, packet.ptsUs, packet.dtsUs, packet.size, packet.keyframe);
}
```

For large packet tables, consume bounded batches:

```ts
import { packetInfoBatches } from '@aibrush/media';

const batches = await packetInfoBatches(file, { batchSize: 512 });

try {
  for await (const batch of batches) {
    consumeRows(batch);
  }
} finally {
  await batches.cancel();
}
```

The batch stream is single-use. Breaking a `for await` loop releases it automatically; explicit
`cancel()` is safe when ownership leaves the loop. An optional `container` hint can skip format routing.

Set `includePayloadDigests: true` when an integrity workflow also needs SHA-256 for each exact coded
payload. Each returned row then carries `payloadDigest`. This performs a full payload scan, but
range-capable sources are still read in bounded windows and batches retain only row metadata. Large-file
policies may omit the public `offset` even though the driver uses private sample placement to hash the
payload; do not treat a missing offset as a missing digest.

### `demux`

`demux()` exposes track descriptors and one packet stream per track:

```ts
import { createMedia } from '@aibrush/media';

const media = createMedia();
const demuxed = await media.demux(file);

try {
  const videoTrack = demuxed.tracks.find((track) => track.mediaType === 'video');
  if (videoTrack !== undefined) {
    const reader = demuxed.packets(videoTrack.id).getReader();
    try {
      const first = await reader.read();
      console.info(first.value?.chunk.timestamp, first.value?.dtsUs);
    } finally {
      await reader.cancel();
    }
  }
} finally {
  await demuxed.close();
  await media.dispose();
}
```

Always call `close()` after consuming or abandoning a demux result.

## Convert

`convert(input, options, callOptions?)` decodes and re-encodes only when the request requires it. If the
source already satisfies the declared target and the container supports a safe packet copy, the engine
may preserve compressed packets.

### Video and audio

```ts
import { convert } from '@aibrush/media';

const output = await convert(file, {
  to: 'mp4',
  video: {
    codec: 'h264',
    width: 1280,
    height: 720,
    fit: 'contain',
    bitrate: 3_000_000,
    fps: 30,
  },
  audio: {
    codec: 'aac',
    sampleRate: 48_000,
    channels: 2,
    bitrate: 128_000,
  },
  faststart: true,
});
```

Set `video: false` or `audio: false` to omit that media type. `transcode` is an alias of `convert`.

A request that asks for nothing beyond the source's own codec family copies the coded packets instead
of re-encoding: no video target, or a target whose only key is a `codec` matching the source
(`{ video: { codec: 'h264' } }` on an H.264 source), when the destination container carries that family.
Audio follows the same rule when no audio target is given. Any transform key (size, fps, bitrate, crf,
crop, rotate, colour, alpha, ...) selects an encoder.

### Video transforms

`VideoTarget` supports:

- resize with `width`, `height`, and `fit: 'contain' | 'cover' | 'fill'`;
- frame-rate selection with `fps`;
- `crop`, `pad`, `rotate`, and horizontal or vertical `flip`;
- `colorspace` conversion and HDR-to-SDR `tonemap`;
- bit depth selection;
- VP8/VP9 alpha preservation or discard;
- bitrate, CRF, two-pass, and objective quality/rate constraints.

```ts
const output = await convert(file, {
  to: 'webm',
  video: {
    codec: 'vp9',
    crop: { x: 80, y: 0, width: 1760, height: 1080 },
    width: 1280,
    height: 720,
    fit: 'cover',
    rotate: 90,
    alpha: 'keep',
  },
  audio: { codec: 'opus' },
});
```

The runtime must provide a valid filter and encoder route for the complete request.

### PCM audio processing

PCM-native WAV, AIFF, CAF, and FLAC targets can apply audio processing without a lossy codec seam:

```ts
const output = await convert(file, {
  to: 'wav',
  video: false,
  audio: {
    codec: 'pcm-s24',
    sampleRate: 48_000,
    channels: 2,
    gainDb: -3,
    fade: { inSec: 0.25, outSec: 0.5, curve: 'equal-power' },
  },
});
```

`AudioTarget` also supports an explicit channel remix matrix, dynamics processing, and one or more
biquad filters. `mixMatrix` requires a PCM-native target, and each output row must have one coefficient
for every input channel.

### H.264 ABR output

`h264AbrLadder()` creates up to eight retained MP4 renditions from one source:

```ts
import { h264AbrLadder } from '@aibrush/media';

const outputs = await h264AbrLadder(file, [
  { name: '360p', width: 640, height: 360, bitrate: 800_000 },
  { name: '720p', width: 1280, height: 720, bitrate: 2_800_000 },
]);
```

The source is limited to 128 MiB and the atomically published output set to 512 MiB. Each result is
materialized as a Blob. With `worker: { pool: n }`, bitrate-only renditions may run concurrently up to
the exported `H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS` limit. A quality-constrained ladder is serialized to
bound its analysis memory.

## Remux

`remux()` copies encoded packets into another compatible container without decoding:

```ts
import { remux } from '@aibrush/media';

const output = await remux(file, {
  to: 'mkv',
  trackSelect: ['video:0', 'audio:0'],
  tags: { title: 'Edited title' },
});
```

Track selectors use zero-based ordinals within a media type. Metadata rewrite support depends on the
source and destination container. An incompatible codec/container pair rejects with `CapabilityError`.

## Trim

Trim times are seconds and use a half-open range from `start` to `end`:

```ts
import { trim } from '@aibrush/media';

const output = await trim(file, {
  start: 12.5,
  end: 27,
  mode: 'accurate',
});
```

- `keyframe` begins from a legal compressed-stream boundary and avoids re-encoding when possible.
- `accurate` targets the requested presentation interval and may decode/re-encode boundary media.

Set `fragmented: true` when the output must preserve or author fragmented MP4 structure.

## Decoded frames and packets

### `decode`

`decode()` returns available video and audio streams. Stream consumers own each frame and must close it:

```ts
import { decode } from '@aibrush/media';

const streams = decode(file, { trackSelect: ['video:0'] });
const reader = streams.video?.getReader();

if (reader !== undefined) {
  try {
    for (;;) {
      const { done, value: frame } = await reader.read();
      if (done) break;
      try {
        render(frame);
      } finally {
        frame.close();
      }
    }
  } finally {
    await reader.cancel();
  }
}
```

Decoded video has the container's display rotation applied. Selecting more than one video or more than
one audio track is rejected because `MediaStreams` has one stream slot per media type.

### `seek`

`seek(input, timeUs)` returns the frame at or immediately after a microsecond timestamp:

```ts
import { seek } from '@aibrush/media';

const frame = await seek(file, 2_500_000);
try {
  render(frame);
} finally {
  frame.close();
}
```

`mode` picks a different landing rule: `'nearest'` returns the frame whose presentation time is closest
to the target (the earlier one on a tie), and `'keyframe'` returns the last random-access frame at or
before the target (or the first one after it), decoded alone — the fastest thumbnail a container can
give. Containers with a random-access index (WebM/Matroska Cues, MP4 sample tables) seek through
bounded ranges, so a seek into a large remote file does not download the whole file.

```ts
const thumbnail = await seek(url, 90_000_000, { mode: 'keyframe' });
```

### `encode` and `mux`

`encode()` consumes `MediaStreams` and authors an encoded output. `mux()` consumes encoded packet
streams with complete `TrackInfo` descriptors. These APIs are intended for applications that already
own a frame or packet pipeline:

```ts
const decoded = media.decode(input);
const output = await media.encode(decoded, {
  to: 'webm',
  video: { codec: 'vp9' },
  audio: { codec: 'opus' },
});
```

When remuxing with `demux()` plus `mux()`, pass the exact source `TrackInfo` with its packet stream so
codec configuration, timing, dimensions, and channel layout are preserved. See the runnable
[`examples/mux.ts`](../examples/mux.ts).

## Decrypt

`decrypt()` supports CENC-family MP4 protection and HLS AES schemes:

```ts
import { decrypt } from '@aibrush/media';

const clear = await decrypt(encryptedMp4, {
  scheme: 'cenc',
  keys: {
    '00112233445566778899aabbccddeeff': 'ffeeddccbbaa99887766554433221100',
  },
});
```

For `cenc`, `cens`, and `cbcs`, keys map a 16-byte hexadecimal key ID to a 16-byte hexadecimal key. For
`hls-aes128` and `hls-sample-aes`, use `{ key, iv }` hexadecimal fields as required by the segment.
Provide keys through a secure application boundary and do not log them.

## Fluent chains

`load(input)` builds an immutable chain. Work starts only at `run()`, `blob()`, `file()`, or `stream()`:

```ts
const clip = await media
  .load(file)
  .trim({ start: 5, end: 20, mode: 'accurate' })
  .resize(1280, 720, 'contain')
  .video({ codec: 'h264', bitrate: 3_000_000 })
  .audio({ codec: 'aac' })
  .to('mp4')
  .blob();
```

Intermediate stages use byte streams instead of retaining full temporary files.

## Declarative jobs

`run(job)` executes a structured-clone-safe pipeline and always returns a `Blob`:

```ts
import { run } from '@aibrush/media';

const output = await run({
  input: file,
  ops: [
    { op: 'trim', start: 5, end: 20, mode: 'accurate' },
    { op: 'resize', width: 1280, height: 720, fit: 'contain' },
  ],
  output: {
    container: 'mp4',
    video: { codec: 'h264' },
    audio: { codec: 'aac' },
    faststart: true,
  },
});
```

Jobs validate and snapshot all plain-data options before consuming a one-shot input. Use the flat API for
custom sinks and positioned `faststart: 'reserve'` output.
