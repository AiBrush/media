import { describe, expect, it } from 'vitest';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
} from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import type { Source } from '../sources/source.ts';
import { createMedia } from './create-media.ts';

function emptySource(reads: { count: number }): Source {
  return {
    __media: 'source',
    kind: 'bytes',
    size: 0,
    mimeHint: 'video/mp4',
    stream(): ReadableStream<Uint8Array> {
      reads.count++;
      throw new Error('known-empty demux must not open a byte stream');
    },
    range(): Promise<Uint8Array> {
      reads.count++;
      throw new Error('known-empty demux must not issue a range read');
    },
  };
}

describe('demux known-empty input rejection', () => {
  it('rejects before source I/O or container routing', async () => {
    const reads = { count: 0 };
    const routes = { count: 0 };
    const driver: ContainerDriver = {
      id: 'empty-route-sentinel',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: () => {
        routes.count++;
        return true;
      },
      demux: () => {
        throw new Error('known-empty demux must not activate a driver');
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
      await expect(media.demux(emptySource(reads))).rejects.toEqual(
        new InputError('cannot demux an empty input'),
      );
      expect(reads.count).toBe(0);
      expect(routes.count).toBe(0);
    } finally {
      await media.dispose();
    }
  });

  it('preserves an already-aborted caller signal over the input error', async () => {
    const reads = { count: 0 };
    const controller = new AbortController();
    controller.abort('stop');
    const media = createMedia();

    try {
      const failure = await media.demux(emptySource(reads), { signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MediaError);
      expect(failure).toMatchObject({ code: 'aborted' });
      expect(reads.count).toBe(0);
    } finally {
      await media.dispose();
    }
  });

  it('threads an explicit driver pin through non-empty demux routing', async () => {
    let demuxCalls = 0;
    let closeCalls = 0;
    const driver: ContainerDriver = {
      id: 'pinned-demux-sentinel',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: () => true,
      demux: () => {
        demuxCalls++;
        return Promise.resolve({
          tracks: [],
          packets: () =>
            new ReadableStream({
              start: (controller) => controller.close(),
            }),
          close: () => {
            closeCalls++;
            return Promise.resolve();
          },
        });
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const module: DriverModule = {
      apiVersion: DRIVER_API_VERSION,
      register: (registry) => registry.addContainer(driver),
    };
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 1,
      mimeHint: 'video/mp4',
      range: (start, end) => Promise.resolve(Uint8Array.of(1).slice(start, end)),
      stream: () =>
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(Uint8Array.of(1));
            controller.close();
          },
        }),
    };
    const media = createMedia().use(module);

    try {
      const demuxed = await media.demux(source, {
        strategy: { pinDriver: 'pinned-demux-sentinel' },
      });
      expect(demuxCalls).toBe(1);
      await demuxed.close();
      expect(closeCalls).toBe(1);
    } finally {
      await media.dispose();
    }
  });
});
