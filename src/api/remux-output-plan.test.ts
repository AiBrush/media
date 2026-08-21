/**
 * The pre-execution output-sink declaration (REQUIREMENTS §5.1/§5.6).
 *
 * Two things are proven here. First the decision table itself — every route, both sides of every
 * size/shape boundary, and the sink-kind matrix — as a pure function, so no browser codec seam is
 * needed. Second, and more important, that the declaration cannot be a fiction: the stream-copy
 * predicate the runner branches on IS the predicate the plan reports, the reserve contract the plan
 * advertises IS the contract `validateReservedFaststart` enforces, and a real engine plan agrees with
 * what a real `remux` of the same request goes on to do.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { Mp4Module } from '../drivers/mp4/mp4-driver.ts';
import { WebmModule } from '../drivers/webm/webm-driver.ts';
import type { Sink } from '../sinks/sink.ts';
import { toBlob, toFile, toOPFS, toStream } from '../sinks/sink.ts';
import { toStreamTarget } from '../sinks/stream-target.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import {
  type RemuxOutputPlan,
  type RemuxOutputRouteFacts,
  WEBM_STREAMING_MIN_SOURCE_BYTES,
  planRemuxOutput,
  resolveRemuxOutputRoute,
  usesStreamCopyRemux,
} from './remux-output-plan.ts';
import { validateReservedFaststart } from './reserved-faststart.ts';
import type { Container, RemuxOptions } from './types.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The MP4/MOV driver: one driver for two formats, a `streamCopy` writer, no extra copy targets. */
const MP4_FACTS: RemuxOutputRouteFacts = {
  formats: ['mp4', 'mov'],
  hasStreamCopy: true,
};

/** A single-format driver with no copy writer — the shape that forces the packet seam. */
const SINGLE_FORMAT_FACTS: RemuxOutputRouteFacts = {
  formats: ['ogg'],
  hasStreamCopy: false,
};

function facts(overrides: Partial<RemuxOutputRouteFacts> = {}): RemuxOutputRouteFacts {
  return { ...MP4_FACTS, ...overrides };
}

function plan(opts: RemuxOptions, overrides: Partial<RemuxOutputRouteFacts> = {}): RemuxOutputPlan {
  return planRemuxOutput(facts(overrides), opts);
}

