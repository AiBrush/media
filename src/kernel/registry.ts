/**
 * The capability registry (docs/architecture/03 §4, 05 §2) — holds registered drivers by kind so the
 * router can select among them. Populated as driver modules are (lazily) imported.
 *
 * Registration enforces the {@link DRIVER_API_VERSION} compatibility window (05 §5): a driver built
 * against an unsupported contract major is refused at registration with a typed `driver-incompatible`
 * error, never a later crash. Registration is **idempotent by id** so re-importing a driver chunk
 * (HMR, double dynamic-import) is safe.
 */

import type { ImageOps, ImageRegistry } from '../codecs/image/image-driver.ts';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverBase,
  type FilterDriver,
  type Registry as RegistryContract,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';

/** The read side the router consumes (snapshots in insertion order). */
export interface RegistryView {
  codecs(): readonly CodecDriver[];
  containers(): readonly ContainerDriver[];
  filters(): readonly FilterDriver[];
  imageOps(): ImageOps | undefined;
}

/** The set of contract majors this core accepts: the current and previous major (05 §5). */
export function supportedApiVersions(): readonly number[] {
  const prev = DRIVER_API_VERSION - 1;
  return prev >= 0 ? [DRIVER_API_VERSION, prev] : [DRIVER_API_VERSION];
}

/** True when a driver's declared `apiVersion` falls inside the supported window. */
export function isApiVersionSupported(apiVersion: number): boolean {
  return supportedApiVersions().includes(apiVersion);
}

/**
 * The concrete capability registry. Implements the write-side {@link RegistryContract} that driver
 * modules use, plus the read-side {@link RegistryView} the router uses.
 */
export class Registry implements RegistryContract, RegistryView, ImageRegistry {
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
    // Idempotent by id: the first registration wins; a re-import of the same chunk is a safe no-op.
    if (into.has(driver.id)) return;
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
