import { describe, expect, it } from 'vitest';
import type { CodecDriver, ContainerDriver, Packet, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { Registry } from '../kernel/registry.ts';
import { fixtureSource } from '../test-support/corpus.ts';
import { registerDefaultDrivers } from './defaults.ts';

function findContainer(reg: Registry, id: string): ContainerDriver {
  const driver = reg.containers().find((d) => d.id === id);
  if (driver === undefined) throw new Error(`missing container driver '${id}'`);
  return driver;
}

function findCodec(reg: Registry, id: string): CodecDriver {
  const driver = reg.codecs().find((d) => d.id === id);
  if (driver === undefined) throw new Error(`missing codec driver '${id}'`);
  return driver;
}

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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function fakeEncodedAudioChunk(bytes: Uint8Array): EncodedAudioChunk {
  const chunk = {
    byteLength: bytes.byteLength,
    timestamp: 0,
    duration: 1024,
    type: 'key',
    copyTo(destination: AllowSharedBufferSource): void {
      const out = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      out.set(bytes);
    },
  };
  return chunk as unknown as EncodedAudioChunk;
}

function flacTrackInfo(description: Uint8Array): TrackInfo {
  return {
    id: 7,
    mediaType: 'audio',
    codec: 'flac',
    config: {
      codec: 'flac',
      sampleRate: 48_000,
      numberOfChannels: 1,
      description,
    },
  };
}

describe('registerDefaultDrivers', () => {
  it('registers image support on the default registry host', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const images = reg.imageOps();
    expect(images).toBeDefined();
    expect(images?.sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    );
  });

  it('registers the real software video-decode wasm tails (AV1/VPx) now that their cores are vendored', () => {
    // AV1 (dav1d, ADR-093) and VP8/VP9 (ogv.js libvpx, ADR-094) ship vendored prebuilt cores and are
    // registered as miss-only fallbacks — they are no longer core-less scaffolds. They still `supports()`
    // →false in Node (no WebCodecs `VideoFrame` seam); registration just makes the tail available so a
    // browser WebCodecs miss can lazy-load the wasm.
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const ids = reg.codecs().map((d) => d.id);
    expect(ids).toContain('wasm-av1');
    expect(ids).toContain('wasm-vpx');
  });

  it('registers FLAC as a lazy container proxy with cheap support checks', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const flac = findContainer(reg, 'flac');
    expect(flac.formats).toEqual(['flac']);
    expect(
      flac.supports({ direction: 'demux', head: new Uint8Array([0x66, 0x4c, 0x61, 0x43]) }),
    ).toBe(true);
    expect(flac.supports({ direction: 'demux', mime: 'audio/flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'mp3' })).toBe(false);
  });

  it('lazy-loads the FLAC container only when demux or PCM helpers are invoked', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const flac = findContainer(reg, 'flac');
    if (
      flac.decodePcm === undefined ||
      flac.decodePcmAudio === undefined ||
      flac.transformPcm === undefined
    ) {
      throw new Error('lazy FLAC proxy must expose the PCM helper surface');
    }

    const src = await fixtureSource('flac-08bit.flac');
    const demuxer = await flac.demux(src);
    expect(demuxer.tracks).toHaveLength(1);
    expect(demuxer.tracks[0]?.codec).toBe('flac');
    await demuxer.close();

    const audio = await flac.decodePcmAudio(src);
    expect(audio.sampleRate).toBeGreaterThan(0);
    expect(audio.channels).toBeGreaterThan(0);
    expect(audio.planar[0]?.length).toBeGreaterThan(0);

    const wav = await collectBytes(await flac.decodePcm(src, { container: 'wav' }));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');

    const transformed = await collectBytes(
      await flac.transformPcm(src, { container: 'wav', gainDb: -1 }),
    );
    expect(new TextDecoder().decode(transformed.slice(0, 4))).toBe('RIFF');
  });

  it('routes the lazy FLAC muxer through the real muxer and preserves typed misuse errors', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const flac = findContainer(reg, 'flac');
    const description = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x00]);
    const frame = new Uint8Array([0xff, 0xf8, 0x69, 0x00]);

    const muxer = flac.createMuxer();
    expect(muxer.addTrack(flacTrackInfo(description))).toBe(0);
    const output = collectBytes(muxer.output);
    await muxer.write(0, { chunk: fakeEncodedAudioChunk(frame) } satisfies Packet);
    await muxer.finalize();
    const bytes = await output;
    expect([...bytes.slice(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect([...bytes.slice(-frame.byteLength)]).toEqual([...frame]);

    const invalid = flac.createMuxer();
    expect(() => invalid.addTrack({ id: 1, mediaType: 'video', codec: 'vp9' })).toThrowError(
      CapabilityError,
    );

    const duplicate = flac.createMuxer();
    expect(duplicate.addTrack(flacTrackInfo(description))).toBe(0);
    expect(() => duplicate.addTrack(flacTrackInfo(description))).toThrowError(CapabilityError);

    await expect(flac.createMuxer().finalize()).rejects.toThrowError(MediaError);
    await expect(flac.createMuxer({ fragmented: true }).finalize()).rejects.toThrowError(
      CapabilityError,
    );
  });

  it('registers lazy codec proxies that load only after a matching support query', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const flacEncode = findCodec(reg, 'flac-encode');
    expect(flacEncode.tier).toBe('native');
    expect(() =>
      flacEncode.createEncoder({ codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 }),
    ).toThrowError(CapabilityError);
    await expect(
      flacEncode.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 },
      }),
    ).resolves.toMatchObject({ supported: false });
    await expect(
      flacEncode.supports({
        mediaType: 'audio',
        direction: 'encode',
        config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 },
      }),
    ).resolves.toMatchObject({ supported: false });
    expect(() =>
      flacEncode.createEncoder({ codec: 'flac', sampleRate: 0, numberOfChannels: 1 }),
    ).toThrowError(MediaError);
    expect(() =>
      flacEncode.createDecoder({ codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 }),
    ).toThrowError(MediaError);

    const vpx = findCodec(reg, 'wasm-vpx');
    await expect(
      vpx.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'vp09.00.10.08', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).resolves.toMatchObject({ supported: false, reason: 'wasm-vpx does not match' });
    expect(() =>
      vpx.createDecoder({ codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 }),
    ).toThrowError(CapabilityError);
  });
});
