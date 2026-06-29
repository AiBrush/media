import { describe, expect, it } from 'vitest';
import { WasmAacDriver, resetAacCoreForTest } from './wasm-aac/wasm-aac-driver.ts';
import { WasmAv1Driver, resetAv1CoreForTest } from './wasm-av1/wasm-av1-driver.ts';
import { WasmMp3Driver, resetMp3CoreForTest } from './wasm-mp3/wasm-mp3-driver.ts';
import { WasmOpusDriver, resetOpusCoreForTest } from './wasm-opus/wasm-opus-driver.ts';
import { WasmVorbisDriver, resetVorbisCoreForTest } from './wasm-vorbis/wasm-vorbis-driver.ts';
import { WasmVpxDriver, resetVpxCoreForTest } from './wasm-vpx/wasm-vpx-driver.ts';

function installAudioSeam(): () => void {
  const originalAudioData = globalThis.AudioData;
  const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    writable: true,
    value: class Session7FakeAudioData {
      close(): void {}
    } as unknown as typeof AudioData,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: class Session7FakeEncodedAudioChunk {} as unknown as typeof EncodedAudioChunk,
  });
  return () => {
    if (originalAudioData === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
    else
      Object.defineProperty(globalThis, 'AudioData', {
        configurable: true,
        writable: true,
        value: originalAudioData,
      });
    if (originalEncodedAudioChunk === undefined)
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        writable: true,
        value: originalEncodedAudioChunk,
      });
  };
}

function installVideoSeam(): () => void {
  const originalVideoFrame = globalThis.VideoFrame;
  const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    writable: true,
    value: class Session7FakeVideoFrame {
      close(): void {}
    } as unknown as typeof VideoFrame,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: class Session7FakeEncodedVideoChunk {} as unknown as typeof EncodedVideoChunk,
  });
  return () => {
    if (originalVideoFrame === undefined) Reflect.deleteProperty(globalThis, 'VideoFrame');
    else
      Object.defineProperty(globalThis, 'VideoFrame', {
        configurable: true,
        writable: true,
        value: originalVideoFrame,
      });
    if (originalEncodedVideoChunk === undefined)
      Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        writable: true,
        value: originalEncodedVideoChunk,
      });
  };
}

function resetAudioCores(): void {
  resetAacCoreForTest();
  resetMp3CoreForTest();
  resetOpusCoreForTest();
  resetVorbisCoreForTest();
}

function resetVideoCores(): void {
  resetAv1CoreForTest();
  resetVpxCoreForTest();
}

