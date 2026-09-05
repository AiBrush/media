import { describe, expect, it } from 'vitest';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type PacketInfoBatchStream,
  type PacketInfoMetadata,
} from '../contracts/driver.ts';
import { fromBytes } from '../sources/source.ts';
import {
  type PacketInfoRunnerContext,
  runPacketInfo,
  runPacketInfoBatches,
} from './packet-info-runner.ts';

const ROW: PacketInfoMetadata = {
  trackIndex: 0,
  size: 1,
  ptsUs: 0,
  dtsUs: 0,
  durationUs: 1,
  keyframe: true,
};

function batchStream(
  options: {
    readonly onCancel: (reason: unknown) => void;
    readonly onReturn?: () => void;
    readonly onThrow?: (error: unknown) => void;
  },
  batches: readonly (readonly PacketInfoMetadata[])[] = [[ROW]],
): PacketInfoBatchStream {
  return {
    tracks: [],
    cancel(reason): Promise<void> {
      options.onCancel(reason);
      return Promise.resolve();
    },
    [Symbol.asyncIterator](): AsyncIterator<readonly PacketInfoMetadata[]> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<readonly PacketInfoMetadata[]>> {
          const value = batches[index++];
          return Promise.resolve(
            value === undefined ? { done: true, value: undefined } : { done: false, value },
          );
        },
        ...(options.onReturn === undefined
          ? {}
          : {
              return(): Promise<IteratorResult<readonly PacketInfoMetadata[]>> {
                options.onReturn?.();
                return Promise.resolve({ done: true, value: undefined });
              },
            }),
        ...(options.onThrow === undefined
          ? {}
          : {
              throw(error?: unknown): Promise<IteratorResult<readonly PacketInfoMetadata[]>> {
                options.onThrow?.(error);
                return Promise.resolve({ done: true, value: undefined });
              },
            }),
      };
    },
  };
}

