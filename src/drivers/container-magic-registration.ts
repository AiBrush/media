/**
 * The magic-head half of the query-selective first-party container registration, kept small enough to
 * live in the eager kernel.
 *
 * A name-free byte source (`media.demux(bytes)`, an unlabeled blob) reaches the router with a head and
 * no hint. Recognizing that head here lets the engine import the one driver module the operation needs
 * directly, instead of first fetching the selective-registration module to learn the same thing — two
 * serialized chunk round trips on the very first operation. The extension/MIME specs and the audio
 * sniffers stay in `default-container-registration.ts`, which re-exports these so the table has one
 * definition.
 */

import type { ContainerQuery, DriverModule, Registry } from '../contracts/driver.ts';

export interface MagicContainerSpec {
  /** The exact id of the driver this spec's `load()` registers — pins resolve against it. */
  readonly id: string;
  readonly matches: (query: ContainerQuery) => boolean;
  readonly load: () => Promise<DriverModule>;
}

/**
 * Only the unambiguous ISO-BMFF top-level box types count (`ftyp`, `styp`, `moov` at offset 4); anything
 * else returns false and keeps the complete established fallback.
 */
export function matchesIsoBmffMagic(query: ContainerQuery): boolean {
  const head = query.head;
  if (query.direction !== 'demux' || head === undefined || head.byteLength < 8) return false;
  const b4 = head[4];
  // `ftyp` / `styp` share their last three bytes; `moov` is the remaining unambiguous top-level type.
  return head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    ? b4 === 0x66 || b4 === 0x73
    : b4 === 0x6d && head[5] === 0x6f && head[6] === 0x6f && head[7] === 0x76;
}

/** Matroska/WebM's EBML header id (0x1A45DFA3) is equally definite. */
export function matchesMatroskaMagic(query: ContainerQuery): boolean {
  const head = query.head;
  if (query.direction !== 'demux' || head === undefined || head.byteLength < 4) return false;
  return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

const MP4_MIMES = ['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a'] as const;
const MATROSKA_MIMES = [
  'video/webm',
  'audio/webm',
  'video/x-matroska',
  'audio/x-matroska',
] as const;

export function matchesDemuxFamily(
  query: ContainerQuery,
  extensions: readonly string[],
  mimes: readonly string[],
): boolean {
  if (query.direction !== 'demux') return false;
  const extension = query.extension?.toLowerCase();
  if (extension !== undefined && extensions.includes(extension)) return true;
  const mime = query.mime?.toLowerCase().split(';', 1)[0]?.trim();
  return mime !== undefined && mimes.includes(mime);
}

/** Shared with the lazy selective table so the two never drift. */

/**
 * The two video container families a demux query identifies on its own — by definite magic, or by the
 * extension/MIME hint every named source carries. Both routes name exactly one driver module, so the
 * engine can load it without the selective-registration table.
 */
export const MAGIC_CONTAINERS: readonly MagicContainerSpec[] = [
  {
    id: 'mp4',
    matches: (query) =>
      matchesDemuxFamily(query, ['mp4', 'mov', 'm4a', 'm4v', 'qt'], MP4_MIMES) ||
      matchesIsoBmffMagic(query),
    load: () => import('./mp4/mp4-lazy-driver.ts').then((module) => module.Mp4LazyModule),
  },
  {
    id: 'webm',
    matches: (query) =>
      matchesDemuxFamily(query, ['webm', 'mkv', 'mka'], MATROSKA_MIMES) ||
      matchesMatroskaMagic(query),
    load: () => import('./webm/webm-driver.ts').then((module) => module.WebmModule),
  },
];

/**
 * Register the one first-party container a definite magic head names. `false` means no magic claimed
 * the head (or a pin excludes the claimant); the caller then takes the full selective/register-all path.
 */
export async function registerContainerForMagicHead(
  registry: Registry,
  query: ContainerQuery,
  pinDriver: string | undefined,
  beforeRegister?: () => void,
): Promise<boolean> {
  for (const spec of MAGIC_CONTAINERS) {
    if (pinDriver !== undefined && spec.id !== pinDriver) continue;
    if (!spec.matches(query)) continue;
    const module = await spec.load();
    beforeRegister?.();
    module.register(registry);
    return true;
  }
  return false;
}
