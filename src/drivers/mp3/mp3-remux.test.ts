/**
 * MP3 OUTPUT verification (baseline NA-flip bucket: "output mp3" + "remux:mp3-in-mp4"). Proves the engine's
 * real `Mp3Muxer` genuinely produces a valid, INDEPENDENTLY-DECODABLE `.mp3` — so the harness adapter may
 * honestly declare `containersOut += 'mp3'` and `MUX_FAITHFUL_TARGETS += 'mp3'` (NEVER declare unverified).
 *
 * The engine's `remux(..., {to:'mp3'})` path demuxes via the MP3 container's `packets()`, which wraps each
 * frame in a WebCodecs `EncodedAudioChunk` — a browser-only constructor — so the full demux→mux chain is a
 * BROWSER/harness test (the demux side is itself validated in-browser; its pure framing core
 * `enumerateMp3Packets` is Node-oracled separately in `mp3.test.ts`). Here we validate the OTHER half in
 * Node WITHOUT the browser seam: parse the real source's MP3 frames with the pure `enumerateMp3Packets`,
 * feed them through `Mp3Muxer.addChunkStruct` (the exact bytes the browser path would carry), and assert the
 * authored `.mp3` (a) re-parses to the same frame run and (b) DECODES with an INDEPENDENT ffmpeg to non-empty
 * PCM — a real playable MP3, not a byte blob. Can-fail: a dropped/garbled frame breaks the count or decode.
 *
 * Sources: `sound_5.mp3` (CBR), `bear-vbr-toc.mp3` (VBR + Xing TOC), and the MP3 elementary stream lifted
 * from `2x2-green.mp4` (MP3-in-MP4 → the remux:mp3-in-mp4 case; demuxed to its raw frames first).
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../../api/types.ts';
import { loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp3Driver, enumerateMp3Packets, parseMp3 } from './mp3-driver.ts';
import type { Mp3Packet } from './mp3-driver.ts';

/** Drain a muxer's output stream into one buffer. */
async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

/** Whether ffmpeg (the independent decoder reference) is installed. */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Decode an MP3 byte buffer to raw PCM with ffmpeg; returns the PCM byte length (0 ⇒ not a real MP3). */
function ffmpegDecodedPcmBytes(mp3: Uint8Array): number {
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', 'pipe:1'],
    { input: Buffer.from(mp3.buffer, mp3.byteOffset, mp3.byteLength), maxBuffer: 1 << 28 },
  );
  return pcm.byteLength;
}

/** Author a `.mp3` from a source's real MP3 frames via the engine's `Mp3Muxer` (the Node-drivable half). */
async function remuxToMp3(sourceFrames: {
  bytes: Uint8Array;
  packets: Mp3Packet[];
}): Promise<Uint8Array> {
  const muxer = Mp3Driver.createMuxer();
  const id = muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
  for (const p of sourceFrames.packets) {
    muxer.addChunkStruct(id, {
      timestampUs: p.ptsUs,
      durationUs: p.durationUs,
      key: true,
      data: sourceFrames.bytes.subarray(p.offset, p.offset + p.size),
    });
  }
  await muxer.finalize();
  return collectBytes(muxer.output);
}

interface Case {
  id: string;
}

const CASES: readonly Case[] = [
  { id: 'sound_5.mp3' }, // CBR
  { id: 'bear-vbr-toc.mp3' }, // VBR + Xing TOC
];

