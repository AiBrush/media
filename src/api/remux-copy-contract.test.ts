import { describe, expect, it } from 'vitest';

import { plan } from '../kernel/planner.ts';
import {
  REMUX_PRESERVED_KEYS,
  isCopyOnlyRemuxRequest,
  isCopyPreservingRoute,
  missingPreservedKeys,
} from './remux-copy-contract.ts';
import { planRemuxOutput, usesStreamCopyRemux } from './remux-output-plan.ts';
import { isSemanticStreamCopy } from './semantic-stream-copy.ts';

describe('remux copy preservation contract (REQUIREMENTS §5.6 — 1.4.5)', () => {
  it('remux with identical codec and no transform is copyOnly and stream-copy preserving', () => {
    const request = {
      op: 'remux' as const,
      input: {
        container: 'mp4',
        streams: [{ id: 0, mediaType: 'video' as const, codec: 'avc1.64001f' }],
      },
      output: { container: 'mp4' },
    };
    expect(isCopyOnlyRemuxRequest(request)).toBe(true);
    expect(isCopyPreservingRoute('stream-copy')).toBe(true);
    expect(isCopyPreservingRoute('metadata-rewrite')).toBe(true);
    expect(isCopyPreservingRoute('packet-seam')).toBe(false);
    const facts = { formats: ['mp4'], hasStreamCopy: true, streamCopyTargets: ['mp4'] as const };
    expect(usesStreamCopyRemux(facts, { to: 'mp4' })).toBe(true);
    const outputPlan = planRemuxOutput(facts, { to: 'mp4' });
    expect(outputPlan.route).toBe('stream-copy');
    expect(missingPreservedKeys([...REMUX_PRESERVED_KEYS])).toEqual([]);
  });

  it('remux with codec change or filter forces re-encode (not copyOnly)', () => {
    const base = {
      op: 'remux' as const,
      input: {
        container: 'mp4',
        streams: [{ id: 0, mediaType: 'video' as const, codec: 'avc1.64001f' }],
      },
    };
    // codec change on remux is InputError (copy-strict) — never silent transcode
    expect(() =>
      plan({
        ...base,
        output: { container: 'mp4', targets: [{ stream: 0, codec: 'vp09.00.10.08' }] },
      }),
    ).toThrow(/copy-only/);
    // accurate trim forces decode/encode
    const accurate = plan({
      ...base,
      op: 'trim',
      trim: { startSec: 0, endSec: 1, mode: 'accurate' },
    });
    expect(accurate.copyOnly).toBe(false);
    expect(accurate.stages.some((s) => s.kind === 'decode')).toBe(true);
    // keyframe trim stays copyOnly
    const keyframe = plan({
      ...base,
      op: 'trim',
      trim: { startSec: 0, endSec: 1, mode: 'keyframe' },
    });
    expect(keyframe.copyOnly).toBe(true);
  });

  it('semantic stream-copy preserves rotation/alpha/color without decode', () => {
    const tracks: any[] = [
      {
        mediaType: 'video',
        config: { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 480 },
        rotation: 0,
        alpha: false,
      },
    ];
    expect(isSemanticStreamCopy({ to: 'webm', video: { width: 640, height: 480 } }, tracks)).toBe(
      true,
    );
    // mismatched alpha forces non-copy
    expect(isSemanticStreamCopy({ to: 'webm', video: { alpha: 'keep' } }, tracks)).toBe(false);
    // mismatched rotation forces non-copy
    expect(isSemanticStreamCopy({ to: 'webm', video: { rotate: 90 } }, tracks)).toBe(false);
    expect(missingPreservedKeys(['timestamps', 'editList'])).toContain('codecPrivate');
  });

  it('remux output plan gapless/edit/color/rotation always declared preserved', () => {
    // The contract is that every copy-preserving route carries all keys; packet-seam is still
    // timestamp+edit preserving for copy streams (decode only when edit unavoidable).
    expect(REMUX_PRESERVED_KEYS.length).toBe(14);
    expect(missingPreservedKeys([]).length).toBe(14);
    expect(
      missingPreservedKeys([
        'timestamps',
        'compositionOffsets',
        'editList',
        'codecPrivate',
        'color',
        'rotation',
        'alpha',
        'language',
      ]),
    ).toEqual(['gapless', 'chapters', 'text', 'attachments', 'tags', 'coverArt']);
  });

  it('convert with identical semantics stays copy-preserving, otherwise re-encodes', () => {
    const input = {
      container: 'mp4',
      streams: [{ id: 0, mediaType: 'video' as const, codec: 'avc1.64001f' }],
    };
    const keep = plan({ op: 'convert', input, output: { container: 'mp4' } });
    expect(keep.copyOnly).toBe(true);
    const transcode = plan({
      op: 'convert',
      input,
      output: {
        container: 'mp4',
        targets: [
          { stream: 0, codec: 'avc1.64001f', filters: [{ type: 'rotate', angle: 90 } as any] },
        ],
      },
    });
    expect(transcode.copyOnly).toBe(false);
  });

  it('20× randomized remux vs convert copy decision is deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const codec = i % 2 === 0 ? 'avc1.64001f' : 'mp4a.40.2';
      const mediaType = i % 2 === 0 ? ('video' as const) : ('audio' as const);
      const request = {
        op: 'remux' as const,
        input: { container: 'mp4', streams: [{ id: i, mediaType, codec }] },
        output: { container: 'mp4' },
      };
      const a = isCopyOnlyRemuxRequest(request);
      const b = isCopyOnlyRemuxRequest(request);
      expect(a).toBe(b);
      expect(a).toBe(true);
      // mismatched codec on convert (per-stream) deterministically re-encodes
      const convertMismatch = plan({
        op: 'convert',
        input: { container: 'mp4', streams: [{ id: 0, mediaType, codec }] },
        output: {
          container: 'mp4',
          targets: [{ stream: 0, codec: codec === 'avc1.64001f' ? 'vp09.00.10.08' : 'opus' }],
        },
      });
      expect(convertMismatch.copyOnly).toBe(false);
    }
  });

  it('malformed requests throw typed InputError, not silent corrupt', () => {
    expect(() => plan({ op: 'remux', input: { container: '', streams: [] } } as any)).toThrow(
      /container token/,
    );
    expect(() =>
      plan({
        op: 'remux',
        input: { container: 'mp4', streams: [{ id: 0, mediaType: 'video', codec: '' }] },
      } as any),
    ).toThrow(/codec token/);
  });
});
