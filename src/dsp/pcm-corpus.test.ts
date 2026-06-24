import { describe, expect, it } from 'vitest';
import { type WavPcm, readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { type SampleFormat, channelAt, encodePcm } from './pcm.ts';

/** Independent `data`-chunk locator (skips fmt/fact/etc.) — the byte-exact oracle stays independent. */
function dataChunk(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[pos] ?? 0,
      bytes[pos + 1] ?? 0,
      bytes[pos + 2] ?? 0,
      bytes[pos + 3] ?? 0,
    );
    const size = dv.getUint32(pos + 4, true);
    if (id === 'data')
      return bytes.subarray(pos + 8, pos + 8 + Math.min(size, bytes.byteLength - pos - 8));
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function maxAbsDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

// The same "sfx" sound encoded to every PCM wire format (s24/s32/f32 are WAVE_FORMAT_EXTENSIBLE).
const PCM_FIXTURES: Array<{ id: string; format: SampleFormat; quantStep: number }> = [
  { id: 'sfx-pcm-u8.wav', format: 'u8', quantStep: 2 ** -7 },
  { id: 'sfx-pcm-s16.wav', format: 's16', quantStep: 2 ** -15 },
  { id: 'sfx-pcm-s24.wav', format: 's24', quantStep: 2 ** -23 },
  { id: 'sfx-pcm-s32.wav', format: 's32', quantStep: 2 ** -23 }, // f64 canonical caps at 24-bit vs f32 ref
  { id: 'sfx-pcm-f32.wav', format: 'f32', quantStep: 2 ** -23 },
];

describe('audio-dsp on the real PCM corpus (decoded-audio-pcm, every wire format)', () => {
  for (const { id, format } of PCM_FIXTURES) {
    it(`${id}: decodes as ${format} @ 48 kHz mono and re-encodes byte-for-byte`, async () => {
      const file = await loadFixture(id);
      const a = readWavPcm(file);
      expect(a.format).toBe(format);
      expect(a.sampleRate).toBe(48000);
      expect(a.channels).toBe(1);
      expect(a.frames).toBeGreaterThan(0);
      // Strict per-format oracle on real audio: encode∘decode reproduces the source PCM exactly.
      expect(encodePcm(a, a.format)).toEqual(dataChunk(file));
    });
  }

  it('cross-format: every encoding is the same signal within its quantization step', async () => {
    const decoded = new Map<SampleFormat, WavPcm>();
    for (const { id, format } of PCM_FIXTURES)
      decoded.set(format, readWavPcm(await loadFixture(id)));

    const ref = decoded.get('f32');
    expect(ref).toBeDefined();
    if (!ref) return;
    const refCh = channelAt(ref.planar, 0);

    // All formats must agree on length (same source) ...
    for (const { format } of PCM_FIXTURES) {
      expect(decoded.get(format)?.frames).toBe(ref.frames);
    }
    // ... and on sample values, to within each format's quantization step vs the float reference.
    for (const { format, quantStep } of PCM_FIXTURES) {
      const ch = channelAt(decoded.get(format)?.planar ?? [], 0);
      expect(maxAbsDiff(ch, refCh)).toBeLessThanOrEqual(quantStep * 1.5);
    }
  });
});
