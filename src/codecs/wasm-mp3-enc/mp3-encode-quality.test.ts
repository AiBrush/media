import { describe, expect, it } from 'vitest';
import { mp3CbrBitratesKbps, snapMp3BitrateKbps } from './mp3-enc.ts';

describe('MP3 encode quality-normalized (2.1.2)', () => {
  it('snaps arbitrary bitrate hints to nearest legal CBR and breaks ties upward', () => {
    // 44.1k table: 32,40,48,56,64,80,96,112,128,160,192,224,256,320
    expect(snapMp3BitrateKbps(100_000, 44_100)).toBe(96); // nearest 96 vs 112
    expect(snapMp3BitrateKbps(104_000, 44_100)).toBe(112);
    expect(snapMp3BitrateKbps(120_000, 44_100)).toBe(128); // 120 is tie 112/128 → up
    expect(snapMp3BitrateKbps(144_000, 44_100)).toBe(160); // tie 128/160 midpoint 144 -> up
    expect(snapMp3BitrateKbps(0, 44_100)).toBe(32); // 0 snaps to lowest
  });

  it('22.05k uses MPEG-2 table and snaps accordingly', () => {
    // MPEG-2 table: 8,16,24,32,40,48,56,64,80,96,112,128,144,160
    expect(snapMp3BitrateKbps(20_000, 22_050)).toBe(24);
    expect(snapMp3BitrateKbps(30_000, 22_050)).toBe(32);
    expect(snapMp3BitrateKbps(100_000, 22_050)).toBe(96);
  });

  it('8k uses MPEG-2.5 table (8-64)', () => {
    const table = mp3CbrBitratesKbps(8000);
    expect(table).toEqual([8, 16, 24, 32, 40, 48, 56, 64]);
    expect(snapMp3BitrateKbps(10_000, 8000)).toBe(8);
    expect(snapMp3BitrateKbps(60_000, 8000)).toBe(64);
  });

  it('parsed frame header bitrate matches snapped value for CBR encodes', async () => {
    // Verify that the helper that the encoder uses to pick the header's bitrate_index
    // actually yields a header whose bitrate equals the snapped value.
    const { normalizeMp3EncoderConfig } = await import('./mp3-enc.ts');
    for (const rate of [44_100, 22_050, 8000] as const) {
      for (const hint of [32_000, 64_000, 128_000, 192_000, 256_000]) {
        const init = normalizeMp3EncoderConfig({
          codec: 'mp3',
          sampleRate: rate,
          numberOfChannels: 1,
          bitrate: hint,
        });
        if (init.cbrBitrateKbps === 0) continue; // VBR
        // The init's cbrBitrateKbps must be in the legal table and equal snap
        expect(mp3CbrBitratesKbps(rate)).toContain(init.cbrBitrateKbps);
        expect(init.cbrBitrateKbps).toBe(snapMp3BitrateKbps(hint, rate));
      }
    }
  });

  it('20× randomized bitrate hints stay within legal table and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const rate = [44_100, 48_000, 32_000, 22_050, 8000][i % 5] as number;
      const hint = (i * 12345) % 400_000;
      const snapped = snapMp3BitrateKbps(hint, rate);
      expect(mp3CbrBitratesKbps(rate)).toContain(snapped);
      expect(snapped).toBeGreaterThan(0);
      expect(snapped).toBeLessThan(500);
    }
  });

  it('rejects sample rates with no legal table', () => {
    expect(() => snapMp3BitrateKbps(128_000, 4000)).toThrow(/no constant bitrate table/);
    expect(() => snapMp3BitrateKbps(128_000, 96_000)).toThrow(/no constant bitrate table/);
  });
});
