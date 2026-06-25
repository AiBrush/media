/**
 * MPEG-TS parsing primitives — framing detection (188 / m2ts-192 / offset) and PES timing, derived from
 * the committed real `h264_720p.head.ts` packets (no synthetic media; the m2ts/offset variants wrap the
 * verbatim 188-byte payloads). These cover the packetisation edge cases the full-file probe does not
 * exercise (m2ts 4-byte prefix, a junk byte run before the first sync), guarding the resync/stride math.
 */

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectFraming, parseTs } from './ts-parse.ts';

const DERIVED = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;
const PACKET = 188;

let ts188: Uint8Array;
beforeAll(async () => {
  ts188 = new Uint8Array(await readFile(`${DERIVED}h264_720p.head.ts`));
});

/** Wrap each verbatim 188-byte packet in a 192-byte m2ts packet (4-byte timestamp prefix). */
function toM2ts(ts: Uint8Array): Uint8Array {
  const n = Math.floor(ts.byteLength / PACKET);
  const out = new Uint8Array(n * 192);
  for (let i = 0; i < n; i++) {
    const stamp = i * 100; // an arbitrary but well-formed 4-byte copy-counter timestamp
    out[i * 192] = (stamp >>> 24) & 0xff;
    out[i * 192 + 1] = (stamp >>> 16) & 0xff;
    out[i * 192 + 2] = (stamp >>> 8) & 0xff;
    out[i * 192 + 3] = stamp & 0xff;
    out.set(ts.subarray(i * PACKET, (i + 1) * PACKET), i * 192 + 4);
  }
  return out;
}

describe('detectFraming', () => {
  it('locks onto plain 188-byte packets at offset 0', () => {
    expect(detectFraming(ts188)).toEqual({ packetSize: 188, start: 0, tsOffset: 0 });
  });

  it('detects m2ts 192-byte packets with a 4-byte prefix (sync at offset 4)', () => {
    expect(detectFraming(toM2ts(ts188))).toEqual({ packetSize: 192, start: 0, tsOffset: 4 });
  });

  it('finds the packet grid after a run of junk bytes before the first sync', () => {
    const shifted = new Uint8Array(7 + ts188.byteLength);
    shifted.set(ts188, 7);
    expect(detectFraming(shifted)).toEqual({ packetSize: 188, start: 7, tsOffset: 0 });
  });

  it('returns undefined for buffers with no transport sync run', () => {
    expect(detectFraming(new Uint8Array(1000))).toBeUndefined(); // all zero
    expect(detectFraming(Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff))).toBeUndefined();
  });

  it('locks on a tiny 2-packet input but needs ≥ 2 packets to confirm a stride', () => {
    // Two real packets are enough to confirm the 188 stride (the short-run acceptance path)…
    expect(detectFraming(ts188.subarray(0, PACKET * 2))).toEqual({
      packetSize: 188,
      start: 0,
      tsOffset: 0,
    });
    // …but a single packet cannot prove a periodic grid (one stray 0x47 ≠ a transport stream).
    expect(detectFraming(ts188.subarray(0, PACKET))).toBeUndefined();
  });
});

describe('parseTs on the m2ts (192-byte) and offset variants of the real slice', () => {
  it('parses the same tracks/dims/first-PTS from m2ts as from plain TS', () => {
    const plain = parseTs(ts188);
    const m2ts = parseTs(toM2ts(ts188));
    const summarize = (p: ReturnType<typeof parseTs>): unknown[] =>
      p.tracks.map((t) => ({
        codec: t.stream.codec,
        type: t.stream.mediaType,
        firstPtsUs: t.units[0]?.ptsUs,
        units: t.units.length,
      }));
    expect(summarize(m2ts)).toEqual(summarize(plain));
    const v = m2ts.tracks[0]?.config as VideoDecoderConfig;
    expect(v).toMatchObject({ codec: 'h264', codedWidth: 1280, codedHeight: 720 });
  });

  it('parses the offset-shifted (junk-prefixed) 188 stream identically', () => {
    const shifted = new Uint8Array(7 + ts188.byteLength);
    shifted.set(ts188, 7);
    expect(parseTs(shifted).tracks.map((t) => t.stream.codec)).toEqual(['h264', 'aac']);
  });
});
