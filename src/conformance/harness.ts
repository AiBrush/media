/**
 * Driver conformance harness (docs/architecture/05 §3-4, 11 §4.2) — the *same* checks every driver of
 * a kind must pass, so a WASM-FLAC codec driver and a WebCodecs-H264 driver are held to identical
 * seam/lifecycle/error behavior. Runner-agnostic (plain throwing assertions, no test framework
 * dependency) so third-party driver authors can run it under any harness.
 *
 * These are the **structural + honesty** checks that run anywhere (Node included): identity, declared
 * capabilities, `supports()` never throwing, and the coder/muxer/filter factory shapes. The deep
 * frame-flow checks (close-once discipline, flush-on-close) require real WebCodecs and run under
 * browser-mode in Phase 1, layered on top of these.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  ContainerDriver,
  ContainerQuery,
  DecoderConfig,
  DriverBase,
  EncoderConfig,
  FilterDriver,
  FilterSpec,
  FilterSubstrate,
  Tier,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { isApiVersionSupported } from '../kernel/registry.ts';

/** Thrown when a driver violates the contract. */
export class ConformanceError extends Error {
  override readonly name = 'ConformanceError';
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ConformanceError(msg);
}

const TIERS: readonly Tier[] = ['hardware', 'gpu', 'native', 'wasm'];
const SUBSTRATES: readonly FilterSubstrate[] = ['webgpu', 'webgl', 'canvas2d', 'native', 'wasm'];

function isTransformStreamLike(x: unknown): boolean {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { readable?: unknown }).readable instanceof ReadableStream &&
    (x as { writable?: unknown }).writable instanceof WritableStream
  );
}

function assertDriverBase(d: DriverBase, kind: string, label: string): void {
  assert(typeof d.id === 'string' && d.id.length > 0, `${label}: id must be a non-empty string`);
  assert(
    isApiVersionSupported(d.apiVersion),
    `${label} '${d.id}': apiVersion ${d.apiVersion} is outside the supported window`,
  );
  assert(
    (d as DriverBase & { kind: unknown }).kind === kind,
    `${label} '${d.id}': kind must be '${kind}'`,
  );
}

/** A query/config matrix used to exercise a {@link CodecDriver}. */
export interface CodecConformanceCase {
  supported: CodecQuery;
  unsupported: CodecQuery;
  decodeConfig?: DecoderConfig;
  encodeConfig?: EncoderConfig;
}

/** Assert a {@link CodecDriver} obeys the contract. Throws {@link ConformanceError} on any violation. */
export async function assertCodecDriverConforms(
  d: CodecDriver,
  c: CodecConformanceCase,
): Promise<void> {
  const label = 'CodecDriver';
  assertDriverBase(d, 'codec', label);
  assert(TIERS.includes(d.tier), `${label} '${d.id}': tier '${d.tier}' is not a valid Tier`);

  // supports() is honest: declares support truthfully and never throws (even on a garbage config).
  const yes = await d.supports(c.supported);
  assert(yes.supported === true, `${label} '${d.id}': must support its declared supported query`);
  const no = await d.supports(c.unsupported);
  assert(
    no.supported === false,
    `${label} '${d.id}': must not support its declared unsupported query`,
  );
  await assertDoesNotThrow(
    () => d.supports({ mediaType: 'video', direction: 'decode', config: { codec: '' } }),
    `${label} '${d.id}': supports() must not throw on a garbage query`,
  );

  if (c.decodeConfig) {
    assert(
      isTransformStreamLike(d.createDecoder(c.decodeConfig)),
      `${label} '${d.id}': createDecoder must return a TransformStream`,
    );
  }
  if (c.encodeConfig) {
    assertStreamOrMediaError(
      () => d.createEncoder(c.encodeConfig as EncoderConfig),
      `${label} '${d.id}': createEncoder must return a TransformStream or throw a typed MediaError`,
    );
  }
}

/** Cases used to exercise a {@link ContainerDriver}. */
export interface ContainerConformanceCase {
  supported: ContainerQuery;
  unsupported: ContainerQuery;
}

