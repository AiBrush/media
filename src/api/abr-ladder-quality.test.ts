import { describe, expect, it } from 'vitest';
import { ConstraintUnsatisfiedError, InputError, MediaError } from '../contracts/errors.ts';
import type { JobStreamRunner } from '../kernel/worker-host.ts';
import type { WorkerMediaCaps } from '../kernel/worker-protocol.ts';
import {
  abrRetainedOutputBudget,
  type AbrLadderRunnerContext,
  runH264AbrLadder,
} from './abr-ladder-runner.ts';
import {
  H264_ABR_MAX_RETAINED_OUTPUT_BYTES,
  H264_ABR_MAX_RUNGS,
  H264_ABR_MAX_SOURCE_BYTES,
} from './types.ts';
import type { ConvertOptions, H264AbrRung } from './types.ts';
import { planH264AbrLadder } from './video-stream-plan.ts';

const SOURCE = { width: 1_920, height: 1_080, fps: 30 } as const;
const SIGNAL = new AbortController().signal;

function qualityRung(overrides: Partial<H264AbrRung> = {}): H264AbrRung {
  return {
    name: '480p',
    width: 854,
    height: 480,
    bitrate: 1_400_000,
    maxAverageBitrate: 1_820_000,
    quality: { metric: 'ssim-luma-v1', minimumMean: 0.95, samples: 8 },
    ...overrides,
  };
}

function captureThrown(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected call to throw');
}

function inlineContext(convert: AbrLadderRunnerContext['convert']): AbrLadderRunnerContext {
  return {
    workerMode: 'inline',
    poolCache: {},
    poolSize: 1,
    stage: {},
    convert,
  };
}

type FakeOffloadPool = JobStreamRunner & { readonly caps?: WorkerMediaCaps };

function offloadContext(
  pool: FakeOffloadPool,
  convert: AbrLadderRunnerContext['convert'] = () => Promise.resolve(undefined),
): AbrLadderRunnerContext {
  return {
    workerMode: 'offload',
    poolCache: { pool: pool as never },
    poolSize: pool.size ?? 1,
    stage: {},
    convert,
  };
}

