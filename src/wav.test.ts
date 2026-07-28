import { describe, expect, it } from 'vitest';
import { decodeWavPcmInterleavedPrefix, parseWavHeader, rewriteEmptyWavPcm } from './wav.ts';

function emptyWav(sampleRate = 48_000, channels = 2, declaredDataBytes = 0): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const) {
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  }
  view.setUint32(4, 36, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, declaredDataBytes, true);
  return bytes;
}

function s16Wav(samples: readonly number[], sampleRate = 48_000, channels = 2): Uint8Array {
  if (samples.length % channels !== 0) throw new Error('sample count must contain complete frames');
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  bytes.set(emptyWav(sampleRate, channels, dataBytes));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 36 + dataBytes, true);
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(44 + index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

describe('@aibrush/media/wav zero-frame PCM rewrite', () => {
  it('changes PCM declarations without synthesizing samples or mutating the input', () => {
    const input = emptyWav();
    const before = input.slice();
    const output = rewriteEmptyWavPcm(input, 'f32', 'le', 1, 44_100);
    expect(input).toEqual(before);
    expect(output?.byteLength).toBe(44);
    if (output === undefined) throw new Error('zero-frame rewrite unexpectedly declined');
    const view = new DataView(output.buffer);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it('declines non-empty, truncated, big-endian, and signed-8-bit requests', () => {
    const nonEmpty = new Uint8Array(46);
    nonEmpty.set(emptyWav());
    new DataView(nonEmpty.buffer).setUint32(40, 2, true);
    expect(rewriteEmptyWavPcm(nonEmpty, 's16')).toBeUndefined();
    expect(rewriteEmptyWavPcm(emptyWav(48_000, 2, 2), 's16')).toBeUndefined();
    expect(rewriteEmptyWavPcm(emptyWav(), 's16', 'be')).toBeUndefined();
    expect(rewriteEmptyWavPcm(emptyWav(), 's8')).toBeUndefined();
  });
});

describe('@aibrush/media/wav bounded PCM prefix decode', () => {
  it('decodes only the requested interleaved sample-frame prefix into exact-owned f32', () => {
    const input = s16Wav([-32_768, 32_767, 0, 16_384, -16_384, 8_192]);
    const before = input.slice();
    const decoded = decodeWavPcmInterleavedPrefix(input, 2);

    expect(input).toEqual(before);
    expect(decoded).toMatchObject({
      format: 's16',
      sampleRate: 48_000,
      channels: 2,
      frames: 2,
    });
    expect([...decoded.data]).toEqual([-1, 32_767 / 32_768, 0, 0.5]);
    expect(decoded.data.byteOffset).toBe(0);
    expect(decoded.data.byteLength).toBe(decoded.data.buffer.byteLength);
  });

  it('bounds at the available frame count and rejects invalid limits or non-WAV bytes', () => {
    expect(decodeWavPcmInterleavedPrefix(s16Wav([0, 0]), 20).frames).toBe(1);
    expect(() => decodeWavPcmInterleavedPrefix(s16Wav([0, 0]), -1)).toThrow(
      'invalid WAV PCM prefix frame count',
    );
    expect(() => decodeWavPcmInterleavedPrefix(new Uint8Array(44), 1)).toThrow(
      'not a RIFF/WAVE file',
    );
  });
});

describe('@aibrush/media/wav bounded header probe', () => {
  it('reports canonical PCM facts from a bounded header and rejects a definitively truncated fmt body', () => {
    const input = s16Wav([0, 0, 1, -1]);
    expect(parseWavHeader(input.subarray(0, 44), input.byteLength)).toMatchObject({
      info: {
        codec: 'pcm-s16',
        sampleRate: 48_000,
        channels: 2,
        durationSec: 2 / 48_000,
      },
      dataOffset: 44,
      dataBytes: 8,
      bytesPerFrame: 4,
      dataFound: true,
    });
    expect(() => parseWavHeader(input.subarray(0, 20), 20)).toThrow('WAVE: truncated fmt chunk');
  });
});
