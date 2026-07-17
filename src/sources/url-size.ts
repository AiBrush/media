import { InputError } from '../contracts/errors.ts';
import { parseContentLength, parseContentRangeTotal } from './http-range.ts';

export async function probeUrlSizeImpl(url: string | URL): Promise<number | undefined> {
  const href = typeof url === 'string' ? url : url.href;
  try {
    const head = await fetch(href, { method: 'HEAD' });
    if (head.ok) {
      const len = parseContentLength(head.headers);
      if (len !== undefined) return len;
    }
  } catch {
    // HEAD unsupported / network refusal; fall through to the ranged probe.
  }
  const res = await fetch(href, { headers: { Range: 'bytes=0-0' } });
  if (!res.ok) {
    throw new InputError(`size probe failed for ${href} (status ${res.status})`);
  }
  await res.arrayBuffer();
  return res.status === 206
    ? parseContentRangeTotal(res.headers.get('Content-Range'))
    : parseContentLength(res.headers);
}
