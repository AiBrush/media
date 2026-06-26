/**
 * ADTS OUTPUT verification (baseline NA-flip: "output adts"). Proves the engine's real `AdtsMuxer` produces
 * a valid, INDEPENDENTLY-DECODABLE `.adts` from raw AAC access units — so the harness adapter may honestly
 * declare `containersOut += 'adts'` (NEVER declare unverified).
 *
 * The engine's full demux→mux remux is browser-gated (ADTS `packets()` wraps frames in WebCodecs
 * `EncodedAudioChunk`), so we validate the MUXER half in Node WITHOUT the browser seam: parse a real ADTS
 * file's frames with the pure `enumerateAdtsFrames` (offset/size/headerBytes), strip each frame's ADTS
 * header to recover the bare AAC access unit (the exact bytes the demux→mux path carries), synthesize the
 * AAC `AudioSpecificConfig` from the first frame, feed the access units through `AdtsMuxer.addChunkStruct`,
 * and assert the re-authored `.adts` (a) re-parses to the SAME frame count and (b) DECODES with an
 * INDEPENDENT ffmpeg to non-empty PCM. Can-fail: a wrong ADTS header (bad frame_length / freqIndex /
 * channels) breaks the re-parse or the ffmpeg decode.
 *
 * Source: `sfx.adts` (a real raw-AAC/ADTS stream).
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { AdtsDriver, enumerateAdtsFrames, parseAdts } from './adts-driver.ts';

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

/** Decode an ADTS/AAC byte buffer to raw PCM with ffmpeg; returns the PCM byte length (0 ⇒ not real AAC). */
function ffmpegDecodedPcmBytes(adts: Uint8Array): number {
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'],
    { input: Buffer.from(adts.buffer, adts.byteOffset, adts.byteLength), maxBuffer: 1 << 28 },
  );
  return pcm.byteLength;
}

/**
 * Synthesize the 2-byte ASC from `sfx.adts`'s first frame (AOT/freqIndex/channelConfig) — the
 * `config.description` the muxer's `addTrack` needs. Mirrors the driver's own `audioSpecificConfig`.
 */
function ascFor(bytes: Uint8Array): Uint8Array {
  const RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = parseAdts(bytes, bytes.byteLength);
  const freqIndex = RATES.indexOf(info.sampleRate);
  // AOT from the first frame's profile field (+1); channelConfig from info.channels (1:1 for 1–6, 8→7).
  const b2 = dv.getUint8(2);
  const aot = ((b2 >> 6) & 0x3) + 1;
  const channelConfig = info.channels === 8 ? 7 : info.channels;
  return new Uint8Array([
    (aot << 3) | (freqIndex >> 1),
    ((freqIndex & 1) << 7) | (channelConfig << 3),
  ]);
}

describe('ADTS output / AdtsMuxer — the engine produces a valid, decodable .adts (baseline NA-flip)', () => {
  it('re-authors sfx.adts from its AAC access units to a valid .adts (re-parses + ffmpeg-decodes)', async () => {
    const ffmpeg = hasFfmpeg();
    if (!ffmpeg) console.warn('[adts-remux] no ffmpeg — skipping the independent-decode assertion');

    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    expect(frames.length, 'source has ADTS frames').toBeGreaterThan(0);
    const asc = ascFor(bytes);

    const muxer = AdtsDriver.createMuxer();
    const id = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: parseAdts(bytes, bytes.byteLength).codec,
      config: {
        codec: 'mp4a.40.2',
        sampleRate: 44_100,
        numberOfChannels: 2,
        description: asc,
      },
    });
    for (const f of frames) {
      // Strip the ADTS header to recover the bare AAC access unit the muxer re-wraps.
      muxer.addChunkStruct(id, {
        timestampUs: f.ptsUs,
        durationUs: f.durationUs,
        key: true,
        data: bytes.subarray(f.offset + f.headerBytes, f.offset + f.size),
      });
    }
    await muxer.finalize();
    const out = await collectBytes(muxer.output);

    // (a) The output re-parses to the SAME number of ADTS frames.
    const outFrames = enumerateAdtsFrames(out);
    expect(outFrames.length, 'output frame count matches source').toBe(frames.length);

    // (b) FAITHFUL: each AAC access unit (the ADTS payload, header stripped) is byte-identical to the
    // source's — the muxer re-frames AAC losslessly, so MUX_FAITHFUL_TARGETS += 'adts' is honest. (The
    // ADTS *headers* may differ — the source may use 9-byte CRC headers, our muxer writes 7-byte — so we
    // compare the AAC payloads, the actual codec data, not the frame bytes.)
    for (let i = 0; i < frames.length; i++) {
      const sf = frames[i];
      const of = outFrames[i];
      if (sf === undefined || of === undefined) continue;
      const a = bytes.subarray(sf.offset + sf.headerBytes, sf.offset + sf.size);
      const b = out.subarray(of.offset + of.headerBytes, of.offset + of.size);
      expect(b.byteLength, `frame ${i} AAC payload size`).toBe(a.byteLength);
      expect(Buffer.from(b).equals(Buffer.from(a)), `frame ${i} AAC payload byte-identical`).toBe(
        true,
      );
    }

    // (c) Independent decode: ffmpeg turns the re-authored .adts into non-empty PCM.
    if (ffmpeg) {
      expect(ffmpegDecodedPcmBytes(out), 'ffmpeg decodes the re-authored .adts').toBeGreaterThan(0);
    }
  }, 60_000);

  it('rejects misuse with typed errors (non-AAC track, missing ASC, double finalize)', async () => {
    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    const au = bytes.subarray(
      (frames[0]?.offset ?? 0) + (frames[0]?.headerBytes ?? 7),
      (frames[0]?.offset ?? 0) + (frames[0]?.size ?? 0),
    );
    const asc = ascFor(bytes);

    // A non-AAC track is a capability miss.
    expect(() =>
      AdtsDriver.createMuxer().addTrack({ id: 0, mediaType: 'audio', codec: 'opus' }),
    ).toThrowError(/AAC/);

    // Missing ASC description is a typed mux error.
    expect(() =>
      AdtsDriver.createMuxer().addTrack({ id: 0, mediaType: 'audio', codec: 'mp4a.40.2' }),
    ).toThrowError(/ASC/);

    // Double finalize is a typed mux error.
    const m = AdtsDriver.createMuxer();
    const id = m.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      config: { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2, description: asc },
    });
    m.addChunkStruct(id, { timestampUs: 0, durationUs: 0, key: true, data: au });
    await m.finalize();
    await expect(m.finalize()).rejects.toThrowError(MediaError);
  }, 30_000);
});
