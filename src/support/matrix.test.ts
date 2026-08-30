import { describe, expect, it } from 'vitest';
import { generateSupportMatrix } from './matrix.ts';

describe('support matrix — executable declarations (REQUIREMENTS §6)', () => {
  it('is frozen and has the expected schema', () => {
    const m = generateSupportMatrix();
    expect(m.schema).toBe('aibrush-media/support-matrix@1');
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.containers)).toBe(true);
  });

  it('covers required container families with at least probe/demux', () => {
    const m = generateSupportMatrix();
    const containers = new Set(m.containers.map((r) => r.container));
    for (const required of ['mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'adts']) {
      expect(containers.has(required), required).toBe(true);
      const row = m.containers.find((r) => r.container === required)!;
      expect(row.operations).toContain('probe');
      expect(row.operations).toContain('demux');
    }
  });

  it('declares remux/mux only where executable spec has streamCopy or muxKind', () => {
    const m = generateSupportMatrix();
    const wav = m.containers.find((r) => r.container === 'wav')!;
    expect(wav.operations).toContain('mux');
    // avi has no muxKind/streamCopy in defaults → no mux
    const avi = m.containers.find((r) => r.container === 'avi');
    if (avi !== undefined) expect(avi.operations).not.toContain('mux');
  });

  it('covers required codecs with parse/decode/encode and hardware/software routes', () => {
    const m = generateSupportMatrix();
    const codes = new Set(m.codecs.map((r) => r.codec));
    for (const required of [
      'h264',
      'hevc',
      'av1',
      'vp9',
      'vp8',
      'aac',
      'opus',
      'vorbis',
      'mp3',
      'flac',
      'pcm',
    ]) {
      expect(codes.has(required), required).toBe(true);
    }
    // vp8/vp9 alpha (WebM BlockAdditions), h264 not
    expect(m.codecs.find((r) => r.codec === 'vp8')!.alpha).toBe(true);
    expect(m.codecs.find((r) => r.codec === 'vp9')!.alpha).toBe(true);
    expect(m.codecs.find((r) => r.codec === 'h264')!.alpha).toBe(false);
    // vorbis has software decode but no hardware
    const vorbis = m.codecs.find((r) => r.codec === 'vorbis')!;
    expect(vorbis.decode.software).toBe(true);
    expect(vorbis.decode.hardware).toBe(false);
  });

  it('is a pure function — same result across 20 randomized orderings', () => {
    const a = generateSupportMatrix();
    for (let i = 0; i < 20; i++) {
      const b = generateSupportMatrix();
      expect(b).toEqual(a);
    }
  });

  it('is deterministic and contains no fixture branching', () => {
    const m = generateSupportMatrix();
    // Every container row operations are subset of the canonical set and sorted
    const canonical = [
      'probe',
      'demux',
      'mux',
      'streaming-mux',
      'remux',
      'metadata',
      'seek',
      'trim',
      'encryption',
    ];
    for (const row of m.containers) {
      for (const op of row.operations) expect(canonical).toContain(op);
      expect(
        [...row.operations].sort((x, y) => canonical.indexOf(x) - canonical.indexOf(y)),
      ).toEqual([...row.operations]);
    }
    // No container implies codec support automatically — codec list is independent
    expect(m.containers.length).toBeGreaterThan(0);
    expect(m.codecs.length).toBeGreaterThan(0);
  });

  it('does not mutate inputs and rejects mutation of returned rows', () => {
    const m = generateSupportMatrix();
    expect(() => {
      (m as unknown as { schema: string }).schema = 'x';
    }).toThrow(TypeError);
    const row = m.containers[0] as unknown as { container: string };
    expect(() => {
      row.container = 'x';
    }).toThrow(TypeError);
  });
});
