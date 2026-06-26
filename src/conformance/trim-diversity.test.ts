/**
 * Keyframe-trim diversity (task §3.F.19): the keyframe-trim oracle must hold across a MATRIX of ≥5 real
 * MP4 fixtures (codecs/resolutions/durations), not one canned asset (anti-overfitting, doc 11 §5). MP4
 * keyframe trim is a pure byte stream-copy (`Mp4Driver.streamCopy` with a `trim` range), so it runs in Node;
 * we trim a real sub-range, re-demux the output, and assert the strict structural oracle:
 *   - the output is a valid MP4 with the same track set,
 *   - a strict sub-range produces FEWER packets than the full file (a genuine cut, not a passthrough),
 *   - the video track of the trimmed output STARTS on a keyframe (so it decodes), and
 *   - every trimmed packet's bytes are a subset of the source (lossless copy — no re-encode/corruption).
 *
 * **accurate-trim is browser-only** (it re-encodes the GOP head through the WebCodecs codec seam, which
 * needs `VideoFrame`/`VideoEncoder` — absent in Node), so the frame-accurate boundary digests are asserted
 * in the Playwright browser harness; here we validate the Node-feasible keyframe path across the matrix.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../contracts/driver.ts';
import { Mp4Driver, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { sha256Hex } from '../util/digest.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

function source(bytes: Uint8Array): ByteSource {
  return {
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(bytes);
          c.close();
        },
      }),
    size: bytes.byteLength,
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** The MP4 driver always provides `streamCopy` (a documented invariant); narrow the optional method once. */
function mp4StreamCopy(): NonNullable<typeof Mp4Driver.streamCopy> {
  const fn = Mp4Driver.streamCopy;
  if (!fn) throw new Error('the MP4 driver must provide streamCopy');
  return fn.bind(Mp4Driver);
}

async function loadBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
}

interface PacketRow {
  trackId: number;
  sizeBytes: number;
  ptsUs: number;
  keyframe: boolean | undefined;
}
async function packetTable(bytes: Uint8Array): Promise<PacketRow[]> {
  const demuxer = await Mp4Driver.demux(source(bytes));
  try {
    return (demuxer.packetTable?.() ?? []).map((p) => ({
      trackId: p.trackId,
      sizeBytes: p.sizeBytes,
      ptsUs: p.ptsUs,
      keyframe: p.keyframe,
    }));
  } finally {
    await demuxer.close();
  }
}
async function durationSec(bytes: Uint8Array): Promise<number> {
  const table = await packetTable(bytes);
  return Math.max(...table.map((p) => p.ptsUs / 1e6));
}

/** ≥5 real non-fragmented MP4 fixtures with complete sample tables (keyframe-trim-able in Node). */
const TRIM_FIXTURES = [
  'movie_5.mp4',
  'bear-1280x720.mp4',
  'test.mp4',
  'bear-4k-hevc.mp4',
  'bear-hevc-10bit-hdr10.mp4',
  'obs-remux-variable-aac.mp4',
] as const;

describe('keyframe-trim diversity — strict structural oracle over ≥5 real MP4 fixtures', () => {
  it('the matrix has ≥5 real fixtures', () => {
    expect(TRIM_FIXTURES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(TRIM_FIXTURES)(
    '%s: a sub-range keyframe trim cuts packets, stays valid, and starts on a keyframe',
    async (id) => {
      const input = await loadBytes(id);
      const full = await packetTable(input);
      expect(full.length, `${id}: source has packets`).toBeGreaterThan(0);
      const dur = await durationSec(input);
      // Trim the middle third — a strict sub-range that must drop packets at both ends.
      const start = dur / 3;
      const end = (dur * 2) / 3;
      const trimmed = await collect(
        await mp4StreamCopy()(source(input), { trim: { startSec: start, endSec: end } }),
      );

      // (1) valid MP4 with the same track set.
      const movie = await readMovie(ra(trimmed));
      const srcMovie = await readMovie(ra(input));
      expect(movie.tracks.length, `${id}: track count preserved`).toBe(srcMovie.tracks.length);

      // (2) a genuine cut: fewer packets than the full file.
      const trimTable = await packetTable(trimmed);
      expect(trimTable.length, `${id}: trim cuts packets`).toBeGreaterThan(0);
      expect(trimTable.length, `${id}: trim < full`).toBeLessThan(full.length);

      // (3) the video track of the trimmed output starts on a keyframe (decodable).
      const videoRows = trimTable.filter((p) => p.keyframe !== undefined);
      if (videoRows.length > 0) {
        const firstVideo = videoRows.reduce((a, b) => (b.ptsUs < a.ptsUs ? b : a));
        expect(firstVideo.keyframe, `${id}: trimmed video starts on a keyframe`).toBe(true);
      }
    },
  );

  it('every trimmed packet is a lossless byte-subset of the source (no re-encode/corruption)', async () => {
    // Use a fixture whose payload bytes we can hash per packet via the demuxer's sample data.
    const id = 'movie_5.mp4';
    const input = await loadBytes(id);
    const srcMovie = await readMovie(ra(input));
    const { muxTracksFromMovie } = await import('../drivers/mp4/mp4-driver.ts');
    const srcTracks = await muxTracksFromMovie(ra(input), srcMovie);
    const srcShas = new Set<string>();
    for (const tr of srcTracks)
      for (const s of tr.samples) srcShas.add(await sha256Hex(copy(s.data)));

    const dur = await durationSec(input);
    const trimmed = await collect(
      await mp4StreamCopy()(source(input), { trim: { startSec: 0, endSec: dur / 2 } }),
    );
    const trimMovie = await readMovie(ra(trimmed));
    const trimTracks = await muxTracksFromMovie(ra(trimmed), trimMovie);
    let checked = 0;
    for (const tr of trimTracks)
      for (const s of tr.samples) {
        expect(
          srcShas.has(await sha256Hex(copy(s.data))),
          'trimmed sample is a verbatim source sample',
        ).toBe(true);
        checked++;
      }
    expect(checked, 'real samples checked').toBeGreaterThan(0);
  });

  it('the oracle can fail — the FULL-range trim is NOT smaller than the source (no false cut)', async () => {
    const input = await loadBytes('movie_5.mp4');
    const full = await packetTable(input);
    const dur = await durationSec(input);
    const whole = await collect(
      await mp4StreamCopy()(source(input), { trim: { startSec: 0, endSec: dur + 1 } }),
    );
    const wholeTable = await packetTable(whole);
    // A full-range trim keeps every packet — so "trim always cuts" would be a false oracle; we assert equality here.
    expect(wholeTable.length).toBe(full.length);
  });
});

/** Copy a byte view into a fresh `Uint8Array<ArrayBuffer>` (so it satisfies `BufferSource` for WebCrypto). */
function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}
