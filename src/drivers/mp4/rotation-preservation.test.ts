/**
 * Rotation/display-transform preservation at the container boundary.
 *
 * The source is Chromium's genuine QuickTime/H.264/AAC rotation fixture. Its `tkhd` carries more than
 * a scalar angle: a translated 3x3 fixed-point matrix plus raw 16.16 display width/height. Stream-copy
 * must retain all 44 bytes, in progressive MOV and fragmented MP4, while packet bytes/timing remain
 * untouched. The raw extraction below is intentionally independent of the parser/writer under test.
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { fragmentMp4 } from './fragment.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { toMuxTrack, trackStateFrom } from './mux.ts';
import { buildSamples } from './samples.ts';
import { writeMp4 } from './write.ts';

function randomAccess(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    read: (offset: number, length: number) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

function concat(parts: Iterable<Uint8Array>): Uint8Array {
  const chunks = [...parts];
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function asciiAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/** First non-identity tkhd's 9 matrix words + raw width/height (44 bytes). */
function rotatedTkhdTransform(bytes: Uint8Array): Uint8Array {
  const identity = new Uint8Array([
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    64, 0, 0, 0,
  ]);
  for (let typeOffset = 4; typeOffset + 48 <= bytes.byteLength; typeOffset++) {
    if (asciiAt(bytes, typeOffset) !== 'tkhd') continue;
    const version = bytes[typeOffset + 4];
    if (version !== 0 && version !== 1) continue;
    const matrixOffset = typeOffset + (version === 1 ? 56 : 44);
    if (matrixOffset + 44 > bytes.byteLength) continue;
    const matrix = bytes.subarray(matrixOffset, matrixOffset + 36);
    if (!matrix.every((value, index) => value === identity[index])) {
      return bytes.slice(matrixOffset, matrixOffset + 44);
    }
  }
  throw new Error('no rotated tkhd transform found');
}

function packetFacts(
  tracks: Awaited<ReturnType<typeof muxTracksFromMovie>>,
): ReadonlyArray<
  ReadonlyArray<{ duration: number; ctts: number; key: boolean; data: Uint8Array }>
> {
  return tracks.map((track) =>
    track.samples.map((sample) => ({
      duration: sample.durationTicks,
      ctts: sample.cttsTicks,
      key: sample.keyframe,
      data: sample.data,
    })),
  );
}

describe('MP4/MOV tkhd display transform preservation', () => {
  it('keeps the raw translated matrix/display size and every packet through progressive + fragmented paths', async () => {
    const source = await loadFixture('bear-rotate-90.mp4');
    const sourceMovie = await readMovie(randomAccess(source));
    const sourceTracks = await muxTracksFromMovie(randomAccess(source), sourceMovie);
    const expectedTransform = rotatedTkhdTransform(source);
    const expectedPackets = packetFacts(sourceTracks);

    const progressive = writeMp4(sourceTracks, { brand: 'mov' });
    expect(rotatedTkhdTransform(progressive)).toEqual(expectedTransform);
    const progressiveMovie = await readMovie(randomAccess(progressive));
    expect(
      packetFacts(await muxTracksFromMovie(randomAccess(progressive), progressiveMovie)),
    ).toEqual(expectedPackets);

    const fragmented = concat(fragmentMp4(sourceTracks));
    expect(rotatedTkhdTransform(fragmented)).toEqual(expectedTransform);
    const fragmentedMovie = await readMovie(randomAccess(fragmented));
    expect(
      packetFacts(await muxTracksFromMovie(randomAccess(fragmented), fragmentedMovie)),
    ).toEqual(expectedPackets);
  });

  it('gives the opaque source matrix precedence over a conflicting scalar', async () => {
    const source = await loadFixture('bear-rotate-90.mp4');
    const movie = await readMovie(randomAccess(source));
    const tracks = await muxTracksFromMovie(randomAccess(source), movie);
    const expectedTransform = rotatedTkhdTransform(source);
    const conflicting = tracks.map((track) =>
      track.mediaType === 'video' ? { ...track, rotation: 270 } : track,
    );

    const output = writeMp4(conflicting, { brand: 'mov' });
    expect(rotatedTkhdTransform(output)).toEqual(expectedTransform);
    const parsed = await readMovie(randomAccess(output));
    expect(parsed.tracks.find((track) => track.mediaType === 'video')?.rotation).toBe(90);
  });

  it('carries scalar rotation through TrackInfo -> generic MP4 mux state -> tkhd', async () => {
    const source = await loadFixture('h264.mp4');
    const movie = await readMovie(randomAccess(source));
    const video = movie.tracks.find((track) => track.mediaType === 'video');
    expect(video).toBeDefined();
    if (video === undefined) return;
    const sample = buildSamples(video)[0];
    expect(sample).toBeDefined();
    if (sample === undefined) return;

    const state = trackStateFrom({
      id: video.id,
      mediaType: 'video',
      codec: video.codec,
      rotation: 270,
      ...(video.fps !== undefined ? { fps: video.fps } : {}),
      durationSec: video.durationSec,
      config: video.config,
    });
    state.chunks.push({
      timestampUs: sample.ptsUs,
      durationUs: sample.durationUs,
      dtsUs: sample.dtsUs,
      key: sample.keyframe,
      data: source.slice(sample.offset, sample.offset + sample.size),
    });
    const muxTrack = toMuxTrack(state);
    for (const output of [writeMp4([muxTrack]), concat(fragmentMp4([muxTrack]))]) {
      const parsed = await readMovie(randomAccess(output));
      const parsedVideo = parsed.tracks.find((track) => track.mediaType === 'video');
      expect(parsedVideo?.rotation).toBe(270);
      expect(parsedVideo?.width).toBe(video.width);
      expect(parsedVideo?.height).toBe(video.height);
      expect(parsedVideo?.displayTransform?.matrix[6]).toBe(0);
      expect(parsedVideo?.displayTransform?.matrix[7]).toBe(Math.round((video.width ?? 0) * 65536));
    }
  });
});
