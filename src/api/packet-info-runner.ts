/**
 * Packet-table inspection orchestration, lazy because it is an expert introspection operation.
 */

import type {
  ContainerDriver,
  PacketInfoBatchOptions,
  PacketInfoBatchStream,
  PacketInfoMetadata,
  PacketInfoTable,
  StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { cancelSource } from '../sources/source.ts';
import type { MediaInput, Source } from '../sources/source.ts';
import { normalizeByteInput, stampContainerToken } from './op-support.ts';
import type { CallOptions, Container } from './types.ts';

export type PacketInfoCallOptions = CallOptions & { readonly container?: Container };
export type PacketInfoBatchCallOptions = PacketInfoCallOptions & {
  readonly batchSize?: number;
  readonly includePayloadDigests?: boolean;
};

export interface PacketInfoRunnerContext {
  resolveHls(input: MediaInput, source: Source, signal: AbortSignal): Promise<Source>;
  cacheFiniteBlobRanges(source: Source): Promise<Source>;
  routeSource(
    source: Source,
    signal: AbortSignal,
    pinDriver: string | undefined,
  ): Promise<ContainerDriver>;
  routeToken(container: string, pinDriver: string | undefined): Promise<ContainerDriver>;
  stage(signal: AbortSignal, options: CallOptions): StageOptions;
}

export async function runPacketInfo(
  context: PacketInfoRunnerContext,
  input: MediaInput,
  options: PacketInfoCallOptions,
  signal: AbortSignal,
): Promise<PacketInfoTable> {
  let source = await context.resolveHls(input, normalizeByteInput(input, 'packetInfo'), signal);
  try {
    source = await context.cacheFiniteBlobRanges(source);
    const container =
      options.container === undefined
        ? await context.routeSource(source, signal, options.strategy?.pinDriver)
        : await context.routeToken(options.container, options.strategy?.pinDriver);
    if (container.packetInfo === undefined) {
      throw new CapabilityError('no packet-info', {
        op: { kind: 'route', id: 'demux' },
        tried: [container.id],
      });
    }
    return stampContainerToken(
      await container.packetInfo(source, context.stage(signal, options)),
      container,
    );
  } finally {
    await cancelSource(source, signal.reason);
  }
}

/**
 * Route a pull-driven packet-info operation while retaining normalized-source ownership until EOF,
 * early iterator return, explicit cancellation, or failure.
 */
export async function runPacketInfoBatches(
  context: PacketInfoRunnerContext,
  input: MediaInput,
  options: PacketInfoBatchCallOptions,
  signal: AbortSignal,
): Promise<PacketInfoBatchStream> {
  // #withCancel releases its caller-listener when this setup promise settles. Keep the original signal
  // in the live lease as well, so a later caller abort still stops batch I/O after the stream is returned.
  const lifecycleSignal =
    options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
  let source = await context.resolveHls(
    input,
    normalizeByteInput(input, 'packetInfoBatches'),
    lifecycleSignal,
  );
  try {
    source = await context.cacheFiniteBlobRanges(source);
    const container =
      options.container === undefined
        ? await context.routeSource(source, lifecycleSignal, options.strategy?.pinDriver)
        : await context.routeToken(options.container, options.strategy?.pinDriver);
    if (container.packetInfoBatches === undefined) {
      throw new CapabilityError('no batched packet-info', {
        op: { kind: 'route', id: 'demux' },
        tried: [container.id],
      });
    }
    const stage: PacketInfoBatchOptions = {
      ...context.stage(lifecycleSignal, options),
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.includePayloadDigests !== undefined
        ? { includePayloadDigests: options.includePayloadDigests }
        : {}),
    };
    const inner = await container.packetInfoBatches(source, stage);
    return stampContainerToken(ownPacketInfoBatchSource(inner, source, lifecycleSignal), container);
  } catch (error) {
    await cancelSource(source, error);
    throw error;
  }
}

/** Bind a driver's iterator lifetime to the public runner's normalized source. */
function ownPacketInfoBatchSource(
  inner: PacketInfoBatchStream,
  source: Source,
  signal: AbortSignal,
): PacketInfoBatchStream {
  let claimed = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (reason?: unknown): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async (): Promise<void> => {
      try {
        await inner.cancel(reason);
      } finally {
        await cancelSource(source, reason);
      }
    })();
    return closePromise;
  };
  return {
    tracks: inner.tracks,
    cancel: close,
    [Symbol.asyncIterator](): AsyncIterator<readonly PacketInfoMetadata[]> {
      if (claimed) throw new TypeError('packet-info batches are single-use');
      claimed = true;
      const iterator = inner[Symbol.asyncIterator]();
      return {
        async next() {
          if (closed) return { done: true, value: undefined };
          try {
            const result = await iterator.next();
            if (result.done === true) await close(signal.reason);
            return result;
          } catch (error) {
            await close(error);
            throw error;
          }
        },
        async return(value?: unknown) {
          try {
            if (iterator.return !== undefined) await iterator.return();
          } finally {
            await close(value);
          }
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          try {
            if (iterator.throw !== undefined) await iterator.throw(error);
          } finally {
            await close(error);
          }
          throw error;
        },
      };
    },
  };
}
