import type { TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';

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
  if (!Number.isSafeInteger(mediaTimeTicks))
    throw new MediaError(
      'demux-error',
      `mediaTimeTicks must be safe integer, got ${mediaTimeTicks}`,
    );
  if (!Number.isFinite(editDurationSec) || editDurationSec < 0)
    throw new MediaError(
      'demux-error',
      `editDurationSec must be finite >=0, got ${editDurationSec}`,
    );
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
    throw new MediaError('demux-error', `sampleRate must be safe positive int, got ${sampleRate}`);
  if (!Number.isSafeInteger(timescale) || timescale <= 0)
    throw new MediaError('demux-error', `timescale must be safe positive int, got ${timescale}`);
  if (!Number.isSafeInteger(codedSamples) || codedSamples < 0)
    throw new MediaError(
      'demux-error',
      `codedSamples must be safe non-negative int, got ${codedSamples}`,
    );
  const boundedCodedSamples = Math.max(0, codedSamples);
  const leadingRaw =
    mediaTimeTicks >= 0
      ? Number(
          (BigInt(mediaTimeTicks) * BigInt(sampleRate) + BigInt(timescale) / 2n) /
            BigInt(timescale),
        )
      : Number(
          (BigInt(mediaTimeTicks) * BigInt(sampleRate) - BigInt(timescale) / 2n) /
            BigInt(timescale),
        );
  const leadingSamples = Math.max(0, leadingRaw);
  // Use BigInt half-up to avoid float drift for large editDurationSec (e.g., 10 GiB → 600s at 48k).
  const declaredTotalSamples = Math.max(
    0,
    Number(
      (BigInt(Math.round(editDurationSec * 1_000_000)) * BigInt(sampleRate) + 500_000n) /
        1_000_000n,
    ),
  );
  const maximumProgramSamples = Math.max(0, boundedCodedSamples - leadingSamples);
  const totalSamples = Math.min(declaredTotalSamples, maximumProgramSamples);
  const trailingSamples = Math.max(0, boundedCodedSamples - leadingSamples - totalSamples);
  if (
    leadingSamples > Number.MAX_SAFE_INTEGER ||
    totalSamples > Number.MAX_SAFE_INTEGER ||
    trailingSamples > Number.MAX_SAFE_INTEGER
  ) {
    throw new MediaError('demux-error', 'gapless sample count exceeds MAX_SAFE_INTEGER');
  }
  return { basis: 'mp4-edit-list', leadingSamples, trailingSamples, totalSamples };
}
