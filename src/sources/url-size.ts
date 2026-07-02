import { InputError } from '../contracts/errors.ts';

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
    throw new InputError(
      'unsupported-input',
      `size probe failed for ${href} (status ${res.status})`,
    );
  }
  await res.arrayBuffer();
  return res.status === 206
    ? parseContentRangeTotal(res.headers.get('Content-Range'))
    : parseContentLength(res.headers);
}

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('Content-Length');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseContentRangeTotal(value: string | null): number | undefined {
  if (value === null) return undefined;
  const slash = value.lastIndexOf('/');
  if (slash < 0) return undefined;
  const tail = value.slice(slash + 1).trim();
  if (tail === '*' || tail === '') return undefined;
  const n = Number(tail);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
