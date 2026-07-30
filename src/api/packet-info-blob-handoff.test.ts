import { describe, expect, it } from 'vitest';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
} from '../contracts/driver.ts';
import { SOURCE_CACHE_KEY, type Source } from '../sources/source.ts';
import { createMedia } from './create-media.ts';

describe('packetInfo finite Blob range handoff', () => {
  it('reuses owned raw bytes while reparsing every operation', async () => {
    const payload = Uint8Array.of(0x11, 0x22, 0x33, 0x44);
    let sourceReads = 0;
    let parserCalls = 0;
    const observedFirstBytes: number[] = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: payload.byteLength,
      mimeHint: 'audio/aac',
      [SOURCE_CACHE_KEY]: 'blob:https://example.test/immutable-aac',
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packetInfo must stay range-backed');
      },
      async range(start, end, signal): Promise<Uint8Array> {
        if (signal?.aborted) throw signal.reason;
        sourceReads++;
        return payload.slice(start, end);
      },
    };
    const driver: ContainerDriver = {
      id: 'blob-packet-info',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['adts'],
      supports: () => true,
      async packetInfo(input, options) {
        parserCalls++;
        const bytes = await input.range?.(0, input.size ?? 0, options?.signal);
        if (bytes === undefined) throw new Error('expected finite range source');
        observedFirstBytes.push(bytes[0] ?? -1);
        bytes[0] = 0xff;
        return { tracks: [], packets: [] };
      },
      demux: () => {
        throw new Error('unused');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const module: DriverModule = {
      apiVersion: DRIVER_API_VERSION,
      register: (registry) => registry.addContainer(driver),
    };
    const media = createMedia().use(module);

    try {
      await media.packetInfo(source, { container: 'adts' });
      await media.packetInfo(source, { container: 'adts' });

      expect(parserCalls).toBe(2);
      expect(sourceReads).toBe(1);
      expect(observedFirstBytes).toEqual([0x11, 0x11]);
      expect(payload[0]).toBe(0x11);
    } finally {
      await media.dispose();
    }
  });

  it('reuses owned raw bytes while rebuilding each demux session', async () => {
    const payload = Uint8Array.of(0x4f, 0x67, 0x67, 0x53);
    let sourceReads = 0;
    let demuxCalls = 0;
    const observedFirstBytes: number[] = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: payload.byteLength,
      mimeHint: 'audio/x-demux-handoff',
      [SOURCE_CACHE_KEY]: 'blob:https://example.test/immutable-demux',
      stream(): ReadableStream<Uint8Array> {
        throw new Error('demux must stay range-backed');
      },
      async range(start, end, signal): Promise<Uint8Array> {
        if (signal?.aborted) throw signal.reason;
        sourceReads++;
        return payload.slice(start, end);
      },
    };
    const driver: ContainerDriver = {
      id: 'blob-demux',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['handoff'],
      supports: (query) => query.mime === 'audio/x-demux-handoff',
      async demux(input, options) {
        demuxCalls++;
        const bytes = await input.range?.(0, input.size ?? 0, options?.signal);
        if (bytes === undefined) throw new Error('expected finite range source');
        observedFirstBytes.push(bytes[0] ?? -1);
        bytes[0] = 0xff;
        return {
          tracks: [],
          packets: () => new ReadableStream({ start: (controller) => controller.close() }),
          close: () => Promise.resolve(),
        };
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const module: DriverModule = {
      apiVersion: DRIVER_API_VERSION,
      register: (registry) => registry.addContainer(driver),
    };
    const media = createMedia().use(module);

    try {
      await (await media.demux(source)).close();
      await (await media.demux(source)).close();

      expect(demuxCalls).toBe(2);
      expect(sourceReads).toBe(1);
      expect(observedFirstBytes).toEqual([0x4f, 0x4f]);
      expect(payload[0]).toBe(0x4f);
    } finally {
      await media.dispose();
    }
  });
});