describe('remux output plan — route resolution', () => {
  it('takes the source driver’s stream copy for an ordinary same-family request', () => {
    expect(plan({ to: 'mp4' }).route).toBe('stream-copy');
    expect(plan({ to: 'mov' }).route).toBe('stream-copy');
  });

  it('routes a declared target the copy writer advertises but does not itself demux', () => {
    const oggLike = { formats: ['ogg'], hasStreamCopy: true, streamCopyTargets: ['webm', 'mkv'] };
    expect(planRemuxOutput(oggLike, { to: 'mkv' }).route).toBe('stream-copy');
    // …and never a target it advertises nowhere.
    expect(planRemuxOutput(oggLike, { to: 'mp4' }).route).toBe('packet-seam');
  });

  it('declines the copy writer once a track subset is requested', () => {
    expect(plan({ to: 'mp4', trackSelect: ['video:0'] }).route).toBe('packet-seam');
    // An empty selector is "no selection", not "select nothing".
    expect(plan({ to: 'mp4', trackSelect: [] }).route).toBe('stream-copy');
  });

  it('routes a same-container tag rewrite away from reserialization', () => {
    expect(plan({ to: 'mp4', tags: { title: 'x' } }).route).toBe('metadata-rewrite');
    expect(planRemuxOutput(SINGLE_FORMAT_FACTS, { to: 'ogg', tags: { title: 'x' } }).route).toBe(
      'metadata-rewrite',
    );
    // A requested output shape means the bytes must be re-authored, so the rewrite shortcut is off.
    expect(plan({ to: 'mp4', tags: { title: 'x' }, fragmented: true }).route).toBe('stream-copy');
    expect(plan({ to: 'mp4', tags: { title: 'x' }, faststart: false }).route).toBe('stream-copy');
    // A cross-family tag request is an ordinary remux that happens to carry tags.
    expect(planRemuxOutput(SINGLE_FORMAT_FACTS, { to: 'mkv', tags: { title: 'x' } }).route).toBe(
      'packet-seam',
    );
  });

  it('sends every WebM-family output above the prepared-writer boundary to the streaming writer', () => {
    for (const to of ['webm', 'mkv'] as const) {
      expect(plan({ to }, { sourceSizeBytes: WEBM_STREAMING_MIN_SOURCE_BYTES + 1 }).route).toBe(
        'streaming-webm',
      );
      expect(plan({ to, fragmented: true }, { sourceSizeBytes: 1 }).route).toBe('streaming-webm');
      expect(plan({ to }, { sourceSizeBytes: 2 * GIB }).route).toBe('streaming-webm');
    }
  });

  it('overrides a driver that WOULD have copied the WebM family itself', () => {
    // This is the guard's whole point: the WebM driver's own copy writer materializes the complete
    // source, so it must lose to the Cluster-on-write writer above the boundary and for any explicitly
    // fragmented request — even though `hasStreamCopy` and the format list both say it could copy.
    const webmDriver: RemuxOutputRouteFacts = { formats: ['webm', 'mkv'], hasStreamCopy: true };
    const oggDriver: RemuxOutputRouteFacts = {
      formats: ['ogg'],
      hasStreamCopy: true,
      streamCopyTargets: ['webm', 'mkv'],
    };
    for (const driver of [webmDriver, oggDriver]) {
      for (const to of ['webm', 'mkv'] as const) {
        const label = `${driver.formats[0]}->${to}`;
        // Small and unshaped: the driver's own copy writer wins.
        expect(planRemuxOutput({ ...driver, sourceSizeBytes: 4 * MIB }, { to }).route, label).toBe(
          'stream-copy',
        );
        // Above the boundary, or fragmented at any size: diverted.
        expect(
          planRemuxOutput(
            { ...driver, sourceSizeBytes: WEBM_STREAMING_MIN_SOURCE_BYTES + 1 },
            { to },
          ).route,
          label,
        ).toBe('streaming-webm');
        expect(
          planRemuxOutput({ ...driver, sourceSizeBytes: 1 }, { to, fragmented: true }).route,
          label,
        ).toBe('streaming-webm');
        expect(usesStreamCopyRemux({ ...driver, sourceSizeBytes: 4 * GIB }, { to }), label).toBe(
          false,
        );
      }
    }
    // The divert is WebM-family-specific: an equally huge non-WebM target still takes the copy writer.
    expect(planRemuxOutput({ ...oggDriver, sourceSizeBytes: 4 * GIB }, { to: 'ogg' }).route).toBe(
      'stream-copy',
    );
  });

  it('holds the exact 64 MiB boundary and does not divert other targets', () => {
    expect(plan({ to: 'mkv' }, { sourceSizeBytes: WEBM_STREAMING_MIN_SOURCE_BYTES }).route).toBe(
      'packet-seam',
    );
    expect(
      plan({ to: 'mkv' }, { sourceSizeBytes: WEBM_STREAMING_MIN_SOURCE_BYTES + 1 }).route,
    ).toBe('streaming-webm');
    // Size never diverts a non-WebM target, however large.
    expect(plan({ to: 'mp4' }, { sourceSizeBytes: 8 * GIB }).route).toBe('stream-copy');
    expect(plan({ to: 'ts' }, { sourceSizeBytes: 8 * GIB }).route).toBe('packet-seam');
  });

  it('treats an unknown source length as "not large" rather than guessing', () => {
    expect(planRemuxOutput(MP4_FACTS, { to: 'mkv' }).route).toBe('packet-seam');
    expect(planRemuxOutput(MP4_FACTS, { to: 'mkv', fragmented: true }).route).toBe(
      'streaming-webm',
    );
    expect(MP4_FACTS.sourceSizeBytes).toBeUndefined();
  });
});

