import type { TrackInfo } from '../../contracts/driver.ts';

/**
 * Convert one supported AAC MP4 edit into the public decoded-sample window. The edit duration is a
 * presentation declaration, but malformed/legacy writers can declare more program samples than the
 * coded timeline can possibly decode. Clamp only that impossible upper bound; shorter edits remain exact
 * and independently trim trailing encoder padding.
 */
export function gaplessFromMp4Edit(
  mediaTimeTicks: number,
  editDurationSec: number,
  sampleRate: number,
  timescale: number,
  codedSamples: number,
): NonNullable<TrackInfo['gapless']> {
  const scale = sampleRate / timescale;
  const boundedCodedSamples = Math.max(0, codedSamples);
  const leadingSamples = Math.max(0, Math.round(mediaTimeTicks * scale));
  const declaredTotalSamples = Math.max(0, Math.round(editDurationSec * sampleRate));
  const maximumProgramSamples = Math.max(0, boundedCodedSamples - leadingSamples);
  const totalSamples = Math.min(declaredTotalSamples, maximumProgramSamples);
  const trailingSamples = Math.max(0, boundedCodedSamples - leadingSamples - totalSamples);
  return { basis: 'mp4-edit-list', leadingSamples, trailingSamples, totalSamples };
}
