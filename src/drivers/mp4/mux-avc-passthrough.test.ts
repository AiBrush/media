/**
 * Regression: AVC-format (`avcC`) samples must be muxed VERBATIM, never re-parsed as Annex-B (conf-killer
 * `ladder_*_h264_180p`, browser-reproduced by agent-validation).
 *
 * The WebCodecs `VideoEncoder` emits **avc-format** chunks — a sequence of 4-byte big-endian NAL lengths,
 * each followed by that many payload bytes — together with an `avcC` `description`. A length prefix whose
 * value is ≤ 0x0000FFFF *contains* the byte pattern `00 00 01` (e.g. a 501-byte NAL → `00 00 01 F5`, or a
 * 257-byte NAL → `00 00 01 01`). The muxer used to detect Annex-B by scanning for that exact start-code
 * pattern, so it mis-split such a length prefix and mangled the sample. The decoder then died on the FIRST
 * frame whose length prefix looked like a start code (in the harness: "4 frames decoded then Decoding
 * error", because the first 4 frames' lengths happened not to contain `00 00 01`).
 *
 * The fix: when an `avcC` `description` is present, a chunk that parses as length-prefixed is passed through
 * unchanged; only a chunk that is genuinely Annex-B is converted. This test drives the pure
 * {@link Mp4Muxer.addChunkStruct} seam (the same path `write()` uses post-`copyTo`) and reads the samples
 * back out of the produced MP4, asserting byte-exact preservation.
 */

import { describe, expect, it } from 'vitest';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import type { ChunkStruct } from './mux.ts';
import { Mp4Muxer } from './mux.ts';

/** avcC for a Constrained-Baseline 320×180 stream (4-byte NAL length: lengthSizeMinusOne = 3). */
const AVCC = new Uint8Array([1, 0x42, 0x00, 0x0d, 0xff, 0xe1, 0x00, 0x00]);

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** One avc-format access unit: a 4-byte big-endian length then `len` payload bytes (filled with `fill`). */
function avcSample(len: number, fill: number): Uint8Array {
  const out = new Uint8Array(4 + len);
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out.fill(fill, 4);
  return out;
}

function chunk(timestampUs: number, key: boolean, data: Uint8Array): ChunkStruct {
  return { timestampUs, durationUs: 33_333, key, data };
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

/** Read the video track's per-sample byte arrays back out of a muxed MP4. */
async function videoSamples(mp4: Uint8Array): Promise<Uint8Array[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === 'video');
  return (tracks[idx]?.samples ?? []).map((s) => s.data);
}

describe('mp4 mux — AVC-format samples whose length prefix contains 00 00 01 survive verbatim', () => {
  it('round-trips avc-format samples (incl. 00 00 01 / 00 00 00 01 length prefixes) byte-exact', async () => {
    // Sizes chosen so several length prefixes are exactly a start code: 501→00 00 01 F5, 257→00 00 01 01,
    // 1→00 00 00 01 (a 4-byte Annex-B start code as a length!), plus benign sizes that never tripped the bug.
    const samples = [
      avcSample(2677, 0x65), // key; length 0x00000A75 — benign
      avcSample(763, 0x41), // 0x000002FB — benign
      avcSample(855, 0x41), // 0x00000357 — benign
      avcSample(409, 0x41), // 0x00000199 — benign
      avcSample(501, 0x42), // 0x000001F5 — CONTAINS 00 00 01 (the frame the decoder used to die on)
      avcSample(257, 0x43), // 0x00000101 — CONTAINS 00 00 01
      avcSample(1, 0x44), //   0x00000001 — IS a 4-byte Annex-B start code
      avcSample(212, 0x45), // 0x000000D4 — benign
    ];

    const muxer = new Mp4Muxer({ faststart: true });
    const vid = muxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'avc1.42000d',
      config: { codec: 'avc1.42000d', description: AVCC, codedWidth: 320, codedHeight: 180 },
      fps: 30,
    });
    samples.forEach((data, i) => muxer.addChunkStruct(vid, chunk(i * 33_333, i === 0, data)));
    await muxer.finalize();
    const out = await collect(muxer.output);

    const readBack = await videoSamples(out);
    expect(readBack.length).toBe(samples.length);
    // Every sample must be byte-IDENTICAL to what we fed (no Annex-B re-split mangling).
    for (let i = 0; i < samples.length; i++) {
      expect(
        [...(readBack[i] ?? [])],
        `sample ${i} (len-prefix ${[...(samples[i] ?? []).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')})`,
      ).toEqual([...(samples[i] ?? [])]);
    }
  });

  it('still converts genuine Annex-B input to length-prefixed AVC (the no-description path is unaffected)', async () => {
    // An Annex-B access unit (start-code-prefixed SPS + PPS + IDR), no description → muxer synthesizes avcC.
    const sps = new Uint8Array([0x67, 0x42, 0x00, 0x0d, 0xda, 0x02, 0x80]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const idr = new Uint8Array([0x65, 0x88, 0x84, 0x21]); // no trailing zero (Annex-B strips trailing zeros)
    const annexB = (...nalus: Uint8Array[]): Uint8Array => {
      const total = nalus.reduce((n, nal) => n + 4 + nal.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const nal of nalus) {
        out.set([0, 0, 0, 1], o);
        o += 4;
        out.set(nal, o);
        o += nal.byteLength;
      }
      return out;
    };

    const muxer = new Mp4Muxer({ faststart: true });
    const vid = muxer.addTrack({ id: 0, mediaType: 'video', codec: 'avc1.42000d', fps: 30 });
    muxer.addChunkStruct(vid, chunk(0, true, annexB(sps, pps, idr)));
    await muxer.finalize();
    const out = await collect(muxer.output);

    const readBack = await videoSamples(out);
    expect(readBack.length).toBe(1);
    // The sample is now a sequence of length-prefixed NALs (the Annex-B start codes are replaced by 4-byte
    // lengths); the muxer ALSO copies SPS/PPS into the synthesized avcC. Walk the length-prefixed NALs and
    // assert they reconstruct exactly the input NAL set in order (SPS, PPS, IDR) — a valid AVC sample.
    const sample = readBack[0];
    expect(sample).toBeDefined();
    if (sample) {
      const nals: Uint8Array[] = [];
      let p = 0;
      while (p + 4 <= sample.byteLength) {
        const len =
          ((sample[p] ?? 0) << 24) |
          ((sample[p + 1] ?? 0) << 16) |
          ((sample[p + 2] ?? 0) << 8) |
          (sample[p + 3] ?? 0);
        nals.push(sample.subarray(p + 4, p + 4 + len));
        p += 4 + len;
      }
      expect(p).toBe(sample.byteLength); // length prefixes consume the sample exactly (well-formed avc)
      expect(nals.map((n) => [...n])).toEqual([[...sps], [...pps], [...idr]]);
    }
  });
});
