/**
 * Vorbis encode oracle: libvorbisenc-in-wasm -> project Ogg muxer -> independent ffmpeg decode.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { OggMuxer } from '../../drivers/ogg/ogg-write.ts';
import { readWavPcm } from '../../drivers/wav/pcm.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  VORBIS_CODEC,
  type VorbisEncWasmCore,
  type VorbisEncodedPacket,
  buildVorbisExtradata,
  errMessage,
  interleaveF32,
  normalizeVorbisEncoderConfig,
  samplesToMicros,
} from './vorbis-enc.ts';

async function loadCore(): Promise<VorbisEncWasmCore> {
  const mod = await import('./vorbis-enc-core.js');
  await mod.default();
  return mod.createVorbisEncCore();
}

function externalDecoder(): 'ffmpeg' | undefined {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return undefined;
  }
}

interface Pcm {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly interleaved: Float32Array;
}

function tone(
  sampleRate: number,
  channels: number,
  seconds: number,
  freqs: readonly number[],
): Pcm {
  const frames = Math.round(sampleRate * seconds);
  const planes = Array.from({ length: channels }, (_, c) => {
    const plane = new Float32Array(frames);
    const f = freqs[c] ?? 440;
    for (let i = 0; i < frames; i++) {
      const t = (2 * Math.PI * i) / sampleRate;
      plane[i] = 0.35 * Math.sin(f * t) + 0.18 * Math.sin(2 * f * t) + 0.09 * Math.sin(3 * f * t);
    }
    return plane;
  });
  return { sampleRate, channels, frames, interleaved: interleaveF32(planes, frames) };
}

async function wavPcm(id: string): Promise<Pcm> {
  const wav = readWavPcm(await loadFixture(id));
  const channels = Math.min(wav.channels, 2);
  const planes = Array.from({ length: channels }, (_, c) => {
    const src = wav.planar[c] ?? new Float32Array(wav.frames);
    const plane = new Float32Array(wav.frames);
    plane.set(src.subarray(0, wav.frames));
    return plane;
  });
  return {
    sampleRate: wav.sampleRate,
    channels,
    frames: wav.frames,
    interleaved: interleaveF32(planes, wav.frames),
  };
}

function addPackets(
  muxer: OggMuxer,
  trackId: number,
  packets: readonly VorbisEncodedPacket[],
  sampleRate: number,
  state: { granule: number },
): void {
  for (const packet of packets) {
    const durationSamples =
      Number.isFinite(packet.granulepos) && packet.granulepos >= state.granule
        ? packet.granulepos - state.granule
        : 0;
    muxer.addChunkStruct(trackId, {
      timestampUs: samplesToMicros(state.granule, sampleRate),
      durationUs: samplesToMicros(durationSamples, sampleRate),
      key: true,
      data: packet.data,
    });
    state.granule += durationSamples;
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function encodeToOggVorbis(
  core: VorbisEncWasmCore,
  pcm: Pcm,
  bitrate: number | 'auto',
): Promise<Uint8Array> {
  const encoder = await core.createEncoder({
    sampleRate: pcm.sampleRate,
    channels: pcm.channels,
    bitrate,
    quality: 0.5,
  });
  try {
    const headers = encoder.headers();
    const muxer = new OggMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: VORBIS_CODEC,
      durationSec: pcm.frames / pcm.sampleRate,
      config: {
        codec: VORBIS_CODEC,
        sampleRate: pcm.sampleRate,
        numberOfChannels: pcm.channels,
        description: buildVorbisExtradata(headers[0], headers[1], headers[2]),
      },
    });
    const state = { granule: 0 };
    addPackets(muxer, trackId, encoder.encode(pcm.interleaved, pcm.frames), pcm.sampleRate, state);
    addPackets(muxer, trackId, encoder.finish(), pcm.sampleRate, state);
    await muxer.finalize();
    return collect(muxer.output);
  } finally {
    encoder.free();
  }
}

function ffmpegDecode(ogg: Uint8Array, channels: number, sampleRate: number): Float32Array {
  const path = `${tmpdir()}/aibrush-vorbis-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}.ogg`;
  writeFileSync(path, ogg);
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

function snrDb(source: Float32Array, decoded: Float32Array, channels: number): number {
  const srcFrames = source.length / channels;
  const decFrames = decoded.length / channels;
  const corrLen = Math.min(20_000, decFrames - 1, srcFrames - 1);
  let bestOffset = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset <= 4000 && offset < srcFrames - corrLen; offset++) {
    let cc = 0;
    for (let i = 0; i < corrLen; i++) {
      cc += (source[(i + offset) * channels] ?? 0) * (decoded[i * channels] ?? 0);
    }
    if (cc > bestCorrelation) {
      bestCorrelation = cc;
      bestOffset = offset;
    }
  }
  let signal = 0;
  let noise = 0;
  const span = Math.min(srcFrames - bestOffset, decFrames);
  for (let i = 2000; i < span - 2000; i++) {
    for (let c = 0; c < channels; c++) {
      const s = source[(i + bestOffset) * channels + c] ?? 0;
      const d = decoded[i * channels + c] ?? 0;
      signal += s * s;
      noise += (s - d) * (s - d);
    }
  }
  return 10 * Math.log10(signal / (noise || 1e-12));
}

const SNR_FLOOR_DB = 10;

describe('Vorbis encoder helpers', () => {
  it('normalizes valid WebCodecs configs and rejects invalid ones', () => {
    expect(
      normalizeVorbisEncoderConfig({
        codec: VORBIS_CODEC,
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 96_000,
      }),
    ).toEqual({ sampleRate: 48_000, channels: 2, bitrate: 96_000, quality: 0.4 });
    expect(() =>
      normalizeVorbisEncoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow();
    expect(() =>
      normalizeVorbisEncoderConfig({ codec: VORBIS_CODEC, sampleRate: 0, numberOfChannels: 2 }),
    ).toThrow();
    expect(() =>
      normalizeVorbisEncoderConfig({
        codec: VORBIS_CODEC,
        sampleRate: 48_000,
        numberOfChannels: 9,
      }),
    ).toThrow();
  });

  it('covers fallback tuning, interleave validation, and error-message helpers', () => {
    expect(
      normalizeVorbisEncoderConfig({
        codec: VORBIS_CODEC,
        sampleRate: 44_100,
        numberOfChannels: 1,
        bitrate: Number.NaN,
        vorbis: { quality: 0.75 },
      } as AudioEncoderConfig),
    ).toEqual({ sampleRate: 44_100, channels: 1, bitrate: 'auto', quality: 0.75 });
    expect(
      normalizeVorbisEncoderConfig({
        codec: VORBIS_CODEC,
        sampleRate: 44_100,
        numberOfChannels: 1,
        bitrate: -1,
        vorbis: { quality: 2 },
      } as AudioEncoderConfig),
    ).toEqual({ sampleRate: 44_100, channels: 1, bitrate: 'auto', quality: 0.4 });

    expect(interleaveF32([Float32Array.of(1, 2), Float32Array.of(3, 4)], 2)).toEqual(
      Float32Array.of(1, 3, 2, 4),
    );
    expect(() => interleaveF32([], 0)).toThrow();
    expect(() => interleaveF32([new Float32Array(1)], -1)).toThrow();
    expect(() => interleaveF32([new Float32Array(1)], 2)).toThrow();
    expect(errMessage('plain')).toBe('plain');
    expect(errMessage(new Error('wrapped'))).toBe('wrapped');
    expect(errMessage({ cause: 'opaque' })).toBe('unknown error');
  });
});

describe('Vorbis authoring - vendored libvorbisenc core, Ogg mux, ffmpeg oracle', () => {
  it('emits real setup headers and Ogg pages that ffmpeg decodes', async () => {
    if (!externalDecoder()) return;
    const core = await loadCore();
    const pcm = tone(48_000, 2, 1, [440, 660]);
    const ogg = await encodeToOggVorbis(core, pcm, 'auto');
    expect(ogg[0], 'OggS magic').toBe(0x4f);
    const decoded = ffmpegDecode(ogg, pcm.channels, pcm.sampleRate);
    expect(decoded.length / pcm.channels).toBeGreaterThan(pcm.frames * 0.9);
    expect(snrDb(pcm.interleaved, decoded, pcm.channels), 'tonal SNR').toBeGreaterThan(
      SNR_FLOOR_DB,
    );
  }, 30_000);

  it('encodes five real WAV fixtures through an independent decoder oracle', async () => {
    if (!externalDecoder()) return;
    const core = await loadCore();
    const ids = [
      'sfx-pcm-s16.wav',
      'sfx-pcm-s24.wav',
      'sfx-pcm-f32.wav',
      'sfx-pcm-u8.wav',
      'sfx-pcm-s32.wav',
    ] as const;
    for (const id of ids) {
      const pcm = await wavPcm(id);
      const ogg = await encodeToOggVorbis(core, pcm, 112_000);
      const decoded = ffmpegDecode(ogg, pcm.channels, pcm.sampleRate);
      const snr = snrDb(pcm.interleaved, decoded, pcm.channels);
      expect(snr, `${id} SNR`).toBeGreaterThan(SNR_FLOOR_DB);
    }
  }, 60_000);

  it('produces compressed Vorbis smaller than source PCM', async () => {
    const core = await loadCore();
    const pcm = await wavPcm('sfx-pcm-s16.wav');
    const ogg = await encodeToOggVorbis(core, pcm, 96_000);
    expect(ogg.byteLength).toBeLessThan(pcm.frames * pcm.channels * 2);
  }, 30_000);
});
