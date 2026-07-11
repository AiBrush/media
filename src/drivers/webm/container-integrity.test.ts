/**
 * WebM demux must consume a structurally valid Segment, not stop after the last useful Cluster. These
 * rotations destroy the trailing Cues element header in five genuine WebM files. Their earlier Tracks and
 * Blocks remain readable, which proves a parser can only reject by validating the complete EBML walk.
 */

import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { readVint } from './ebml.ts';
import { demuxWebm } from './webm-driver.ts';

const WEBM_ROTATIONS = [
  '2x2-green.webm',
  'movie_5.webm',
  'white.webm',
  'recorder_headerless.webm',
  'bear-vp9-alpha.webm',
] as const;

const SEGMENT_ID = 0x18538067;
const CUES_ID = 0x1c53bb6b;

interface ElementHeader {
  readonly id: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

function elementHeader(dv: DataView, start: number, limit: number): ElementHeader | undefined {
  const id = readVint(dv, start, true);
  if (id === undefined) return undefined;
  const size = readVint(dv, start + id.length, false);
  if (size === undefined) return undefined;
  const dataStart = start + id.length + size.length;
  const declaredEnd = size.value < 0 ? limit : dataStart + size.value;
  if (dataStart > limit || declaredEnd > limit || declaredEnd < dataStart) return undefined;
  return { id: id.value, dataStart, dataEnd: declaredEnd };
}

function findChildStart(
  dv: DataView,
  start: number,
  end: number,
  wantedId: number,
): number | undefined {
  let offset = start;
  while (offset < end) {
    const element = elementHeader(dv, offset, end);
    if (element === undefined) return undefined;
    if (element.id === wantedId) return offset;
    if (element.dataEnd <= offset) return undefined;
    offset = element.dataEnd;
  }
  return undefined;
}

function destroyCuesHeader(source: Uint8Array): Uint8Array {
  const bytes = source.slice();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentStart = findChildStart(dv, 0, bytes.byteLength, SEGMENT_ID);
  if (segmentStart === undefined) throw new Error('real WebM test fixture has no Segment');
  const segment = elementHeader(dv, segmentStart, bytes.byteLength);
  if (segment === undefined) throw new Error('real WebM test fixture has an invalid Segment');
  const cuesStart = findChildStart(dv, segment.dataStart, segment.dataEnd, CUES_ID);
  if (cuesStart === undefined) throw new Error('real WebM test fixture has no Cues element');
  bytes[cuesStart] = 0;
  return bytes;
}

describe('WebM demux container integrity', () => {
  it.each(WEBM_ROTATIONS)('%s rejects a destroyed trailing element header', async (id) => {
    const source = await loadFixture(id);
    const clean = demuxWebm(source);
    expect(clean.framesByIndex.reduce((total, frames) => total + frames.length, 0)).toBeGreaterThan(
      0,
    );

    const error = (() => {
      try {
        return demuxWebm(destroyCuesHeader(source));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({ code: 'demux-error' });
  });
});
