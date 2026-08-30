/**
 * Append-only sink contract for remux (REQUIREMENTS §5.6 — 1.4.6).
 *
 * "Append-only sinks MUST either receive a valid progressively emitted format or be rejected
 * during planning. They MUST NOT fail only after the full operation has run."
 *
 * The declaration {@link planRemuxOutput} and the preflight {@link validateReservedFaststart}
 * together enforce this: a positioned‐write route (reserved faststart) is rejected during planning
 * when the sink cannot seek, every other route is append-only, and the whole-output vs progressive
 * distinction is declared via `requiresFinalization`/`fragmented`/`retention` so callers can choose
 * a sink before any byte is produced. The streaming-webm and fragmented MP4 routes are the valid
 * progressively emitted formats; ordinary packet-seam/whole-output routes are valid append-only
 * payloads that buffer before the final index (they do not fail late).
 */

import { describe, expect, it } from 'vitest';
import { toBlob, toStream } from '../sinks/sink.ts';
import { toOPFS } from '../sinks/sink.ts';
import { toStreamTarget } from '../sinks/stream-target.ts';
import { type RemuxOutputRouteFacts, planRemuxOutput } from './remux-output-plan.ts';
import { validateReservedFaststart } from './reserved-faststart.ts';

const MP4_FACTS: RemuxOutputRouteFacts = { formats: ['mp4', 'mov'], hasStreamCopy: true };
const WEBM_FACTS: RemuxOutputRouteFacts = { formats: ['webm', 'mkv'], hasStreamCopy: true };
const OGG_FACTS: RemuxOutputRouteFacts = { formats: ['ogg'], hasStreamCopy: false };

