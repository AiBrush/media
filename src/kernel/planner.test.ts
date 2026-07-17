import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { type PlanRequest, type Planner, plan } from './planner.ts';

const H264 = { id: 1, mediaType: 'video', codec: 'h264' } as const;
const AAC = { id: 2, mediaType: 'audio', codec: 'aac' } as const;

function mp4Input(encrypted?: boolean): PlanRequest['input'] {
  return {
    container: 'mp4',
    streams: [H264, AAC],
    ...(encrypted !== undefined ? { encrypted } : {}),
  };
}

describe('planner — plan(request) → StageGraph', () => {
  it('plans a same-codec remux as copyOnly with zero decode/encode stages', () => {
    const graph = plan({
      op: 'remux',
      input: mp4Input(),
      output: { container: 'mkv' },
    });

    expect(graph.copyOnly).toBe(true);
    expect(graph.stages.map((stage) => stage.kind)).toEqual(['demux', 'copy', 'copy', 'mux']);
    expect(graph.stages.some((s) => s.kind === 'decode' || s.kind === 'encode')).toBe(false);
    expect(graph.stages[0]).toMatchObject({ target: 'mp4', label: 'demux:mp4' });
    expect(graph.stages[1]).toMatchObject({ mediaType: 'video', target: 'h264' });
    expect(graph.stages[2]).toMatchObject({ mediaType: 'audio', target: 'aac' });
    expect(graph.stages[3]).toMatchObject({ target: 'mkv', label: 'mux:mkv' });
  });

  it('plans a codec-changing convert as copyOnly:false with a decode+encode pair', () => {
    const graph = plan({
      op: 'convert',
      input: mp4Input(),
      output: {
        container: 'webm',
        targets: [{ stream: H264.id, codec: 'vp9' }],
      },
    });

    expect(graph.copyOnly).toBe(false);
    expect(graph.stages.map((stage) => `${stage.kind}:${stage.target ?? ''}`)).toEqual([
      'demux:mp4',
      'decode:h264',
      'encode:vp9',
      'copy:aac', // the untouched stream still copies — re-encode is decided per stream
      'mux:webm',
    ]);
  });

  it('forces decode → filter → encode when a target carries filters, even same-codec', () => {
    const graph = plan({
      op: 'convert',
      input: mp4Input(),
      output: {
        container: 'mp4',
        targets: [
          {
            stream: H264.id,
            filters: [{ mediaType: 'video', type: 'resize', width: 640, height: 360 }],
          },
        ],
      },
    });

    expect(graph.copyOnly).toBe(false);
    expect(graph.stages.map((stage) => stage.kind)).toEqual([
      'demux',
      'decode',
      'filter',
      'encode',
      'copy',
      'mux',
    ]);
    const filter = graph.stages.find((stage) => stage.kind === 'filter');
    expect(filter).toMatchObject({
      mediaType: 'video',
      filter: { type: 'resize', width: 640, height: 360 },
      label: 'filter:video:resize',
    });
  });

  it('plans keyframe trim as pure copy and accurate trim as a full re-encode', () => {
    const keyframe = plan({
      op: 'trim',
      input: mp4Input(),
      trim: { startSec: 1, endSec: 2, mode: 'keyframe' },
    });
    expect(keyframe.copyOnly).toBe(true);
    expect(keyframe.stages.map((stage) => stage.kind)).toEqual(['demux', 'copy', 'copy', 'mux']);

    const accurate = plan({
      op: 'trim',
      input: mp4Input(),
      trim: { startSec: 1, endSec: 2, mode: 'accurate' },
    });
    expect(accurate.copyOnly).toBe(false);
    expect(accurate.stages.map((stage) => stage.kind)).toEqual([
      'demux',
      'decode',
      'encode',
      'decode',
      'encode',
      'mux',
    ]);
  });

  it('drops discarded streams and keeps the remainder a copy fast path', () => {
    const graph = plan({
      op: 'remux',
      input: mp4Input(),
      output: { container: 'mp4', targets: [{ stream: H264.id, discard: true }] },
    });
    expect(graph.copyOnly).toBe(true);
    expect(graph.stages.map((stage) => `${stage.kind}:${stage.target ?? ''}`)).toEqual([
      'demux:mp4',
      'copy:aac',
      'mux:mp4',
    ]);
  });

  it('plans decrypt with a decrypt stage ahead of stream copies — never copyOnly', () => {
    const graph = plan({ op: 'decrypt', input: mp4Input(true) });
    expect(graph.copyOnly).toBe(false);
    expect(graph.stages.map((stage) => stage.kind)).toEqual([
      'demux',
      'decrypt',
      'copy',
      'copy',
      'mux',
    ]);
  });

  it('plans encrypted-input convert with the decrypt stage before any codec work', () => {
    const graph = plan({
      op: 'convert',
      input: mp4Input(true),
      output: { container: 'mp4', targets: [{ stream: AAC.id, codec: 'opus' }] },
    });
    expect(graph.stages.map((stage) => stage.kind)).toEqual([
      'demux',
      'decrypt',
      'copy',
      'decode',
      'encode',
      'mux',
    ]);
    expect(graph.copyOnly).toBe(false);
  });

  it('satisfies the Planner seam interface', () => {
    const planner: Planner = { plan };
    const graph = planner.plan({ op: 'probe', input: mp4Input() });
    expect(graph.stages.map((stage) => stage.kind)).toEqual(['demux']);
    expect(graph.copyOnly).toBe(false);
  });

  it('rejects malformed requests with typed InputErrors', () => {
    expect(() => plan({ op: 'convert', input: mp4Input() })).not.toThrow(); // output optional: same container, all-copy
    expect(() =>
      plan({ op: 'remux', input: { container: '', streams: [] }, output: { container: 'mp4' } }),
    ).toThrow(InputError);
    expect(() =>
      plan({
        op: 'remux',
        input: { container: 'mp4', streams: [H264, { ...AAC, id: H264.id }] },
        output: { container: 'mp4' },
      }),
    ).toThrow(InputError);
    expect(() => plan({ op: 'trim', input: mp4Input(), trim: { startSec: 2, endSec: 1 } })).toThrow(
      InputError,
    );
    expect(() =>
      plan({
        op: 'convert',
        input: mp4Input(),
        output: { container: 'mp4', targets: [{ stream: 99, codec: 'vp9' }] },
      }),
    ).toThrow(InputError);
    expect(() =>
      plan({
        op: 'convert',
        input: mp4Input(),
        output: {
          container: 'mp4',
          targets: [
            { stream: H264.id, codec: 'vp9' },
            { stream: H264.id, codec: 'av1' },
          ],
        },
      }),
    ).toThrow(InputError);
    expect(() => plan({ op: 'encode', input: mp4Input() })).toThrow(InputError);
    // A remux is copy-only by definition: a codec-changing target is a caller error, not a transcode.
    expect(() =>
      plan({
        op: 'remux',
        input: mp4Input(),
        output: { container: 'mp4', targets: [{ stream: AAC.id, codec: 'opus' }] },
      }),
    ).toThrow(InputError);
  });
});