describe('remux output plan — declared write contract', () => {
  it('declares append-only, non-seeking writes for every non-reserved route', () => {
    for (const opts of [
      { to: 'mp4' } as const,
      { to: 'mp4', faststart: false } as const,
      { to: 'mp4', fragmented: true } as const,
      { to: 'mkv' } as const,
      { to: 'ts' } as const,
      { to: 'mp4', tags: { title: 'x' } } as const,
    ]) {
      const declared = plan(opts);
      expect(declared.writeOrder, opts.to).toBe('append-only');
      expect(declared.requiresSeek, opts.to).toBe(false);
      expect(declared.requiresReservation, opts.to).toBe(false);
    }
  });

  it('declares the reserved-index layout as positioned, seeking, and reservation-bearing', () => {
    const reserved = plan({
      to: 'mp4',
      faststart: 'reserve',
      maximumPacketCount: 1_000,
      sink: toStreamTarget(() => {}),
    });
    expect(reserved.writeOrder).toBe('positioned');
    expect(reserved.requiresSeek).toBe(true);
    expect(reserved.requiresReservation).toBe(true);
    expect(reserved.acceptedSinkKinds).toEqual(['opfs', 'stream-target', 'opfs-target']);
  });

  it('declares finalization for every layout except a progressively valid fragmented one', () => {
    expect(plan({ to: 'mp4' }).requiresFinalization).toBe(true);
    expect(plan({ to: 'mp4', faststart: false }).requiresFinalization).toBe(true);
    expect(plan({ to: 'mkv' }, { sourceSizeBytes: 2 * GIB }).requiresFinalization).toBe(true);
    expect(plan({ to: 'mp4', fragmented: true }).requiresFinalization).toBe(false);
    expect(plan({ to: 'mkv', fragmented: true }).requiresFinalization).toBe(false);
    expect(plan({ to: 'mp4', fragmented: true }).fragmented).toBe(true);
    expect(plan({ to: 'mp4' }).fragmented).toBe(false);
  });
});

describe('remux output plan — declared retention', () => {
  const streamingSinks: readonly Sink[] = [toStream(), toStreamTarget(() => {}), toOPFS('out.bin')];
  const retainingSinks: readonly Sink[] = [toBlob(), toFile('out.bin')];

  it('reports bounded retention for a copy route drained through a streaming sink', () => {
    for (const sink of streamingSinks) {
      expect(plan({ to: 'mp4', sink }).retention, sink.kind).toBe('bounded');
      expect(plan({ to: 'mkv', sink }, { sourceSizeBytes: 2 * GIB }).retention, sink.kind).toBe(
        'bounded',
      );
    }
  });

  it('reports whole-output retention when the caller asked for a whole-output sink', () => {
    for (const sink of retainingSinks) {
      expect(plan({ to: 'mp4', sink }).retention, sink.kind).toBe('whole-output');
      // …while still telling the caller a bounded drain is reachable if they change the sink.
      expect(plan({ to: 'mp4', sink }).boundedRetentionAvailable, sink.kind).toBe(true);
    }
    // Omitting `sink` means the default `toBlob()`, so the default is a retaining answer.
    expect(plan({ to: 'mp4' }).retention).toBe('whole-output');
  });

  it('never promises bounded retention for a route that must materialize', () => {
    for (const sink of [...streamingSinks, ...retainingSinks]) {
      // The packet seam and the metadata rewrite both hold the complete payload.
      expect(plan({ to: 'ts', sink }).boundedRetentionAvailable, sink.kind).toBe(false);
      expect(plan({ to: 'ts', sink }).retention, sink.kind).toBe('whole-output');
      expect(plan({ to: 'mp4', tags: { t: 'x' }, sink }).retention, sink.kind).toBe('whole-output');
      // A post-mux tag rewrite reads its own output back, so even a copy route loses boundedness.
      expect(
        plan({ to: 'mkv', tags: { t: 'x' }, sink }, { sourceSizeBytes: 2 * GIB }).retention,
        sink.kind,
      ).toBe('whole-output');
    }
  });
});

