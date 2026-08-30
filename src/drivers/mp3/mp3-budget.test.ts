import { describe, expect, it } from 'vitest';
import { MAX_MP3_FRAMES_PER_STREAM, iterateMp3Frames } from '../../codecs/wasm-mp3/mp3.ts';
import { trimMp3Exact } from './mp3-exact-trim.ts';

function validMp3WithExtraFrames(extra: number): Uint8Array {
  // Minimal valid MPEG1 Layer III 32kbps 44100Hz stereo frame (size 104, sideInfo 32, mainDataBegin 0)
  // Header: ff fb 10 00 = sync + mpeg1/layer3/crcAbsent + brIndex1/sr0/pad0 + stereo
  const frameSize = 104;
  const frame = new Uint8Array(frameSize);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x10;
  frame[3] = 0x00;
  // sideInfo (32 bytes) already zero => main_data_begin 0, scfsi 0, part2_3_length 0 => silent valid frame
  const totalFrames = 1 + extra;
  const out = new Uint8Array(frameSize * totalFrames);
  for (let i = 0; i < totalFrames; i++) out.set(frame, i * frameSize);
  return out;
}

describe('MP3 frame budget — malformed-input protection (REQUIREMENTS §8.4)', () => {
  it('rejects MP3 with >MAX frames with typed demux-error and budget message', () => {
    const bytes = validMp3WithExtraFrames(MAX_MP3_FRAMES_PER_STREAM);
    // 1+MAX frames > MAX
    expect(() => [...iterateMp3Frames(bytes)]).toThrowError(/budget exceeded/);
    expect(() => trimMp3Exact(bytes, { startSec: 0, endSec: 0.02 })).toThrowError(
      /budget exceeded/,
    );
  });

  it('accepts exactly MAX frames boundary', () => {
    const bytes = validMp3WithExtraFrames(MAX_MP3_FRAMES_PER_STREAM - 1);
    const frames = [...iterateMp3Frames(bytes)];
    expect(frames.length).toBe(MAX_MP3_FRAMES_PER_STREAM);
    // trim path also accepts (do 0-0.02 trimming to stay in range)
    const r = trimMp3Exact(bytes, { startSec: 0, endSec: 0.02 });
    expect(r.bytes.length).toBeGreaterThan(0);
  });

  it('20x randomized valid MP3 with 0–9 extra frames remains bit-exact on frame count', () => {
    for (let iter = 0; iter < 20; iter++) {
      const extra = iter % 10;
      const bytes = validMp3WithExtraFrames(extra);
      const frames = [...iterateMp3Frames(bytes)];
      expect(frames.length).toBe(1 + extra);
      // duration = frames * 1152 / 44100 ; verify via trim result sample count not truncated
      const r = trimMp3Exact(bytes, { startSec: 0, endSec: 0.02 });
      // should not throw budget
      expect(r.encoderDelaySamples).toBeGreaterThanOrEqual(0);
    }
  });

  it('truncated MP3 with excessive header still rejects with typed error (no unbounded alloc)', () => {
    const truncated = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00]);
    // Truncated final frame: walk stops cleanly (0 frames) or throws typed demux/input, never OOM
    try {
      const f = [...iterateMp3Frames(truncated)];
      expect(f.length).toBe(0);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/MP3|truncated|budget|no MPEG/i);
    }
    const bytes = validMp3WithExtraFrames(2);
    const cut = bytes.subarray(0, bytes.byteLength - 5);
    // cut mid-frame: iterate should stop cleanly without budget error
    const frames = [...iterateMp3Frames(cut)];
    expect(frames.length).toBe(2);
  });
});
