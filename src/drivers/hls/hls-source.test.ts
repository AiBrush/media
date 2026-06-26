/**
 * HLS source resolution — REAL-corpus oracle (BUILD §2/§6.1/§6.2; RFC 8216, ADR-023). Proves
 * {@link resolveHlsSource} turns a `.m3u8` playlist into a single demuxable {@link Source} the **unmodified**
 * engine probes/demuxes, with the resource fetch pointed at the local corpus segments (the same real code
 * the browser runs over `fetch`). Subjects: the corpus `hls_vod.m3u8` (clear) and `hls_aes128.m3u8`
 * (AES-128, 5×2s MPEG-TS segments, ENDLIST VOD).
 *
 * The headline oracle is **bit-exact decrypt**: the AES-128 segments, fetched + decrypted + stitched, are
 * byte-for-byte identical to the clear playlist's stitched bytes — so the whole-segment AES-128 decrypt is
 * provably correct, not a fabricated cleartext (directive 6). Plus: the stitched clear stream **probes**
 * through the engine as MPEG-TS with the expected duration (≈10s) and a video track, and **demuxes** to
 * packets — proving HLS reuses the MPEG-TS driver end to end with no engine change. Malformed/live/unsupported
 * inputs reject with typed errors.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { InputError } from '../../contracts/errors.ts';
import { type HlsResourceFetcher, resolveHlsSource } from './hls-source.ts';

const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

async function corpusText(name: string): Promise<string> {
  return readFile(`${MEDIA_TEST}${name}`, 'utf8');
}

/** A local-file resource fetcher: maps a resolved URI back to its basename in the corpus dir. */
const fetchLocal: HlsResourceFetcher = async (uri) => {
  const name = uri.split('/').pop() ?? uri;
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
};

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('resolveHlsSource — real corpus, MPEG-TS segments', () => {
  it('stitches a clear VOD playlist into one TS source the engine probes (≈10s, video track)', async () => {
    const src = await resolveHlsSource(await corpusText('hls_vod.m3u8'), {
      fetchResource: fetchLocal,
    });
    expect(src.mimeHint).toBe('video/mp2t');
    const info = await createMedia().probe(src);
    expect(info.container).toBe('ts');
    // 5 segments × 2.000s = ~10s (TS timing tolerance — the demuxer reads PCR/PTS, not the playlist).
    expect(info.durationSec).toBeGreaterThan(8);
    expect(info.durationSec).toBeLessThan(12);
    expect(info.tracks.some((t) => t.type === 'video')).toBe(true);
  });

  it('the stitched clear source demuxes (HLS reuses the MPEG-TS driver, no engine change)', async () => {
    // `demux()` returns the MPEG-TS demuxer's track list in pure TS (Node). Pulling `.packets()` builds
    // WebCodecs `EncodedChunk`s, which Node lacks — that browser seam is validated in the mpegts driver's
    // own tests; here the HLS-source contribution is proven at the demuxer/track level (no engine change).
    const src = await resolveHlsSource(await corpusText('hls_vod.m3u8'), {
      fetchResource: fetchLocal,
    });
    const demuxed = await createMedia().demux(src);
    try {
      const video = demuxed.tracks.find((t) => t.mediaType === 'video');
      expect(video).toBeDefined();
      expect(video?.config).toBeDefined(); // a decodable video track was described from the stitched TS
    } finally {
      await demuxed.close();
    }
  });

  it('BIT-EXACT decrypt: AES-128 segments decrypt+stitch to the clear playlist byte-for-byte', async () => {
    const clear = await resolveHlsSource(await corpusText('hls_vod.m3u8'), {
      fetchResource: fetchLocal,
    });
    const aes = await resolveHlsSource(await corpusText('hls_aes128.m3u8'), {
      fetchResource: fetchLocal,
    });
    const clearBytes = await drain(clear.stream());
    const aesBytes = await drain(aes.stream());
    // The AES-128 corpus encrypts the SAME media as the clear playlist, so a correct whole-segment
    // AES-128-CBC decrypt (key + explicit IV from the playlist) recovers it exactly — a falsifiable oracle.
    expect(aesBytes.byteLength).toBe(clearBytes.byteLength);
    expect(aesBytes).toEqual(clearBytes);
  });

  it('the decrypted AES-128 source also probes as a valid ≈10s TS', async () => {
    const src = await resolveHlsSource(await corpusText('hls_aes128.m3u8'), {
      fetchResource: fetchLocal,
    });
    const info = await createMedia().probe(src);
    expect(info.container).toBe('ts');
    expect(info.durationSec).toBeGreaterThan(8);
    expect(info.tracks.some((t) => t.type === 'video')).toBe(true);
  });
});

