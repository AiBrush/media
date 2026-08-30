/**
 * **Key/clear-sample hygiene** (REQUIREMENTS §5.8, §8.1 — 2.4.3, §5.9).
 *
 * Keys and clear samples MUST NOT be logged, included in telemetry, or retained beyond their required
 * lifetime. Where detailed errors could become an oracle, failure must be indistinguishable in detail to
 * untrusted callers. This module provides the minimal primitives to enforce that contract without fixture
 * branching:
 *
 * - `wipeBytes` — zero-fill a buffer after its crypto lifetime (best-effort, synchronous);
 * - `redactKeys` — produce a redacted view of a KID→key map for reporting (no key material);
 * - `errorLeaksKeyMaterial` — predicate for tests that an error's message/detail inadvertently contains key
 *   hex or clear bytes.
 *
 * The decrypt runner and CENC/HLS paths must keep raw key hex out of `MediaError` messages/details and must
 * wipe temporary decoded key bytes promptly (the caller-owned `keys` record itself is not mutated).
 */

export function wipeBytes(buf: Uint8Array): void {
  buf.fill(0);
}

export function redactKid(kid: string): string {
  if (kid.length <= 8) return '***';
  return `${kid.slice(0, 4)}***${kid.slice(-4)}`;
}

export function redactKeys(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kid of Object.keys(keys)) out[redactKid(kid)] = '[redacted]';
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as unknown as { detail?: unknown }).detail;
    return `${error.message} ${detail === undefined ? '' : JSON.stringify(detail)}`;
  }
  return String(error);
}

export function errorLeaksKeyMaterial(error: unknown, keys: Record<string, string>): boolean {
  const text = errorText(error).toLowerCase();
  for (const hex of Object.values(keys)) {
    if (hex.length >= 8 && text.includes(hex.toLowerCase())) return true;
  }
  return false;
}

export function errorLeaksBytes(error: unknown, bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const hex = [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toLowerCase();
  if (hex.length < 8) return false;
  return errorText(error).toLowerCase().includes(hex);
}