describe('H.264 ABR quality-constrained rungs', () => {
  it('preserves legacy bitrate-only convert options byte-for-byte', () => {
    const planned = planH264AbrLadder(
      [{ name: 'legacy', width: 640, height: 360, bitrate: 800_000 }],
      SOURCE,
    );

    expect(planned[0]?.options).toEqual({
      to: 'mp4',
      video: { codec: 'h264', width: 640, height: 360, bitrate: 800_000 },
    });
    expect(planned[0]?.options.video).not.toHaveProperty('maxAverageBitrate');
    expect(planned[0]?.options.video).not.toHaveProperty('quality');
    expect(planned[0]?.config.bitrate).toBe(800_000);
    expect(planned[0]?.config.bitrateMode).toBe('variable');
  });

  it('forwards the authored preferred, maximum, and objective-quality tuple exactly', () => {
    const planned = planH264AbrLadder([qualityRung()], SOURCE);

    expect(planned[0]?.options).toEqual({
      to: 'mp4',
      video: {
        codec: 'h264',
        width: 854,
        height: 480,
        bitrate: 1_400_000,
        maxAverageBitrate: 1_820_000,
        quality: { metric: 'ssim-luma-v1', minimumMean: 0.95, samples: 8 },
      },
    });
    expect(planned[0]?.config.bitrateMode).toBe('quantizer');
    expect(planned[0]?.config).not.toHaveProperty('bitrate');
  });

  it('rejects partial quality tuples and invalid authored ceilings during planning', () => {
    expect(() =>
      planH264AbrLadder(
        [
          {
            width: 854,
            height: 480,
            bitrate: 1_400_000,
            maxAverageBitrate: 1_820_000,
          },
        ],
        SOURCE,
      ),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder(
        [
          {
            width: 854,
            height: 480,
            bitrate: 1_400_000,
            quality: { metric: 'ssim-luma-v1', minimumMean: 0.95, samples: 8 },
          },
        ],
        SOURCE,
      ),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder([qualityRung({ maxAverageBitrate: 1_399_999 })], SOURCE),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder(
        [
          qualityRung({
            quality: { metric: 'ssim-luma-v1', minimumMean: 1.01, samples: 8 },
          }),
        ],
        SOURCE,
      ),
    ).toThrow(InputError);
  });

  it('rejects ladders beyond the documented public fanout bound before execution', () => {
    const ladder = Array.from({ length: H264_ABR_MAX_RUNGS + 1 }, (_, index) => ({
      name: `${index}`,
      width: 640,
      height: 360,
      bitrate: 800_000,
    }));
    expect(captureThrown(() => planH264AbrLadder(ladder, SOURCE))).toMatchObject({
      code: 'unsupported-input',
      detail: { rungCount: H264_ABR_MAX_RUNGS + 1, maximumRungs: H264_ABR_MAX_RUNGS },
    });
  });

  it('rejects a declared oversized source before opening it or starting a rung', async () => {
    let opened = 0;
    let converted = 0;
    const source = {
      __media: 'source',
      kind: 'stream',
      size: H264_ABR_MAX_SOURCE_BYTES + 1,
      stream(): ReadableStream<Uint8Array> {
        opened += 1;
        return new ReadableStream<Uint8Array>();
      },
    } as const;

    await expect(
      runH264AbrLadder(
        inlineContext(() => {
          converted += 1;
          return Promise.resolve(undefined);
        }),
        source as never,
        [{ width: 640, height: 360, bitrate: 800_000 }],
        {},
        SIGNAL,
      ),
    ).rejects.toMatchObject({
      code: 'unsupported-input',
      detail: {
        sourceBytes: H264_ABR_MAX_SOURCE_BYTES + 1,
        maximumSourceBytes: H264_ABR_MAX_SOURCE_BYTES,
      },
    });
    expect(opened).toBe(0);
    expect(converted).toBe(0);
  });

  it('counts cumulative retained output atomically and rejects the first byte beyond its limit', () => {
    const budget = abrRetainedOutputBudget(5);
    budget.charge(2);
    budget.charge(3);
    expect(budget.retainedBytes).toBe(5);
    expect(captureThrown(() => budget.charge(1))).toMatchObject({
      code: 'mux-error',
      detail: { retainedBytes: 5, nextBytes: 1, maximumBytes: 5 },
    });
    expect(budget.retainedBytes).toBe(5);
    expect(H264_ABR_MAX_RETAINED_OUTPUT_BYTES).toBe(512 * 1024 * 1024);
  });

  it('passes exact quality tuples into convert while leaving legacy rungs unchanged', async () => {
    const seen: ConvertOptions[] = [];
    await runH264AbrLadder(
      inlineContext((_input, opts) => {
        seen.push(opts);
        return Promise.resolve(undefined);
      }),
      new Uint8Array([1, 2, 3]),
      [qualityRung(), { name: 'legacy', width: 640, height: 360, bitrate: 800_000 }],
      {},
      SIGNAL,
    );

    expect(seen).toEqual([
      {
        to: 'mp4',
        video: {
          codec: 'h264',
          width: 854,
          height: 480,
          bitrate: 1_400_000,
          maxAverageBitrate: 1_820_000,
          quality: { metric: 'ssim-luma-v1', minimumMean: 0.95, samples: 8 },
        },
      },
      {
        to: 'mp4',
        video: { codec: 'h264', width: 640, height: 360, bitrate: 800_000 },
      },
    ]);
  });

  it('publishes no partial ladder and preserves typed constraint evidence when a rung fails', async () => {
    const failure = new ConstraintUnsatisfiedError('quality floor was not met', {
      constraint: 'h264-quality-rate',
      preferredAverageBitrate: 1_400_000,
      maxAverageBitrate: 1_820_000,
      minimumQualityMean: 0.95,
      metric: 'ssim-luma-v1',
      attempts: [],
    });
    let conversions = 0;

    await expect(
      runH264AbrLadder(
        inlineContext(() => {
          conversions++;
          if (conversions === 2) return Promise.reject(failure);
          return Promise.resolve(undefined);
        }),
        new Uint8Array([1, 2, 3]),
        [qualityRung({ name: '720p' }), qualityRung(), qualityRung({ name: '360p' })],
        {},
        SIGNAL,
      ),
    ).rejects.toBe(failure);
    expect(conversions).toBe(2);
  });

  it('does not start a later inline rung after caller cancellation', async () => {
    const caller = new AbortController();
    let conversions = 0;
    await expect(
      runH264AbrLadder(
        inlineContext((_input, _opts, options) => {
          conversions += 1;
          expect(options.signal).toBe(caller.signal);
          caller.abort('stop after first rung');
          return Promise.resolve(undefined);
        }),
        Uint8Array.of(1, 2, 3),
        [
          { width: 854, height: 480, bitrate: 1_400_000 },
          { width: 640, height: 360, bitrate: 800_000 },
        ],
        {},
        caller.signal,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(conversions).toBe(1);
  });

  it('falls back inline unless worker caps affirm every rung media path', async () => {
    for (const caps of [undefined, { video: false, audio: true }] as const) {
      let offloads = 0;
      let inline = 0;
      const pool: FakeOffloadPool = {
        size: 2,
        ...(caps === undefined ? {} : { caps }),
        runStream: () => {
          offloads += 1;
          throw new Error('unproven worker must not receive an ABR job');
        },
      };
      const output = await runH264AbrLadder(
        offloadContext(pool, () => {
          inline += 1;
          return Promise.resolve(undefined);
        }),
        Uint8Array.of(1, 2, 3),
        [qualityRung()],
        {},
        SIGNAL,
      );
      expect(output).toEqual([undefined]);
      expect(offloads).toBe(0);
      expect(inline).toBe(1);
    }
  });

  it('serializes quality rungs and preserves the first typed failure without starting siblings', async () => {
    const failure = new ConstraintUnsatisfiedError('quality floor was not met', {
      constraint: 'h264-quality-rate',
      preferredAverageBitrate: 1_400_000,
      maxAverageBitrate: 1_820_000,
      minimumQualityMean: 0.95,
      metric: 'ssim-luma-v1',
      attempts: [],
    });
    let started = 0;
    const pool: FakeOffloadPool = {
      size: 4,
      caps: { video: true, audio: true },
      runStream: () => {
        started += 1;
        return new ReadableStream<Transferable>({
          start(controller): void {
            controller.error(failure);
          },
        });
      },
    };

    await expect(
      runH264AbrLadder(
        offloadContext(pool),
        Uint8Array.of(1, 2, 3),
        [qualityRung({ name: '720p' }), qualityRung(), qualityRung({ name: '360p' })],
        {},
        SIGNAL,
      ),
    ).rejects.toBe(failure);
    expect(started).toBe(1);
  });

  it('aborts active offloaded siblings and awaits their teardown before rejecting', async () => {
    const failure = new MediaError('encode-error', 'first rung failed');
    let started = 0;
    let active = 0;
    let siblingAborts = 0;
    let firstController: ReadableStreamDefaultController<Transferable> | undefined;
    let settleFirst: (() => void) | undefined;
    const pool: FakeOffloadPool = {
      size: 3,
      caps: { video: true, audio: true },
      runStream: (_job, opts) => {
        const index = started++;
        active += 1;
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          active -= 1;
        };
        const stream = new ReadableStream<Transferable>({
          start(controller): void {
            if (index === 0) {
              firstController = controller;
              settleFirst = settle;
            }
            opts.signal?.addEventListener(
              'abort',
              () => {
                if (index !== 0) siblingAborts += 1;
                settle();
                controller.error(new MediaError('aborted', 'sibling cancelled'));
              },
              { once: true },
            );
          },
          cancel(): void {
            settle();
          },
        });
        if (started === 3) {
          queueMicrotask(() => {
            settleFirst?.();
            firstController?.error(failure);
          });
        }
        return stream;
      },
    };

    await expect(
      runH264AbrLadder(
        offloadContext(pool),
        Uint8Array.of(1, 2, 3),
        [
          { width: 1_280, height: 720, bitrate: 2_000_000 },
          { width: 854, height: 480, bitrate: 1_000_000 },
          { width: 640, height: 360, bitrate: 600_000 },
        ],
        {},
        SIGNAL,
      ),
    ).rejects.toBe(failure);
    expect(started).toBe(3);
    expect(siblingAborts).toBe(2);
    expect(active).toBe(0);
  });

  it('propagates caller cancellation through the one active quality rung', async () => {
    const caller = new AbortController();
    let started = 0;
    let aborted = 0;
    let signalStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pool: FakeOffloadPool = {
      size: 4,
      caps: { video: true, audio: true },
      runStream: (_job, opts) => {
        started += 1;
        signalStarted();
        return new ReadableStream<Transferable>({
          start(controller): void {
            opts.signal?.addEventListener(
              'abort',
              () => {
                aborted += 1;
                controller.error(new MediaError('aborted', 'caller cancelled'));
              },
              { once: true },
            );
          },
        });
      },
    };

    const operation = runH264AbrLadder(
      offloadContext(pool),
      Uint8Array.of(1, 2, 3),
      [qualityRung({ name: '720p' }), qualityRung(), qualityRung({ name: '360p' })],
      {},
      caller.signal,
    );
    await startedPromise;
    caller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'aborted' });
    expect(started).toBe(1);
    expect(aborted).toBe(1);
  });
});
