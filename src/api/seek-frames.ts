/**
 * Landing rules for {@link MediaEngine.seek} beyond the default "first frame at or after the target":
 * the nearest frame, and the random-access frame a GOP stream starts on. Pure stream helpers; the
 * seek runner picks one per {@link SeekMode}.
 */

import { InputError } from '../contracts/errors.ts';
import { closeFrame } from '../kernel/frames.ts';

/**
 * Read the first item of a stream without losing it: returns that item plus a stream that re-emits
 * it before the rest. A `'keyframe'` seek uses this to learn which random-access frame the GOP stream
 * starts on, which is the frame it must land on.
 */
export async function peekSeekHead<T>(
  stream: ReadableStream<T>,
): Promise<{ readonly first: T | undefined; readonly stream: ReadableStream<T> }> {
  const reader = stream.getReader();
  const { done, value } = await reader.read();
  if (done) {
    reader.releaseLock();
    return { first: undefined, stream };
  }
  const rest = new ReadableStream<T>({
    start(controller): void {
      controller.enqueue(value);
    },
    async pull(controller): Promise<void> {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
  return { first: value, stream: rest };
}

/**
 * Resolve with the decoded frame whose timestamp is closest to `targetUs` (the earlier one on a tie).
 * Every other frame is `close()`d exactly once and the reader is cancelled once the answer is known;
 * a stream with no frames rejects with a typed {@link InputError}.
 */
export async function seekNearestFrame(
  frames: ReadableStream<VideoFrame>,
  targetUs: number,
): Promise<VideoFrame> {
  const reader = frames.getReader();
  let before: VideoFrame | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.timestamp >= targetUs) {
        const keepAfter =
          before === undefined || value.timestamp - targetUs < targetUs - before.timestamp;
        const chosen = keepAfter ? value : (before as VideoFrame);
        const dropped = keepAfter ? before : value;
        if (dropped !== undefined) closeFrame(dropped);
        before = undefined;
        await reader.cancel();
        return chosen;
      }
      if (before !== undefined) closeFrame(before);
      before = value;
    }
  } catch (error) {
    if (before !== undefined) closeFrame(before);
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  if (before !== undefined) return before;
  throw new InputError('no seek frame');
}
