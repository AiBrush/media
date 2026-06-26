/**
 * Opus **authoring** oracle (BUILD §2/§4; ADR-088 — the vendored prebuilt libopus core completing the
 * wasm-opus encoder). The vendored `libopus-wasm` core runs in Node, so the whole encode chain is
 * Node-validated WITHOUT a browser: PCM → our libopus encoder (via the {@link OpusWasmCore} glue) → a
 * real Ogg-Opus file (the engine's `OggMuxer`, carrying our OpusHead) → an INDEPENDENT `ffmpeg` libopus
 * decode → SNR vs the source. A broken encoder, a wrong OpusHead pre-skip, or a channel/rate bug all
 * collapse the SNR (the oracle FAILS). Synthetic tones give a clean, alignment-robust signal across the
 * mono/stereo × {16,24,48} kHz matrix; the real `sfx` 48 kHz fixtures prove it on actual audio.
 *
 * Pure OpusHead + framing helpers are unit-tested here too; the lossy CELT/SILK math is the vendored
 * core's (validated transitively by the ffmpeg round-trip).
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { oggAudioPackets } from '../../drivers/ogg/ogg-driver.ts';
import { OggMuxer } from '../../drivers/ogg/ogg-write.ts';
import { readWavPcm } from '../../drivers/wav/pcm.ts';
import { demuxWebm } from '../../drivers/webm/webm-driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  FrameAccumulator,
  type OpusWasmCore,
  asDecodeRate,
  buildOpusHead,
  frameSamplesAtRate,
  packetDurationSamples,
  preSkipFromDescription,
} from './opus.ts';

/** Load the vendored libopus-wasm glue facade once (it runs in Node — the whole reason this is here). */
async function loadCore(): Promise<OpusWasmCore> {
  const mod = (await import('./opus-core.js')) as {
    default: (u?: unknown) => Promise<unknown>;
    createOpusCore: () => OpusWasmCore;
  };
  await mod.default();
  return mod.createOpusCore();
}

/** Which independent Opus decoder is installed (the third-party oracle), if any. */
function externalDecoder(): 'ffmpeg' | undefined {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return undefined;
  }
}

interface Pcm {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Interleaved f32 `[c0,c1,…]`. */
  interleaved: Float32Array;
}

/**
 * A synthetic source: a fundamental + 2nd/3rd harmonics per channel (one distinct fundamental per
 * channel). The harmonic content spreads energy across the band so Opus codes it faithfully (a single
 * pure tone is an adversarial low-rate case), while staying perfectly periodic → alignment-robust.
 */
function tone(sampleRate: number, channels: number, seconds: number, freqs: number[]): Pcm {
  const frames = Math.round(sampleRate * seconds);
  const interleaved = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const f = freqs[c] ?? 440;
      const t = (2 * Math.PI * i) / sampleRate;
      interleaved[i * channels + c] =
        0.35 * Math.sin(f * t) + 0.18 * Math.sin(2 * f * t) + 0.09 * Math.sin(3 * f * t);
    }
  }
  return { sampleRate, channels, frames, interleaved };
}

/** A real WAV fixture as interleaved f32 (down-mixed to ≤2 channels). */
async function wavPcm(id: string): Promise<Pcm> {
  const wav = readWavPcm(await loadFixture(id));
  const channels = Math.min(wav.channels, 2);
  const interleaved = new Float32Array(wav.frames * channels);
  for (let c = 0; c < channels; c++) {
    const plane = wav.planar[c];
    if (plane === undefined) continue;
    for (let i = 0; i < wav.frames; i++) interleaved[i * channels + c] = plane[i] ?? 0;
  }
  return { sampleRate: wav.sampleRate, channels, frames: wav.frames, interleaved };
}

