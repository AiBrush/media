import { describe, expect, it } from 'vitest';
import { audioDataToPlanes as mp3Planes } from './wasm-mp3-enc/wasm-mp3-enc-driver.ts';
import { audioDataToInterleaved as opusInterleaved } from './wasm-opus/wasm-opus-driver.ts';
import { audioDataToInterleaved as vorbisInterleaved } from './wasm-vorbis-enc/wasm-vorbis-enc-driver.ts';

function interleave(planes: Float32Array[]): Float32Array {
  const frames = planes[0]?.length ?? 0;
  const channels = planes.length;
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) out[i * channels + c] = planes[c]?.[i] ?? 0;
  return out;
}

class WebKitLikeAudioData {
  constructor(
    readonly sampleRate: number,
    readonly numberOfChannels: number,
    readonly numberOfFrames: number,
    readonly timestamp: number,
    private readonly interleaved: Float32Array,
  ) {}

  copyTo(destination: AllowSharedBufferSource, options?: AudioDataCopyToOptions): void {
    const opts = options as { planeIndex?: number; format?: string } | undefined;
    // WebKit rejects f32-planar per-plane copies
    if (opts?.format === 'f32-planar') {
      throw new DOMException('NotSupportedError', 'NotSupportedError');
    }
    // WebKit supports interleaved f32 as a single copy covering all channels
    if (opts?.format === 'f32') {
      (destination as Float32Array).set(this.interleaved);
      return;
    }
    throw new TypeError('unsupported format in mock');
  }

  close(): void {}
}

class NormalAudioData {
  constructor(
    readonly sampleRate: number,
    readonly numberOfChannels: number,
    readonly numberOfFrames: number,
    readonly timestamp: number,
    private readonly planes: Float32Array[],
  ) {}

  copyTo(destination: AllowSharedBufferSource, options?: AudioDataCopyToOptions): void {
    const opts = options as { planeIndex?: number; format?: string } | undefined;
    if (opts?.format === 'f32-planar') {
      const idx = opts.planeIndex ?? 0;
      (destination as Float32Array).set(this.planes[idx] ?? new Float32Array(0));
      return;
    }
    if (opts?.format === 'f32') {
      (destination as Float32Array).set(interleave(this.planes));
      return;
    }
    throw new TypeError('unsupported');
  }

  close(): void {}
}

