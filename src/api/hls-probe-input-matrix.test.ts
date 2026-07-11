/**
 * Public HLS AES-128 probe matrix, independent of the acceptance harness.
 *
 * Every success case resolves a real, multi-segment encrypted playlist from the repository's ffmpeg /
 * OpenSSL-baked corpus. Full resource URLs are checked so a basename-only fallback cannot pass. The
 * boundary cases use two real TS programs behind byte-identical relative manifests to prove why detached
 * bytes cannot recover a missing playlist origin, then reproduce the exact MPEG-TS error from raw AES-CBC
 * ciphertext that contains no manifest/key/IV context.
 */

import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHlsPlaylist } from '../drivers/hls/hls-source.ts';
import { type MediaInput, fromURL } from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import type { MediaInfo } from './types.ts';

const FIXTURE_ROOT = new URL('../../fixtures/media-derived/hls-aes128/', import.meta.url).pathname;
const MEDIA_ROOT = new URL('../../fixtures/media/', import.meta.url).pathname;
const WEB_ORIGIN = 'https://media.example.test';
const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function responseBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

function responseAt(body: BodyInit | null, url: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  return response;
}

async function variantManifest(id: string): Promise<string> {
  return readFile(join(FIXTURE_ROOT, id, 'media.m3u8'), 'utf8');
}

function manifestUrl(id: string): string {
  return `${WEB_ORIGIN}/hls/${id}/media.m3u8`;
}

function absoluteManifestUris(text: string, baseUrl: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          return `URI="${new URL(uri, baseUrl).href}"`;
        });
      }
      return line.length === 0 ? line : new URL(line, baseUrl).href;
    })
    .join('\n');
}

interface InstalledFetch {
  readonly seen: string[];
  readonly ambientUrl: string;
}

/** Serve exactly one baked variant; a request resolved into any other directory is a real 404. */
function installVariantFetch(id: string): InstalledFetch {
  const directoryUrl = new URL('.', manifestUrl(id)).href;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const ambient = typeof location === 'undefined' ? directoryUrl : location.href;
    const href = new URL(raw, ambient).href;
    seen.push(href);
    if (!href.startsWith(directoryUrl)) return new Response(null, { status: 404 });
    const name = new URL(href).pathname.split('/').pop() ?? '';
    try {
      const bytes = new Uint8Array(await readFile(join(FIXTURE_ROOT, id, name)));
      return new Response(responseBody(bytes), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }) as typeof fetch;
  return { seen, ambientUrl: `${directoryUrl}page.html` };
}

function manifestStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes.subarray(0, 5));
      controller.enqueue(bytes.subarray(5, 11));
      controller.enqueue(bytes.subarray(11));
      controller.close();
    },
  });
}

function assertRealTsProbe(info: MediaInfo): void {
  expect(info.container).toBe('ts');
  expect(info.durationSec).toBeGreaterThan(4);
  expect(info.tracks.map((track) => track.type)).toEqual(
    expect.arrayContaining(['video', 'audio']),
  );
  const video = info.tracks.find((track) => track.type === 'video');
  expect(video?.codec).toBe('h264');
  expect(video?.width).toBe(160);
  expect(video?.height).toBe(120);
}

async function probe(input: MediaInput): Promise<MediaInfo> {
  return createMedia().probe(input);
}

describe('public probe — real HLS AES-128 input-shape matrix', () => {
  it('absolute URL string: explicit IV, six encrypted MPEG-TS segments', async () => {
    const fetch = installVariantFetch('ffmpeg-explicit-seq47');
    assertRealTsProbe(await probe(manifestUrl('ffmpeg-explicit-seq47')));
    expect(fetch.seen).toContain(`${WEB_ORIGIN}/hls/ffmpeg-explicit-seq47/k1.bin`);
    expect(fetch.seen).toContain(`${WEB_ORIGIN}/hls/ffmpeg-explicit-seq47/seg052.ts`);
  });

  it('absolute URL-backed Source retains the manifest base', async () => {
    const fetch = installVariantFetch('ffmpeg-explicit-seq47');
    assertRealTsProbe(await probe(fromURL(manifestUrl('ffmpeg-explicit-seq47'))));
    expect(fetch.seen.some((href) => href.endsWith('/seg047.ts'))).toBe(true);
  });

  it('uses the final response URL after an HTTP redirect as the relative-resource base', async () => {
    const id = 'ffmpeg-explicit-seq47';
    const requestUrl = 'https://edge.example.test/watch/master.m3u8';
    const finalUrl = manifestUrl(id);
    const finalDirectory = new URL('.', finalUrl).href;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const href = input instanceof Request ? input.url : String(input);
      seen.push(href);
      if (href === requestUrl) {
        return responseAt(
          responseBody(new TextEncoder().encode(await variantManifest(id))),
          finalUrl,
        );
      }
      if (!href.startsWith(finalDirectory)) return responseAt(null, href, 404);
      const name = new URL(href).pathname.split('/').pop() ?? '';
      try {
        return responseAt(
          responseBody(new Uint8Array(await readFile(join(FIXTURE_ROOT, id, name)))),
          href,
        );
      } catch {
        return responseAt(null, href, 404);
      }
    }) as typeof fetch;

    assertRealTsProbe(await probe(requestUrl));
    assertRealTsProbe(await probe(fromURL(requestUrl)));
    assertRealTsProbe(await probe(fromURL(requestUrl, { rangeRequests: false })));
    expect(seen).toContain(`${finalDirectory}k1.bin`);
    expect(seen).not.toContain('https://edge.example.test/watch/k1.bin');
  });

  it('root-relative URL string resolves against browser location', async () => {
    const fetch = installVariantFetch('ffmpeg-explicit-seq47');
    vi.stubGlobal('location', new URL(`${WEB_ORIGIN}/app/player.html`));
    assertRealTsProbe(await probe('/hls/ffmpeg-explicit-seq47/media.m3u8'));
    expect(fetch.seen).not.toContain(`${WEB_ORIGIN}/app/seg047.ts`);
  });

  it('root-relative URL-backed Source resolves against browser location', async () => {
    const fetch = installVariantFetch('ffmpeg-explicit-seq47');
    vi.stubGlobal('location', new URL(`${WEB_ORIGIN}/app/player.html`));
    assertRealTsProbe(await probe(fromURL('/hls/ffmpeg-explicit-seq47/media.m3u8')));
    expect(fetch.seen).not.toContain(`${WEB_ORIGIN}/app/k1.bin`);
  });

  it('File/Blob manifest with absolute key and segment URIs needs no ambient base', async () => {
    installVariantFetch('ffmpeg-explicit-seq47');
    const text = absoluteManifestUris(
      await variantManifest('ffmpeg-explicit-seq47'),
      manifestUrl('ffmpeg-explicit-seq47'),
    );
    const file = new File([text], 'detached.m3u8', {
      type: 'application/vnd.apple.mpegurl',
    });
    assertRealTsProbe(await probe(file));
    assertRealTsProbe(await probe(new Blob([text], { type: 'application/vnd.apple.mpegurl' })));
  });

  it('detached Uint8Array and replayed stream work only with a matching ambient resource resolver', async () => {
    const fetch = installVariantFetch('ffmpeg-explicit-seq47');
    vi.stubGlobal('location', new URL(fetch.ambientUrl));
    const bytes = new TextEncoder().encode(await variantManifest('ffmpeg-explicit-seq47'));
    assertRealTsProbe(await probe(bytes));
    assertRealTsProbe(await probe(manifestStream(bytes)));
  });

  for (const id of ['implicit-seq47', 'rotation'] as const) {
    it(`${id}: URL probe covers implicit IV / key rotation across every segment`, async () => {
      const fetch = installVariantFetch(id);
      assertRealTsProbe(await probe(manifestUrl(id)));
      expect(fetch.seen.some((href) => href.endsWith('/k1.bin'))).toBe(true);
      if (id === 'rotation') expect(fetch.seen.some((href) => href.endsWith('/k2.bin'))).toBe(true);
    });
  }
});