function runnerContext(
  streams: PacketInfoBatchStream[],
  routes: string[],
  stageSignals: AbortSignal[],
): PacketInfoRunnerContext {
  const driver: ContainerDriver = {
    id: 'packet-info-runner-test',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    packetInfo: () => Promise.resolve({ tracks: [], packets: [ROW] }),
    packetInfoBatches: () => {
      const stream = streams.shift();
      if (stream === undefined) throw new Error('missing queued packet-info batch stream');
      return Promise.resolve(stream);
    },
    demux: () => {
      throw new Error('unused');
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return {
    resolveHls: (_input, source) => Promise.resolve(source),
    cacheFiniteBlobRanges: (source) => Promise.resolve(source),
    routeSource: (_source, _signal, pinDriver) => {
      routes.push(`source:${pinDriver ?? '-'}`);
      return Promise.resolve(driver);
    },
    routeToken: (container, pinDriver) => {
      routes.push(`token:${container}:${pinDriver ?? '-'}`);
      return Promise.resolve(driver);
    },
    stage: (signal) => {
      stageSignals.push(signal);
      return { signal };
    },
  };
}

describe('packet-info runner branch lifecycle', () => {
  it('threads pinned source and token routes through materialized packet info', async () => {
    const routes: string[] = [];
    const stageSignals: AbortSignal[] = [];
    const context = runnerContext([], routes, stageSignals);
    const source = fromBytes(Uint8Array.of(1));
    const signal = new AbortController().signal;

    await expect(
      runPacketInfo(
        context,
        source,
        { strategy: { pinDriver: 'packet-info-runner-test' } },
        signal,
      ),
    ).resolves.toEqual({ container: 'mp4', tracks: [], packets: [ROW] });
    await expect(
      runPacketInfo(
        context,
        source,
        { container: 'mp4', strategy: { pinDriver: 'packet-info-runner-test' } },
        signal,
      ),
    ).resolves.toEqual({ container: 'mp4', tracks: [], packets: [ROW] });

    expect(routes).toEqual(['source:packet-info-runner-test', 'token:mp4:packet-info-runner-test']);
    expect(stageSignals).toEqual([signal, signal]);
  });

  it('owns normal EOF, is single-use, and makes post-close reads idempotent', async () => {
    const cancellations: unknown[] = [];
    const routes: string[] = [];
    const stageSignals: AbortSignal[] = [];
    const signal = new AbortController().signal;
    const context = runnerContext(
      [batchStream({ onCancel: (reason) => cancellations.push(reason) })],
      routes,
      stageSignals,
    );
    const batches = await runPacketInfoBatches(
      context,
      fromBytes(Uint8Array.of(1)),
      { strategy: { pinDriver: 'packet-info-runner-test' } },
      signal,
    );
    const iterator = batches[Symbol.asyncIterator]();

    expect(() => batches[Symbol.asyncIterator]()).toThrowError(/single-use/);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: [ROW] });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await batches.cancel('already closed');

    expect(routes).toEqual(['source:packet-info-runner-test']);
    expect(stageSignals).toEqual([signal]);
    expect(cancellations).toEqual([undefined]);
  });

  it('combines caller cancellation and closes through an inner iterator return when present', async () => {
    const cancellations: unknown[] = [];
    let returns = 0;
    const routes: string[] = [];
    const stageSignals: AbortSignal[] = [];
    const setup = new AbortController();
    const caller = new AbortController();
    const context = runnerContext(
      [
        batchStream({
          onCancel: (reason) => cancellations.push(reason),
          onReturn: () => {
            returns++;
          },
        }),
      ],
      routes,
      stageSignals,
    );
    const batches = await runPacketInfoBatches(
      context,
      fromBytes(Uint8Array.of(1)),
      {
        container: 'mp4',
        signal: caller.signal,
        strategy: { pinDriver: 'packet-info-runner-test' },
      },
      setup.signal,
    );
    const iterator = batches[Symbol.asyncIterator]();

    caller.abort('caller stopped');
    expect(stageSignals[0]?.aborted).toBe(true);
    await expect(iterator.return?.('early return')).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(routes).toEqual(['token:mp4:packet-info-runner-test']);
    expect(returns).toBe(1);
    expect(cancellations).toEqual(['early return']);
  });

  it('closes and rethrows explicit iterator errors with and without an inner throw hook', async () => {
    const forwarded: unknown[] = [];
    const cancellations: unknown[] = [];
    const routes: string[] = [];
    const stageSignals: AbortSignal[] = [];
    const context = runnerContext(
      [
        batchStream({ onCancel: (reason) => cancellations.push(reason) }),
        batchStream({
          onCancel: (reason) => cancellations.push(reason),
          onThrow: (error) => forwarded.push(error),
        }),
      ],
      routes,
      stageSignals,
    );

    for (const reason of [new Error('without hook'), new Error('with hook')]) {
      const batches = await runPacketInfoBatches(
        context,
        fromBytes(Uint8Array.of(1)),
        {},
        new AbortController().signal,
      );
      const iterator = batches[Symbol.asyncIterator]();
      await expect(iterator.throw?.(reason)).rejects.toBe(reason);
    }

    expect(forwarded).toEqual([expect.objectContaining({ message: 'with hook' })]);
    expect(cancellations).toEqual([
      expect.objectContaining({ message: 'without hook' }),
      expect.objectContaining({ message: 'with hook' }),
    ]);
  });

  it('declines a driver that has no batched packet-info seam', async () => {
    const routes: string[] = [];
    const stageSignals: AbortSignal[] = [];
    const batchless: ContainerDriver = {
      id: 'batchless-packet-info-test',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: () => true,
      demux: () => {
        throw new Error('unused');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const context: PacketInfoRunnerContext = {
      ...runnerContext([], routes, stageSignals),
      routeSource: () => Promise.resolve(batchless),
    };

    await expect(
      runPacketInfoBatches(context, fromBytes(Uint8Array.of(1)), {}, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'capability-miss',
      message: 'no batched packet-info',
      detail: {
        tried: ['batchless-packet-info-test'],
      },
    });
  });
});
