/**
 * The merged {@link LazyMuxer} (R-S04.9): one parameterized lazy muxer behind every container proxy.
 * Verifies pre-load track validation, queued-track replay on lazy creation, post-load addTrack, the
 * configurable raw-PCM seam (present ⇔ `pcmSeam: true`), and the typed PCM miss naming the driver
 * that was tried (R-S04.4: never an empty `tried` for attempted work).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContainerDriver, Muxer, Packet, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { LazyMuxer, missingLazyMethod } from './lazy-muxer.ts';

function track(id: number): TrackInfo {
  return { id, mediaType: 'audio', codec: 'opus' };
}

function packet(): Packet {
  return { chunk: { timestamp: 0 } as unknown as Packet['chunk'] };
}

function stubDriver(muxer: Muxer): ContainerDriver {
  return {
    id: 'stub',
    apiVersion: 1,
    kind: 'container',
    formats: ['stub'],
    supports: () => true,
    demux: () => Promise.reject(new Error('unused')),
    createMuxer: () => muxer,
  };
}

function recordingMuxer(withPcm: boolean): Muxer & {
  added: TrackInfo[];
  writes: Array<readonly [number, Packet]>;
  pcmWrites: Array<readonly [number, Uint8Array]>;
} {
  const added: TrackInfo[] = [];
  const writes: Array<readonly [number, Packet]> = [];
  const pcmWrites: Array<readonly [number, Uint8Array]> = [];
  return {
    added,
    writes,
    pcmWrites,
    output: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    }),
    addTrack(info: TrackInfo): number {
      added.push(info);
      return added.length + 99; // distinct target-id space proves the id mapping is honored
    },
    write(trackId: number, p: Packet): Promise<void> {
      writes.push([trackId, p]);
      return Promise.resolve();
    },
    ...(withPcm
      ? {
          writePcm(trackId: number, data: Uint8Array): Promise<void> {
            pcmWrites.push([trackId, data]);
            return Promise.resolve();
          },
        }
      : {}),
    finalize: () => Promise.resolve(),
  };
}

describe('LazyMuxer', () => {
  it('validates tracks synchronously, replays them on lazy creation, and maps ids on write', async () => {
    const real = recordingMuxer(false);
    const load = vi.fn(() => Promise.resolve(stubDriver(real)));
    const validateTrack = vi.fn();
    const lazy = new LazyMuxer({ driverId: 'stub', load, muxOptions: undefined, validateTrack });

    expect(lazy.addTrack(track(1))).toBe(0);
    expect(lazy.addTrack(track(2))).toBe(1);
    expect(validateTrack).toHaveBeenCalledTimes(2);
    expect(validateTrack).toHaveBeenLastCalledWith(track(2), 1);
    expect(load).not.toHaveBeenCalled();

    await lazy.write(1, packet());
    expect(load).toHaveBeenCalledTimes(1);
    expect(real.added).toEqual([track(1), track(2)]);
    expect(real.writes.map(([id]) => id)).toEqual([101]);

    expect(lazy.addTrack(track(3))).toBe(2);
    await lazy.write(2, packet());
    expect(real.writes.map(([id]) => id)).toEqual([101, 102]);

    await expect(lazy.write(9, packet())).rejects.toThrowError(MediaError);
    await lazy.finalize();
  });

  it('exposes the raw-PCM seam only when configured, delegating to the loaded muxer', async () => {
    const real = recordingMuxer(true);
    const lazy = new LazyMuxer({
      driverId: 'stub',
      load: () => Promise.resolve(stubDriver(real)),
      muxOptions: undefined,
      pcmSeam: true,
    });
    expect(typeof lazy.writePcm).toBe('function');
    lazy.addTrack(track(1));
    await lazy.writePcm?.(0, new Uint8Array([1, 2]));
    expect(real.pcmWrites).toEqual([[100, new Uint8Array([1, 2])]]);

    const noSeam = new LazyMuxer({
      driverId: 'stub',
      load: () => Promise.resolve(stubDriver(recordingMuxer(true))),
      muxOptions: undefined,
    });
    expect(noSeam.writePcm).toBeUndefined();
  });

  it('raises a typed PCM miss naming the tried driver when the loaded muxer lacks the seam', async () => {
    const lazy = new LazyMuxer({
      driverId: 'stub',
      load: () => Promise.resolve(stubDriver(recordingMuxer(false))),
      muxOptions: undefined,
      pcmSeam: true,
    });
    lazy.addTrack(track(1));
    const miss = await lazy.writePcm?.(0, new Uint8Array([1])).then(
      () => undefined,
      (e: unknown) => e as CapabilityError,
    );
    expect(miss).toBeInstanceOf(CapabilityError);
    expect(miss?.detail?.op).toEqual({
      kind: 'route',
      id: 'mux',
      facts: { mediaType: 'audio', codec: 'pcm' },
    });
    expect(miss?.detail?.tried).toEqual(['stub']);
  });

  it('missingLazyMethod names the method and driver in the typed descriptor', () => {
    const err = missingLazyMethod('mp4', 'decrypt');
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.detail?.op).toEqual({ kind: 'route', id: 'decrypt', facts: { driver: 'mp4' } });
    expect(err.detail?.tried).toEqual(['mp4']);
  });
});
