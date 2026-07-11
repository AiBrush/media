/**
 * MP4 demux must validate every top-level box header and the container that owns each declared sample
 * before exposing tracks. Rotations cover every ordinary top-level role (`ftyp`/`free`/`moov`/`mdat`) on
 * five genuine files. A zero type is a destroyed FourCC, while arbitrary nonzero unknown FourCCs remain
 * forward-compatible; a top-level size zero remains legal when the resulting final-box layout is valid.
 */

import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver } from './mp4-driver.ts';

const MP4_ROTATIONS = [
  '2x2-green.mp4',
  'movie_5.mp4',
  'h264.mp4',
  'test.mp4',
  'obs-remux-variable-aac.mp4',
] as const;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function topLevelBoxSize(dv: DataView, offset: number): number {
  const size32 = dv.getUint32(offset);
  if (size32 === 0) return dv.byteLength - offset;
  if (size32 === 1) {
    if (offset + 16 > dv.byteLength) throw new Error('truncated largesize test fixture');
    const size64 = dv.getBigUint64(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oversize test fixture');
    return Number(size64);
  }
  return size32;
}

interface TopLevelBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

function topLevelBoxes(bytes: Uint8Array): TopLevelBox[] {
  const out: TopLevelBox[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = topLevelBoxSize(dv, offset);
    if (size < 8 || offset + size > bytes.byteLength) break;
    out.push({ type: fourcc(bytes, offset + 4), start: offset, end: offset + size });
    offset += size;
  }
  return out;
}

function topLevelBox(source: Uint8Array, type: string): TopLevelBox {
  const found = topLevelBoxes(source).find((box) => box.type === type);
  if (found === undefined) throw new Error(`real MP4 test fixture has no top-level ${type}`);
  return found;
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

type InvalidHeaderMutation =
  | 'zero-type'
  | 'zero-header'
  | 'size-one'
  | 'size-seven'
  | 'size-huge'
  | 'truncate';

function mutateInvalidHeader(
  source: Uint8Array,
  type: string,
  mutation: InvalidHeaderMutation,
): Uint8Array {
  const box = topLevelBox(source, type);
  if (mutation === 'truncate') return source.slice(0, box.start + 7);
  const bytes = source.slice();
  switch (mutation) {
    case 'zero-type':
      bytes.fill(0, box.start + 4, box.start + 8);
      break;
    case 'zero-header':
      bytes.fill(0, box.start, box.start + 8);
      break;
    case 'size-one':
      setU32(bytes, box.start, 1);
      break;
    case 'size-seven':
      setU32(bytes, box.start, 7);
      break;
    case 'size-huge':
      setU32(bytes, box.start, 0xffff_ffff);
      break;
  }
  return bytes;
}

function replaceType(source: Uint8Array, type: string, replacement: string): Uint8Array {
  const box = topLevelBox(source, type);
  const bytes = source.slice();
  bytes.set(
    [...replacement].map((char) => char.charCodeAt(0)),
    box.start + 4,
  );
  return bytes;
}

function zeroFinalBoxSize(source: Uint8Array): Uint8Array {
  const boxes = topLevelBoxes(source);
  const last = boxes.at(-1);
  if (last === undefined || last.end !== source.byteLength) {
    throw new Error('real MP4 fixture has no complete final box');
  }
  const bytes = source.slice();
  setU32(bytes, last.start, 0);
  return bytes;
}

async function expectDemuxReject(bytes: Uint8Array): Promise<void> {
  const error = await Mp4Driver.demux(fromBytes(bytes, { mime: 'video/mp4' })).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MediaError);
  expect(error).toMatchObject({ code: 'demux-error' });
}

describe('MP4 demux container integrity', () => {
  const TOP_LEVEL_TYPES = ['ftyp', 'free', 'moov', 'mdat'] as const;
  const INVALID_HEADER_MUTATIONS = [
    'zero-type',
    'zero-header',
    'size-one',
    'size-seven',
    'size-huge',
    'truncate',
  ] as const;

  for (const type of TOP_LEVEL_TYPES) {
    for (const mutation of INVALID_HEADER_MUTATIONS) {
      it.each(MP4_ROTATIONS)(
        `%s rejects ${mutation} on the top-level ${type} header`,
        async (id) => {
          const source = await loadFixture(id);
          await expectDemuxReject(mutateInvalidHeader(source, type, mutation));
        },
      );
    }
  }

  it.each(MP4_ROTATIONS)(
    '%s keeps nonzero unknown boxes and optional ftyp compatible',
    async (id) => {
      const source = await loadFixture(id);
      for (const type of ['ftyp', 'free'] as const) {
        const demuxer = await Mp4Driver.demux(
          fromBytes(replaceType(source, type, 'Xx42'), { mime: 'video/mp4' }),
        );
        expect(demuxer.tracks.length).toBeGreaterThan(0);
        await demuxer.close();
      }
    },
  );

  it.each(MP4_ROTATIONS)('%s accepts a legal size-zero final top-level box', async (id) => {
    const demuxer = await Mp4Driver.demux(
      fromBytes(zeroFinalBoxSize(await loadFixture(id)), { mime: 'video/mp4' }),
    );
    expect(demuxer.tracks.length).toBeGreaterThan(0);
    await demuxer.close();
  });

  it.each(MP4_ROTATIONS)('%s clean control remains demuxable', async (id) => {
    const source = await loadFixture(id);
    const clean = await Mp4Driver.demux(fromBytes(source, { mime: 'video/mp4' }));
    expect(clean.tracks.length).toBeGreaterThan(0);
    await clean.close();
  });

  it('uses a source size learned by the first range response for complete validation', async () => {
    const bytes = await loadFixture('h264.mp4');
    let learnedSize: number | undefined;
    const source: Source = {
      __media: 'source',
      kind: 'url',
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      range: (start, end) => {
        learnedSize = bytes.byteLength;
        Object.defineProperty(source, 'size', {
          value: learnedSize,
          enumerable: true,
          configurable: true,
        });
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const demuxer = await Mp4Driver.demux(source);
    expect(learnedSize).toBe(bytes.byteLength);
    expect(demuxer.tracks.length).toBeGreaterThan(0);
    await demuxer.close();
  });
});