/** Assert a {@link ContainerDriver} obeys the contract. */
export function assertContainerDriverConforms(
  d: ContainerDriver,
  c: ContainerConformanceCase,
): void {
  const label = 'ContainerDriver';
  assertDriverBase(d, 'container', label);
  assert(
    Array.isArray(d.formats) && d.formats.length > 0,
    `${label} '${d.id}': formats must be a non-empty list`,
  );

  assert(d.supports(c.supported) === true, `${label} '${d.id}': must support its declared query`);
  assert(
    d.supports(c.unsupported) === false,
    `${label} '${d.id}': must not support its declared unsupported query`,
  );
  let threw = false;
  try {
    d.supports({ direction: 'demux' });
  } catch {
    threw = true;
  }
  assert(!threw, `${label} '${d.id}': supports() must not throw on an empty query`);

  assertStreamOrMediaError(
    () => d.createMuxer(),
    `${label} '${d.id}': createMuxer must return a Muxer or throw a typed MediaError`,
    isMuxerLike,
  );
}

/**
 * Node-checkable conformance facets for a {@link CodecDriver} whose `supports()` answer is
 * **environment-dependent** — a browser tier (WebCodecs `tier:'hardware'`) or a WASM tier whose vendored
 * core is loaded miss-only. In Node those drivers honestly report `supported:false` for *every* query
 * (no `VideoFrame`/`AudioData`/`isConfigSupported`, no core), so the full {@link assertCodecDriverConforms}
 * "must support its declared query" assertion cannot hold here. This subset asserts everything that IS
 * decidable in Node — identity, contract version, kind, a valid tier, and `supports()` **honesty +
 * total-function** behavior (never throws, even on garbage; returns a well-typed `{supported:false,…}` in
 * this environment) — so every real codec driver is held to the *same* seam contract the browser harness
 * then extends with the true-support + frame-flow facets. Throws {@link ConformanceError} on any violation.
 *
 * @param expectNodeSupport `true` only for a driver that genuinely works in Node (none ship today; the
 *   parameter keeps the harness honest if a pure-TS codec driver is added later, in which case the
 *   stronger {@link assertCodecDriverConforms} should be used instead).
 */
export async function assertCodecDriverNodeFacets(d: CodecDriver): Promise<void> {
  const label = 'CodecDriver';
  assertDriverBase(d, 'codec', label);
  assert(TIERS.includes(d.tier), `${label} '${d.id}': tier '${d.tier}' is not a valid Tier`);

  // supports() is a total function: it never throws (browser API probes are wrapped) and returns a
  // well-formed CodecSupport. We probe a representative decode AND encode query plus an empty-codec query.
  for (const q of nodeCodecProbes()) {
    const s = await assertResolves(
      () => d.supports(q),
      `${label} '${d.id}': supports() must not throw (query ${describeQuery(q)})`,
    );
    assert(
      typeof s === 'object' && s !== null && typeof (s as CodecSupport).supported === 'boolean',
      `${label} '${d.id}': supports() must return { supported: boolean } (query ${describeQuery(q)})`,
    );
    // Honest miss: a browser/WASM tier with no API/core in Node must answer `false`, never a phantom yes.
    assert(
      (s as CodecSupport).supported === false,
      `${label} '${d.id}': a non-Node tier must report supported:false in Node, not a phantom capability (query ${describeQuery(q)})`,
    );
  }
}

/**
 * Node-checkable conformance facets for a {@link FilterDriver} whose `supports()` is environment-dependent
 * (GPU substrates need WebGPU/`OffscreenCanvas`/`VideoFrame`; the audio-dsp `native` substrate needs
 * `AudioData`) — all absent in Node, so each honestly returns `false`. Asserts identity, a valid substrate,
 * and `supports()` honesty + total-function behavior; the browser harness extends this with the
 * true-support + `createFilter` stream facets.
 */
export function assertFilterDriverNodeFacets(d: FilterDriver): void {
  const label = 'FilterDriver';
  assertDriverBase(d, 'filter', label);
  assert(
    SUBSTRATES.includes(d.substrate),
    `${label} '${d.id}': substrate '${d.substrate}' is not valid`,
  );
  for (const f of nodeFilterProbes()) {
    let result: boolean | undefined;
    let threw = false;
    try {
      result = d.supports(f);
    } catch {
      threw = true;
    }
    assert(!threw, `${label} '${d.id}': supports() must not throw (spec ${f.type})`);
    assert(
      typeof result === 'boolean',
      `${label} '${d.id}': supports() must return a boolean (spec ${f.type})`,
    );
    assert(
      result === false,
      `${label} '${d.id}': a GPU/native substrate must report false in Node (spec ${f.type})`,
    );
  }
}

