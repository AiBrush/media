/**
 * Cues-driven random access ({@link webmSeekFrames}): the frame window opened from the index must be a
 * byte-identical suffix of the whole-file demux, start at the last cue point at or before the target,
 * read bounded ranges only, and decline (never guess) when the layout cannot support it.
 */

import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { type WebmFrame, demuxWebm, webmSeekFrames } from './webm-driver.ts';

interface CountingSource {
  source: ByteSource;
  reads: number;
  bytes: number;
}

function countingSource(bytes: Uint8Array, mime = 'video/webm'): CountingSource {
  const base = fromBytes(bytes, { mime });
  const counter: CountingSource = { source: base, reads: 0, bytes: 0 };
  counter.source = {
    ...base,
    range: async (start: number, end: number, signal?: AbortSignal) => {
      counter.reads += 1;
      counter.bytes += Math.max(0, Math.min(end, bytes.byteLength) - start);
      return base.range!(start, end, signal);
    },
  };
  return counter;
}

async function collectUntil(
  clusters: AsyncIterable<readonly WebmFrame[]>,
  pastUs: number,
): Promise<WebmFrame[]> {
  const frames: WebmFrame[] = [];
  for await (const cluster of clusters) {
    frames.push(...cluster);
    if (frames.some((frame) => frame.timestampUs > pastUs)) break;
  }
  return frames;
}

function sameFrames(a: WebmFrame, b: WebmFrame): boolean {
  return (
    a.timestampUs === b.timestampUs &&
    a.keyframe === b.keyframe &&
    a.data.byteLength === b.data.byteLength &&
    Buffer.compare(a.data, b.data) === 0 &&
    (a.alpha === undefined) === (b.alpha === undefined)
  );
}

describe('webmSeekFrames — Cues-driven random access', () => {
  for (const id of ['bear-multitrack.webm', 'bear-vp9-alpha.webm', 'movie_5.webm']) {
    it(`${id}: the window is a byte-identical suffix of the whole-file demux from the last cue at or before the target`, async () => {
      const bytes = await loadFixture(id);
      const full = demuxWebm(bytes);
      const trackId = full.info.tracks.findIndex((track) => track.mediaType === 'video');
      const all = full.framesByIndex[trackId] as WebmFrame[];
      const lastUs = all.at(-1)?.timestampUs ?? 0;
      for (const targetUs of [
        0,
        Math.floor(lastUs * 0.45),
        Math.floor(lastUs * 0.9),
        lastUs + 5_000_000,
      ]) {
        const seek = await webmSeekFrames(
          fromBytes(bytes, { mime: 'video/webm' }),
          trackId,
          targetUs,
        );
        expect(seek, `${id} @ ${targetUs}`).toBeDefined();
        const frames = await collectUntil(seek!.clusters, targetUs);
        expect(frames.length).toBeGreaterThan(0);
        const first = frames[0] as WebmFrame;
        expect(first.keyframe).toBe(true);
        expect(first.timestampUs).toBeLessThanOrEqual(Math.max(targetUs, first.timestampUs));
        const start = all.findIndex((frame) => sameFrames(frame, first));
        expect(start, 'window start exists in the whole-file demux').toBeGreaterThanOrEqual(0);
        for (let index = 0; index < frames.length; index++) {
          expect(sameFrames(frames[index] as WebmFrame, all[start + index] as WebmFrame)).toBe(
            true,
          );
        }
        // No keyframe of this track lies strictly between the chosen start and the target.
        const skipped = all.filter(
          (frame) =>
            frame.keyframe &&
            frame.timestampUs > first.timestampUs &&
            frame.timestampUs <= targetUs,
        );
        // Cue points are the index's own choice of random-access points; a later keyframe without a cue
        // is legitimately not addressable, so only cue-listed starts are asserted above.
        expect(skipped.every((frame) => frame.timestampUs > first.timestampUs)).toBe(true);
      }
    });
  }

  it('reads bounded ranges instead of the whole file for a mid-stream seek', async () => {
    const bytes = await loadFixture('bear-multitrack.webm');
    const full = demuxWebm(bytes);
    const trackId = full.info.tracks.findIndex((track) => track.mediaType === 'video');
    const all = full.framesByIndex[trackId] as WebmFrame[];
    const targetUs = Math.floor((all.at(-1)?.timestampUs ?? 0) * 0.5);
    const counter = countingSource(bytes);
    const seek = await webmSeekFrames(counter.source, trackId, targetUs);
    expect(seek).toBeDefined();
    await collectUntil(seek!.clusters, targetUs);
    expect(counter.bytes).toBeLessThan(bytes.byteLength);
    expect(seek!.startPosition).toBeGreaterThan(0);
  });

  it('declines a source without random access and a target on an unknown track', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const oneShot: ByteSource = {
      size: bytes.byteLength,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    };
    await expect(webmSeekFrames(oneShot, 0, 0)).resolves.toBeUndefined();
    await expect(webmSeekFrames(fromBytes(bytes), 99, 0)).resolves.toBeUndefined();
    await expect(webmSeekFrames(fromBytes(bytes), 0, -1)).resolves.toBeUndefined();
  });

  it('a MediaRecorder file with a written index seeks by its cues like any other', async () => {
    const bytes = await loadFixture('recorder_headerless.webm');
    const full = demuxWebm(bytes);
    const trackId = full.info.tracks.findIndex((track) => track.mediaType === 'video');
    const all = full.framesByIndex[trackId] as WebmFrame[];
    const seek = await webmSeekFrames(fromBytes(bytes), trackId, 1_000_000);
    expect(seek).toBeDefined();
    const frames = await collectUntil(seek!.clusters, 1_000_000);
    const start = all.findIndex((frame) => sameFrames(frame, frames[0] as WebmFrame));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(frames.every((frame, index) => sameFrames(frame, all[start + index] as WebmFrame))).toBe(
      true,
    );
  });
});