describe('remux output plan — invariants over a randomized request space', () => {
  const CONTAINERS: readonly Container[] = [
    'mp4',
    'mov',
    'webm',
    'mkv',
    'ogg',
    'ts',
    'wav',
    'flac',
  ];
  const SINKS: readonly (Sink | undefined)[] = [
    undefined,
    toBlob(),
    toFile('o'),
    toStream(),
    toOPFS('o'),
    toStreamTarget(() => {}),
  ];
  const SIZES: readonly (number | undefined)[] = [
    undefined,
    0,
    1,
    WEBM_STREAMING_MIN_SOURCE_BYTES - 1,
    WEBM_STREAMING_MIN_SOURCE_BYTES,
    WEBM_STREAMING_MIN_SOURCE_BYTES + 1,
    3 * GIB,
    Number.MAX_SAFE_INTEGER,
  ];

  /** A tiny deterministic LCG: the corpus is reproducible without a fixture or a seed file. */
  function* requests(count: number): Generator<{
    readonly opts: RemuxOptions;
    readonly routeFacts: RemuxOutputRouteFacts;
  }> {
    let state = 0x2f6e_2b1;
    const pick = <T>(values: readonly T[]): T => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      // An LCG's low bits are short-period; taking a small modulus of them correlates the choices and
      // would silently starve whole route combinations out of the corpus. Use the high bits.
      return values[(state >>> 13) % values.length] as T;
    };
    for (let i = 0; i < count; i++) {
      const size = pick(SIZES);
      const sink = pick(SINKS);
      const tags = pick([undefined, { title: 't' }]);
      const trackSelect = pick([undefined, [], ['video:0'], ['audio:0', 'video:0']]);
      const faststart = pick([undefined, true, false, 'reserve'] as const);
      const fragmented = pick([undefined, true, false]);
      yield {
        opts: {
          to: pick(CONTAINERS),
          ...(sink === undefined ? {} : { sink }),
          ...(tags === undefined ? {} : { tags }),
          ...(trackSelect === undefined ? {} : { trackSelect }),
          ...(faststart === undefined ? {} : { faststart }),
          ...(fragmented === undefined ? {} : { fragmented }),
        },
        routeFacts: {
          formats: pick([['mp4', 'mov'], ['webm', 'mkv'], ['ogg'], ['ts']]),
          hasStreamCopy: pick([true, false]),
          ...(pick([true, false]) ? { streamCopyTargets: ['mkv', 'webm'] } : {}),
          ...(size === undefined ? {} : { sourceSizeBytes: size }),
        },
      };
    }
  }

  it('holds every structural invariant across 4000 generated requests', () => {
    let stream = 0;
    let webm = 0;
    let seam = 0;
    let rewrite = 0;
    let excludedSinks = 0;
    for (const { opts, routeFacts } of requests(4_000)) {
      const declared = planRemuxOutput(routeFacts, opts);
      expect(Object.isFrozen(declared)).toBe(true);
      expect(declared.schema).toBe('aibrush-media/remux-output-plan@1');
      expect(declared.container).toBe(opts.to);
      // Seeking, positioned order, and reservation are one and the same requirement.
      expect(declared.requiresSeek).toBe(declared.writeOrder === 'positioned');
      expect(declared.requiresReservation).toBe(declared.requiresSeek);
      // `fragmented` and `requiresFinalization` are exact complements.
      expect(declared.requiresFinalization).toBe(!declared.fragmented);
      // A bounded answer is only ever reachable where boundedness was advertised.
      if (declared.retention === 'bounded') expect(declared.boundedRetentionAvailable).toBe(true);
      expect(declared.acceptedSinkKinds.length).toBeGreaterThan(0);
      // The declaration and the runner's own branch predicate agree, always: the runner takes the copy
      // writer exactly when the plan said `stream-copy`, or when a declined metadata rewrite falls into
      // it — and never when the plan said the streaming writer or the packet seam.
      const copies = usesStreamCopyRemux(routeFacts, opts);
      if (declared.route === 'stream-copy') expect(copies).toBe(true);
      if (declared.route === 'streaming-webm' || declared.route === 'packet-seam') {
        expect(copies).toBe(false);
      }
      // A sink kind the plan excludes must be a request the shared preflight actually rejects.
      const kind = opts.sink?.kind ?? 'blob';
      if (!declared.acceptedSinkKinds.includes(kind)) {
        excludedSinks++;
        expect(() => validateReservedFaststart('remux', opts.to, opts)).toThrow(Error);
      }
      if (declared.route === 'stream-copy') stream++;
      else if (declared.route === 'streaming-webm') webm++;
      else if (declared.route === 'packet-seam') seam++;
      else rewrite++;
    }
    // The corpus really did reach every route — otherwise the invariants above prove nothing.
    for (const [label, count] of [
      ['stream-copy', stream],
      ['streaming-webm', webm],
      ['packet-seam', seam],
      ['metadata-rewrite', rewrite],
      // …including requests whose sink the declaration excludes, so that clause is not vacuous.
      ['sink-excluded', excludedSinks],
    ] as const) {
      expect(count, label).toBeGreaterThan(0);
    }
  });

  it('is a pure function of its inputs and never mutates them', () => {
    const routeFacts: RemuxOutputRouteFacts = {
      formats: ['mp4', 'mov'],
      hasStreamCopy: true,
      sourceSizeBytes: 5 * GIB,
    };
    const opts: RemuxOptions = { to: 'mkv', trackSelect: ['video:0'] };
    const before = JSON.stringify({ routeFacts, opts });
    expect(planRemuxOutput(routeFacts, opts)).toEqual(planRemuxOutput(routeFacts, opts));
    expect(JSON.stringify({ routeFacts, opts })).toBe(before);
  });

  it('rejects a mutation of the returned declaration', () => {
    const declared = plan({ to: 'mp4' });
    expect(() => {
      (declared as { route: string }).route = 'packet-seam';
    }).toThrow(TypeError);
  });
});

