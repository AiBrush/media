/**
 * HLS playlist parser — structural oracle on REAL `.m3u8` manifests (BUILD_INSTRUCTIONS §6.1/§6.2).
 *
 * Subject media: the two real playlists in the sibling `media-test` corpus (`hls_vod.m3u8` clear,
 * `hls_aes128.m3u8` AES-128) read by direct path, plus the normative RFC 8216 §8.4 master/media examples
 * (a master playlist is plain text, not media — there is no master fixture in the corpus, so the public
 * normative example is the right subject). The oracle is **can-fail**: exact segment count / durations /
 * URIs, `EXT-X-KEY` method+IV+inheritance, master-vs-media classification, URI resolution, and a clean
 * `InputError` on a non-`#EXTM3U` document. A final integration check parses the real clear playlist and
 * probes one of its actual `.ts` segments through the engine — proving HLS reuses the MPEG-TS driver.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { InputError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import {
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  HlsModule,
  parseM3u8,
} from './hls-driver.ts';

const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

async function textFromMediaTest(name: string): Promise<string> {
  return readFile(`${MEDIA_TEST}${name}`, 'utf8');
}
async function bytesFromMediaTest(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

function asMedia(p: ReturnType<typeof parseM3u8>): HlsMediaPlaylist {
  if (p.type !== 'media') throw new Error(`expected a media playlist, got ${p.type}`);
  return p;
}
function asMaster(p: ReturnType<typeof parseM3u8>): HlsMasterPlaylist {
  if (p.type !== 'master') throw new Error(`expected a master playlist, got ${p.type}`);
  return p;
}

describe('parseM3u8 — real clear media playlist (hls_vod.m3u8)', () => {
  it('classifies as a media playlist with its exact attributes and 5 segments', async () => {
    const p = asMedia(parseM3u8(await textFromMediaTest('hls_vod.m3u8')));
    expect(p.version).toBe(3);
    expect(p.targetDuration).toBe(2);
    expect(p.mediaSequence).toBe(0);
    expect(p.playlistType).toBe('VOD');
    expect(p.endList).toBe(true);
    expect(p.segments).toHaveLength(5);
    expect(p.durationSec).toBeCloseTo(10, 6); // 5 × 2.0 s
    // Segment URIs are the verbatim relative names, in order, each EXTINF 2.0, none encrypted.
    expect(p.segments.map((s) => s.uri)).toEqual([
      'hls_vod_000.ts',
      'hls_vod_001.ts',
      'hls_vod_002.ts',
      'hls_vod_003.ts',
      'hls_vod_004.ts',
    ]);
    for (const [i, seg] of p.segments.entries()) {
      expect(seg.durationSec).toBeCloseTo(2.0, 6);
      expect(seg.sequence).toBe(i);
      expect(seg.key).toBeUndefined();
      expect(seg.discontinuity).toBe(false);
    }
  });

  it('resolves relative segment URIs against a base URL when provided', async () => {
    const p = asMedia(
      parseM3u8(await textFromMediaTest('hls_vod.m3u8'), 'https://cdn.test/vod/index.m3u8'),
    );
    expect(p.segments[0]?.uri).toBe('https://cdn.test/vod/hls_vod_000.ts');
    expect(p.segments[4]?.uri).toBe('https://cdn.test/vod/hls_vod_004.ts');
  });
});

describe('parseM3u8 — real AES-128 media playlist (hls_aes128.m3u8)', () => {
  it('parses the EXT-X-KEY (method, key URI, exact IV) and applies it to every segment', async () => {
    const p = asMedia(parseM3u8(await textFromMediaTest('hls_aes128.m3u8')));
    expect(p.segments).toHaveLength(5);
    const expectedIv = Uint8Array.from(
      // IV=0x953e5e232e1585e615d9164ece153cf2 from the fixture's #EXT-X-KEY line.
      [
        0x95, 0x3e, 0x5e, 0x23, 0x2e, 0x15, 0x85, 0xe6, 0x15, 0xd9, 0x16, 0x4e, 0xce, 0x15, 0x3c,
        0xf2,
      ],
    );
    for (const seg of p.segments) {
      expect(seg.key?.method).toBe('AES-128');
      expect(seg.key?.uri).toBe('hls_aes128.key'); // KEY inheritance: one tag covers all 5 segments
      expect(seg.key?.iv).toEqual(expectedIv);
    }
  });

  it('resolves the EXT-X-KEY URI against the media playlist URL', async () => {
    const p = asMedia(
      parseM3u8(
        await textFromMediaTest('hls_aes128.m3u8'),
        'https://cdn.test/fixtures/hls_aes128.m3u8',
      ),
    );
    for (const seg of p.segments) {
      expect(seg.key?.uri).toBe('https://cdn.test/fixtures/hls_aes128.key');
    }
  });
});

describe('parseM3u8 — master (multivariant) playlist (RFC 8216 §8.4)', () => {
  const MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=29.97',
    'hi/index.m3u8',
  ].join('\n');

  it('classifies as a master playlist and parses each variant (bandwidth/resolution/codecs)', () => {
    const p = asMaster(parseM3u8(MASTER, 'https://cdn.test/master.m3u8'));
    expect(p.version).toBe(4);
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0]).toMatchObject({
      uri: 'https://cdn.test/low/index.m3u8',
      bandwidth: 1280000,
      averageBandwidth: 1000000,
      resolution: { width: 640, height: 360 },
      codecs: 'avc1.42e01e,mp4a.40.2',
    });
    expect(p.variants[1]).toMatchObject({
      uri: 'https://cdn.test/hi/index.m3u8',
      bandwidth: 2560000,
      resolution: { width: 1280, height: 720 },
      frameRate: 29.97,
    });
    expect('segments' in p).toBe(false); // a master never carries segments
  });
});

describe('parseM3u8 — tag semantics + robustness', () => {
  it('rejects a document that does not start with #EXTM3U', () => {
    expect(() => parseM3u8('hls_vod_000.ts\n')).toThrowError(InputError);
    expect(() => parseM3u8('')).toThrowError(InputError);
    expect(() => parseM3u8('#EXT-X-VERSION:3\n#EXTM3U\n')).toThrowError(InputError);
  });

  it('handles CRLF endings, blank lines, comments, and a UTF-8 BOM', () => {
    const text = '﻿#EXTM3U\r\n\r\n# a comment\r\n#EXTINF:4.5,Title\r\nseg0.ts\r\n#EXT-X-ENDLIST\r\n';
    const p = asMedia(parseM3u8(text));
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ uri: 'seg0.ts', durationSec: 4.5, title: 'Title' });
    expect(p.endList).toBe(true);
  });

  it('inherits EXT-X-KEY until changed, and METHOD=NONE clears it', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k1.key",IV=0x00000000000000000000000000000001',
      '#EXTINF:2,',
      'enc0.ts',
      '#EXTINF:2,',
      'enc1.ts', // still encrypted (inherited)
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:2,',
      'clear0.ts', // key cleared
    ].join('\n');
    const p = asMedia(parseM3u8(text));
    expect(p.segments[0]?.key?.uri).toBe('k1.key');
    expect(p.segments[1]?.key?.uri).toBe('k1.key');
    expect(p.segments[2]?.key).toBeUndefined();
  });

  it('parses EXT-X-BYTERANGE, EXT-X-MAP, and EXT-X-DISCONTINUITY for fMP4/byte-range variants', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6,',
      '#EXT-X-BYTERANGE:75232@0',
      'main.mp4',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:6,',
      '#EXT-X-BYTERANGE:82112@75232',
      'main.mp4',
    ].join('\n');
    const p = asMedia(parseM3u8(text, 'https://cdn.test/v/index.m3u8'));
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]).toMatchObject({
      byteRange: { length: 75232, offset: 0 },
      map: { uri: 'https://cdn.test/v/init.mp4' },
      discontinuity: false,
    });
    expect(p.segments[1]).toMatchObject({
      byteRange: { length: 82112, offset: 75232 },
      discontinuity: true, // the EXT-X-DISCONTINUITY precedes it
    });
  });

  it('ignores unknown EXT-X tags (forward-compatible) without dropping known structure', () => {
    const text = '#EXTM3U\n#EXT-X-FUTURE-TAG:whatever\n#EXTINF:1,\nseg.ts\n';
    const p = asMedia(parseM3u8(text));
    expect(p.segments).toHaveLength(1);
  });
});

describe('HlsModule — reuses the MPEG-TS driver to demux HLS segments', () => {
  it('registers a container that probes a real .ts segment named by the playlist (end-to-end)', async () => {
    // Parse the real clear playlist, take its first segment name, and probe that actual segment via an
    // engine using only HlsModule — proving the module wires the MPEG-TS driver for HLS .ts segments.
    const playlist = asMedia(parseM3u8(await textFromMediaTest('hls_vod.m3u8')));
    const firstSegmentName = playlist.segments[0]?.uri;
    expect(firstSegmentName).toBe('hls_vod_000.ts');

    const info = await createMedia()
      .use(HlsModule)
      .probe(fromBytes(await bytesFromMediaTest(firstSegmentName ?? ''), { mime: 'video/mp2t' }));
    expect(info.container).toBe('ts');
    expect(info.tracks.find((t) => t.type === 'video')).toMatchObject({ codec: 'h264' });
    expect(info.tracks.find((t) => t.type === 'audio')).toMatchObject({ codec: 'aac' });
  });
});