describe('MP3 output / Mp3Muxer — the engine produces a valid, decodable .mp3 (baseline NA-flip)', () => {
  it('mp3→mp3 remux preserves every VBR frame and the 10 s duration', async () => {
    const fixture = 'bear-vbr-toc.mp3';
    const golden = (await loadGoldenMetadata(fixture)) as MediaInfo;
    const sourceBytes = await loadFixture(fixture);
    const sourcePackets = enumerateMp3Packets(sourceBytes);
    const sourceAudioBytes = sourcePackets.reduce((sum, packet) => sum + packet.size, 0);
    const outBytes = await remuxToMp3({ bytes: sourceBytes, packets: sourcePackets });
    const outPackets = enumerateMp3Packets(outBytes);
    const outAudioBytes = outPackets.reduce((sum, packet) => sum + packet.size, 0);
    const reparsed = parseMp3(outBytes, outBytes.byteLength);

    expect(outBytes.byteLength, 'duration metadata frame is present').toBeGreaterThan(
      sourceAudioBytes,
    );
    expect(outPackets[0]?.offset, 'first audio frame follows Xing metadata').toBeGreaterThan(0);
    expect(outPackets.length, 'all audio frames preserved').toBe(sourcePackets.length);
    expect(outAudioBytes, 'all MP3 frame bytes preserved').toBe(sourceAudioBytes);
    expect(reparsed.durationSec, 'VBR remux duration').toBeCloseTo(golden.durationSec, 6);
    expect(reparsed.sampleRate).toBe(golden.tracks[0]?.sampleRate);
    expect(reparsed.channels).toBe(golden.tracks[0]?.channels);
  }, 30_000);

  it('authors ≥2 real MP3 sources to a valid .mp3 (re-parses + ffmpeg-decodes)', async () => {
    const ffmpeg = hasFfmpeg();
    if (!ffmpeg) console.warn('[mp3-remux] no ffmpeg — skipping the independent-decode assertion');
    expect(CASES.length).toBeGreaterThanOrEqual(2);

    for (const { id } of CASES) {
      const bytes = await loadFixture(id);
      const packets = enumerateMp3Packets(bytes);
      expect(packets.length, `${id}: source has MP3 frames`).toBeGreaterThan(0);

      const out = await remuxToMp3({ bytes, packets });

      // (a) The output is a real MP3 elementary stream that re-parses to the same emittable frame count.
      const outPackets = enumerateMp3Packets(out);
      expect(outPackets.length, `${id}: output frame count`).toBe(packets.length);

      // (b) Independent decode: ffmpeg turns it into non-empty PCM (a sham blob yields 0 / throws).
      if (ffmpeg) {
        expect(ffmpegDecodedPcmBytes(out), `${id}: ffmpeg decodes the .mp3`).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('is a FAITHFUL remux — the authored frames are byte-identical to the source frames', async () => {
    // The Mp3Muxer copies frames verbatim, so a same-container remux reproduces every MPEG frame bit-for-bit.
    const bytes = await loadFixture('sound_5.mp3');
    const packets = enumerateMp3Packets(bytes);
    const out = await remuxToMp3({ bytes, packets });
    const outPackets = enumerateMp3Packets(out);
    expect(outPackets.length, 'frame count preserved').toBe(packets.length);
    for (let i = 0; i < packets.length; i++) {
      const a = bytes.subarray(
        packets[i]?.offset,
        (packets[i]?.offset ?? 0) + (packets[i]?.size ?? 0),
      );
      const b = out.subarray(
        outPackets[i]?.offset,
        (outPackets[i]?.offset ?? 0) + (outPackets[i]?.size ?? 0),
      );
      expect(b.byteLength, `frame ${i} size`).toBe(a.byteLength);
      expect(Buffer.from(b).equals(Buffer.from(a)), `frame ${i} bytes identical`).toBe(true);
    }
  }, 30_000);

  it('the MP3-in-MP4 elementary stream (2x2-green.mp4) authors to a decodable .mp3 (remux:mp3-in-mp4)', async () => {
    const ffmpeg = hasFfmpeg();
    // ffmpeg lifts the MP3 elementary stream out of the ISO-BMFF container (what the engine's MP4 demuxer
    // feeds the Mp3Muxer in the browser); we then author it via Mp3Muxer and re-decode — proving the
    // mp3-in-mp4 → .mp3 remux yields a real MP3, end to end on the muxer half.
    if (!ffmpeg) {
      console.warn('[mp3-remux] no ffmpeg — skipping mp3-in-mp4');
      return;
    }
    const mp4 = await loadFixture('2x2-green.mp4');
    const elementary = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'copy', '-f', 'mp3', 'pipe:1'],
      { input: Buffer.from(mp4.buffer, mp4.byteOffset, mp4.byteLength), maxBuffer: 1 << 28 },
    );
    const elemBytes = new Uint8Array(
      elementary.buffer,
      elementary.byteOffset,
      elementary.byteLength,
    );
    const packets = enumerateMp3Packets(elemBytes);
    expect(packets.length, '2x2-green.mp4 has an MP3 audio track').toBeGreaterThan(0);

    const out = await remuxToMp3({ bytes: elemBytes, packets });
    expect(enumerateMp3Packets(out).length, 'authored .mp3 frame count').toBe(packets.length);
    expect(ffmpegDecodedPcmBytes(out), 'authored .mp3 decodes').toBeGreaterThan(0);
  }, 60_000);
});