function encryptSegment(clear: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return new Uint8Array(Buffer.concat([cipher.update(clear), cipher.final()]));
}

function collisionManifest(iv: Uint8Array): string {
  const ivHex = [...iv].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${ivHex}`,
    '#EXTINF:10.0,',
    'segment.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

interface CollisionProgram {
  readonly key: Uint8Array;
  readonly cipher: Uint8Array;
}

function installCollisionFetch(
  manifest: string,
  programs: Readonly<Record<'a' | 'b', CollisionProgram>>,
  ambientProgram: 'a' | 'b',
): void {
  const ambient = `${WEB_ORIGIN}/program-${ambientProgram}/page.html`;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, ambient);
    const match = /^\/program-(a|b)\/(media\.m3u8|key\.bin|segment\.ts)$/.exec(url.pathname);
    if (match === null) return new Response(null, { status: 404 });
    const program = programs[match[1] as 'a' | 'b'];
    const body =
      match[2] === 'media.m3u8'
        ? manifest
        : match[2] === 'key.bin'
          ? responseBody(program.key)
          : responseBody(program.cipher);
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('HLS detached-origin boundary — two valid same-name encrypted programs', () => {
  it('byte-identical manifests select different real media solely by origin; raw ciphertext reproduces the TS-sync error', async () => {
    const clearA = new Uint8Array(await readFile(join(FIXTURE_ROOT, 'clear', 'seg000.ts')));
    const clearB = new Uint8Array(await readFile(join(MEDIA_ROOT, 'bear-1280x720.ts')));
    const iv = Uint8Array.from({ length: 16 }, (_, index) => 0x80 + index);
    const keyA = Uint8Array.from({ length: 16 }, (_, index) => index);
    const keyB = Uint8Array.from({ length: 16 }, (_, index) => 0xf0 - index);
    const programs = {
      a: { key: keyA, cipher: encryptSegment(clearA, keyA, iv) },
      b: { key: keyB, cipher: encryptSegment(clearB, keyB, iv) },
    } as const;
    const manifest = collisionManifest(iv);

    installCollisionFetch(manifest, programs, 'a');
    const selectedA = await probe(`${WEB_ORIGIN}/program-a/media.m3u8`);
    expect(selectedA.tracks.find((track) => track.type === 'video')).toMatchObject({
      width: 160,
      height: 120,
    });

    // These are the exact same manifest bytes, but no playlist URL remains. Browser-relative fetch now
    // legitimately selects program B's same-named 16-byte key + ciphertext and returns different media.
    installCollisionFetch(manifest, programs, 'b');
    const detached = await probe(new TextEncoder().encode(manifest));
    expect(detached.tracks.find((track) => track.type === 'video')).toMatchObject({
      width: 1280,
      height: 720,
    });

    // A raw AES-CBC segment has neither the #EXTM3U signature nor key/IV/playlist duration. Routing it as
    // `video/mp2t` must therefore reach the TS parser as ciphertext and reproduce the observed sync error.
    expect(isHlsPlaylist(programs.a.cipher.subarray(0, 16))).toBe(false);
    const rawError = await probe(
      new Blob([ownedArrayBuffer(programs.a.cipher)], { type: 'video/mp2t' }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(rawError).toBeInstanceOf(Error);
    expect((rawError as Error).message).toContain('not an MPEG-TS stream');
    expect((rawError as Error).message).toContain('no transport sync run found');
  });
});