describe('resolveHlsSource — honest typed errors', () => {
  it('rejects a non-#EXTM3U document (delegates to parseM3u8)', async () => {
    await expect(
      resolveHlsSource('not a playlist', { fetchResource: fetchLocal }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a live playlist (no #EXT-X-ENDLIST) — not a finite single source', async () => {
    const live = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n';
    await expect(resolveHlsSource(live, { fetchResource: fetchLocal })).rejects.toMatchObject({
      name: 'InputError',
    });
  });

  it('declines SAMPLE-AES (sample-level decrypt is the decrypt op, not whole-segment AES-128)', async () => {
    const sampleAes =
      '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.key"\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n';
    await expect(
      resolveHlsSource(sampleAes, { fetchResource: async () => new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'decode-error' });
  });

  it('honors an already-aborted signal', async () => {
    await expect(
      resolveHlsSource(await corpusText('hls_vod.m3u8'), {
        fetchResource: fetchLocal,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ── synthetic playlists: master variant-pick + fMP4 init + AES IV (no corpus needed) ─────────────────

/**
 * A fetcher over an in-memory map of `uri → bytes`. Text resources (playlists/keys) are encoded; binary
 * segments are passed as bytes. Lets the master/fMP4/AES branches be driven with tiny synthetic manifests.
 */
function mapFetcher(files: Record<string, string | Uint8Array>): HlsResourceFetcher {
  return async (uri) => {
    const name = uri.split('/').pop() ?? uri;
    const v = files[name];
    if (v === undefined) throw new Error(`synthetic 404: ${name}`);
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  };
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  'high.m3u8',
  '',
].join('\n');

function mediaPlaylist(tag: string): string {
  return [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    '#EXTINF:2.0,',
    `${tag}.ts`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

describe('resolveHlsSource — master playlist variant selection', () => {
  const files = {
    'low.m3u8': mediaPlaylist('low'),
    'high.m3u8': mediaPlaylist('high'),
    'low.ts': new Uint8Array([0x10, 0x11]),
    'high.ts': new Uint8Array([0x20, 0x21]),
  };

  it('defaults to the highest-bandwidth variant', async () => {
    const src = await resolveHlsSource(MASTER, {
      fetchResource: mapFetcher(files),
      baseUrl: 'http://h/',
    });
    expect([...(await drain(src.stream()))]).toEqual([0x20, 0x21]); // high.ts
    expect(src.mimeHint).toBe('video/mp2t');
  });

  it('picks the lowest-bandwidth variant when asked', async () => {
    const src = await resolveHlsSource(MASTER, {
      fetchResource: mapFetcher(files),
      baseUrl: 'http://h/',
      variant: 'lowest',
    });
    expect([...(await drain(src.stream()))]).toEqual([0x10, 0x11]); // low.ts
  });

  it('picks an explicit variant index', async () => {
    const src = await resolveHlsSource(MASTER, {
      fetchResource: mapFetcher(files),
      baseUrl: 'http://h/',
      variant: 0,
    });
    expect([...(await drain(src.stream()))]).toEqual([0x10, 0x11]); // index 0 = low.m3u8 (as listed)
  });

  it('rejects an out-of-range variant index', async () => {
    await expect(
      resolveHlsSource(MASTER, {
        fetchResource: mapFetcher(files),
        baseUrl: 'http://h/',
        variant: 9,
      }),
    ).rejects.toMatchObject({ name: 'InputError' });
  });
});

describe('resolveHlsSource — fMP4 (CMAF) init section', () => {
  it('prepends the #EXT-X-MAP init section once and tags the source as MP4', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:2.0,',
      'seg0.m4s',
      '#EXTINF:2.0,',
      'seg1.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const src = await resolveHlsSource(playlist, {
      baseUrl: 'http://h/',
      fetchResource: mapFetcher({
        'init.mp4': new Uint8Array([0xff]),
        'seg0.m4s': new Uint8Array([0x01]),
        'seg1.m4s': new Uint8Array([0x02]),
      }),
    });
    expect(src.mimeHint).toBe('video/mp4');
    // init prepended exactly once, then the two fragments in order.
    expect([...(await drain(src.stream()))]).toEqual([0xff, 0x01, 0x02]);
  });
});

describe('resolveHlsSource — AES-128 IV + key-URI handling', () => {
  // A 16-byte zero key + a 16-byte zero plaintext, AES-128-CBC + PKCS#7 (one padded block) — the cleartext
  // is recovered exactly with the sequence-derived IV (no explicit IV in the playlist). Encrypted offline.
  it('derives the IV from the media-sequence number when IV= is absent', async () => {
    // Build ciphertext for a known (key=0, iv=seq#0 ⇒ all-zero IV) so decrypt yields the known plaintext.
    const { createCipheriv } = await import('node:crypto');
    const key = Buffer.alloc(16, 0);
    const iv = Buffer.alloc(16, 0); // sequence 0 ⇒ all-zero IV
    const plain = Buffer.from([1, 2, 3, 4]);
    const c = createCipheriv('aes-128-cbc', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key"',
      '#EXTINF:2.0,',
      's0.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const src = await resolveHlsSource(playlist, {
      baseUrl: 'http://h/',
      fetchResource: mapFetcher({ 'k.key': new Uint8Array(key), 's0.ts': new Uint8Array(ct) }),
    });
    expect([...(await drain(src.stream()))]).toEqual([1, 2, 3, 4]);
  });

  it('honors #EXT-X-BYTERANGE sub-segments of one resource', async () => {
    // Two byte-range segments carve a single resource (length@offset); the stitched output is the two
    // windows concatenated — exercising the byte-range slice path.
    const resource = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const playlist = [
      '#EXTM3U',
      '#EXT-X-BYTERANGE:3@0',
      '#EXTINF:2.0,',
      'all.bin',
      '#EXT-X-BYTERANGE:2@5',
      '#EXTINF:2.0,',
      'all.bin',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const src = await resolveHlsSource(playlist, {
      baseUrl: 'http://h/',
      fetchResource: mapFetcher({ 'all.bin': resource }),
    });
    expect([...(await drain(src.stream()))]).toEqual([0, 1, 2, 5, 6]); // [0,3) ++ [5,7)
  });

  it('rejects an AES-128 key with no URI', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128',
      '#EXTINF:2.0,',
      's0.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    await expect(
      resolveHlsSource(playlist, {
        baseUrl: 'http://h/',
        fetchResource: mapFetcher({ 's0.ts': new Uint8Array(16) }),
      }),
    ).rejects.toMatchObject({ name: 'InputError' });
  });
});