describe('remux 1.4.6 — append-only sink planning', () => {
  it('reserved faststart is the only positioned route and is rejected for append-only sinks during planning', () => {
    // stream, blob, file cannot seek → InputError during planning
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 10,
      } as any),
    ).toThrow();
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 10,
        sink: toBlob(),
      } as any),
    ).toThrow();
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 10,
        sink: toStream(),
      } as any),
    ).toThrow();
    // position-aware sinks pass
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 10,
        sink: toStreamTarget(() => {}),
      } as any),
    ).not.toThrow();
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 10,
        sink: toOPFS('out.mp4'),
      } as any),
    ).not.toThrow();

    const reserved = planRemuxOutput(MP4_FACTS, {
      to: 'mp4',
      faststart: 'reserve',
      maximumPacketCount: 10,
      sink: toStreamTarget(() => {}),
    });
    expect(reserved.writeOrder).toBe('positioned');
    expect(reserved.requiresSeek).toBe(true);
    expect(reserved.acceptedSinkKinds).toEqual(['opfs', 'stream-target', 'opfs-target']);
    expect(reserved.acceptedSinkKinds).not.toContain('stream');
    expect(reserved.acceptedSinkKinds).not.toContain('blob');
  });

  it('every non-reserved remux is append-only and never late-fails for a stream sink', () => {
    for (const facts of [MP4_FACTS, WEBM_FACTS, OGG_FACTS]) {
      for (const to of ['mp4', 'webm', 'ogg', 'ts'] as const) {
        const planStream = planRemuxOutput(facts, { to, sink: toStream() });
        expect(planStream.writeOrder).toBe('append-only');
        expect(planStream.requiresSeek).toBe(false);
        expect(planStream.acceptedSinkKinds).toContain('stream');
        // planning does not reject — validation mirrors declaration
        expect(() =>
          validateReservedFaststart('remux', to, { to, sink: toStream() } as any),
        ).not.toThrow();
      }
    }
  });

  it('progressively emitted formats are declared and remain append-only', () => {
    // fragmented MP4 is progressive (no finalization)
    const frag = planRemuxOutput(MP4_FACTS, { to: 'mp4', fragmented: true, sink: toStream() });
    expect(frag.fragmented).toBe(true);
    expect(frag.requiresFinalization).toBe(false);
    expect(frag.writeOrder).toBe('append-only');

    // streaming-webm is progressive via bounded Cluster-on-write
    const bigWebm = planRemuxOutput(
      { ...WEBM_FACTS, sourceSizeBytes: 200 * 1024 * 1024 },
      { to: 'webm', sink: toStream() },
    );
    expect(bigWebm.route).toBe('streaming-webm');
    expect(bigWebm.writeOrder).toBe('append-only');
    expect(bigWebm.boundedRetentionAvailable).toBe(true);

    // ordinary whole-output packet-seam routes are valid append-only payloads (finalization required, buffered)
    const ordinary = planRemuxOutput(OGG_FACTS, { to: 'mp4', sink: toStream() });
    expect(ordinary.requiresFinalization).toBe(true);
    expect(ordinary.retention).toBe('whole-output');
    // still accepted for stream — buffering before emit, not a late failure
    expect(ordinary.acceptedSinkKinds).toContain('stream');
    // same-container stream-copy with a streaming sink is bounded but still append-only and accepted
    const copyBounded = planRemuxOutput(MP4_FACTS, { to: 'mp4', sink: toStream() });
    expect(copyBounded.retention).toBe('bounded');
  });

  it('boundary: malformed reserve tuples throw typed InputError, not silent fallback', () => {
    expect(() =>
      planRemuxOutput(MP4_FACTS, {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 0,
        sink: toStreamTarget(() => {}),
      } as any),
    ).not.toThrow(); // plan itself is pure, validation is separate
    expect(() =>
      validateReservedFaststart('remux', 'mp4', {
        to: 'mp4',
        faststart: 'reserve',
        maximumPacketCount: 0,
        sink: toStreamTarget(() => {}),
      } as any),
    ).toThrow();
    expect(() =>
      validateReservedFaststart('remux', 'webm', {
        to: 'webm',
        faststart: 'reserve',
        maximumPacketCount: 1,
        sink: toStreamTarget(() => {}),
      } as any),
    ).toThrow();
  });

  it('20× randomized append-only contract holds: reserved excluded, non-reserved included, no late failure', () => {
    const factsChoices: RemuxOutputRouteFacts[] = [MP4_FACTS, WEBM_FACTS, OGG_FACTS];
    const containers = ['mp4', 'webm', 'ogg', 'ts', 'flac'] as const;
    const sinks = [toBlob(), toStream(), toStreamTarget(() => {}), toOPFS('x')] as const;
    let seenReserved = 0;
    let seenProgressive = 0;
    for (let i = 0; i < 20; i++) {
      const facts = factsChoices[i % factsChoices.length] as RemuxOutputRouteFacts;
      const to = containers[i % containers.length] as any;
      const sink = sinks[i % sinks.length] as any;
      const fragmented = i % 3 === 0 ? true : undefined;
      const reserve = i % 7 === 0 ? ('reserve' as const) : undefined;
      const opts: any = {
        to,
        sink,
        ...(fragmented ? { fragmented } : {}),
        ...(reserve ? { faststart: reserve, maximumPacketCount: 10 } : {}),
      };
      const plan = planRemuxOutput(facts, opts);
      // writeOrder ↔ requiresSeek invariant
      expect(plan.requiresSeek).toBe(plan.writeOrder === 'positioned');
      expect(plan.requiresReservation).toBe(plan.requiresSeek);
      expect(plan.requiresFinalization).toBe(!plan.fragmented);
      if (reserve) {
        seenReserved++;
        expect(plan.acceptedSinkKinds).not.toContain('stream');
        expect(() => validateReservedFaststart('remux', to, opts)).toThrow();
      } else {
        expect(plan.acceptedSinkKinds).toContain('stream');
        expect(() => validateReservedFaststart('remux', to, opts)).not.toThrow();
      }
      if (plan.fragmented || plan.route === 'streaming-webm') seenProgressive++;
    }
    expect(seenReserved).toBeGreaterThan(0);
    expect(seenProgressive).toBeGreaterThan(0);
  });
});
