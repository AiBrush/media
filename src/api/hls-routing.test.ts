/**
 * Engine-level HLS input auto-resolution (ADR-023 / ADR-183 addendum). HLS `.m3u8` is a source-level
 * transform, not a byte container: `probe`/`demux`/`convert`/`remux` must stitch (+ decrypt) the segments
 * BEFORE the container router runs, or the raw manifest reaches the MPEG-TS driver and fails "not an
 * MPEG-TS stream" — which is exactly the `probe/hls_aes128` harness red. This asserts the engine now
 * detects a manifest input and resolves it to the demuxable segment source. (The decrypt itself is proven
 * byte-exact in `src/drivers/hls/hls-aes128.test.ts`; this covers the engine wiring the driver can't.)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
});
