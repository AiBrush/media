import { describe, expect, it } from 'vitest';
import { NoopDriverModule } from '../conformance/noop-driver.ts';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
  type TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type MediaInput, type Source, fromBytes, fromStream } from '../sources/source.ts';
import * as sugar from './create-media.ts';
import { createMedia } from './create-media.ts';

/** A container driver that reports real tracks, to exercise MediaInfo mapping. */
function tracksModule(): DriverModule {
  const tracks: TrackInfo[] = [
    {
      id: 0,
      mediaType: 'video',
      codec: 'avc1.42001f',
      durationSec: 10,
      config: { codec: 'avc1.42001f', codedWidth: 1920, codedHeight: 1080 },
    },
    {
      id: 1,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: 9.5,
      config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    },
  ];
  const driver: ContainerDriver = {
    id: 'fake-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/mp4' || q.head?.[0] === 0x66,
    demux: () =>
      Promise.resolve({
        tracks,
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (reg) => reg.addContainer(driver) };
}

const NOOP_BYTES = fromBytes(new Uint8Array([1, 2, 3, 4]), { mime: 'application/x-noop' });

describe('createMedia', () => {
  it('instantiates an engine exposing the public surface', () => {
    const media = createMedia();
    for (const m of [
      'probe',
      'convert',
      'remux',
      'trim',
      'decode',
      'encode',
      'demux',
      'mux',
      'decrypt',
      'preload',
      'from',
      'source',
      'use',
    ]) {
      expect(typeof (media as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('normalizes inputs through from()/source()', () => {
    const media = createMedia();
    expect(media.from(new Uint8Array([1])).kind).toBe('bytes');
    expect(media.source('https://x/y.mp4').kind).toBe('url');
  });

  it('probe routes to a registered container driver and returns MediaInfo', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES);
    expect(info).toEqual({ container: 'noop', durationSec: 0, sizeBytes: 4, tracks: [] });
  });

  it('probe raises a typed CapabilityError when no container driver is registered', async () => {
    await expect(createMedia().probe(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('demux routes to a registered container driver and exposes packet streams', async () => {
    const media = createMedia().use(NoopDriverModule);
    const demuxed = await media.demux(NOOP_BYTES);
    expect(demuxed.tracks).toEqual([]);
    const reader = demuxed.packets(0).getReader();
    expect((await reader.read()).done).toBe(true);
    await demuxed.close();
  });

  it('probe maps demuxer tracks into MediaInfo (dims + audio params + duration)', async () => {
    const media = createMedia().use(tracksModule());
    const info = await media.probe(fromBytes(new Uint8Array([1]), { mime: 'video/mp4' }));
    expect(info.container).toBe('mp4');
    expect(info.durationSec).toBe(10);
    expect(info.tracks).toEqual([
      { id: 0, type: 'video', codec: 'avc1.42001f', durationSec: 10, width: 1920, height: 1080 },
      {
        id: 1,
        type: 'audio',
        codec: 'mp4a.40.2',
        durationSec: 9.5,
        sampleRate: 48000,
        channels: 2,
      },
    ]);
  });

  it('codec-dependent ops raise a typed CapabilityError (Phase 1 pipelines)', async () => {
    const media = createMedia();
    await expect(media.convert(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.remux(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.trim(NOOP_BYTES, { start: 0, end: 1 })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(media.encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.mux({}, { container: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.decrypt(NOOP_BYTES, { scheme: 'cenc', keys: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    expect(() => media.decode(NOOP_BYTES)).toThrowError(CapabilityError);
  });

  it('reads the head of a non-seekable custom source, then routes', async () => {
    const noRange: Source = {
      __media: 'source',
      kind: 'bytes',
      stream: () =>
        new ReadableStream({
          start: (c) => {
            c.enqueue(new Uint8Array([0x66]));
            c.close();
          },
        }),
    };
    const media = createMedia().use(tracksModule());
    const info = await media.probe(noRange);
    expect(info.container).toBe('mp4');
  });

  it('honors a pre-aborted signal path without crashing', async () => {
    const media = createMedia().use(NoopDriverModule);
    await media.probe(NOOP_BYTES, { signal: AbortSignal.abort() }).catch(() => undefined);
  });

  it('honors a per-call determinism strategy override', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES, { strategy: { determinism: 'force-software' } });
    expect(info.container).toBe('noop');
  });

  it('runs with a live (not-yet-aborted) signal', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES, { signal: new AbortController().signal });
    expect(info.container).toBe('noop');
  });

  it('rejects probing a non-seekable stream source', async () => {
    const media = createMedia().use(NoopDriverModule);
    const input = fromStream(
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    );
    await expect(media.probe(input)).rejects.toBeInstanceOf(InputError);
  });

  it('routes a container by file extension', async () => {
    const media = createMedia().use(NoopDriverModule);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.noop');
    expect((await media.probe(file)).container).toBe('noop');
  });

  it('codec ops reject an invalid input shape with InputError', async () => {
    await expect(
      createMedia().convert(123 as unknown as MediaInput, { to: 'mp4' }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('op handles expose .cancel()', () => {
    const handle = createMedia().probe(NOOP_BYTES);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();
    return expect(handle).rejects.toBeInstanceOf(MediaError);
  });

  it('use() validates the driver module apiVersion', () => {
    const media = createMedia();
    expect(() => media.use({ apiVersion: 999, register: () => {} })).toThrowError(MediaError);
  });

  it('preload is idempotent and never throws', async () => {
    await expect(
      createMedia().preload('probe', { op: 'convert', container: 'mp4' }),
    ).resolves.toBeUndefined();
  });
});

describe('bare-function sugar', () => {
  it('delegates every verb to a shared default instance', async () => {
    expect(sugar.transcode).toBe(sugar.convert);
    await expect(sugar.probe(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.demux(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.convert(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.remux(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.trim(NOOP_BYTES, { start: 0, end: 1 })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(sugar.encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.mux({}, { container: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.decrypt(NOOP_BYTES, { scheme: 'cenc', keys: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    expect(() => sugar.decode(NOOP_BYTES)).toThrowError(CapabilityError);
    await expect(sugar.preload('probe')).resolves.toBeUndefined();
  });
});
