/**
 * Unit tests for the AV1 dav1d WASM fallback scaffold. These lock the pure, Node-runnable surface:
 * AV1 codec-string parsing, B-frame/VFR display timestamp ordering, 8/10/12-bit 4:2:0 layout math,
 * decoder-config normalization, driver identity/registration, and honest absence of the dav1d core.
 * Real decoded-frame validation is blocked until the dav1d WASM artifact is vendored (BUILD.md).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { Mp4Module } from '../../drivers/mp4/mp4-driver.ts';
import { fixtureSource } from '../../test-support/corpus.ts';
import {
  normalizeAv1DecoderConfig,
  parseAv1Codec,
  pixelFormatForAv1BitDepth,
  planeLayoutI420,
  pushDisplayTimestamp,
  shiftDisplayTimestamp,
} from './av1.ts';
import WasmAv1Module, {
  AV1_CODEC,
  hasVideoFrameSeam,
  isAv1DecodeQuery,
  loadAv1Core,
  probeAv1Core,
  resetAv1CoreForTest,
  unsupported,
  WasmAv1Driver,
} from './wasm-av1-driver.ts';

describe('parseAv1Codec — AV1 codec strings', () => {
  it('bare av1 maps to the conservative decode default', () => {
    expect(parseAv1Codec('av1')).toEqual({
      codec: 'av1',
      profile: 0,
      level: 4,
      tier: 'main',
      bitDepth: 8,
      monochrome: false,
      chromaSubsampling: '420',
    });
  });

  it('parses the real WPT av1.mp4 codec string', () => {
    expect(parseAv1Codec('av01.0.00M.08')).toEqual({
      codec: 'av1',
      profile: 0,
      level: 0,
      tier: 'main',
      bitDepth: 8,
      monochrome: false,
      chromaSubsampling: '420',
    });
  });

  it('parses 10-bit, high-tier, and explicit 4:2:0 fields', () => {
    expect(parseAv1Codec('av01.0.08H.10.0.110.09.16.09.0')).toMatchObject({
      profile: 0,
      level: 8,
      tier: 'high',
      bitDepth: 10,
      monochrome: false,
      chromaSubsampling: '420',
    });
  });

  it('parses professional profile 12-bit 4:4:4 and monochrome', () => {
    expect(parseAv1Codec('av01.2.05M.12.0.000')).toMatchObject({
      profile: 2,
      bitDepth: 12,
      chromaSubsampling: '444',
    });
    expect(parseAv1Codec('av01.0.04M.08.1.110')).toMatchObject({
      monochrome: true,
      chromaSubsampling: '400',
    });
  });

  it('rejects malformed profile, tier, bit depth, and chroma fields', () => {
    expect(() => parseAv1Codec('vp09.00.10.08')).toThrow(MediaError);
    expect(() => parseAv1Codec('av01.3.04M.08')).toThrow(/profile/);
    expect(() => parseAv1Codec('av01.0.99M.08')).toThrow(/level/);
    expect(() => parseAv1Codec('av01.0.04X.08')).toThrow(/level\/tier/);
    expect(() => parseAv1Codec('av01.0.04M.09')).toThrow(/bit depth/);
    expect(() => parseAv1Codec('av01.0.04M.08.2')).toThrow(/monochrome/);
    expect(() => parseAv1Codec('av01.0.04M.08.0.010')).toThrow(/chroma/);
  });
});

describe('real AV1 corpus metadata strings feed the parser', () => {
  it('parses the checked-in 8-bit and 10-bit AV1 fixture codec strings', async () => {
    const media = createMedia().use(Mp4Module);
    const wpt = await media.probe(await fixtureSource('av1.mp4'));
    const bear10 = await media.probe(await fixtureSource('bear-av1-10bit.mp4'));
    const wptCodec = wpt.tracks[0]?.codec;
    const bearCodec = bear10.tracks[0]?.codec;
    expect(wptCodec).toBe('av01.0.00M.08');
    expect(bearCodec?.startsWith('av01.')).toBe(true);
    expect(parseAv1Codec(wptCodec ?? '')).toMatchObject({ bitDepth: 8, profile: 0 });
    expect(parseAv1Codec(bearCodec ?? '')).toMatchObject({ bitDepth: 10, profile: 0 });
  });
});

describe('display timestamp queue — reordered AV1 output', () => {
  it('emits timestamps in presentation order even when input chunks arrive in decode order', () => {
    const queue: Array<{ timestampUs: number; durationUs: number | null }> = [];
    pushDisplayTimestamp(queue, { timestampUs: 0, durationUs: 33_333 });
    pushDisplayTimestamp(queue, { timestampUs: 100_000, durationUs: 33_333 });
    pushDisplayTimestamp(queue, { timestampUs: 33_333, durationUs: 33_333 });
    pushDisplayTimestamp(queue, { timestampUs: 66_666, durationUs: 33_334 });

    expect(shiftDisplayTimestamp(queue)?.timestampUs).toBe(0);
    expect(shiftDisplayTimestamp(queue)?.timestampUs).toBe(33_333);
    expect(shiftDisplayTimestamp(queue)?.timestampUs).toBe(66_666);
    expect(shiftDisplayTimestamp(queue)?.timestampUs).toBe(100_000);
    expect(shiftDisplayTimestamp(queue)).toBeUndefined();
  });
});

describe('4:2:0 plane layout', () => {
  it('maps bit depth to WebCodecs pixel formats', () => {
    expect(pixelFormatForAv1BitDepth(8)).toBe('I420');
    expect(pixelFormatForAv1BitDepth(10)).toBe('I420P10');
    expect(pixelFormatForAv1BitDepth(12)).toBe('I420P12');
  });

  it('computes 8-bit and 10-bit odd-dimension layouts', () => {
    expect(planeLayoutI420(5, 3, 8)).toMatchObject({
      format: 'I420',
      byteLength: 27,
      planes: [
        { offset: 0, stride: 5 },
        { offset: 15, stride: 3 },
        { offset: 21, stride: 3 },
      ],
    });
    expect(planeLayoutI420(2, 2, 10)).toMatchObject({
      format: 'I420P10',
      byteLength: 12,
      planes: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 2 },
        { offset: 10, stride: 2 },
      ],
    });
  });

  it('rejects invalid dimensions', () => {
    expect(() => planeLayoutI420(0, 2, 8)).toThrow(MediaError);
    expect(() => planeLayoutI420(2.5, 2, 8)).toThrow(MediaError);
  });
});

describe('normalizeAv1DecoderConfig', () => {
  it('carries parsed codec facts, coded dimensions, and description bytes', () => {
    const description = Uint8Array.of(0xff, 0x81, 0x00, 0x0c, 0x00, 0xee);
    const init = normalizeAv1DecoderConfig({
      codec: 'av01.0.00M.08',
      codedWidth: 320,
      codedHeight: 240,
      description: description.subarray(1, 5),
    });
    description[1] = 0x00;
    expect(init).toMatchObject({
      codec: 'av1',
      profile: 0,
      level: 0,
      tier: 'main',
      bitDepth: 8,
      codedWidth: 320,
      codedHeight: 240,
    });
    expect([...(init.description ?? [])]).toEqual([0x81, 0x00, 0x0c, 0x00]);
  });

  it('omits invalid optional dimensions without writing undefined keys', () => {
    const init = normalizeAv1DecoderConfig({
      codec: 'av01.0.04M.08',
      codedWidth: 0,
      codedHeight: 1,
    });
    expect('codedWidth' in init).toBe(false);
    expect('codedHeight' in init).toBe(false);
  });
});

describe('wasm-av1 driver identity and honest absence', () => {
  afterEach(() => {
    resetAv1CoreForTest();
  });

  it('declares the expected codec driver identity', () => {
    expect(AV1_CODEC).toBe('av1');
    expect(WasmAv1Driver.id).toBe('wasm-av1');
    expect(WasmAv1Driver.kind).toBe('codec');
    expect(WasmAv1Driver.tier).toBe('wasm');
    expect(WasmAv1Driver.apiVersion).toBe(1);
  });

  it('registers exactly itself as a codec module', () => {
    const added: unknown[] = [];
    WasmAv1Module.register({
      addCodec: (d) => added.push(d),
      addContainer: () => undefined,
      addFilter: () => undefined,
    });
    expect(added).toEqual([WasmAv1Driver]);
  });

  it('matches AV1 video decode queries only', () => {
    expect(
      isAv1DecodeQuery({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'av01.0.04M.08' },
      }),
    ).toBe(true);
    expect(
      isAv1DecodeQuery({
        mediaType: 'video',
        direction: 'encode',
        config: { codec: 'av01.0.04M.08' } as unknown as VideoEncoderConfig,
      }),
    ).toBe(false);
    expect(
      isAv1DecodeQuery({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'av01.0.04M.08' } as unknown as AudioDecoderConfig,
      }),
    ).toBe(false);
  });

  it('unsupported returns a reasoned non-support result', () => {
    expect(unsupported('blocked')).toEqual({ supported: false, reason: 'blocked' });
  });

  it('has no browser video frame seam in Node', () => {
    expect(hasVideoFrameSeam()).toBe(false);
  });

  it('does not find or load a dav1d core when artifacts are absent', async () => {
    expect(await probeAv1Core()).toBe(false);
    await expect(
      loadAv1Core({
        kind: 'baseline',
        simd: false,
        threads: false,
        sharedArrayBuffer: false,
      }),
    ).resolves.toBeNull();
  });

  it('supports() returns false in Node before any core load', async () => {
    const s = await WasmAv1Driver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/EncodedVideoChunk/);
  });

  it('supports() returns false for encode and non-AV1 codecs', async () => {
    await expect(
      WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'encode',
        config: {
          codec: 'av01.0.04M.08',
          width: 320,
          height: 240,
        } as unknown as VideoEncoderConfig,
      }),
    ).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/decode-only/) });

    await expect(
      WasmAv1Driver.supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'vp09.00.10.08' },
      }),
    ).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/AV1/) });
  });

  it('createDecoder fails fast with a typed capability miss when the host video seam is absent', () => {
    expect(() =>
      WasmAv1Driver.createDecoder({ codec: 'av01.0.04M.08', codedWidth: 16, codedHeight: 16 }),
    ).toThrow(CapabilityError);
  });

  it('createDecoder validates config before the seam check', () => {
    expect(() => WasmAv1Driver.createDecoder({ codec: 'vp09.00.10.08' })).toThrow(MediaError);
  });

  it('createEncoder is an honest dav1d decode-only miss', () => {
    expect(() =>
      WasmAv1Driver.createEncoder({
        codec: 'av01.0.04M.08',
        width: 320,
        height: 240,
      } as unknown as VideoEncoderConfig),
    ).toThrow(CapabilityError);
  });
});
