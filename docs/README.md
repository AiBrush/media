# @aibrush/media documentation

This documentation describes the package as it is implemented today. The exported TypeScript types are
the final authority for exact signatures.

## Start here

If you are integrating the package for the first time, read these pages in order:

1. [Getting started](getting-started.md)
2. [Inputs and outputs](inputs-and-outputs.md)
3. [Operations](operations.md)
4. [Runtime and capabilities](runtime-and-capabilities.md)
5. [Errors and resource ownership](errors-and-lifecycle.md)

Use the [API reference](api-reference.md) when you already know the operation you need. The planned simplification of this surface is described in [Simple API design](simple-api-design.md).

## By task

| Goal | Page |
| --- | --- |
| Inspect a file or URL | [Probe and packet inspection](operations.md#inspect-media) |
| Convert audio or video | [Convert](operations.md#convert) |
| Copy compressed tracks without re-encoding | [Remux](operations.md#remux) |
| Cut a time range | [Trim](operations.md#trim) |
| Work with decoded frames | [Decode, seek, encode, and mux](operations.md#decoded-frames-and-packets) |
| Stream output without retaining a full file | [Output sinks](inputs-and-outputs.md#output-sinks) |
| Process a URL efficiently | [URL input](inputs-and-outputs.md#urls) |
| Handle unsupported runtime features | [Capability preflight](runtime-and-capabilities.md#capability-preflight) |
| Cancel work and release resources | [Errors and resource ownership](errors-and-lifecycle.md) |
| Add a custom media driver | [Driver authoring](driver-authoring.md) |
| Validate a package release | [Development and release](development.md) |

## Public package entries

| Import | Intended use |
| --- | --- |
| `@aibrush/media` | Application API, sources, sinks, types, and errors |
| `@aibrush/media/image` | Direct image inspection and browser image decoding |
| `@aibrush/media/wav` | Small synchronous WAV header and PCM utilities |
| `@aibrush/media/mp4-packet-info` | Focused MP4/MOV packet metadata inspection |
| `@aibrush/media/hls` | HLS manifest parsing and key/segment resolution |
| `@aibrush/media/core` | Driver contracts and advanced embedding APIs |
| `@aibrush/media/drivers/*` | Explicit first-party driver modules |

Most applications need only `@aibrush/media`.