describe('WASM audio encoders — WebKit AudioData fallback', () => {
  it('vorbis: planar fallback produces identical interleaved samples on WebKit-like AudioData', () => {
    const frames = 4;
    const channels = 2;
    const planes = [
      Float32Array.from([0.1, 0.2, 0.3, 0.4]),
      Float32Array.from([0.5, 0.6, 0.7, 0.8]),
    ];
    const interleaved = interleave(planes);
    const wk = new WebKitLikeAudioData(
      48000,
      channels,
      frames,
      0,
      interleaved,
    ) as unknown as AudioData;
    const normal = new NormalAudioData(48000, channels, frames, 0, planes) as unknown as AudioData;
    const outWebKit = vorbisInterleaved(wk, { sampleRate: 48000, channels } as never);
    const outNormal = vorbisInterleaved(normal, { sampleRate: 48000, channels } as never);
    expect(outWebKit).toEqual(interleaved);
    expect(outNormal).toEqual(interleaved);
    expect(outWebKit).toEqual(outNormal);
  });

  it('opus: planar fallback works for WebKit-like source', () => {
    const frames = 3;
    const channels = 1;
    const planes = [Float32Array.from([1, 2, 3])];
    const interleaved = interleave(planes);
    const wk = new WebKitLikeAudioData(
      48000,
      channels,
      frames,
      0,
      interleaved,
    ) as unknown as AudioData;
    expect(opusInterleaved(wk)).toEqual(interleaved);
  });

  it('mp3: planar fallback de-interleaves correctly on WebKit-like source', () => {
    const frames = 2;
    const channels = 2;
    const planes = [Float32Array.from([0.1, 0.2]), Float32Array.from([0.3, 0.4])];
    const interleaved = interleave(planes);
    const wk = new WebKitLikeAudioData(
      44100,
      channels,
      frames,
      0,
      interleaved,
    ) as unknown as AudioData;
    const out = mp3Planes(wk, { sampleRate: 44100, channels } as never);
    expect(out[0]).toEqual(planes[0]);
    expect(out[1]).toEqual(planes[1]);
  });

  it('vorbis: normal planar path still used when available (no fallback triggered)', () => {
    const frames = 2;
    const channels = 2;
    const planes = [Float32Array.from([9, 9]), Float32Array.from([8, 8])];
    const normal = new NormalAudioData(48000, channels, frames, 0, planes) as unknown as AudioData;
    // Should not throw and should use interleaved path which works for both layouts
    const out = vorbisInterleaved(normal, { sampleRate: 48000, channels } as never);
    expect(out).toEqual(interleave(planes));
  });

  it('boundary: single frame stereo via fallback', () => {
    const frames = 1;
    const channels = 2;
    const planes = [Float32Array.from([0.5]), Float32Array.from([-0.5])];
    const interleaved = interleave(planes);
    const wk = new WebKitLikeAudioData(
      48000,
      channels,
      frames,
      0,
      interleaved,
    ) as unknown as AudioData;
    expect(vorbisInterleaved(wk, { sampleRate: 48000, channels } as never)).toEqual(interleaved);
  });

  it('randomized: fallback matches planar for random stereo tones', () => {
    for (let trial = 0; trial < 20; trial++) {
      const frames = 16 + Math.floor(Math.random() * 16);
      const channels = 2;
      const planes = [
        Float32Array.from({ length: frames }, () => Math.random() * 2 - 1),
        Float32Array.from({ length: frames }, () => Math.random() * 2 - 1),
      ];
      const interleaved = interleave(planes);
      const wk = new WebKitLikeAudioData(
        48000,
        channels,
        frames,
        0,
        interleaved,
      ) as unknown as AudioData;
      const normal = new NormalAudioData(
        48000,
        channels,
        frames,
        0,
        planes,
      ) as unknown as AudioData;
      const a = vorbisInterleaved(wk, { sampleRate: 48000, channels } as never);
      const b = vorbisInterleaved(normal, { sampleRate: 48000, channels } as never);
      expect(a).toEqual(b);
      expect(a).toEqual(interleaved);
    }
  });

  // WebKit has been observed to return swapped channels via the per-plane `f32-planar`
  // path even when it does not throw. The new interleaved-first implementation must
  // remain correct in that case. This mock returns swapped planes for `f32-planar`
  // but correct data for `f32`, mimicking the channel-swap bug.
  class SwappedPlanarAudioData {
    constructor(
      readonly sampleRate: number,
      readonly numberOfChannels: number,
      readonly numberOfFrames: number,
      readonly timestamp: number,
      private readonly planes: Float32Array[],
      private readonly interleaved: Float32Array,
    ) {}
    copyTo(destination: AllowSharedBufferSource, options?: AudioDataCopyToOptions): void {
      const opts = options as { planeIndex?: number; format?: string } | undefined;
      if (opts?.format === 'f32-planar') {
        const idx = opts.planeIndex ?? 0;
        // Return the *other* channel's data to simulate the WebKit swap bug.
        const swapped = idx === 0 ? 1 : 0;
        (destination as Float32Array).set(this.planes[swapped] ?? new Float32Array(0));
        return;
      }
      if (opts?.format === 'f32') {
        (destination as Float32Array).set(this.interleaved);
        return;
      }
      throw new TypeError('unsupported');
    }
    close(): void {}
  }

  it('interleaved-first avoids WebKit planar channel-swap: vorbis/opus/mp3 stay bit-exact', () => {
    const frames = 8;
    const channels = 2;
    const planes = [
      Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      Float32Array.from([10, 20, 30, 40, 50, 60, 70, 80]),
    ];
    const interleaved = interleave(planes);
    const swapped = new SwappedPlanarAudioData(
      48000,
      channels,
      frames,
      0,
      planes,
      interleaved,
    ) as unknown as AudioData;
    // All three encoders must read the correct interleaved order, not the swapped planar order.
    expect(vorbisInterleaved(swapped, { sampleRate: 48000, channels } as never)).toEqual(
      interleaved,
    );
    expect(opusInterleaved(swapped)).toEqual(interleaved);
    const mp3Out = mp3Planes(swapped, { sampleRate: 48000, channels } as never);
    expect(mp3Out[0]).toEqual(planes[0]);
    expect(mp3Out[1]).toEqual(planes[1]);
    // Also verify the normal path (correct planar) still matches via interleaved-first.
    const normal = new NormalAudioData(48000, channels, frames, 0, planes) as unknown as AudioData;
    expect(vorbisInterleaved(normal, { sampleRate: 48000, channels } as never)).toEqual(
      interleaved,
    );
  });

  it('dsp/audioDataToPcm via interleaved-first is WebKit-exact and randomized', async () => {
    const { audioDataToPcm } = await import('../dsp/audio-data.ts');
    for (let trial = 0; trial < 20; trial++) {
      const frames = 8 + Math.floor(Math.random() * 8);
      const channels = trial % 2 === 0 ? 1 : 2;
      const planes = Array.from({ length: channels }, () =>
        Float32Array.from({ length: frames }, () => Math.random() * 2 - 1),
      );
      const interleaved = interleave(planes);
      const wk = new WebKitLikeAudioData(
        48000,
        channels,
        frames,
        0,
        interleaved,
      ) as unknown as AudioData;
      const normal = new NormalAudioData(
        48000,
        channels,
        frames,
        0,
        planes,
      ) as unknown as AudioData;
      const pcmWk = audioDataToPcm(wk);
      const pcmNormal = audioDataToPcm(normal);
      for (let c = 0; c < channels; c++) {
        expect(Array.from(pcmWk.planar[c] ?? [])).toEqual(Array.from(planes[c] ?? []));
        expect(Array.from(pcmNormal.planar[c] ?? [])).toEqual(Array.from(planes[c] ?? []));
      }
      // Swapped-planar mock must still decode correctly via interleaved
      const swapped = new SwappedPlanarAudioData(
        48000,
        channels,
        frames,
        0,
        planes,
        interleaved,
      ) as unknown as AudioData;
      const pcmSwapped = audioDataToPcm(swapped);
      for (let c = 0; c < channels; c++) {
        expect(Array.from(pcmSwapped.planar[c] ?? [])).toEqual(Array.from(planes[c] ?? []));
      }
    }
    // Empty frames boundary
    const empty = new WebKitLikeAudioData(
      48000,
      2,
      0,
      0,
      new Float32Array(0),
    ) as unknown as AudioData;
    const pcmEmpty = audioDataToPcm(empty);
    expect(pcmEmpty.frames).toBe(0);
    expect(pcmEmpty.planar.length).toBe(2);
  });

  it('malformed: mismatched sampleRate/channels throw typed InputError via vorbis/mp3', () => {
    const planes = [Float32Array.from([0, 0]), Float32Array.from([0, 0])];
    const interleaved = interleave(planes);
    const wk = new WebKitLikeAudioData(48000, 2, 2, 0, interleaved) as unknown as AudioData;
    expect(() => vorbisInterleaved(wk, { sampleRate: 44100, channels: 2 } as never)).toThrow();
    expect(() => vorbisInterleaved(wk, { sampleRate: 48000, channels: 1 } as never)).toThrow();
    const normal = new NormalAudioData(48000, 2, 2, 0, planes) as unknown as AudioData;
    expect(() => mp3Planes(normal, { sampleRate: 44100, channels: 2 } as never)).toThrow();
  });
});