/** Cases used to exercise a {@link FilterDriver}. */
export interface FilterConformanceCase {
  supported: FilterSpec;
  unsupported: FilterSpec;
}

/** Assert a {@link FilterDriver} obeys the contract. */
export function assertFilterDriverConforms(d: FilterDriver, c: FilterConformanceCase): void {
  const label = 'FilterDriver';
  assertDriverBase(d, 'filter', label);
  assert(
    SUBSTRATES.includes(d.substrate),
    `${label} '${d.id}': substrate '${d.substrate}' is not valid`,
  );

  assert(d.supports(c.supported) === true, `${label} '${d.id}': must support its declared spec`);
  assert(
    d.supports(c.unsupported) === false,
    `${label} '${d.id}': must not support its declared unsupported spec`,
  );
  assert(
    isTransformStreamLike(d.createFilter(c.supported)),
    `${label} '${d.id}': createFilter must return a TransformStream`,
  );
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

/**
 * Representative queries spanning decode + encode + a garbage codec, used to exercise a codec driver's
 * `supports()` as a total function in Node. The configs are minimal-but-valid WebCodecs shapes; a driver
 * must answer (not throw) for all of them regardless of whether it serves the codec.
 */
function nodeCodecProbes(): readonly CodecQuery[] {
  return [
    { mediaType: 'video', direction: 'decode', config: { codec: 'avc1.42001e' } },
    {
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    },
    {
      mediaType: 'video',
      direction: 'encode',
      config: { codec: 'avc1.42001e', width: 64, height: 64 },
    },
    {
      mediaType: 'audio',
      direction: 'encode',
      config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    },
    { mediaType: 'video', direction: 'decode', config: { codec: '' } }, // garbage: must not throw
  ];
}

/** Representative filter specs spanning every video + audio op family, for `supports()` total-function checks. */
function nodeFilterProbes(): readonly FilterSpec[] {
  return [
    { mediaType: 'video', type: 'resize', width: 64, height: 64 },
    { mediaType: 'video', type: 'crop', x: 0, y: 0, width: 32, height: 32 },
    { mediaType: 'video', type: 'rotate', degrees: 90 },
    { mediaType: 'video', type: 'flip', axis: 'h' },
    { mediaType: 'video', type: 'colorspace', to: 'srgb' },
    { mediaType: 'video', type: 'tonemap', to: 'sdr' },
    { mediaType: 'audio', type: 'resample', sampleRate: 44100 },
    { mediaType: 'audio', type: 'remix', channels: 1 },
    { mediaType: 'audio', type: 'gain', db: -3 },
  ];
}

/** Run an async thunk, converting any throw into a {@link ConformanceError} with `msg`; return its value. */
async function assertResolves<T>(fn: () => Promise<T>, msg: string): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new ConformanceError(msg);
  }
}

function describeQuery(q: CodecQuery): string {
  return `${q.mediaType}/${q.direction}/${q.config.codec || '<empty>'}`;
}

function isMuxerLike(x: unknown): boolean {
  const m = x as { output?: unknown; addTrack?: unknown; write?: unknown; finalize?: unknown };
  return (
    typeof x === 'object' &&
    x !== null &&
    m.output instanceof ReadableStream &&
    typeof m.addTrack === 'function' &&
    typeof m.write === 'function' &&
    typeof m.finalize === 'function'
  );
}

async function assertDoesNotThrow(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch {
    throw new ConformanceError(msg);
  }
}

/** Assert `fn` returns a value satisfying `ok` (default: TransformStream-like) or throws a MediaError. */
function assertStreamOrMediaError(
  fn: () => unknown,
  msg: string,
  ok: (x: unknown) => boolean = isTransformStreamLike,
): void {
  try {
    assert(ok(fn()), msg);
  } catch (e) {
    if (e instanceof ConformanceError) throw e;
    assert(e instanceof MediaError, `${msg} (threw a non-MediaError: ${describe(e)})`);
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
