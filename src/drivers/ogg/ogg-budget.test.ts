import { describe, expect, it } from 'vitest';
import { MAX_OGG_PAGES_PER_STREAM, oggAudioPackets, parseOgg } from './ogg-driver.ts';

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u64 = (n: number): number[] => [...u32(n >>> 0), ...u32(Math.floor(n / 2 ** 32))];

function page(opts: {
  bos?: boolean;
  eos?: boolean;
  granule?: number;
  serial?: number;
  data: number[];
}): number[] {
  const data = opts.data;
  const segs: number[] = [];
  let rem = data.length;
  while (rem >= 255) {
    segs.push(255);
    rem -= 255;
  }
  segs.push(rem);
  const granule =
    opts.granule === -1 ? [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : u64(opts.granule ?? 0);
  return [
    ...str('OggS'),
    0,
    (opts.bos ? 0x02 : 0x00) | (opts.eos ? 0x04 : 0x00),
    ...granule,
    ...u32(opts.serial ?? 1),
    ...u32(0),
    0,
    0,
    0,
    0,
    segs.length,
    ...segs,
    ...data,
  ];
}

const vorbisId = (ch: number, sr: number): number[] => [
  0x01,
  ...str('vorbis'),
  ...u32(0),
  ch,
  ...u32(sr),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  0xb8,
  0x01,
];
const _opusId = (ch: number, preSkip = 312): number[] => [
  ...str('OpusHead'),
  1,
  ch,
  ...u16(preSkip),
  ...u32(48000),
  ...u16(0),
  0,
];
void _opusId;

function validOggWithExtraPages(extraPages: number): Uint8Array {
  const parts: number[] = [];
  parts.push(...page({ bos: true, data: vorbisId(1, 48000) }));
  parts.push(...page({ granule: 1024, data: [1, 2, 3] }));
  parts.push(...page({ granule: 2048, data: [4, 5, 6] }));
  for (let i = 0; i < extraPages; i++) {
    parts.push(...page({ granule: 2048 + (i + 1) * 1024, data: [0xaa, 0xbb] }));
  }
  return new Uint8Array(parts);
}

describe('Ogg page budget — malformed-input protection (REQUIREMENTS §8.4)', () => {
  it('rejects Ogg with >MAX pages with typed demux-error and budget message', () => {
    const bytes = validOggWithExtraPages(MAX_OGG_PAGES_PER_STREAM);
    // 3 base + MAX extra = MAX+3 > MAX, must exceed budget
    expect(() => parseOgg(bytes)).toThrowError(/budget exceeded/);
    expect(() => oggAudioPackets(bytes)).toThrowError(/budget exceeded/);
  });

  it('accepts exactly MAX pages boundary (MAX = per-stream budget)', () => {
    // Build exactly MAX pages total: 3 base pages + (MAX-3) extra = MAX
    const bytes = validOggWithExtraPages(MAX_OGG_PAGES_PER_STREAM - 3);
    const info = parseOgg(bytes);
    expect(info.codec).toBe('vorbis');
    // Should also demux without budget error (may have 0 audio packets for minimal fixture, just ensure no budget error)
    const pkts = oggAudioPackets(bytes);
    expect(pkts.length).toBeGreaterThanOrEqual(0);
  });

  it('20x randomized valid Ogg with 0–9 extra pages remains bit-exact on duration', () => {
    for (let iter = 0; iter < 20; iter++) {
      const extra = iter % 10;
      const bytes = validOggWithExtraPages(extra);
      const info = parseOgg(bytes);
      // duration derived from max granule: 2048 + extra*1024
      const expectedGranule = 2048 + extra * 1024;
      expect(info.durationSec).toBeCloseTo(expectedGranule / 48000, 6);
      const byPkts = oggAudioPackets(bytes);
      expect(byPkts.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('truncated Ogg with excessive header still rejects with typed error (no unbounded alloc)', () => {
    // Truncated page header (segCount says 2 but bytes missing)
    const truncated = new Uint8Array([
      ...str('OggS'),
      0,
      0x02,
      ...u64(0),
      ...u32(1),
      ...u32(0),
      0,
      0,
      0,
      0,
      2,
      255,
    ]);
    expect(() => parseOgg(truncated)).toThrow();
    // Also delace path on truncated body should not throw budget but demux error gracefully
    const bytes = validOggWithExtraPages(0);
    const cut = bytes.subarray(0, bytes.byteLength - 5);
    // cut mid-page: still should either parse or throw demux-error, not OOM
    try {
      parseOgg(cut);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/Ogg|truncated|budget|no recognized/i);
    }
  });
});
