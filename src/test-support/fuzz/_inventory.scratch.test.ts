import { describe, expect, it } from 'vitest';
import { parseAiff } from '../../drivers/aiff/aiff.ts';
import { parseAvi } from '../../drivers/avi/avi-parse.ts';
import { parseCaf } from '../../drivers/caf/caf.ts';
import { parseFlac } from '../../drivers/flac/flac-driver.ts';
import { parseMp3 } from '../../drivers/mp3/mp3-driver.ts';
import { readMovie } from '../../drivers/mp4/mp4-driver.ts';
import { parseMovie } from '../../drivers/mp4/parse.ts';
import { parseTs } from '../../drivers/mpegts/ts-parse.ts';
import { parseOgg } from '../../drivers/ogg/ogg-driver.ts';
import { parseWav } from '../../drivers/wav/wav-driver.ts';
import { parseWebm } from '../../drivers/webm/webm-driver.ts';
import {
  type Family,
  corruptMatrix,
  escapes,
  fuzzFixture,
  hexPreview,
  runMatrix,
} from './corrupt.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

async function report(
  name: string,
  fixtureId: string,
  family: Family,
  parse: (b: Uint8Array) => unknown,
): Promise<void> {
  const seed = await fuzzFixture(fixtureId);
  const cases = corruptMatrix(seed, { family });
  const results = await runMatrix(cases, parse);
  const esc = escapes(results);
  const byClass = new Map<string, { name: string; label: string; bytes: Uint8Array }>();
  for (const r of esc) {
    if (!byClass.has(r.cls)) {
      const c = cases.find((x) => x.label === r.label);
      byClass.set(r.cls, {
        name: r.errorName ?? '?',
        label: r.label,
        bytes: c?.bytes ?? new Uint8Array(),
      });
    }
  }
  // biome-ignore lint/suspicious/noConsoleLog: scratch inventory
  console.log(
    `\n[${name}] cases=${cases.length} escapes=${esc.length} classes=${[...byClass.keys()].join(',') || 'NONE'}`,
  );
  for (const [cls, info] of byClass) {
    // biome-ignore lint/suspicious/noConsoleLog: scratch inventory
    console.log(`   ${cls}: ${info.name} @ ${info.label} | ${hexPreview(info.bytes)}`);
  }
  expect(true).toBe(true);
}

describe('inventory: per-parser escape classes', () => {
  it('mp4 parseMovie', async () => {
    const seed = await fuzzFixture('h264.mp4');
    // parseMovie wants a moov payload; extract it.
    const dv = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
    let off = 0;
    let moov: Uint8Array | undefined;
    while (off + 8 <= seed.byteLength) {
      const size = dv.getUint32(off);
      const type = String.fromCharCode(
        seed[off + 4] ?? 0,
        seed[off + 5] ?? 0,
        seed[off + 6] ?? 0,
        seed[off + 7] ?? 0,
      );
      if (type === 'moov') {
        moov = seed.slice(off + 8, off + size);
        break;
      }
      if (size < 8) break;
      off += size;
    }
    if (!moov) throw new Error('no moov');
    const cases = corruptMatrix(moov, { family: 'isobmff' });
    const results = await runMatrix(cases, (b) => parseMovie('isom', b));
    const esc = escapes(results);
    const classes = [...new Set(esc.map((e) => `${e.cls}:${e.errorName}`))];
    // biome-ignore lint/suspicious/noConsoleLog: scratch inventory
    console.log(
      `\n[mp4 parseMovie] cases=${cases.length} escapes=${esc.length} ->`,
      classes.join(', ') || 'NONE',
    );
    expect(true).toBe(true);
  });

  it('mp4 readMovie (full file path)', async () => {
    const seed = await fuzzFixture('h264.mp4');
    const cases = corruptMatrix(seed, { family: 'isobmff', seedCap: 16384 });
    const results = await runMatrix(cases, (b) => readMovie(ra(b)));
    const esc = escapes(results);
    const classes = [...new Set(esc.map((e) => `${e.cls}:${e.errorName}`))];
    // biome-ignore lint/suspicious/noConsoleLog: scratch inventory
    console.log(
      `\n[mp4 readMovie] cases=${cases.length} escapes=${esc.length} ->`,
      classes.join(', ') || 'NONE',
    );
    expect(true).toBe(true);
  });

  it('all pure parsers', async () => {
    await report('wav', 'speech.wav', 'riff', (b) => parseWav(b, b.byteLength));
    await report('mp3', 'sound_5.mp3', 'framed', (b) => parseMp3(b, b.byteLength));
    await report('ogg', 'sfx-opus.ogg', 'ogg', (b) => parseOgg(b));
    await report('flac', 'sfx.flac', 'framed', (b) => parseFlac(b));
    await report('adts', 'sfx.adts', 'framed', (b) => parseTs(b)); // placeholder family for framed
    await report('aiff', 'aiff-caf/sfx.aiff', 'iff', (b) => parseAiff(b));
    await report('caf', 'aiff-caf/sfx.caf', 'caf', (b) => parseCaf(b));
    await report('avi', 'mjpeg_pcm_160p.avi', 'riff', (b) => parseAvi(b));
    await report('mpegts', 'bear-1280x720.ts', 'ts', (b) => parseTs(b));
    await report('webm', 'movie_5.webm', 'ebml', (b) => parseWebm(b));
  }, 60000);
});
