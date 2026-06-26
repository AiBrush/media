/**
 * remux:av1-opus-in-webm verification (baseline NA-flip). Proves the engine's `WebmMuxer` accepts an AV1
 * VIDEO track + an OPUS AUDIO track and writes a valid `.webm` carrying `V_AV1` + `A_OPUS` — so the harness
 * adapter may honestly declare `remux:av1-opus-in-webm`. The full demux→mux chain is browser-gated (WebM
 * `packets()` wraps frames in WebCodecs `EncodedVideoChunk`), so we validate the MUXER half in Node WITHOUT
 * the browser seam: lift REAL AV1 frames (the IVF demuxed from `av1.mp4`) and REAL Opus packets (the Ogg
 * demuxed from `sfx-opus.ogg`) with tiny pure parsers, feed them through `WebmMuxer.addChunkStruct` (the
 * exact path `write()` uses after its browser-only `copyTo`), and assert the authored `.webm` (a) re-parses
 * with the engine's own `parseWebm` to an `av1` video track + an `opus` audio track, and (b) is identified
 * by an INDEPENDENT `ffprobe` as `av1` + `opus`. Can-fail: a wrong CodecID/CodecPrivate or dropped track
 * breaks the re-parse or the ffprobe identification.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../test-support/corpus.ts';
import { WebmMuxer } from './webm/ebml-write.ts';
import { parseWebm } from './webm/webm-driver.ts';

/** Whether ffmpeg/ffprobe (the independent reference) is installed. */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Parse an IVF stream into its coded frames (12-byte file header, then [4-byte LE size, 8-byte pts, data]). */
function ivfFrames(ivf: Uint8Array): Uint8Array[] {
  const dv = new DataView(ivf.buffer, ivf.byteOffset, ivf.byteLength);
  const headerLen = dv.getUint16(6, true); // bytes 6-7: header length (usually 32)
  const frames: Uint8Array[] = [];
  let pos = headerLen;
  while (pos + 12 <= ivf.byteLength) {
    const size = dv.getUint32(pos, true);
    pos += 12; // 4-byte size + 8-byte timestamp
    if (pos + size > ivf.byteLength) break;
    frames.push(ivf.subarray(pos, pos + size));
    pos += size;
  }
  return frames;
}

/**
 * Extract Opus audio packets from an Ogg stream. Ogg page: `OggS`(4) + 23-byte header (the 27th byte is the
 * page segment count `N`) + `N` lacing bytes (segment table) + the segments. A packet is the concatenation
 * of consecutive segments until one < 255 bytes. The first two packets are the Opus headers (OpusHead,
 * OpusTags) — skipped, since the WebM track's CodecPrivate carries OpusHead instead.
 */
function oggOpusPackets(ogg: Uint8Array): Uint8Array[] {
  const dv = new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength);
  const packets: Uint8Array[] = [];
  let pos = 0;
  let partial: number[] = [];
  while (pos + 27 <= ogg.byteLength && dv.getUint32(pos, false) === 0x4f676753 /* 'OggS' */) {
    const segCount = dv.getUint8(pos + 26);
    const lacing = pos + 27;
    let dataPos = lacing + segCount;
    for (let s = 0; s < segCount; s++) {
      const len = dv.getUint8(lacing + s);
      for (let i = 0; i < len; i++) partial.push(ogg[dataPos + i] ?? 0);
      dataPos += len;
      if (len < 255) {
        packets.push(Uint8Array.from(partial));
        partial = [];
      }
    }
    pos = dataPos;
  }
  return packets.slice(2); // drop OpusHead + OpusTags header packets
}

/** Synthesize a minimal OpusHead (CodecPrivate) for the WebM track: "OpusHead" + version + channels + … */
function opusHead(channels: number, sampleRate: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  h[8] = 1; // version
  h[9] = channels;
  new DataView(h.buffer).setUint16(10, 3840, true); // pre-skip
  new DataView(h.buffer).setUint32(12, sampleRate, true); // input sample rate
  return h; // output gain (2) + mapping family (1) default 0
}

describe('remux:av1-opus-in-webm — WebmMuxer writes a valid V_AV1 + A_OPUS .webm (baseline NA-flip)', () => {
  it('muxes real AV1 video + real Opus audio into a .webm that re-parses + ffprobes as av1/opus', async () => {
    if (!hasFfmpeg()) {
      console.warn('[av1-opus-remux] no ffmpeg/ffprobe — skipping');
      return;
    }
    // Lift real AV1 frames (av1.mp4 → IVF) and real Opus packets (sfx-opus.ogg → Ogg) with ffmpeg's demux.
    const mp4 = await loadFixture('av1.mp4');
    const ivf = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-c:v', 'copy', '-f', 'ivf', 'pipe:1'],
      {
        input: Buffer.from(mp4.buffer, mp4.byteOffset, mp4.byteLength),
        maxBuffer: 1 << 28,
      },
    );
    const av1 = ivfFrames(new Uint8Array(ivf.buffer, ivf.byteOffset, ivf.byteLength));
    expect(av1.length, 'av1.mp4 yields AV1 frames').toBeGreaterThan(0);

    const oggBytes = await loadFixture('sfx-opus.ogg');
    const opus = oggOpusPackets(oggBytes);
    expect(opus.length, 'sfx-opus.ogg yields Opus packets').toBeGreaterThan(0);

    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'av01.0.04M.08',
      fps: 30,
      config: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
    });
    const aud = muxer.addTrack({
      id: 2,
      mediaType: 'audio',
      codec: 'opus',
      config: {
        codec: 'opus',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: opusHead(2, 48_000),
      },
    });

    let t = 0;
    for (const f of av1) {
      muxer.addChunkStruct(vid, { timestampUs: t, durationUs: 33_333, key: t === 0, data: f });
      t += 33_333;
    }
    let at = 0;
    for (const p of opus) {
      muxer.addChunkStruct(aud, { timestampUs: at, durationUs: 20_000, key: true, data: p });
      at += 20_000;
    }
    await muxer.finalize();

    const reader = muxer.output.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const webm = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      webm.set(p, off);
      off += p.byteLength;
    }

    // (a) The engine's own WebM parser sees an av1 video track + an opus audio track.
    const info = parseWebm(webm);
    const codecs = info.tracks.map((tr) => tr.codec);
    expect(codecs, 'parseWebm sees av1 + opus').toEqual(expect.arrayContaining(['av1', 'opus']));

    // (b) Independent: ffprobe identifies both codecs in the authored .webm.
    const probed = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', 'pipe:0'],
      { input: Buffer.from(webm.buffer, webm.byteOffset, webm.byteLength), maxBuffer: 1 << 28 },
    )
      .toString()
      .trim();
    expect(probed, 'ffprobe identifies av1').toMatch(/av1/);
    expect(probed, 'ffprobe identifies opus').toMatch(/opus/);
  }, 60_000);
});