describe('remux output plan — resolveRemuxOutputRoute agrees with the plan it backs', () => {
  it('never disagrees with planRemuxOutput on a hand-built decision matrix', () => {
    for (const routeFacts of [
      MP4_FACTS,
      SINGLE_FORMAT_FACTS,
      facts({ sourceSizeBytes: 2 * GIB }),
    ]) {
      for (const to of ['mp4', 'mkv', 'ts', 'ogg'] as const) {
        expect(planRemuxOutput(routeFacts, { to }).route).toBe(
          resolveRemuxOutputRoute(routeFacts, { to }),
        );
      }
    }
  });
});

// ── Through the real engine ─────────────────────────────────────────────────────────────────────

/**
 * A `Source` over real MP4 bytes (so the container router recognizes mp4) with `size` overridden to
 * model a large file. The declaration reads `size` before the demuxer touches the body, so the actual
 * byte count can stay tiny — the same modeling `remux-scale-na.test.ts` uses for the scale gate.
 */
function mp4SourceWithSize(bytes: Uint8Array, size: number): Source {
  const src = fromBytes(bytes, { mime: 'video/mp4' });
  Object.defineProperty(src, 'size', { value: size, configurable: true, enumerable: true });
  return src;
}

async function mp4Bytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${ROOT}fixtures/media/movie_5.mp4`));
}

describe('MediaEngine.planRemuxOutput', () => {
  it('declares a bounded append-only copy for a huge same-family request', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 725_106_140);
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const declared = await media.planRemuxOutput(src, {
      to: 'mp4',
      sink: toStreamTarget(() => {}),
    });
    expect(declared.route).toBe('stream-copy');
    expect(declared.writeOrder).toBe('append-only');
    expect(declared.requiresSeek).toBe(false);
    expect(declared.fragmented).toBe(false);
    expect(declared.retention).toBe('bounded');
    expect(declared.acceptedSinkKinds).toContain('stream-target');
  });

  it('declares the streaming Matroska writer for a >1 GiB cross-family request, and takes it', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 1_144_401_376);
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const declared = await media.planRemuxOutput(src, { to: 'mkv', sink: toOPFS('out.mkv') });
    expect(declared.route).toBe('streaming-webm');
    expect(declared.boundedRetentionAvailable).toBe(true);
    expect(declared.retention).toBe('bounded');

    // The declaration is not a story about the code: executing the same request reaches the streaming
    // writer's browser-only `EncodedChunk` seam, never the buffer-all memory gate the other route has.
    const err = await media.remux(src, { to: 'mkv', sink: toOPFS('out.mkv') }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).message).toMatch(/EncodedChunk constructors/i);
    expect((err as CapabilityError).message).not.toMatch(/buffer|memory/i);
  });

  it('declares whole-output retention for the small cross-family request it really buffers', async () => {
    const bytes = await mp4Bytes();
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const declared = await media.planRemuxOutput(fromBytes(bytes, { mime: 'video/mp4' }), {
      to: 'mkv',
      sink: toStream(),
    });
    expect(declared.route).toBe('packet-seam');
    expect(declared.boundedRetentionAvailable).toBe(false);
    expect(declared.retention).toBe('whole-output');
  });

  it('rejects an illegal reserved-faststart tuple during planning, not after the run', async () => {
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const src = fromBytes(await mp4Bytes(), { mime: 'video/mp4' });
    // A whole-output sink cannot honour a positioned reservation patch.
    await expect(
      media.planRemuxOutput(src, { to: 'mp4', faststart: 'reserve', maximumPacketCount: 8 }),
    ).rejects.toBeInstanceOf(InputError);
    // A per-track ceiling is meaningless without the reservation it bounds.
    await expect(
      media.planRemuxOutput(src, { to: 'mp4', maximumPacketCount: 8 }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('produces no output bytes and honours cancellation', async () => {
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const src = fromBytes(await mp4Bytes(), { mime: 'video/mp4' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      media.planRemuxOutput(src, { to: 'mp4' }, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

describe('the declared contract is the contract remux actually delivers', () => {
  /** A `Source` that records every range read, so "bounded" can be measured rather than asserted. */
  function countingSource(bytes: Uint8Array): {
    readonly source: Source;
    readonly reads: Array<{ start: number; end: number }>;
  } {
    const reads: Array<{ start: number; end: number }> = [];
    const inner = fromBytes(bytes, { mime: 'video/mp4' });
    // Deliberately built field by field rather than spread: a `readAll` escape hatch would let the
    // runner slurp the whole file in one call and hide the very laziness being measured.
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: bytes.byteLength,
      mimeHint: 'video/mp4',
      stream: () => inner.stream(),
      range: async (start, end, signal) => {
        reads.push({ start, end });
        return (inner.range as NonNullable<Source['range']>)(start, end, signal);
      },
    };
    return { source, reads };
  }

  it('honours a stream-target sink append-only, incrementally, without slurping the source', async () => {
    const bytes = await mp4Bytes();
    const { source, reads } = countingSource(bytes);
    const media = createMedia().use(Mp4Module).use(WebmModule);

    const writes: Array<{ position: number; length: number; readsSoFar: number }> = [];
    const sink = toStreamTarget((chunk, position) => {
      writes.push({ position, length: chunk.byteLength, readsSoFar: reads.length });
    });
    const declared = await media.planRemuxOutput(source, { to: 'mp4', sink });
    expect(declared.route).toBe('stream-copy');
    expect(declared.writeOrder).toBe('append-only');
    expect(declared.retention).toBe('bounded');

    const returned = await media.remux(source, { to: 'mp4', sink });
    // A target sink writes the destination and returns nothing — there is no whole-output value.
    expect(returned).toBeUndefined();

    // Declared `append-only`: every write lands exactly at the end of the previous one.
    expect(writes.length).toBeGreaterThan(1);
    let cursor = 0;
    for (const write of writes) {
      expect(write.position).toBe(cursor);
      cursor += write.length;
    }
    // Declared `bounded`: the first byte reached the destination before the source was exhausted, and
    // no single write carried the whole program.
    const firstWrite = writes[0] as (typeof writes)[number];
    const readBytesBeforeFirstWrite = reads
      .slice(0, firstWrite.readsSoFar)
      .reduce((sum, read) => sum + (read.end - read.start), 0);
    expect(readBytesBeforeFirstWrite).toBeLessThan(bytes.byteLength);
    expect(Math.max(...writes.map((write) => write.length))).toBeLessThan(cursor);
  });

  it('emits a whole-output value for the whole-output retention it declared', async () => {
    const bytes = await mp4Bytes();
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const source = fromBytes(bytes, { mime: 'video/mp4' });
    const declared = await media.planRemuxOutput(source, { to: 'mp4', sink: toBlob() });
    expect(declared.retention).toBe('whole-output');
    expect(declared.boundedRetentionAvailable).toBe(true);

    const output = await media.remux(source, { to: 'mp4', sink: toBlob() });
    expect(output).toBeInstanceOf(Blob);
    expect((output as Blob).size).toBeGreaterThan(0);
  });
});
