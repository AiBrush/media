/** Matroska rotation is `ProjectionPoseRoll`: CCW-positive, min DocTypeVersion 4 (RFC 9559 section 15.2). */

import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../../contracts/driver.ts';
import { type ChunkStruct, WebmMuxer } from './ebml-write.ts';
import { elements, findChild, readFloat, readUint } from './ebml.ts';
import { parseWebm } from './webm-driver.ts';

const ID = {
  EBML: 0x1a45dfa3,
  DocTypeVersion: 0x4287,
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  Projection: 0x7670,
  ProjectionPoseRoll: 0x7675,
} as const;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function mux(rotation: number | undefined, fragmented = false): Promise<Uint8Array> {
  const muxer = new WebmMuxer({ fragmented }, 'matroska');
  const track: TrackInfo = {
    id: 1,
    mediaType: 'video',
    codec: 'vp8',
    ...(rotation !== undefined ? { rotation } : {}),
    fps: 25,
    durationSec: 0.04,
    config: { codec: 'vp8', codedWidth: 4, codedHeight: 2 },
  };
  const trackId = muxer.addTrack(track);
  const chunk: ChunkStruct = {
    timestampUs: 0,
    durationUs: 40_000,
    key: true,
    data: new Uint8Array([0x9d, 0x01, 0x2a]),
  };
  muxer.addChunkStruct(trackId, chunk);
  const output = collect(muxer.output);
  await muxer.finalize();
  return output;
}

function headerVersion(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = findChild(dv, 0, dv.byteLength, ID.EBML);
  if (header === undefined) throw new Error('missing EBML header');
  for (const child of elements(dv, header.dataStart, header.dataEnd)) {
    if (child.id === ID.DocTypeVersion) return readUint(dv, child);
  }
  throw new Error('missing DocTypeVersion');
}

function projectionRoll(bytes: Uint8Array): number | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (segment === undefined) return undefined;
  const tracks = findChild(dv, segment.dataStart, segment.dataEnd, ID.Tracks);
  if (tracks === undefined) return undefined;
  const entry = findChild(dv, tracks.dataStart, tracks.dataEnd, ID.TrackEntry);
  if (entry === undefined) return undefined;
  const video = findChild(dv, entry.dataStart, entry.dataEnd, ID.Video);
  if (video === undefined) return undefined;
  const projection = findChild(dv, video.dataStart, video.dataEnd, ID.Projection);
  if (projection === undefined) return undefined;
  const roll = findChild(dv, projection.dataStart, projection.dataEnd, ID.ProjectionPoseRoll);
  return roll === undefined ? undefined : readFloat(dv, roll);
}

describe('Matroska ProjectionPoseRoll', () => {
  it.each([
    { clockwise: 90, counterClockwise: -90 },
    { clockwise: 180, counterClockwise: -180 },
    { clockwise: 270, counterClockwise: 90 },
  ])('writes $clockwise° CW as $counterClockwise° CCW and parses it back', async (row) => {
    const bytes = await mux(row.clockwise);
    expect(headerVersion(bytes)).toBe(4);
    expect(projectionRoll(bytes)).toBe(row.counterClockwise);
    const video = parseWebm(bytes).tracks.find((track) => track.mediaType === 'video');
    expect(video?.rotation).toBe(row.clockwise);
    expect(video?.width).toBe(4);
    expect(video?.height).toBe(2);
  });

  it('keeps identity at DocTypeVersion 2 with no Projection element', async () => {
    const bytes = await mux(0);
    expect(headerVersion(bytes)).toBe(2);
    expect(projectionRoll(bytes)).toBeUndefined();
    expect(parseWebm(bytes).tracks[0]?.rotation ?? 0).toBe(0);
  });

  it('carries the same v4 projection in a fragmented/live init segment', async () => {
    const bytes = await mux(90, true);
    expect(headerVersion(bytes)).toBe(4);
    expect(projectionRoll(bytes)).toBe(-90);
    expect(parseWebm(bytes, { scanClusters: true }).tracks[0]?.rotation).toBe(90);
  });
});
