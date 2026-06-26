import { describe, expect, it } from 'vitest';
import { parseAdts } from '../../drivers/adts/adts-driver.ts';
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
  type CorruptCase,
  type Family,
  corruptMatrix,
  escapes,
  fuzzFixture,
  hexPreview,
  runMatrix,
} from './corrupt.ts';

const ra = (b: Uint8Array) => ({
  read: (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(b.subarray(offset, offset + length)),
  size: b.byteLength,
});

interface ParserCase {
  readonly name: string;
  readonly fixtureId: string;
  readonly family: Family;
  readonly parse: (bytes: Uint8Array) => unknown;
  readonly seedCap?: number;
}

const PURE_PARSERS: readonly ParserCase[] = [
  {
    name: 'wav',
    fixtureId: 'speech.wav',
    family: 'riff',
    parse: (bytes) => parseWav(bytes, bytes.byteLength),
  },
  {
    name: 'mp3',
    fixtureId: 'sound_5.mp3',
    family: 'framed',
    parse: (bytes) => parseMp3(bytes, bytes.byteLength),
  },
  { name: 'ogg', fixtureId: 'sfx-opus.ogg', family: 'ogg', parse: (bytes) => parseOgg(bytes) },
  { name: 'flac', fixtureId: 'sfx.flac', family: 'framed', parse: (bytes) => parseFlac(bytes) },
  { name: 'adts', fixtureId: 'sfx.adts', family: 'framed', parse: (bytes) => parseAdts(bytes) },
  {
    name: 'aiff',
    fixtureId: 'aiff-caf/sfx.aiff',
    family: 'iff',
    parse: (bytes) => parseAiff(bytes),
  },
  { name: 'caf', fixtureId: 'aiff-caf/sfx.caf', family: 'caf', parse: (bytes) => parseCaf(bytes) },
  {
    name: 'avi',
    fixtureId: 'mjpeg_pcm_160p.avi',
    family: 'riff',
    parse: (bytes) => parseAvi(bytes),
  },
  { name: 'mpegts', fixtureId: 'bear-1280x720.ts', family: 'ts', parse: (bytes) => parseTs(bytes) },
  { name: 'webm', fixtureId: 'movie_5.webm', family: 'ebml', parse: (bytes) => parseWebm(bytes) },
] as const;

async function moovPayload(fixtureId: string): Promise<Uint8Array> {
  const seed = await fuzzFixture(fixtureId);
  const dv = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  let offset = 0;
  while (offset + 8 <= seed.byteLength) {
    const size = dv.getUint32(offset);
    const type = String.fromCharCode(
      seed[offset + 4] ?? 0,
      seed[offset + 5] ?? 0,
      seed[offset + 6] ?? 0,
      seed[offset + 7] ?? 0,
    );
    if (type === 'moov') return seed.slice(offset + 8, offset + size);
    if (size < 8) break;
    offset += size;
  }
  throw new Error(`fixture ${fixtureId} has no top-level moov box`);
}

async function assertNoEscapes(
  name: string,
  cases: readonly CorruptCase[],
  parse: (bytes: Uint8Array) => unknown,
): Promise<void> {
  const results = await runMatrix(cases, parse);
  expect(formatEscapes(name, cases, escapes(results))).toBe('');
}

function formatEscapes(
  parser: string,
  cases: readonly CorruptCase[],
  failures: ReturnType<typeof escapes>,
): string {
  if (failures.length === 0) return '';
  const firstByClass = new Map<string, (typeof failures)[number]>();
  for (const failure of failures) {
    if (!firstByClass.has(failure.cls)) firstByClass.set(failure.cls, failure);
  }
  const lines = [
    `${parser}: ${failures.length} corrupt-input cases leaked a non-typed failure`,
    ...[...firstByClass.values()].map((failure) => {
      const corrupt = cases.find((candidate) => candidate.label === failure.label);
      return `  ${failure.cls}: ${failure.errorName ?? failure.outcome} @ ${failure.label} | ${hexPreview(corrupt?.bytes ?? new Uint8Array())}`;
    }),
  ];
  return lines.join('\n');
}

describe('parser fuzz robustness', () => {
  it('keeps MP4 moov-table corruption on typed MediaError paths', async () => {
    const moov = await moovPayload('h264.mp4');
    await assertNoEscapes('mp4 parseMovie', corruptMatrix(moov, { family: 'isobmff' }), (bytes) =>
      parseMovie('isom', bytes),
    );
  });

  it('keeps full-file MP4 corruption on typed MediaError paths', async () => {
    const seed = await fuzzFixture('h264.mp4');
    const cases = corruptMatrix(seed, { family: 'isobmff', seedCap: 16_384 });
    await assertNoEscapes('mp4 readMovie', cases, (bytes) => readMovie(ra(bytes)));
  });

  it('keeps pure container parsers on typed MediaError paths', async () => {
    for (const spec of PURE_PARSERS) {
      const seed = await fuzzFixture(spec.fixtureId);
      const cases = corruptMatrix(seed, {
        family: spec.family,
        ...(spec.seedCap !== undefined ? { seedCap: spec.seedCap } : {}),
      });
      await assertNoEscapes(spec.name, cases, spec.parse);
    }
  }, 60_000);
});
