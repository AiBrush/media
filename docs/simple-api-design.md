# Simple API design (Phase 1)

Status: design, 2026-09-02. Source: `REVIEW-2026-09-01.md` §5 and §4.2. This document is the
contract for the Phase 1 work; every item below is either implemented and tested or still open.

## Goal

A developer converts a file in under ten minutes with one import, one input type, one output type
and no knowledge of drivers, sinks, workers or WASM. The benchmark adapter for this engine shrinks
from 15,900 lines to under 1,500 because nothing it does today with `/core` or hand-written fast
paths is left outside the public API.

## Surface

```ts
import { probe, convert, remux, trim, frames, frameAt, plan, createMedia } from '@aibrush/media';

const info = await probe(file);
const out = await convert(file, 'mp4');
const out2 = await convert(file, { to: 'webm', video: { height: 720 }, audio: 'opus', quality: 'high' });
const clip = await trim(file, { start: 1.5, end: 4 });
const fast = await remux(file, 'mp4');
const thumb = await frameAt(file, 2.5);
for await (const frame of frames(file, { fps: 1 })) frame.close();
const p = await plan(file, { to: 'mp4' });

await out.into(await handle.createWritable());
const blob = await out.blob();
console.log(out.report.route, out.report.modulesLoaded, out.report.warnings);
```

### One input

`MediaInput` accepts, without a helper: `File`, `Blob`, `ArrayBuffer`, `ArrayBufferView`,
`ReadableStream<Uint8Array>`, `URL`, `string` (URL), `Response`, `FileSystemFileHandle`,
`HTMLMediaElement`, `MediaStream`. Options that today need a `from*` helper (`mime`, `size`,
`rangeRequests`, `filename`, credentials) are passed as `from(input, options)`. The fifteen
`from*` helpers move to `@aibrush/media/advanced`.

### One output

Every producing operation returns `MediaOutput`:

```ts
interface MediaOutput {
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
  file(name?: string): Promise<File>;
  url(): Promise<string>;                       // object URL, revoked by dispose()
  into(target: WritableStream<Uint8Array> | FileSystemWritableFileStream): Promise<void>;
  readonly mime: string;
  readonly report: ExecutionReport;
  dispose(): void;
}
```

Whether the route streams or buffers is decided by the planner and reported in `report.streaming`;
the caller never chooses a sink class. `into()` on a streaming route writes as bytes are produced;
on a buffered route it writes once at the end. Calling two consumers on one output is an
`InputError` with a remedy.

### `plan()`

`plan(input, options)` replaces `canConvert`, `planRemuxOutput` and `preload`. It resolves the
route the operation would take, loads nothing heavier than the container sniff, and never throws:

```ts
interface Plan {
  ok: boolean;
  op: 'convert' | 'remux' | 'trim' | 'frames' | 'probe';
  route: string;                                 // e.g. 'mp4→mp4 stream-copy (faststart rewrite)'
  streaming: boolean;
  loads: { module: string; bytes: number }[];    // lazy chunks and WASM this route will fetch
  estimatedPeakMemoryBytes: number;
  warnings: string[];                            // e.g. 'audio will be re-encoded to opus'
  reasons: { code: string; message: string; remedy: string }[]; // why ok=false
}
```

### Presets and shorthand

- `convert(file, 'mp4')` equals `convert(file, { to: 'mp4', preset: 'web' })`.
- `preset: 'web' | 'social' | 'archive'` sets codec, quality and faststart defaults per container.
- `quality: 'low' | 'medium' | 'high' | number` maps to codec-specific rate control.
- `audio: 'opus'` equals `audio: { codec: 'opus' }`; `video: false` and `audio: false` drop a track.

### Errors

Three classes, all with `code`, `stage` (`'input' | 'plan' | 'decode' | 'encode' | 'mux' | 'output'`),
`route` and `remedy`:

- `InputError`: the bytes or options are wrong. Remedy names the option or the byte-level cause.
- `CapabilityError`: this runtime cannot do it. Remedy names the nearest thing it can do.
- `MediaError`: the operation was valid but failed or was aborted.