/** Encode a PCM source through our libopus core into a real Ogg-Opus byte stream (with our OpusHead). */
async function encodeToOggOpus(core: OpusWasmCore, pcm: Pcm, bitrate: number): Promise<Uint8Array> {
  const frameSamples = frameSamplesAtRate(pcm.sampleRate, 20);
  const encoder = await core.createEncoder({
    sampleRate: pcm.sampleRate,
    channels: pcm.channels,
    bitrate,
    frameMs: 20,
    frameSamples,
  });
  try {
    const acc = new FrameAccumulator(pcm.channels, frameSamples);
    acc.push(pcm.interleaved);
    const head = buildOpusHead(pcm.channels, encoder.preSkip(), pcm.sampleRate);
    // The OpusHead pre-skip we publish must be exactly what the encoder reported (round-trips here).
    expect(preSkipFromDescription(head)).toBe(encoder.preSkip());

    const muxer = new OggMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'opus',
      config: {
        codec: 'opus',
        sampleRate: pcm.sampleRate,
        numberOfChannels: pcm.channels,
        description: head,
      },
    });
    let pts = 0;
    const micros = (s: number): number => Math.round((s / pcm.sampleRate) * 1e6);
    for (let frame = acc.pull(); frame !== undefined; frame = acc.pull()) {
      muxer.addChunkStruct(trackId, {
        timestampUs: micros(pts),
        durationUs: micros(frameSamples),
        key: true,
        data: encoder.encode(frame),
      });
      pts += frameSamples;
    }
    const tail = acc.drainFinal();
    if (tail) {
      muxer.addChunkStruct(trackId, {
        timestampUs: micros(pts),
        durationUs: micros(frameSamples - tail.padSamples),
        key: true,
        data: encoder.encode(tail.frame),
      });
    }
    await muxer.finalize();
    return collect(muxer.output);
  } finally {
    encoder.free();
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

/** Decode an Ogg-Opus byte stream to interleaved f32 with ffmpeg (the independent oracle). */
function ffmpegDecode(ogg: Uint8Array, channels: number, sampleRate: number): Float32Array {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = tmpdir();
  const tag = `opus-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const inPath = `${dir}/aibrush-${tag}.ogg`;
  fs.writeFileSync(inPath, ogg);
  try {
    const raw = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        inPath,
        '-f',
        'f32le',
        '-ac',
        String(channels),
        '-ar',
        String(sampleRate),
        '-',
      ],
      { maxBuffer: 1 << 28 },
    );
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  } finally {
    try {
      fs.unlinkSync(inPath);
    } catch {
      /* best-effort */
    }
  }
}

/** Decode a corpus fixture file (by id) to interleaved f32 with ffmpeg (the independent decode reference). */
function ffmpegDecodeFile(id: string, channels: number, sampleRate: number): Float32Array {
  const path = `${new URL('../../../fixtures/media/', import.meta.url).pathname}${id}`;
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-f',
      'f32le',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-',
    ],
    { maxBuffer: 1 << 28 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
}

/**
 * SNR (dB) of `ref` vs `ours` interleaved PCM, aligning by shifting `ours` over a BIDIRECTIONAL window
 * (the codec/pre-skip delay can land on either side): maximize `Σ ref[i]·ours[i+off]`, then measure
 * `ref[i]` vs `ours[i+off]`. Used for the decode oracle (both are libopus decodes → agree to float
 * precision) and the encode→decode round-trip. Falsifiable: a wrong decode/encode collapses the SNR.
 */
function snrSigned(ref: Float32Array, ours: Float32Array, channels: number): number {
  const refFrames = ref.length / channels;
  const ourFrames = ours.length / channels;
  const corrLen = Math.min(20_000, refFrames - 1, ourFrames - 1);
  let bestOff = 0;
  let bestC = Number.NEGATIVE_INFINITY;
  for (let off = -1500; off <= 1500; off++) {
    let cc = 0;
    for (let i = Math.max(0, -off); i < corrLen && i + off < ourFrames; i++) {
      cc += (ref[i * channels] ?? 0) * (ours[(i + off) * channels] ?? 0);
    }
    if (cc > bestC) {
      bestC = cc;
      bestOff = off;
    }
  }
  let sig = 0;
  let noise = 0;
  const m = Math.min(refFrames, ourFrames) - Math.abs(bestOff);
  for (let i = 2000; i < m - 2000; i++) {
    for (let c = 0; c < channels; c++) {
      const r = ref[i * channels + c] ?? 0;
      const o = ours[(i + bestOff) * channels + c] ?? 0;
      sig += r * r;
      noise += (r - o) * (r - o);
    }
  }
  return 10 * Math.log10(sig / (noise || 1e-12));
}

/**
 * SNR (dB) of `decoded` vs `source` interleaved PCM, after finding the best integer alignment by
 * cross-correlating channel 0 over a high-energy window (Opus has a deterministic codec delay; ffmpeg
 * already trimmed the OpusHead pre-skip, leaving a small residual). Falsifiable: a wrong encode tanks it.
 */
function snrDb(source: Float32Array, decoded: Float32Array, channels: number): number {
  const srcFrames = source.length / channels;
  const decFrames = decoded.length / channels;
  const corrLen = Math.min(20_000, decFrames - 1, srcFrames - 1);
  let bestOff = 0;
  let bestC = Number.NEGATIVE_INFINITY;
  for (let off = 0; off <= 2000 && off < srcFrames - corrLen; off++) {
    let cc = 0;
    for (let i = 0; i < corrLen; i++)
      cc += (source[(i + off) * channels] ?? 0) * (decoded[i * channels] ?? 0);
    if (cc > bestC) {
      bestC = cc;
      bestOff = off;
    }
  }
  let sig = 0;
  let noise = 0;
  const m = Math.min(srcFrames - bestOff, decFrames);
  for (let i = 2000; i < m - 2000; i++) {
    for (let c = 0; c < channels; c++) {
      const s = source[(i + bestOff) * channels + c] ?? 0;
      const d = decoded[i * channels + c] ?? 0;
      sig += s * s;
      noise += (s - d) * (s - d);
    }
  }
  return 10 * Math.log10(sig / (noise || 1e-12));
}

/** Conservative lossy SNR floor — clean tones/audio round-trip ≫ this; a broken encode is ~1 dB. */
const SNR_FLOOR_DB = 12;

describe('Opus authoring — vendored libopus core, Ogg-mux, ffmpeg-decodable (ADR-088)', () => {
  it('builds a spec-correct OpusHead (RFC 7845) and reads its pre-skip back', () => {
    const head = buildOpusHead(2, 312, 48_000);
    expect(head.byteLength).toBe(19);
    expect([...head.subarray(0, 8)]).toEqual([...new TextEncoder().encode('OpusHead')]);
    expect(head[8]).toBe(1); // version
    expect(head[9]).toBe(2); // channels
    expect(preSkipFromDescription(head)).toBe(312);
    const dv = new DataView(head.buffer);
    expect(dv.getUint32(12, true)).toBe(48_000); // input sample rate
    expect(dv.getUint8(18)).toBe(0); // channel mapping family 0
    expect(() => buildOpusHead(3, 312, 48_000)).toThrow(); // >2ch family-0 is rejected
  });

  it('encodes synthetic 48 kHz tones (mono + stereo); ffmpeg decodes ≈ source (strong SNR oracle)', async () => {
    const tool = externalDecoder();
    if (!tool) {
      console.warn('[wasm-opus] no ffmpeg — skipping the independent-decoder Opus oracle');
      return;
    }
    const core = await loadCore();
    // 48 kHz is Opus' native rate → no decoder-side resample, so a sample-domain SNR is exact. (Lower
    // rates are exercised structurally in the multi-rate test below; resampling there blurs sample SNR.)
    const cases: ReadonlyArray<{ ch: number; freqs: number[] }> = [
      { ch: 1, freqs: [440] },
      { ch: 2, freqs: [440, 660] },
    ];
    for (const { ch, freqs } of cases) {
      const pcm = tone(48_000, ch, 1, freqs);
      const ogg = await encodeToOggOpus(core, pcm, 96_000);
      expect(ogg[0], 'OggS magic').toBe(0x4f); // 'O'
      const decoded = ffmpegDecode(ogg, ch, 48_000);
      const snr = snrDb(pcm.interleaved, decoded, ch);
      expect(snr, `${ch}ch 48kHz tonal SNR`).toBeGreaterThan(SNR_FLOOR_DB);
    }
  }, 30_000);

  it('encodes every Opus input rate {8,12,16,24,48} kHz; ffmpeg decodes valid Opus of the right length', async () => {
    const tool = externalDecoder();
    if (!tool) return;
    const core = await loadCore();
    // Structural multi-rate oracle: the encoder must accept each libopus input rate and emit Opus the
    // independent decoder accepts, yielding ≈ the source duration. (A rate the encoder mishandles fails
    // to produce decodable packets / the wrong sample count.) SNR is checked at 48 kHz above.
    const rates = [8_000, 12_000, 16_000, 24_000, 48_000] as const;
    for (const rate of rates) {
      const ch = rate >= 24_000 ? 2 : 1;
      const pcm = tone(rate, ch, 1, ch === 2 ? [300, 500] : [400]);
      const ogg = await encodeToOggOpus(core, pcm, 96_000);
      const decoded = ffmpegDecode(ogg, ch, rate);
      const decFrames = decoded.length / ch;
      // ffmpeg trims the OpusHead pre-skip; the decoded length is within a frame of the source duration.
      expect(Math.abs(decFrames - pcm.frames), `${ch}ch ${rate}Hz decoded length`).toBeLessThan(
        frameSamplesAtRate(rate, 20) + 1,
      );
    }
  }, 30_000);

  it('encodes real 48 kHz audio fixtures; ffmpeg decodes ≈ source (≥3 real files)', async () => {
    const tool = externalDecoder();
    if (!tool) return;
    const core = await loadCore();
    const ids = ['sfx-pcm-s16.wav', 'sfx-pcm-s24.wav', 'sfx-pcm-f32.wav'] as const;
    for (const id of ids) {
      const pcm = await wavPcm(id);
      expect(pcm.sampleRate, `${id} must be Opus-native`).toBe(48_000);
      const ogg = await encodeToOggOpus(core, pcm, 96_000);
      const decoded = ffmpegDecode(ogg, pcm.channels, pcm.sampleRate);
      const snr = snrDb(pcm.interleaved, decoded, pcm.channels);
      expect(snr, `${id} SNR`).toBeGreaterThan(SNR_FLOOR_DB);
    }
  }, 30_000);

  it('produces genuinely compressed Opus (smaller than the source PCM)', async () => {
    const core = await loadCore();
    const pcm = await wavPcm('sfx-pcm-s16.wav');
    const ogg = await encodeToOggOpus(core, pcm, 96_000);
    const sourceBytes = pcm.frames * pcm.channels * 2; // s16
    expect(ogg.byteLength).toBeLessThan(sourceBytes);
  }, 30_000);
});

describe('Opus DECODE — vendored libopus core vs the ffmpeg reference (§3.C.10, ADR-088)', () => {
  it('decodes a real Opus-in-Ogg fixture ≈ bit-exactly vs ffmpeg (both are libopus)', async () => {
    const tool = externalDecoder();
    if (!tool) return;
    const core = await loadCore();
    const data = await loadFixture('sfx-opus.ogg');
    const channels = 1;
    const sampleRate = 48_000;

    // Extract the native Opus audio packets (Node-pure; headers dropped) and decode each via our core.
    const packets = oggAudioPackets(data);
    expect(packets.length).toBeGreaterThan(0);
    const decoder = await core.createDecoder({ sampleRate, channels, preSkip: 0 });
    const frames: Float32Array[] = [];
    try {
      for (const p of packets) {
        const packet = data.subarray(p.offset, p.offset + p.size);
        frames.push(decoder.decode(packet, packetDurationSamples(packet)));
      }
    } finally {
      decoder.free();
    }
    let total = 0;
    for (const f of frames) total += f.length;
    const ours = new Float32Array(total);
    {
      let o = 0;
      for (const f of frames) {
        ours.set(f, o);
        o += f.length;
      }
    }

    // ffmpeg decodes the SAME file; both decoders are libopus, so they agree to float precision (≫ floor).
    const reference = ffmpegDecodeFile('sfx-opus.ogg', channels, sampleRate);
    const snr = snrSigned(reference, ours, channels);
    expect(snr, 'our Opus decode vs ffmpeg').toBeGreaterThan(60);
  }, 30_000);

  it('decodes real stereo Opus-in-WebM (bear-opus.webm) ≈ ffmpeg (both are libopus)', async () => {
    const tool = externalDecoder();
    if (!tool) return;
    const core = await loadCore();
    const data = await loadFixture('bear-opus.webm');
    const sampleRate = 48_000;

    // Pure WebM demux → the audio track's native Opus packet bytes (no WebCodecs); decode each via our core.
    const demux = demuxWebm(data);
    const audioIndex = demux.info.tracks.findIndex((t) => t.mediaType === 'audio');
    expect(audioIndex, 'bear-opus.webm has an audio track').toBeGreaterThanOrEqual(0);
    const channels = demux.info.tracks[audioIndex]?.channels ?? 2;
    const frames = demux.framesByIndex[audioIndex] ?? [];
    expect(frames.length).toBeGreaterThan(0);

    const decoder = await core.createDecoder({ sampleRate, channels, preSkip: 0 });
    const decoded: Float32Array[] = [];
    try {
      for (const frame of frames)
        decoded.push(decoder.decode(frame.data, packetDurationSamples(frame.data)));
    } finally {
      decoder.free();
    }
    let total = 0;
    for (const f of decoded) total += f.length;
    const ours = new Float32Array(total);
    {
      let o = 0;
      for (const f of decoded) {
        ours.set(f, o);
        o += f.length;
      }
    }
    const reference = ffmpegDecodeFile('bear-opus.webm', channels, sampleRate);
    // Real stereo content; both libopus → high agreement (≫ the ~1 dB a broken decode would give).
    expect(snrSigned(reference, ours, channels), 'our WebM-Opus decode vs ffmpeg').toBeGreaterThan(
      40,
    );
  }, 30_000);

  it('round-trips: our encode → our decode reproduces the source (≥ the lossy floor)', async () => {
    const core = await loadCore();
    const pcm = await wavPcm('sfx-pcm-s16.wav');
    const rate = asDecodeRate(pcm.sampleRate);
    expect(rate, 'fixture must be an Opus-native rate').not.toBeUndefined();
    if (rate === undefined) return;
    const ogg = await encodeToOggOpus(core, pcm, 96_000);
    const packets = oggAudioPackets(ogg);
    const decoder = await core.createDecoder({
      sampleRate: rate,
      channels: pcm.channels,
      preSkip: 0,
    });
    const frames: Float32Array[] = [];
    try {
      for (const p of packets) {
        const packet = ogg.subarray(p.offset, p.offset + p.size);
        frames.push(decoder.decode(packet, packetDurationSamples(packet)));
      }
    } finally {
      decoder.free();
    }
    let total = 0;
    for (const f of frames) total += f.length;
    const decoded = new Float32Array(total);
    {
      let o = 0;
      for (const f of frames) {
        decoded.set(f, o);
        o += f.length;
      }
    }
    expect(
      snrSigned(pcm.interleaved, decoded, pcm.channels),
      'encode→decode round-trip SNR',
    ).toBeGreaterThan(SNR_FLOOR_DB);
  }, 30_000);
});
