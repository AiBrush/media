/**
 * R-S04.5 — the lazy flag table is asserted against the real modules, both directions, so the
 * advertised capability surface (methods on the proxy) and the real capability surface (methods on
 * the loaded driver) can never drift apart silently:
 *
 * 1. every `flag: true` must be a real function/flag on the loaded module (no runtime
 *    `missingLazyMethod` for an advertised capability), and
 * 2. every optional capability the loaded module implements must be flagged, and the built proxy
 *    must advertise exactly the flagged surface (an unflagged real method is a lost capability).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type MuxOptions,
  OPTIONAL_CONTAINER_CAPABILITIES,
  type Packet,
  type TrackInfo,
} from '../contracts/driver.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS, lazyContainer } from './defaults.ts';
import { WAV_LAZY_CONTAINER_SPEC } from './wav/wav-lazy-driver.ts';

function surfaceOf(target: object): readonly string[] {
  return OPTIONAL_CONTAINER_CAPABILITIES.filter((capability) => {
    const member: unknown = Reflect.get(target, capability);
    return typeof member === 'function' || member === true;
  });
}

describe('lazy container spec conformance', () => {
  it('covers every spec-registered default container', () => {
    expect(DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => spec.id).sort()).toEqual(
      ['adts', 'aiff', 'avi', 'caf', 'flac', 'mp3', 'mp4', 'mpegts', 'ogg', 'wav', 'webm'].sort(),
    );
  });

  it.each(DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => [spec.id, spec] as const))(
    'the %s proxy advertises exactly the surface its loaded module implements',
    async (_id, spec) => {
      const loaded = await spec.load();
      const proxy = lazyContainer(spec);
      const advertised = surfaceOf(proxy);
      const real = surfaceOf(loaded);
      const flagged = OPTIONAL_CONTAINER_CAPABILITIES.filter(
        (capability) => spec[capability] === true,
      );
      // Direction 1: every flag is real — an advertised method may never miss at call time.
      expect(flagged).toEqual(advertised);
      // Direction 2: every real optional capability is flagged — no silent capability loss.
      expect(advertised).toEqual(real);
    },
  );

  it('keeps WAV probe on the lightweight implementation until a full-driver flow is requested', async () => {
    const load = vi.fn(WAV_LAZY_CONTAINER_SPEC.load);
    const proxy = lazyContainer({ ...WAV_LAZY_CONTAINER_SPEC, load });
    const bytes = await loadFixture('speech.wav');
    const probe = proxy.probe;
    if (probe === undefined) throw new Error('lazy WAV proxy must expose probe');

    await expect(probe.call(proxy, fromBytes(bytes, { mime: 'audio/wav' }))).resolves.toMatchObject(
      [{ mediaType: 'audio', codec: 'pcm-s16' }],
    );
    expect(load).not.toHaveBeenCalled();

    await expect(proxy.demux(fromBytes(bytes, { mime: 'audio/wav' }))).resolves.toMatchObject({
      tracks: [{ mediaType: 'audio', codec: 'pcm-s16' }],
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a typical faststart MP4 probe light and loads the canonical driver on an exact decline', async () => {
    const spec = DEFAULT_LAZY_CONTAINER_SPECS.find((candidate) => candidate.id === 'mp4');
    if (spec === undefined) throw new Error('default MP4 lazy spec is missing');
    const bytes = await loadFixture('movie_5.mp4');
    const canonical = await spec.load();
    const expected = await canonical.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const quickTimeBytes = await loadFixture('bear-rotate-90.mp4');
    const expectedQuickTime = await canonical.probe?.(
      fromBytes(quickTimeBytes, { mime: 'video/quicktime' }),
    );
    const load = vi.fn(spec.load);
    const proxy = lazyContainer({ ...spec, load });

    await expect(proxy.probe?.(fromBytes(bytes, { mime: 'video/mp4' }))).resolves.toEqual(expected);
    expect(load).not.toHaveBeenCalled();

    await expect(
      proxy.probe?.(fromBytes(quickTimeBytes, { mime: 'video/quicktime' })),
    ).resolves.toEqual(expectedQuickTime);
    expect(load).toHaveBeenCalledTimes(1);

    const sequential = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    };
    await expect(proxy.probe?.(sequential)).resolves.toEqual(expected);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('propagates an abort from the light MP4 range path without loading the fallback', async () => {
    const spec = DEFAULT_LAZY_CONTAINER_SPECS.find((candidate) => candidate.id === 'mp4');
    if (spec === undefined) throw new Error('default MP4 lazy spec is missing');
    const bytes = await loadFixture('movie_5.mp4');
    const controller = new AbortController();
    const releaseRange = vi.fn();
    const load = vi.fn(spec.load);
    const proxy = lazyContainer({ ...spec, load });
    const source = {
      size: bytes.byteLength,
      stream: () => new ReadableStream<Uint8Array>(),
      range(start: number, end: number): Promise<Uint8Array> {
        const result = bytes.slice(start, end);
        controller.abort('stop light probe');
        return Promise.resolve(result);
      },
      releaseRange,
    };

    await expect(proxy.probe?.(source, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(releaseRange).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not load a declined fallback when cancellation wins the probe continuation race', async () => {
    const controller = new AbortController();
    const load = vi.fn(() => Promise.reject(new Error('fallback must stay cold')));
    const proxy = lazyContainer({
      id: 'cancel-race',
      formats: ['mp4'],
      supports: () => true,
      load,
      probe: true,
      probeImpl: async () => {
        queueMicrotask(() => controller.abort('cancel after fast decline'));
        return undefined;
      },
    });

    await expect(
      proxy.probe?.(fromBytes(new Uint8Array([0])), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(load).not.toHaveBeenCalled();
  });

  it('loads once and forwards the exact track, packet iterable, and mux options for auditMuxedTrack', async () => {
    const expected = {
      elementaryPayloadBytes: 7,
      preparedSampleByteLengths: [7],
      presentationSpanUs: 40_000,
      sampleCount: 1,
    } as const;
    const auditMuxedTrack = vi.fn(async () => expected);
    const loaded: ContainerDriver = {
      id: 'audit-container',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['audit'],
      supports: () => true,
      demux: () => Promise.reject(new Error('unused')),
      createMuxer: () => {
        throw new Error('unused');
      },
      auditMuxedTrack,
    };
    const load = vi.fn(async () => loaded);
    const proxy = lazyContainer({
      id: loaded.id,
      formats: loaded.formats,
      supports: loaded.supports,
      load,
      auditMuxedTrack: true,
    });
    const track: TrackInfo = { id: 1, mediaType: 'video', codec: 'avc1.42E01E' };
    const packets: Packet[] = [];
    const options: MuxOptions = { fragmented: true, container: 'audit' };
    const signal = new AbortController().signal;

    await expect(proxy.auditMuxedTrack?.(track, packets, options, signal)).resolves.toBe(expected);
    expect(auditMuxedTrack).toHaveBeenCalledWith(track, packets, options, signal);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries a transient best-effort warmup failure on the next real operation', async () => {
    const loaded: ContainerDriver = {
      id: 'retry-container',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['retry'],
      supports: () => true,
      probe: async () => [],
      demux: () => Promise.reject(new Error('unused')),
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const load = vi
      .fn<() => Promise<ContainerDriver>>()
      .mockRejectedValueOnce(new Error('transient chunk load failure'))
      .mockResolvedValue(loaded);
    const proxy = lazyContainer({
      id: loaded.id,
      formats: loaded.formats,
      supports: loaded.supports,
      load,
      probe: true,
    });
    const ensureLoaded = (proxy as ContainerDriver & { ensureLoaded(): Promise<void> })
      .ensureLoaded;

    await expect(ensureLoaded()).rejects.toThrow('transient chunk load failure');
    await expect(proxy.probe?.(fromBytes(new Uint8Array([1])))).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a custom spec advertises optional methods its module omits', async () => {
    const loaded: ContainerDriver = {
      id: 'incomplete-container',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['incomplete'],
      supports: () => true,
      demux: () => Promise.reject(new Error('unused')),
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const proxy = lazyContainer({
      id: loaded.id,
      formats: loaded.formats,
      supports: loaded.supports,
      load: async () => loaded,
      probe: true,
      packetInfo: true,
      packetInfoBatches: true,
      auditMuxedTrack: true,
      streamCopy: true,
      decrypt: true,
      transformPcm: true,
      decodePcm: true,
      decodePcmAudio: true,
      decodePcmAudioStream: true,
      decodePcmInterleavedStream: true,
    });
    const source = fromBytes(new Uint8Array());
    const track: TrackInfo = { id: 1, mediaType: 'audio', codec: 'pcm-s16' };
    const expectMissing = async (
      method: string,
      operation: Promise<unknown> | undefined,
    ): Promise<void> => {
      if (operation === undefined) throw new Error(`${method} was not advertised`);
      await expect(operation).rejects.toThrow(`lazy ${loaded.id} driver lacks ${method}`);
    };

    await expectMissing('probe', proxy.probe?.(source));
    await expectMissing('packetInfo', proxy.packetInfo?.(source));
    await expectMissing('packetInfoBatches', proxy.packetInfoBatches?.(source));
    await expectMissing('auditMuxedTrack', proxy.auditMuxedTrack?.(track, []));
    await expectMissing('streamCopy', proxy.streamCopy?.(source));
    await expectMissing(
      'decrypt',
      proxy.decrypt?.(source, { scheme: 'cenc', keys: Object.create(null) }),
    );
    await expectMissing('transformPcm', proxy.transformPcm?.(source));
    await expectMissing('decodePcm', proxy.decodePcm?.(source));
    await expectMissing('decodePcmAudio', proxy.decodePcmAudio?.(source));
    await expectMissing('decodePcmAudioStream', proxy.decodePcmAudioStream?.(source));
    await expectMissing('decodePcmInterleavedStream', proxy.decodePcmInterleavedStream?.(source));
  });
});
