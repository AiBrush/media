import { InputError } from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from './abort.ts';
import { parseContentLength, parseContentRangeTotal } from './http-range.ts';

export async function probeUrlSizeImpl(
  url: string | URL,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const href = typeof url === 'string' ? url : url.href;
  throwIfSourceAborted(signal);
  try {
    const head = await raceAbort(
      fetch(href, {
        method: 'HEAD',
        ...(signal !== undefined ? { signal } : {}),
      }),
      signal,
    );
    if (head.ok) {
      const len = parseContentLength(head.headers);
      if (len !== undefined) return len;
    }
  } catch {
    throwIfSourceAborted(signal);
    // HEAD unsupported / network refusal; fall through to the ranged probe.
  }
  const res = await raceAbort(
    fetch(href, {
      headers: { Range: 'bytes=0-0' },
      ...(signal !== undefined ? { signal } : {}),
    }),
    signal,
  );
  if (!res.ok) {
    throw new InputError(`size probe failed for ${href} (status ${res.status})`);
  }
  await raceAbort(res.arrayBuffer(), signal);
  return res.status === 206
    ? parseContentRangeTotal(res.headers.get('Content-Range'))
    : parseContentLength(res.headers);
}
