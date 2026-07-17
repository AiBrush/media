/**
 * The capability registry (docs/architecture/03 §4, 05 §2) — holds registered drivers by kind so the
 * router can select among them. Populated as driver modules are (lazily) imported.
 *
 * Registration enforces the {@link DRIVER_API_VERSION} compatibility window (05 §5): a driver built
 * against an unsupported contract major is refused at registration with a typed `driver-incompatible`
 * error, never a later crash. Registration is **idempotent by id** so re-importing a driver chunk
 * (HMR, double dynamic-import) is safe.
 */

import type { ImageOps } from '../codecs/image/image-driver.ts';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverBase,
  type FilterDriver,
  OPTIONAL_CONTAINER_CAPABILITIES,
  type Registry as RegistryContract,
  type RegistryView,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';

export type { RegistryView } from '../contracts/driver.ts';

/**
 * The set of contract majors this core accepts: the current major, plus the previous one once a real
 * previous major (≥ 1) exists (05 §5). Major 0 never named a shipped contract, so it is never accepted.
 */
export function supportedApiVersions(): readonly number[] {
  const prev = DRIVER_API_VERSION - 1;
  return prev >= 1 ? [DRIVER_API_VERSION, prev] : [DRIVER_API_VERSION];
}

/** True when a driver's declared `apiVersion` falls inside the supported window. */
export function isApiVersionSupported(apiVersion: number): boolean {
  return supportedApiVersions().includes(apiVersion);
}

/**
 * The concrete capability registry. Implements the write-side {@link RegistryContract} that driver
 * modules use, plus the read-side {@link RegistryView} the router uses.
 */
export class Registry implements RegistryContract, RegistryView {
  readonly #codecs = new Map<string, CodecDriver>();
  readonly #containers = new Map<string, ContainerDriver>();
  readonly #filters = new Map<string, FilterDriver>();
  #imageOps: ImageOps | undefined;

  addCodec(d: CodecDriver): void {
    this.#add(this.#codecs, d);
  }

  addContainer(d: ContainerDriver): void {
    this.#add(this.#containers, d);
  }

  addFilter(d: FilterDriver): void {
    this.#add(this.#filters, d);
  }

  addImageOps(ops: ImageOps): void {
    this.#imageOps ??= ops;
  }

  codecs(): readonly CodecDriver[] {
    return [...this.#codecs.values()];
  }

  containers(): readonly ContainerDriver[] {
    return [...this.#containers.values()];
  }

  filters(): readonly FilterDriver[] {
    return [...this.#filters.values()];
  }

  imageOps(): ImageOps | undefined {
    return this.#imageOps;
  }

  /** True when a driver id of the given kind is already registered. */
  has(kind: DriverBase & { kind: string }): boolean {
    return this.#mapFor(kind.kind).has(kind.id);
  }

  #add<D extends DriverBase>(into: Map<string, D>, driver: D): void {
    if (!isApiVersionSupported(driver.apiVersion)) {
      throw new MediaError(
        'driver-incompatible',
        `driver '${driver.id}' apiVersion ${driver.apiVersion} unsupported`,
        { got: driver.apiVersion, supported: supportedApiVersions() },
      );
    }
    assertHonestCapabilities(driver);
    // Idempotent by id: the first registration wins — a re-import of the same chunk is a safe no-op —
    // unless a later same-id driver carries a strictly wider capability surface (e.g. the full
    // demux+mux module arriving after its mux-only sibling), which then supersedes it so op order can
    // never silently drop a capability.
    const existing = into.get(driver.id);
    if (existing !== undefined && !isStrictlyMoreCapable(driver, existing)) return;
    into.set(driver.id, driver);
  }

  #mapFor(kind: string): Map<string, DriverBase> {
    switch (kind) {
      case 'codec':
        return this.#codecs;
      case 'container':
        return this.#containers;
      case 'filter':
        return this.#filters;
      default:
        throw new MediaError('driver-incompatible', `unknown driver kind '${kind}'`, { kind });
    }
  }
}

/** True when the driver actually exposes an advertised member (a function, or a `true` flag). */
function implementsCapability(driver: DriverBase, capability: string): boolean {
  const member: unknown = Reflect.get(driver, capability);
  return typeof member === 'function' || member === true;
}

/**
 * Refuse a dishonest {@link DriverBase.capabilities} advertisement at registration — a driver claiming
 * an optional member it does not implement would otherwise route work into a call-time miss.
 */
function assertHonestCapabilities(driver: DriverBase): void {
  for (const capability of driver.capabilities ?? []) {
    if (implementsCapability(driver, capability)) continue;
    throw new MediaError(
      'driver-incompatible',
      `driver '${driver.id}' advertises capability '${capability}' without implementing it`,
      { id: driver.id, capability },
    );
  }
}

/**
 * The comparable capability surface of a driver: its declared {@link DriverBase.capabilities} plus, for
 * containers, every implemented optional contract member. Codec/filter surfaces are fixed by their
 * mandatory methods, so undeclared ones compare as empty (first-wins is preserved for them).
 */
function capabilitySurface(driver: DriverBase): ReadonlySet<string> {
  const surface = new Set<string>(driver.capabilities ?? []);
  for (const capability of OPTIONAL_CONTAINER_CAPABILITIES) {
    if (implementsCapability(driver, capability)) surface.add(capability);
  }
  return surface;
}

/** True when `next`'s surface is a strict superset of `prev`'s — everything kept, something gained. */
function isStrictlyMoreCapable(next: DriverBase, prev: DriverBase): boolean {
  const nextSurface = capabilitySurface(next);
  const prevSurface = capabilitySurface(prev);
  if (nextSurface.size <= prevSurface.size) return false;
  for (const capability of prevSurface) {
    if (!nextSurface.has(capability)) return false;
  }
  return true;
}
