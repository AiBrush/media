/**
 * Engine-level HLS input auto-resolution (ADR-023 / ADR-183 addendum). HLS `.m3u8` is a source-level
 * transform, not a byte container: `probe`/`demux`/`convert`/`remux` must stitch (+ decrypt) the segments
 * BEFORE the container router runs, or the raw manifest reaches the MPEG-TS driver and fails "not an
 * MPEG-TS stream" — which is exactly the `probe/hls_aes128` harness red. This asserts the engine now
 * detects a manifest input and resolves it to the demuxable segment source. (The decrypt itself is proven
 * byte-exact in `src/drivers/hls/hls-aes128.test.ts`; this covers the engine wiring the driver can't.)
 */

import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MediaInput, fromURL } from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import type { Container, MediaInfo } from './types.ts';

const realFetch = globalThis.fetch;
const HLS_VOD = new URL(
  '../../fixtures/media-derived/hls-aes128/ffmpeg-explicit-seq47/',
  import.meta.url,
).pathname;
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

async function corpusBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${HLS_VOD}${name}`));
}

interface TargetedProbeEngine {
  probeContainer(input: MediaInput, container: Container): Promise<MediaInfo>;
}

function targetedProbeEngine(): TargetedProbeEngine {
  return createMedia() as ReturnType<typeof createMedia> & TargetedProbeEngine;
}

/** A real MPEG-TS segment from the corpus (H.264 + AAC), so the stitched output demuxes to real tracks. */
async function tsSegment(): Promise<Uint8Array> {
  const path = fileURLToPath(new URL('../../fixtures/media/bear-1280x720.ts', import.meta.url));
  return new Uint8Array(await readFile(path));
}

function playlist(): string {
  return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttps://x.test/s0.ts\n#EXT-X-ENDLIST\n';
}

/**
 * The manifest as the engine sees it from the network/harness: a byte payload tagged with an
 * HLS-family MIME. The engine only content-sniffs inputs whose MIME/extension is HLS-plausible
 * (an `.m3u8`, an `application/vnd.apple.mpegurl`, or — as the harness labels them — `video/mp2t`),
 * so a definite non-HLS container never pays for the sniff.
 */
function manifestInput(): Blob {
  return new Blob([playlist()], { type: 'application/vnd.apple.mpegurl' });
}

/** Serve the manifest (any non-segment URL) and the one TS segment. */
function serve(seg: Uint8Array): void {
  globalThis.fetch = (async (url: unknown): Promise<Response> => {
    // A Uint8Array is a valid BodyInit (BufferSource) at runtime; the bundled lib's ArrayBufferLike vs
    // ArrayBuffer strictness needs the cast.
    const body: BodyInit = String(url).endsWith('s0.ts')
      ? (seg as unknown as BodyInit)
      : playlist();
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('engine HLS input auto-resolution', () => {
  it('probes an HLS manifest by resolving+stitching its segments (not routing the raw manifest to mpegts)', async () => {
    const seg = await tsSegment();
    serve(seg);
    const info = await createMedia().probe(manifestInput());
    expect(info.container).toBe('ts');
    const kinds = info.tracks.map((t) => t.type);
    expect(kinds).toContain('video');
    expect(kinds).toContain('audio');
  });

  it('recognizes a URL-form .m3u8 before MIME is known and resolves relative segment URIs', async () => {
    const seg = await tsSegment();
    const manifestUrl = 'https://x.test/media/index.m3u8?token=abc#variant';
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const href = String(url);
      const bytes = href.endsWith('/media/s0.ts')
        ? (seg as unknown as BodyInit)
        : '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\ns0.ts\n#EXT-X-ENDLIST\n';
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;

    const info = await createMedia().probe(manifestUrl);
    expect(info.container).toBe('ts');
    expect(info.tracks.map((track) => track.type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
  });

  it('retains the manifest URL when a URL-backed Source is passed and decrypts relative AES-128 resources', async () => {
    const clear = await tsSegment();
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    const iv = Uint8Array.from({ length: 16 }, (_, index) => 0xf0 - index);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = new Uint8Array(Buffer.concat([cipher.update(clear), cipher.final()]));
    const manifestUrl = 'https://media.example.test/vod/index.m3u8';
    const keyUrl = 'https://media.example.test/vod/key.bin';
    const segmentUrl = 'https://media.example.test/vod/segment.ts';
    const ivHex = [...iv].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${ivHex}`,
      '#EXTINF:10.0,',
      'segment.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const href = String(url);
      seen.push(href);
      if (href === manifestUrl) return new Response(manifest, { status: 200 });
      if (href === keyUrl) {
        return new Response(key as unknown as BodyInit, { status: 200 });
      }
      if (href === segmentUrl) {
        return new Response(encrypted as unknown as BodyInit, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const info = await createMedia().probe(fromURL(manifestUrl));
    expect(info.container).toBe('ts');
    expect(info.tracks.map((track) => track.type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
    expect(seen).toContain(keyUrl);
    expect(seen).toContain(segmentUrl);
    expect(seen).not.toContain('key.bin');
    expect(seen).not.toContain('segment.ts');
  });

  it('resolves a root-relative URL-backed manifest against the browser location', async () => {
    const segment = await tsSegment();
    const pageUrl = 'https://app.example.test/player/index.html';
    const manifestPath = '/media/vod/index.m3u8';
    const manifestUrl = 'https://app.example.test/media/vod/index.m3u8';
    const segmentUrl = 'https://app.example.test/media/vod/segment.ts';
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10.0,',
      'segment.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    vi.stubGlobal('location', new URL(pageUrl));
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const href = new URL(String(url), pageUrl).href;
      seen.push(href);
      if (href === manifestUrl) return new Response(manifest, { status: 200 });
      if (href === segmentUrl) {
        return new Response(segment as unknown as BodyInit, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const info = await createMedia().probe(fromURL(manifestPath));
    expect(info.container).toBe('ts');
    expect(info.tracks.map((track) => track.type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
    expect(seen).toContain(segmentUrl);
    expect(seen).not.toContain('https://app.example.test/player/segment.ts');
  });

  it('recognizes an unhinted Uint8Array manifest and decrypts the real AES-128 VOD', async () => {
    const manifest = await corpusBytes('media.m3u8');
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const name = String(url).split('/').pop() ?? '';
      const bytes = await corpusBytes(name);
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const info = await createMedia().probe(manifest);
    expect(info.container).toBe('ts');
    expect(info.durationSec).toBeGreaterThan(5);
    expect(info.tracks.map((track) => track.type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
  });

  it('structurally recognizes manifests behind ambiguous MIME and extension hints', async () => {
    const segment = await tsSegment();
    serve(segment);
    const inputs: readonly MediaInput[] = [
      new Blob([playlist()], { type: 'application/octet-stream' }),
      new Blob([playlist()], { type: 'text/plain' }),
      new Blob([playlist()], { type: 'video/mp2t; charset=utf-8' }),
      new File([playlist()], 'detached.bin', { type: 'application/octet-stream' }),
    ];

    for (const input of inputs) {
      const info = await createMedia().probe(input);
      expect(info.container).toBe('ts');
      expect(info.tracks.map((track) => track.type)).toEqual(
        expect.arrayContaining(['video', 'audio']),
      );
    }
  });

  it('replays an unhinted manifest stream through targeted MPEG-TS probe before decrypting', async () => {
    const manifest = await corpusBytes('media.m3u8');
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const name = String(url).split('/').pop() ?? '';
      const bytes = await corpusBytes(name);
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(manifest.subarray(0, 7));
        controller.enqueue(manifest.subarray(7));
        controller.close();
      },
    });

    const info = await targetedProbeEngine().probeContainer(stream, 'ts');
    expect(info.container).toBe('ts');
    expect(info.tracks.map((track) => track.type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
  });

  it('demuxes an HLS manifest to the resolved segment tracks', async () => {
    const seg = await tsSegment();
    serve(seg);
    const demuxed = await createMedia().demux(manifestInput());
    expect(demuxed.tracks.some((t) => t.mediaType === 'video')).toBe(true);
    expect(demuxed.tracks.some((t) => t.mediaType === 'audio')).toBe(true);
  });

  it('leaves a non-HLS input untouched (a plain MP4 still routes to the mp4 container)', async () => {
    const path = fileURLToPath(new URL('../../fixtures/media/movie_5.mp4', import.meta.url));
    const mp4 = new Uint8Array(await readFile(path));
    // A stray fetch would mean the engine mistook the MP4 for a manifest; fail loudly if called.
    globalThis.fetch = (async () => {
      throw new Error('non-HLS input must not trigger HLS resolution');
    }) as unknown as typeof fetch;
    const info = await createMedia().probe(mp4);
    expect(info.container).toBe('mp4');
  });

  it('replays every byte of a non-HLS single-use stream after the manifest peek', async () => {
    const path = fileURLToPath(new URL('../../fixtures/media/movie_5.mp4', import.meta.url));
    const mp4 = new Uint8Array(await readFile(path));
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(mp4.subarray(0, 11));
        controller.enqueue(mp4.subarray(11));
        controller.close();
      },
    });
    const info = await targetedProbeEngine().probeContainer(stream, 'mp4');
    expect(info.container).toBe('mp4');
    expect(info.tracks.some((track) => track.type === 'video')).toBe(true);
  });
});
