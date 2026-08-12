# Driver authoring

Most applications should use the zero-configuration drivers selected by `@aibrush/media`. The
`@aibrush/media/core` entry exists for custom media formats, codec substrates, filter implementations,
and advanced embedding.

## Driver model

There are three driver kinds:

| Kind | Responsibility | Main data seam |
| --- | --- | --- |
| `ContainerDriver` | Detect, probe, demux, mux, and optionally copy/decrypt one container family | Bytes and encoded packets |
| `CodecDriver` | Decode or encode one codec on one execution tier | Encoded chunks and frames |
| `FilterDriver` | Transform video or audio frames | Raw frames |

The registry stores implementations; the router selects them from declared support. Drivers must reject
unsupported execution honestly with typed errors and must not fabricate media output.

## Register a module

A published driver default-exports a `DriverModule` with the current contract version:

```ts
import { DRIVER_API_VERSION } from '@aibrush/media/core';
import type { ContainerDriver, DriverModule } from '@aibrush/media/core';

declare const containerDriver: ContainerDriver;

const module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(registry) {
    registry.addContainer(containerDriver);
  },
};

export default module;
```

Install it on an engine before the first operation that should use it:

```ts
import { createMedia } from '@aibrush/media';
import CustomContainerModule from '@example/custom-container';

const media = createMedia().use(CustomContainerModule);
```

`use()` is chainable and rejects a module whose `apiVersion` is not supported.

## Contract requirements

Every driver declares a unique `id`, `kind`, and `apiVersion`.

Container drivers also declare `formats`, synchronously answer `supports(query)`, implement `demux()`,
and provide `createMuxer()`. Focused drivers can add efficient `probe`, packet metadata, stream-copy,
PCM, or decrypt capabilities.

A demuxer can implement `packetStats(trackId): PacketMetadataStats | undefined` so conversion planning
can measure coded bitrate and presentation span without calling the legacy row-materializing
`packetTable()`. The result must be computed with constant-sized auxiliary state: publish packet count,
total coded bytes, and exact presentation start/end; publish `decodeStartUs` and `decodeEndUs` together
only when both are exact. Return `undefined` when the driver cannot produce a valid bounded summary.
Long inputs must never allocate one object per packet merely to implement this seam.
Without `packetStats`, conversion still proceeds and the muxer's authoritative byte cap remains active,
but measured-bitrate and shifted-origin early planning evidence is unavailable; the engine does not call
`packetTable()` as a fallback.

Codec drivers declare an execution `tier`, asynchronously probe exact decoder/encoder configurations,
and build transform streams for the directions they support. `supports()` must be cheap and must return an
honest unsupported verdict instead of deferring an expected miss to execution.

Filter drivers match a typed filter specification and return a frame transform. Input frame ownership,
output frame ownership, abort behavior, and backpressure must be explicit.

## Versioning

Import `DRIVER_API_VERSION` from `@aibrush/media/core`; do not copy its numeric value into a driver
package. The engine validates the version at registration.

`VERSION` is the application package version and is independent of the driver contract version.

## Conformance

The core entry exports:

- `assertContainerDriverConforms`;
- `assertCodecDriverConforms`;
- `assertFilterDriverConforms`;
- their associated conformance-case types and `ConformanceError`.

Run the applicable harness in the driver package with valid input, abort, and unsupported-capability
cases. Add real round-trip or independent-parser checks for the media format itself; contract conformance
does not prove bitstream correctness.

## Explicit first-party drivers

First-party modules can be imported from `@aibrush/media/drivers/*` and passed to `use()`:

```ts
import { createMedia } from '@aibrush/media';
import Mp4Module from '@aibrush/media/drivers/mp4';

const media = createMedia().use(Mp4Module);
```

Available subpaths are `adts`, `aiff`, `avi`, `caf`, `flac`, `hls`, `mp3`, `mp4`, `mpegts`, `ogg`,
`wav`, and `webm`. Normal application code does not need to register them manually.

## Advanced core exports

`@aibrush/media/core` also exposes the registry/router, worker primitives, frame cleanup helpers,
prepared container writers, HLS resolution, and packet-focused utilities. These are lower-level
contracts: applications using them own more lifecycle and format validation than applications using the
root operations.