describe('Session 7.2 WASM fallback routing probes', () => {
  it('declines queries outside each fallback driver family before core selection', async () => {
    const videoDecodeQuery = {
      mediaType: 'video' as const,
      direction: 'decode' as const,
      config: { codec: 'avc1.42001f', codedWidth: 16, codedHeight: 16 },
    };
    const audioDecodeQuery = {
      mediaType: 'audio' as const,
      direction: 'decode' as const,
      config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const av1EncodeQuery = {
      mediaType: 'video' as const,
      direction: 'encode' as const,
      config: { codec: 'av01.0.04M.08', codedWidth: 16, codedHeight: 16 },
    };
    const vpxEncodeQuery = {
      mediaType: 'video' as const,
      direction: 'encode' as const,
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    };

    const aac = await WasmAacDriver.supports(videoDecodeQuery);
    const mp3 = await WasmMp3Driver.supports(videoDecodeQuery);
    const opus = await WasmOpusDriver.supports(videoDecodeQuery);
    const vorbis = await WasmVorbisDriver.supports(videoDecodeQuery);
    const av1Audio = await WasmAv1Driver.supports(audioDecodeQuery);
    const vpxAudio = await WasmVpxDriver.supports(audioDecodeQuery);
    const av1Encode = await WasmAv1Driver.supports(av1EncodeQuery);
    const vpxEncode = await WasmVpxDriver.supports(vpxEncodeQuery);

    expect(aac.supported).toBe(false);
    expect(aac.reason ?? '').toMatch(/audio only/);
    expect(mp3.supported).toBe(false);
    expect(mp3.reason ?? '').toMatch(/audio only/);
    expect(opus.supported).toBe(false);
    expect(opus.reason ?? '').toMatch(/audio only/);
    expect(vorbis.supported).toBe(false);
    expect(vorbis.reason ?? '').toMatch(/audio only/);
    expect(av1Audio.supported).toBe(false);
    expect(av1Audio.reason ?? '').toMatch(/video only/);
    expect(vpxAudio.supported).toBe(false);
    expect(vpxAudio.reason ?? '').toMatch(/video only/);
    expect(av1Encode.supported).toBe(false);
    expect(av1Encode.reason ?? '').toMatch(/decode-only/);
    expect(vpxEncode.supported).toBe(false);
    expect(vpxEncode.reason ?? '').toMatch(/decode-only/);
  });

  it('declines exact audio configs the fallback decoder would reject later', async () => {
    const restore = installAudioSeam();
    try {
      const aac = await WasmAacDriver.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 6 },
      });
      const mp3 = await WasmMp3Driver.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 3 },
      });
      const opus = await WasmOpusDriver.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'opus', sampleRate: 44_100, numberOfChannels: 2 },
      });
      const vorbis = await WasmVorbisDriver.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 },
      });

      expect(aac.supported).toBe(false);
      expect(aac.reason ?? '').toMatch(/channels/);
      expect(mp3.supported).toBe(false);
      expect(mp3.reason ?? '').toMatch(/channels/);
      expect(opus.supported).toBe(false);
      expect(opus.reason ?? '').toMatch(/sampleRate/);
      expect(vorbis.supported).toBe(false);
      expect(vorbis.reason ?? '').toMatch(/description/);
    } finally {
      restore();
      resetAudioCores();
    }
  });

  it('declines exact video configs outside the vendored AV1/VPX core envelopes', async () => {
    const restore = installVideoSeam();
    try {
      const av1Main10 = await WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'av01.0.04M.10', codedWidth: 320, codedHeight: 240 },
      });
      const av1Monochrome = await WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'av01.0.04M.08.1.110', codedWidth: 320, codedHeight: 240 },
      });
      const av1Professional444 = await WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'av01.2.05M.12.0.000', codedWidth: 320, codedHeight: 240 },
      });
      const vpxTenBit = await WasmVpxDriver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'vp09.00.10.10', codedWidth: 320, codedHeight: 240 },
      });
      const vpx444 = await WasmVpxDriver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'vp09.01.10.08.03', codedWidth: 320, codedHeight: 240 },
      });

      expect(av1Main10.supported).toBe(false);
      expect(av1Main10.reason ?? '').toMatch(/10-bit|does not support/);
      expect(av1Monochrome.supported).toBe(false);
      expect(av1Monochrome.reason ?? '').toMatch(/monochrome|4:2:0/);
      expect(av1Professional444.supported).toBe(false);
      expect(av1Professional444.reason ?? '').toMatch(/12-bit|4:2:0|does not support/);
      expect(vpxTenBit.supported).toBe(false);
      expect(vpxTenBit.reason ?? '').toMatch(/8-bit/);
      expect(vpx444.supported).toBe(false);
      expect(vpx444.reason ?? '').toMatch(/4:2:0/);
    } finally {
      restore();
      resetVideoCores();
    }
  });

  it('accepts exact configs inside the vendored video fallback envelopes', async () => {
    const restore = installVideoSeam();
    try {
      const av1 = await WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
      });
      const vpx = await WasmVpxDriver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 240 },
      });

      expect(av1.supported).toBe(true);
      expect(vpx.supported).toBe(true);
    } finally {
      restore();
      resetVideoCores();
    }
  });
});
