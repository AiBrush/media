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
const SUBSTRATES: readonly FilterSubstrate[] = ['webgpu', 'webgl', 'canvas2d', 'wasm'];

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