Malformed input never resolves to a bogus output and never throws a generic `TypeError`.

### Workers and assets

Worker offload is on when `Worker` exists; `createMedia({ worker: false })` opts out. WASM and
lazy chunks resolve from `import.meta.url`; `assetBaseUrl` is the one override. A blocked fetch
produces a `CapabilityError` whose remedy states the URL that was tried and the CSP directive to
allow.

### Progressive disclosure

Moves to `@aibrush/media/advanced`: `strategy.pinDriver`, `determinism`, `faststart: 'reserve'`
with `maximumPacketCount`, `fragmented`, `packetInfo` batches, `h264AbrLadder`, `run(job)`,
`muxPrepared*`, the `from*` helpers, `decrypt`. Drivers stay on `/core`. The fluent `MediaChain`
becomes a typed class whose methods are the same seven operations, or it is removed; a `Proxy`
that accepts any method name is not an API.

## Library gaps the adapter reveals

| Adapter workaround (media-test) | Public API that replaces it | Status |
|---|---|---|
| `enrichAibrushProbeMetadata` reads the whole file | `MediaInfo` gains bitrate, codec profile/level string, colour, alpha, exact fps, priming/edit list, chapters, lazily | open |
| `repairAibrushOggContinuationFlags` | none needed; page writer verified by property test, call sites removed | done 2026-09-02 |
| `tryPreparedWav*`, `tryPreparedAiffWav*` via `/core` | planner rule: PCM→PCM with format, endianness or gain change only is a direct rewrite | open |
| `tryPrepared*Remux` (mp3, ts↔iso, mov→mkv, mkv→x, ts→x) | `remux` ranks the byte-copy route itself | open |
| `tryStrictPreparedAibrushCopyTrim` | `trim` copy route preserves metadata and edit lists | open |
| `fastHlsProbeMetadata`, `playlistOnlyHlsProbeMetadata` | `probe` of `.m3u8` returns a playlist-level result with lazy segment resolution | open |
| `#packetAlignedSeekTarget` builds a full packet table | `frameAt(input, t, { mode: 'exact' \| 'keyframe-before' \| 'keyframe-after' \| 'nearest' })` on `stss`/`sidx`/Cues | open |
| `isGracefulNegativeContext` + `GracefulRejectionError` | typed `InputError` for malformed bytes on every driver | open |
| `createAibrushAuthenticatedSource` | `from(url, { integrity })` | open (decide once) |
| `tryBrowserCanvasHdrTonemapTranscode` | planner selects the HDR→SDR tonemap route | open |
| `verifyRequestedIsoShape`, `instrumentedAibrushSink` | `report` on every output: route, write trace, retained bytes | open |

## Measuring "simple"

- Adapter lines in media-test: 15,900 today, target ≤ 1,500, enforced by a CI `wc -l` check and a
  lint rule that forbids `/core` imports and harness-context branching.
- Time to first conversion following `getting-started.md`: under ten minutes for someone who has
  not seen the code.
- Concepts on the getting-started page: input, output, options, plan, errors. Nothing else.
- Every documentation snippet is an executable example run in Playwright, not only compiled.

## Order of work

1. `MediaOutput` and `report` on `convert`, `remux`, `trim` (keep byte-identical routes; add tests
   that the report names the route the benchmark observed).
2. Universal input and `from(input, options)`; move `from*` to `/advanced`.
3. `plan()`; delete `canConvert`, `planRemuxOutput`, `preload`.
4. Presets, shorthand codecs, quality words.
5. Error classes with `stage` and `remedy`; malformed-input guarantee per driver.
6. `frames()` / `frameAt()` with index-based seek modes.
7. Move advanced knobs to `/advanced`; decide the fate of `MediaChain`.
8. Rewrite the media-test adapter against the root entry only; every removed path is either a
   library feature above or a cited `NA_ENGINE`.

Each step lands with its docs and examples updated in the same change; `docs:check` compiles the
examples and, once step 1 ships, runs them.
