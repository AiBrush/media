/**
 * Dist smoke test — exercises the SHIPPED package, not the TypeScript sources.
 *
 * It imports through the published `exports` map (`@aibrush/media` and `@aibrush/media/core`, resolved by
 * package self-reference), so it proves the built ESM + the `.d.ts` a real consumer sees are correct:
 *  • the default entry exposes every public value (the engine factory, the bare-function sugar, the
 *    source/sink constructors, the typed-error classes, `VERSION`) and every public TYPE is nameable;
 *  • `@aibrush/media/core` exposes the driver-author surface (`DRIVER_API_VERSION`, the contracts);
 *  • the built engine wires end-to-end — a real op routed through the compiled kernel rejects with a
 *    TYPED error (never a string, never a silent wrong result) on input it cannot satisfy in Node.
 *
 * Requires a prior `bun run build` (it reads `dist/`). When `dist/` is absent (a fresh checkout running
 * `vitest run` before the build) the suite SKIPS rather than fails; the `test:dist` script and the `gate`
 * run it after `tsup`, where `dist/` is guaranteed present.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Import through the package name so the `exports` map (not a relative path) is what gets resolved —
// the faithful consumer view. Types come from the built `dist/index.d.ts` / `dist/core.d.ts`.
import * as media from '@aibrush/media';
import type {
  ByteRange,
  CacheOptions,
  CachingSource,
  CallOptions,
  Cancellable,
  ConvertOptions,
  Determinism,
  EncodedChunk,
  MediaEngine,
  MediaInfo,
  MediaInput,
  Output,
  PacketStreams,
  Progress,
  Sink,
  Source,
  StreamDestination,
  StreamTarget,
  StreamTargetWriter,
  TrackInfo,
} from '@aibrush/media';
import * as core from '@aibrush/media/core';
import { describe, expect, it } from 'vitest';

const distBuilt = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
const suite = distBuilt ? describe : describe.skip;

suite('dist smoke (built package via exports map)', () => {
  it('default entry exposes the engine factory + every bare-function op as callables', () => {
    expect(typeof media.createMedia).toBe('function');
    for (const op of [
      'probe',
      'convert',
      'transcode',
      'remux',
      'trim',
      'demux',
      'decode',
      'encode',
      'mux',
      'seek',
      'decrypt',
      'preload',
    ] as const) {
      expect(typeof media[op], `bare-function sugar '${op}' must be exported`).toBe('function');
    }
    // `transcode` is the documented alias of `convert` (ADR-012) — same function identity.
    expect(media.transcode).toBe(media.convert);
  });

  it('default entry exposes the source + sink constructors and the source guard', () => {
    for (const ctor of [
      'from',
      'fromBytes',
      'fromBlob',
      'fromStream',
      'fromURL',
      'fromOPFS',
    ] as const) {
      expect(typeof media[ctor], `source constructor '${ctor}'`).toBe('function');
    }
    for (const sink of ['toBlob', 'toFile', 'toStream', 'toOPFS', 'toElement'] as const) {
      expect(typeof media[sink], `sink constructor '${sink}'`).toBe('function');
    }
    expect(typeof media.isSource).toBe('function');
    expect(media.isSource(media.fromBytes(new Uint8Array([1, 2, 3])))).toBe(true);
    expect(media.isSource({})).toBe(false);
    // Sink descriptors carry their discriminant.
    expect(media.toBlob()).toEqual({ kind: 'blob' });
    expect(media.toFile('out.mp4')).toEqual({ kind: 'file', name: 'out.mp4' });
  });

  it('default entry exposes the streaming-output + source-cache surface (and they work)', async () => {
    for (const fn of [
      'toStreamTarget',
      'writeToStreamTarget',
      'cacheSource',
      'probeUrlSize',
    ] as const) {
      expect(typeof media[fn], `export '${fn}'`).toBe('function');
    }

    // `toStreamTarget` builds a streaming sink descriptor; `writeToStreamTarget` drives a readable into a
    // caller-owned destination chunk-by-chunk (bounded memory) — exercise the callback arm end-to-end.
    const written: Uint8Array[] = [];
    const target = media.toStreamTarget((chunk) => {
      written.push(chunk);
    });
    expect(target.kind).toBe('stream-target');
    const src = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    await media.writeToStreamTarget(target, src);
    expect(written.flatMap((c) => [...c])).toEqual([1, 2, 3]);

    // `cacheSource` wraps a source in an opt-in range cache and serves repeat reads from memory.
    const cached = media.cacheSource(media.fromBytes(new Uint8Array([10, 11, 12, 13])));
    expect(media.isSource(cached)).toBe(true);
    expect([...(await cached.range(1, 3))]).toEqual([11, 12]);
    expect([...(await cached.range(1, 3))]).toEqual([11, 12]); // second read is a cache hit
  });

  it('default entry exposes the typed-error model and VERSION', () => {
    expect(typeof media.VERSION).toBe('string');
    const err = new media.CapabilityError('capability-miss', 'x', { op: 'probe', tried: [] });
    expect(err).toBeInstanceOf(media.MediaError);
    expect(err).toBeInstanceOf(media.CapabilityError);
    expect(err.code).toBe('capability-miss');
    expect(err.name).toBe('CapabilityError');
    expect(new media.InputError('unsupported-input', 'x')).toBeInstanceOf(media.MediaError);
  });

  it('the `core` subpath exposes the driver-author surface', () => {
    expect(core.DRIVER_API_VERSION).toBe(1);
    expect(core.VERSION).toBe(media.VERSION);
    expect(typeof core.createMedia).toBe('function');
    expect(typeof core.Registry).toBe('function');
    expect(typeof core.MediaEngineImpl).toBe('function');
    // The error model is shared across both entries (same code semantics).
    expect(new core.MediaError('demux-error', 'x').code).toBe('demux-error');
  });

  it('the fragmented-MP4 writer lives on `/core`, NOT the eager default entry (budget invariant)', () => {
    // `fragmentMp4` is heavy MP4 box-writer code: it must stay off the eager `@aibrush/media` entry so it
    // never inlines into the kernel chunk, and instead be reachable on the advanced `/core` surface.
    expect(typeof core.fragmentMp4).toBe('function');
    expect(typeof core.fragmentMp4([]).next).toBe('function'); // a generator (init + media segments)
    expect('fragmentMp4' in media).toBe(false);
  });

  it('a created engine has the full intent-only op surface', () => {
    const engine: MediaEngine = media.createMedia();
    for (const method of [
      'probe',
      'convert',
      'remux',
      'trim',
      'decode',
      'encode',
      'demux',
      'mux',
      'seek',
      'decrypt',
      'preload',
      'from',
      'source',
      'use',
    ] as const) {
      expect(typeof engine[method], `engine.${method}`).toBe('function');
    }
  });

  it('the built engine rejects un-satisfiable input with a TYPED error (no string, no silent pass)', async () => {
    // Garbage bytes: not a recognizable container ⇒ a typed MediaError (CapabilityError here, since no
    // container driver matches in Node). The point is the *type* of the throw and that the built kernel
    // routes end-to-end — never a raw string, never a fabricated MediaInfo.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    await expect(media.probe(garbage)).rejects.toBeInstanceOf(media.MediaError);

    // A non-finite seek time is bad input, surfaced as InputError by the compiled engine.
    await expect(media.seek(garbage, Number.NaN)).rejects.toBeInstanceOf(media.InputError);

    // The op handle is a cancellable promise (ADR: the returned Promise also exposes `.cancel()`).
    const handle = media.probe(garbage);
    expect(typeof handle.cancel).toBe('function');
    await handle.catch(() => {}); // settle so no unhandled rejection escapes
  });

  it('preload is idempotent and never throws (warmup contract)', async () => {
    await expect(
      media.preload('probe', { op: 'convert', video: 'h264', container: 'mp4' }),
    ).resolves.toBeUndefined();
  });
});

// ── Type-level surface assertions (compile-time; zero runtime). These FAIL THE BUILD if a public type
//    that appears in a public signature stops being nameable from the default entry. ──────────────────

/** Assert `T` is exactly assignable both ways to `Expected` (a structural identity check). */
type Exact<T, Expected> = [T] extends [Expected] ? ([Expected] extends [T] ? true : false) : false;
function assertType<T extends true>(): void {
  void 0 as unknown as T;
}

assertType<Exact<Determinism, 'auto' | 'force-software'>>();
// Every type below must be importable from '@aibrush/media' (the lines above already import them); these
// references pin that they remain part of the public surface.
type _Pins = [
  MediaInput,
  Source,
  Sink,
  Output,
  MediaInfo,
  TrackInfo,
  EncodedChunk,
  Progress,
  CallOptions,
  ConvertOptions,
  PacketStreams,
  Cancellable<MediaInfo>,
  MediaEngine,
  // Streaming-output sink (doc 09) and the source-cache surface — newly wired into the barrel.
  StreamTarget,
  StreamDestination,
  StreamTargetWriter,
  CachingSource,
  CacheOptions,
  ByteRange,
];
// Reference the tuple so `noUnusedLocals` is satisfied without emitting runtime code.
export type __SurfacePins = _Pins;
