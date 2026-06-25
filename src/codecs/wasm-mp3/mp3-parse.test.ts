/**
 * MP3 frame-walk — the reachable error/edge branches the real-decode oracle (mp3.test.ts) doesn't drive:
 * a buffer with no MPEG-audio syncword must REJECT with a typed error (never fabricate a frame). These are
 * deliberately-invalid byte sequences exercising the typed-error path, not synthetic *media*.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '../../contracts/errors.ts';
import { iterateMp3Frames } from './mp3.ts';

describe('mp3 frame walk — typed-error branch', () => {
  it('throws InputError when the buffer carries no MPEG-audio frame', () => {
    // all-zero bytes have no syncword ⇒ firstFrameOffset's scan exhausts ⇒ typed reject (never a fake frame).
    expect(() => [...iterateMp3Frames(new Uint8Array(256))]).toThrow(InputError);
  });

  it('throws InputError on bytes whose only 0xFF runs are not valid frame syncs', () => {
    // 0xFF bytes trip the sync scan but fail full header validation ⇒ still no real frame ⇒ reject.
    expect(() => [...iterateMp3Frames(new Uint8Array(256).fill(0xff))]).toThrow(InputError);
  });
});
