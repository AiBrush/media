/**
 * Shared HTTP length/range header parsers (docs/architecture/sources.md §5 item 4; RFC 9110 §8.6
 * `Content-Length`, §14.4 `Content-Range`). The single definition used by every URL-backed read
 * path — the fetch transport in `source.ts` and the body-free size probe in `url-size.ts` — so
 * total-length semantics can never drift between them. Values are `1*DIGIT` per the RFC: anything
 * else (signs, decimals, hex, unsafe magnitudes) is honest `undefined`, never a guess.
 */

const DIGITS_ONLY = /^\d+$/;

/** Parse one `1*DIGIT` token into a safe non-negative integer, or `undefined`. */
function parseByteTotal(raw: string): number | undefined {
  const token = raw.trim();
  if (!DIGITS_ONLY.test(token)) return undefined;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Parse a non-negative integer `Content-Length`, or `undefined` if absent/malformed. */
export function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('Content-Length');
  return raw === null ? undefined : parseByteTotal(raw);
}

/**
 * Parse the `total` from `Content-Range: bytes <start>-<end>/<total>` — including the `416`
 * unsatisfied-range form, where the range part before the slash is `*`. A `*` or absent total
 * (unknown length) ⇒ `undefined`.
 */
export function parseContentRangeTotal(value: string | null): number | undefined {
  if (value === null) return undefined;
  const slash = value.lastIndexOf('/');
  if (slash < 0) return undefined;
  const tail = value.slice(slash + 1);
  if (tail.trim() === '*') return undefined;
  return parseByteTotal(tail);
}
