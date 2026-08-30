/**
 * Exact MP3 → MP3 copy-trim oracle (REQUIREMENTS §5.7). Two independent decode references, both real:
 *
 *  1. **The vendored Symphonia-in-wasm core** (`src/codecs/wasm-mp3`), driven frame by frame in Node, with
 *     the Xing/LAME gapless fields applied here rather than by the decoder. That makes the assertion
 *     falsifiable at the level this module actually writes: if the authored `delay`/`padding` were off by
 *     one sample, or the bit-reservoir carrier frame did not restore the decoder state, the decoded PCM
 *     would differ from the same window of the source decode.
 *  2. **ffmpeg** (when installed) — an implementation that applies Xing/LAME itself, so it also proves the
 *     authored tag is what a third-party decoder reads, not just what this repo's arithmetic assumes.
 *
 * The corpus spans MPEG-1 stereo VBR-with-Xing (`bear-vbr-toc.mp3`), MPEG-1 stereo CBR with NO VBR tag
 * (`mp3_cbr_notoc.mp3` — the case whose coded origin sits 529 samples before presentation zero),
 * MPEG-1 stereo with a Xing/LAME tag (`mp3_xing.mp3`), and MPEG-2 mono at 22050 Hz (`sound_5.mp3`).
 * MPEG-2.5 and further rate/channel geometries are encoded on the fly where ffmpeg is available.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { iterateMp3Frames, parseVbrHeader } from '../../codecs/wasm-mp3/mp3.ts';
import type { TrimAlignment } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp3Module, enumerateMp3Packets, parseMp3 } from './mp3-driver.ts';
import {
  MP3_LAME_GAPLESS_FIELD_MAX,
  type Mp3ExactTrimResult,
  mp3TrimAlignment,
  trimMp3Exact,
  trimMp3ExactWithHistoryPatch,
} from './mp3-exact-trim.ts';
import { MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES } from './mp3-gapless.ts';

const WASM_PATH = new URL('../../codecs/wasm-mp3/mp3_wasm_bg.wasm', import.meta.url).pathname;
const MEDIA_TEST_MEDIA = new URL('../../../../media-test/fixtures/media/', import.meta.url);

interface Mp3WasmClass {
  new (
    channels: number,
    sampleRate: number,
  ): {
    decode(frame: Uint8Array): Float32Array;
    reset(): void;
    free(): void;
  };
}

let corePromise: Promise<Mp3WasmClass> | undefined;
/** Instantiate the vendored Symphonia-MP3 wasm core from bytes (runs in Node, no fetch). */
async function loadCore(): Promise<Mp3WasmClass> {
  corePromise ??= (async (): Promise<Mp3WasmClass> => {
    const mod = await import('../../codecs/wasm-mp3/mp3-core.js');
    const module = await WebAssembly.compile(await readFile(WASM_PATH));
    await mod.default({ module_or_path: module });
    return mod.Mp3Wasm as unknown as Mp3WasmClass;
  })();
  return corePromise;
}

interface DecodedProgram {
  readonly pcm: Float32Array;
  readonly channels: number;
  readonly sampleRate: number;
  readonly sampleFrames: number;
  /** Program length the Xing/LAME tag declares, before clipping to what the frames can deliver. */
  readonly declaredSampleFrames: number;
}

/**
 * Decode an MP3 buffer's gapless PRESENTATION program: every program frame through the wasm core, then
 * the Xing/LAME window applied by hand — drop `encoderDelay + 528 + 1` leading decoder samples and keep
 * `codedSamples − encoderDelay − encoderPadding`. A Layer III decoder emits one frame of PCM per frame it
 * consumes, so a tail that would need a further frame is simply unavailable and the window is clipped.
 */
async function decodeProgram(bytes: Uint8Array): Promise<DecodedProgram> {
  const Mp3Wasm = await loadCore();
  const walked = [...iterateMp3Frames(bytes)];
  const head = walked[0];
  if (head === undefined) throw new Error('no MP3 frames to decode');
  const vbr = parseVbrHeader(head.data, head.header);
  const audio = vbr === undefined ? walked : walked.slice(1);
  const first = audio[0];
  if (first === undefined) throw new Error('no MP3 audio frames to decode');
  const { channels, sampleRate, samplesPerFrame } = first.header;
  const declared = vbr?.frameCount;
  const programFrames =
    declared !== undefined && declared > 0 && declared <= audio.length ? declared : audio.length;

  const decoder = new Mp3Wasm(channels, sampleRate);
  const raw = new Float32Array(programFrames * samplesPerFrame * channels);
  let filled = 0;
  try {
    for (const { data } of audio.slice(0, programFrames)) {
      const pcm = decoder.decode(data);
      // An un-decodable frame (reservoir not yet satisfied) still occupies its slot on the sample clock.
      filled += pcm.length === 0 ? samplesPerFrame * channels : pcm.length;
      if (pcm.length > 0) raw.set(pcm, filled - pcm.length);
    }
  } finally {
    decoder.free();
  }

  const delay = vbr?.encoderDelay ?? 0;
  const padding = vbr?.encoderPadding ?? 0;
  // Only a stream that signals an encoder delay declares a presentation origin; an untagged stream
  // presents its raw decoder output, latency and all (the same rule ffmpeg applies).
  const skip = vbr?.encoderDelay === undefined ? 0 : delay + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES;
  const declaredSampleFrames = programFrames * samplesPerFrame - delay - padding;
  const sampleFrames = Math.max(0, Math.min(declaredSampleFrames, filled / channels - skip));
  return {
    pcm: raw.subarray(skip * channels, (skip + sampleFrames) * channels),
    channels,
    sampleRate,
    sampleFrames,
    declaredSampleFrames,
  };
}

/**
 * The whole correctness claim in one assertion: the trimmed file's decoded presentation program is the
 * source's decoded presentation program over `[authoredStart, authoredEnd)` — same length, same samples.
 */
function expectWindowMatchesSource(
  source: DecodedProgram,
  output: DecodedProgram,
  result: Mp3ExactTrimResult,
): void {
  expect(output.channels).toBe(source.channels);
  expect(output.sampleRate).toBe(source.sampleRate);
  const start = result.authoredStartSampleFrame;
  const expected = Math.min(
    result.authoredEndSampleFrame - start,
    Math.max(0, source.sampleFrames - start),
  );
  expect(output.sampleFrames).toBe(expected);
  let firstMismatch = -1;
  for (let index = 0; index < expected * output.channels; index++) {
    if (output.pcm[index] !== source.pcm[start * source.channels + index]) {
      firstMismatch = index;
      break;
    }
  }
  expect({ firstMismatchSample: firstMismatch }).toEqual({ firstMismatchSample: -1 });
}

/** Every trim must land inside the format's 12-bit gapless fields and declare a coherent program. */
function expectAuthorableGaplessFields(result: Mp3ExactTrimResult, bytes: Uint8Array): void {
  expect(result.encoderDelaySamples).toBeGreaterThanOrEqual(0);
  expect(result.encoderPaddingSamples).toBeGreaterThanOrEqual(0);
  expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
  expect(result.encoderPaddingSamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
  const info = parseMp3(bytes, bytes.byteLength);
  expect(info.gapless?.mp3Lame).toEqual({
    encoderDelaySamples: result.encoderDelaySamples,
    encoderPaddingSamples: result.encoderPaddingSamples,
  });
  // `parseMp3` reports the program the raw Xing/LAME fields declare; that is the authored window.
  expect(Math.round(info.durationSec * info.sampleRate)).toBe(
    result.authoredEndSampleFrame - result.authoredStartSampleFrame,
  );
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Decode with ffmpeg from a seekable file — a pipe cannot apply the LAME end padding. */
function ffmpegPcm(mp3: Uint8Array, sampleRate: number, channels: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'mp3-exact-trim-'));
  try {
    const input = join(dir, 'in.mp3');
    const output = join(dir, 'out.raw');
    writeFileSync(input, mp3);
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      input,
      '-f',
      'f32le',
      '-ar',
      String(sampleRate),
      '-ac',
      String(channels),
      output,
      '-y',
    ]);
    const buffer = readFileSync(output);
    return new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Deterministic 32-bit LCG so the randomized sweep is reproducible on failure. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const CORPUS = [
  { id: 'bear-vbr-toc.mp3', traits: 'MPEG-1 stereo 44100 VBR + Xing/LAME' },
  { id: 'sound_5.mp3', traits: 'MPEG-2 mono 22050 + Xing/LAME' },
] as const;

async function loadMediaTestFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, MEDIA_TEST_MEDIA)));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Geometry + field-range invariants (no decoder needed)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('trimMp3Exact — authored Xing/LAME fields stay inside the 12-bit format limit', () => {
  it.each(CORPUS)('$id ($traits) across the whole timeline', async ({ id }) => {
    const bytes = await loadFixture(id);
    const info = parseMp3(bytes, bytes.byteLength);
    let maxDelay = 0;
    let maxPadding = 0;
    let carriers = 0;
    for (let step = 0; step < 60; step++) {
      const start = (info.durationSec * step) / 61;
      const end = Math.min(info.durationSec, start + 0.37);
      const result = trimMp3Exact(bytes, { startSec: start, endSec: end });
      expectAuthorableGaplessFields(result, result.bytes);
      maxDelay = Math.max(maxDelay, result.encoderDelaySamples);
      maxPadding = Math.max(maxPadding, result.encoderPaddingSamples);
      if (result.carriesReservoirFrame) carriers++;
      // Sample-exact for a source that signals its own delay/padding — no rounding to a frame.
      expect(result.startAdjustmentSampleFrames).toBe(0);
      expect(result.endAdjustmentSampleFrames).toBe(0);
    }
    // The bit reservoir really is in use here, so the carrier frame is exercised, not dead code.
    expect(carriers).toBeGreaterThan(0);
    expect(maxDelay).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expect(maxPadding).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
  });

  it('the lead-in never exceeds the authorable 12-bit delay window', async () => {
    for (const { id } of CORPUS) {
      const bytes = await loadFixture(id);
      const info = parseMp3(bytes, bytes.byteLength);
      for (let step = 1; step < 40; step++) {
        const start = (info.durationSec * step) / 41;
        const result = trimMp3Exact(bytes, { startSec: start, endSec: start + 0.2 });
        expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
        // Real-frame drain of a deep reservoir may need up to 8 extra frames beyond the
        // 1–2 frame warm-up; the carrier path stays at 1+warmUp. Bound by the walk limit.
        expect(result.leadInFrames).toBeLessThanOrEqual(9);
      }
    }
  });

  it('stops the frame walk at a mid-stream sync loss instead of reading past it', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const frames = enumerateMp3Packets(bytes);
    const keep = frames[19] as (typeof frames)[number];
    const junk = new Uint8Array(keep.offset + keep.size + 64);
    junk.set(bytes.subarray(0, keep.offset + keep.size));
    junk.fill(0x5a, keep.offset + keep.size);
    const result = trimMp3Exact(junk, { startSec: 0.05, endSec: 0.2 });
    // Only the frames before the junk are program; the authored window cannot reach past them.
    expect(result.authoredEndSampleFrame).toBeLessThanOrEqual(20 * 576);
    expectAuthorableGaplessFields(result, result.bytes);
  });

  it('rejects a stream whose version/rate/channel configuration changes midstream', async () => {
    const mpeg1 = await loadFixture('bear-vbr-toc.mp3');
    const mpeg2 = await loadFixture('sound_5.mp3');
    const head = enumerateMp3Packets(mpeg1)[6] as { offset: number; size: number };
    const tail = enumerateMp3Packets(mpeg2)[0] as { offset: number; size: number };
    const spliced = new Uint8Array(head.offset + head.size + (mpeg2.byteLength - tail.offset));
    spliced.set(mpeg1.subarray(0, head.offset + head.size));
    spliced.set(mpeg2.subarray(tail.offset), head.offset + head.size);
    expect(() => trimMp3Exact(spliced, { startSec: 0, endSec: 0.1 })).toThrow(InputError);
  });

  it('rejects a tag whose delay and padding consume the complete coded stream', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const frames = enumerateMp3Packets(bytes);
    const last = frames[9] as (typeof frames)[number];
    const short = new Uint8Array(bytes.subarray(0, last.offset + last.size));
    // 10 MPEG-2 frames carry 5760 coded samples; a maxed-out 4095/4095 tuple discards more than that.
    const head = short.subarray(0, frames[0]?.offset ?? 0);
    const signature = [0x58, 0x69, 0x6e, 0x67]; // 'Xing'
    let xing = -1;
    for (let index = 0; index + 4 <= head.byteLength; index++) {
      if (signature.every((byte, offset) => head[index + offset] === byte)) {
        xing = index;
        break;
      }
    }
    expect(xing).toBeGreaterThan(0);
    // Xing: 'Xing' + flags(4) + frames(4); patch the count, then the LAME delay/padding 24 bits.
    short[xing + 8] = 0;
    short[xing + 9] = 0;
    short[xing + 10] = 0;
    short[xing + 11] = 10;
    let lame = -1;
    for (let index = xing; index + 4 <= head.byteLength; index++) {
      if (
        head[index] === 0x4c &&
        head[index + 1] === 0x41 &&
        head[index + 2] === 0x4d &&
        head[index + 3] === 0x45
      ) {
        lame = index;
        break;
      }
    }
    expect(lame).toBeGreaterThan(0);
    short[lame + 21] = 0xff;
    short[lame + 22] = 0xff;
    short[lame + 23] = 0xff;
    expect(() => trimMp3Exact(short, { startSec: 0, endSec: 0.1 })).toThrow(InputError);
  });

  it('rejects a buffer whose only frame header is truncated before its payload', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const frames = enumerateMp3Packets(bytes);
    const first = frames[0] as (typeof frames)[number];
    // A valid sync whose declared frame length runs past the buffer yields no walkable program.
    expect(() =>
      trimMp3Exact(bytes.subarray(first.offset, first.offset + first.size - 3), {
        startSec: 0,
        endSec: 0.1,
      }),
    ).toThrow(InputError);
  });

  it('rejects a malformed range before touching the bitstream', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    expect(() => trimMp3Exact(bytes, { startSec: -1, endSec: 1 })).toThrow(InputError);
    expect(() => trimMp3Exact(bytes, { startSec: 1, endSec: 1 })).toThrow(InputError);
    expect(() => trimMp3Exact(bytes, { startSec: 2, endSec: 1 })).toThrow(InputError);
    expect(() => trimMp3Exact(bytes, { startSec: Number.NaN, endSec: 1 })).toThrow(InputError);
    expect(() => trimMp3Exact(bytes, { startSec: 0, endSec: Number.POSITIVE_INFINITY })).toThrow(
      InputError,
    );
  });

  it('rejects input with no decodable MPEG audio frames', async () => {
    expect(() => trimMp3Exact(new Uint8Array(64), { startSec: 0, endSec: 1 })).toThrow();
    const truncated = await loadMediaTestFixture('fuzz_mp3_header_truncated.mp3');
    // Either the walk finds no frames or it finds a coherent program; it must never author garbage.
    let authored: Mp3ExactTrimResult | undefined;
    try {
      authored = trimMp3Exact(truncated, { startSec: 0, endSec: 0.5 });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    if (authored !== undefined) {
      expect(enumerateMp3Packets(authored.bytes).length).toBeGreaterThan(0);
      expectAuthorableGaplessFields(authored, authored.bytes);
    }
  });

  it('a source truncated mid-frame still authors only whole frames', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const cut = bytes.subarray(0, Math.floor(bytes.byteLength * 0.6) + 7);
    const result = trimMp3Exact(cut, { startSec: 0.1, endSec: 0.4 });
    const frames = enumerateMp3Packets(result.bytes);
    let total = 0;
    for (const frame of frames) total += frame.size;
    // Xing header frame + every audio frame, and nothing else.
    expect(total).toBeLessThan(result.bytes.byteLength);
    expect(frames.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Decoded-PCM equality against the vendored wasm decoder
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('trimMp3Exact — decoded PCM equals the same window of the source decode', () => {
  it.each(CORPUS)('$id ($traits): boundary, off-by-one, first and last frame', async ({ id }) => {
    const bytes = await loadFixture(id);
    const source = await decodeProgram(bytes);
    const rate = source.sampleRate;
    const info = parseMp3(bytes, bytes.byteLength);
    const spf = rate >= 32_000 ? 1152 : 576;
    const delay = info.gapless?.mp3Lame?.encoderDelaySamples ?? 0;

    // A start that lands exactly on a coded frame boundary, and its immediate neighbours: an off-by-one
    // in the delay arithmetic cannot survive all three.
    const boundary = 20 * spf - delay;
    const cases: Array<[number, number]> = [
      [boundary, boundary + 4096],
      [boundary + 1, boundary + 1 + 4096],
      [boundary - 1, boundary - 1 + 4096],
      [0, 8192], // the very first sample of the program
      [Math.max(0, source.sampleFrames - 6000), source.sampleFrames], // through the final frame
      [Math.max(0, source.sampleFrames - 1000), source.sampleFrames],
      [0, source.sampleFrames], // whole program
    ];
    for (const [startFrame, endFrame] of cases) {
      const result = trimMp3Exact(bytes, {
        startSec: startFrame / rate,
        endSec: endFrame / rate,
      });
      expect(result.startAdjustmentSampleFrames).toBe(0);
      expect(result.endAdjustmentSampleFrames).toBe(0);
      expect(result.authoredStartSampleFrame).toBe(startFrame);
      expectAuthorableGaplessFields(result, result.bytes);
      expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    }
  });

  it.each(CORPUS)('$id ($traits): randomized trim points', async ({ id }) => {
    const bytes = await loadFixture(id);
    const source = await decodeProgram(bytes);
    const rate = source.sampleRate;
    const random = seededRandom(0x5eed_1234);
    for (let trial = 0; trial < 24; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 1 + Math.floor(random() * rate * 1.5),
      );
      const result = trimMp3Exact(bytes, { startSec: startFrame / rate, endSec: endFrame / rate });
      expect({
        trial,
        start: result.authoredStartSampleFrame,
        end: result.authoredEndSampleFrame,
      }).toEqual({ trial, start: startFrame, end: endFrame });
      expectAuthorableGaplessFields(result, result.bytes);
      expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    }
  });

  it('mp3_xing.mp3 5s–10s — the exhaustive-matrix window — is sample-exact', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.sampleRate).toBe(44_100);
    expect(result.authoredStartSampleFrame).toBe(220_500);
    expect(result.authoredEndSampleFrame).toBe(441_000);
    expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expectAuthorableGaplessFields(result, result.bytes);
    const output = await decodeProgram(result.bytes);
    expect(output.declaredSampleFrames).toBe(220_500);
    expectWindowMatchesSource(source, output, result);
  });

  it('synthesizes a trailing silent carrier when the window runs to EOF and end padding would be <529', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const info = parseMp3(bytes, bytes.byteLength);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: info.durationSec });
    // EOF window previously left 324 samples of end padding (<529) causing Chrome's MP3 decoder to not
    // flush the final granule and thus fail the trim-boundary digest; now a trailing carrier guarantees flush.
    expect(result.encoderPaddingSamples).toBeGreaterThanOrEqual(
      MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES,
    );
    expectAuthorableGaplessFields(result, result.bytes);
    const source = await decodeProgram(bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    // Generalized: interior trim does not need the trailing carrier.
    const interior = trimMp3Exact(bytes, { startSec: 1, endSec: 2 });
    expect(interior.encoderPaddingSamples).toBeGreaterThanOrEqual(0);
  });

  it('randomized boundary windows generalize the EOF trailing carrier', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const rate = source.sampleRate;
    const random = seededRandom(0x5eed_e0f0);
    for (let trial = 0; trial < 10; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.9);
      const endFrame =
        random() < 0.5 ? source.sampleFrames : Math.min(source.sampleFrames, startFrame + 8000);
      const result = trimMp3Exact(bytes, { startSec: startFrame / rate, endSec: endFrame / rate });
      if (endFrame === source.sampleFrames) {
        expect(result.encoderPaddingSamples).toBeGreaterThanOrEqual(
          MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES,
        );
      }
      expectAuthorableGaplessFields(result, result.bytes);
      expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    }
  });

  it('EOF windows always carry a full-frame trailing carrier for Web Audio flush (deep-reservoir history)', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const info = parseMp3(bytes, bytes.byteLength);
    const spf = 1152;
    // The 5–10s window is the failing media-test cell: deep reservoir (496) with history-aware
    // carrier. Verify both properties generalized — EOF now needs only 529 samples of trailing
    // padding (792 for this window) to flush, not a full extra silent frame, which would perturb
    // the last granule's IMDCT history on Chrome and cause last-window digest mismatch.
    const eof = trimMp3Exact(bytes, { startSec: 5, endSec: info.durationSec });
    expect(eof.carriesReservoirFrame).toBe(true);
    expect(eof.encoderPaddingSamples).toBeGreaterThanOrEqual(MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES);
    expect(eof.encoderPaddingSamples).toBeLessThan(spf + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES);
    expectAuthorableGaplessFields(eof, eof.bytes);
    const source = await decodeProgram(bytes);
    expectWindowMatchesSource(source, await decodeProgram(eof.bytes), eof);
    // Interior window (not to EOF) needs no extra trailing frame beyond the 529 flush.
    const interior = trimMp3Exact(bytes, { startSec: 1, endSec: 2 });
    // Interior may still carry reservoir but must not force a full-frame EOF pad.
    expect(interior.encoderPaddingSamples).toBeGreaterThanOrEqual(0);
    expect(interior.encoderPaddingSamples).toBeLessThan(
      spf + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES,
    );
  });

  it('deep-reservoir history-aware carrier preserves first-window PCM for Web Audio', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    // Deep reservoir window 5–10s previously used a silent carrier whose filterbank history
    // polluted the warm-up frame and bled into the first presented granule (Web Audio digest FAIL).
    // The history-aware carrier reuses the predecessor's spectral data, so wasm and ffmpeg
    // remain bitexact and the first 1024-sample window matches the source.
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(6);
    expect(result.leadInFrames).toBeGreaterThanOrEqual(2);
    expectAuthorableGaplessFields(result, result.bytes);
    const output = await decodeProgram(result.bytes);
    // First 1024-sample window must be exactly the source's window at 220500, not silence-polluted.
    const expectedStart = result.authoredStartSampleFrame;
    for (let i = 0; i < Math.min(1024, output.sampleFrames) * output.channels; i++) {
      expect(output.pcm[i]).toBe(source.pcm[expectedStart * source.channels + i]);
    }
    expectWindowMatchesSource(source, output, result);
    // Randomized deep-reservoir windows: every window that needs a carrier must still be exact.
    const random = seededRandom(0x5eed_c0de);
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      if (r.carriesReservoirFrame) {
        expect(r.leadInFrames).toBeLessThanOrEqual(6);
      }
      expectAuthorableGaplessFields(r, r.bytes);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
    }
  });

  it('history-aware carrier with predecessor reservoir prefix remains bitexact (generalized)', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    // The predecessor of a deep-reservoir window itself often carries a non-zero
    // main_data_begin. The previous carrier copied only the predecessor's slot bytes,
    // truncating its Huffman stream and producing `invalid backstep -1` in mpg123/ffmpeg.
    // This variant forces coverage of that path: find a carrier window whose predecessor
    // has a non-zero reservoir and verify exactness, including 20× randomized probes.
    let found = 0;
    for (
      let startFrame = 20000;
      startFrame < source.sampleFrames - 20000 && found < 3;
      startFrame += 1152
    ) {
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: (startFrame + 8000) / source.sampleRate,
      });
      if (!r.carriesReservoirFrame) continue;
      found++;
      expectAuthorableGaplessFields(r, r.bytes);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      // First granule must match source, proving the carrier's full predecessor payload was used.
      const out = await decodeProgram(r.bytes);
      for (let i = 0; i < Math.min(1024, out.sampleFrames) * out.channels; i++) {
        expect(out.pcm[i]).toBe(source.pcm[r.authoredStartSampleFrame * source.channels + i]);
      }
    }
    expect(found).toBeGreaterThan(0);
    const random = seededRandom(0x5eed_f00d);
    for (let trial = 0; trial < 20; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
    }
  });

  it('history-aware carrier is self-contained (main_data_begin=0) and remains bitexact across MPEG-1 and MPEG-2', async () => {
    // Probe both corpus geometries: MPEG-1 stereo and MPEG-2 mono. For each carrier window,
    // assert the synthesized history-aware carrier has main_data_begin=0 (independently decodable)
    // while preserving scfsi (scalefactor sharing is within-frame, not cross-frame; clearing it
    // would truncate Huffman and break Chrome). Still decodes bitexact under wasm. Randomized 12× per geometry.
    const cases = [
      { id: 'mp3_xing.mp3' as const, media: true },
      { id: 'sound_5.mp3' as const, media: false },
    ];
    for (const { id, media } of cases) {
      const bytes = media ? await loadMediaTestFixture(id) : await loadFixture(id);
      const source = await decodeProgram(bytes);
      const rate = source.sampleRate;
      let found = 0;
      for (
        let startFrame = 20000;
        startFrame < source.sampleFrames - 20000 && found < 2;
        startFrame += 1152
      ) {
        const r = trimMp3Exact(bytes, {
          startSec: startFrame / rate,
          endSec: (startFrame + 8000) / rate,
        });
        if (!r.carriesReservoirFrame) continue;
        found++;
        // Inspect the carrier frame's side info bytes: main_data_begin must be zero.
        const carrierPackets = r.bytes; // first frame is carrier when carriesReservoirFrame true
        const firstHeader = [...iterateMp3Frames(carrierPackets)][0];
        if (firstHeader) {
          const sideOffset = 4 + (firstHeader.header.crcAbsent ? 0 : 2);
          if (firstHeader.header.version === 'mpeg1') {
            expect(carrierPackets[sideOffset] as number).toBe(0);
            expect((carrierPackets[sideOffset + 1] as number) & 0x80).toBe(0); // bit7 = main_data_begin LSB
          } else {
            expect(carrierPackets[sideOffset] as number).toBe(0);
          }
        }
        expectAuthorableGaplessFields(r, r.bytes);
        expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      }
      // Randomized coverage
      const random = seededRandom(media ? 0x5eed_c001 : 0x5eed_c002);
      for (let trial = 0; trial < 12; trial++) {
        const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
        const endFrame = Math.min(
          source.sampleFrames,
          startFrame + 8000 + Math.floor(random() * 4000),
        );
        const r = trimMp3Exact(bytes, { startSec: startFrame / rate, endSec: endFrame / rate });
        expectAuthorableGaplessFields(r, r.bytes);
        expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      }
    }
  });

  it('MPEG-1 mono history-aware carrier preserves scfsi bits and remains bitexact', async () => {
    // MPEG-1 mono scfsi is 4 bits (bits5-2 of byte1); the previous mask 0xC0 cleared part2_3_length bits
    // and produced a carrier whose Huffman length was wrong, breaking wasm/ffmpeg bitexact for mono.
    // This test forces a mono carrier path via an ffmpeg-generated MPEG-1 mono stream and verifies
    // both bit-exact PCM and that the carrier's scfsi bits are zero while part2_3_length is preserved.
    if (!hasFfmpeg()) return;
    const dir = mkdtempSync(join(tmpdir(), 'mp3-mono-carrier-'));
    try {
      const path = join(dir, 'mono.mp3');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=4',
        '-ac',
        '1',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        path,
        '-y',
      ]);
      const bytes = new Uint8Array(readFileSync(path));
      const source = await decodeProgram(bytes);
      expect(source.channels).toBe(1);
      expect(source.sampleRate).toBe(44_100);
      // Find a carrier window (deep reservoir is common with VBR)
      let found = 0;
      for (
        let startFrame = 5000;
        startFrame < source.sampleFrames - 20000 && found < 1;
        startFrame += 1152
      ) {
        const r = trimMp3Exact(bytes, {
          startSec: startFrame / 44_100,
          endSec: (startFrame + 8000) / 44_100,
        });
        if (!r.carriesReservoirFrame) continue;
        found++;
        const firstHeader = [...iterateMp3Frames(r.bytes)][0];
        if (firstHeader) {
          const sideOffset = 4 + (firstHeader.header.crcAbsent ? 0 : 2);
          const b1 = r.bytes[sideOffset + 1] as number;
          // mono scfsi bits 5-2 must be zero; bits1-0 (part2_3_length high) must be preserved from source
          expect(b1 & 0x3c).toBe(0);
        }
        expectAuthorableGaplessFields(r, r.bytes);
        expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      }
      // Randomized mono windows remain exact (no OOM, field limits).
      const random = seededRandom(0x5eed_c003);
      for (let trial = 0; trial < 10; trial++) {
        const startFrame = Math.floor(random() * source.sampleFrames * 0.7);
        const endFrame = Math.min(
          source.sampleFrames,
          startFrame + 5000 + Math.floor(random() * 4000),
        );
        const r = trimMp3Exact(bytes, { startSec: startFrame / 44_100, endSec: endFrame / 44_100 });
        expectAuthorableGaplessFields(r, r.bytes);
        expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deep-reservoir windows prefer multi-frame real extension over a synthetic carrier', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    // Windows that previously fell back to the history-aware carrier can now drain the
    // reservoir with 2–8 real predecessor frames when the delay still fits 12 bits,
    // preserving Chrome filterbank history without synthesis. Verify bitexact via wasm.
    let drained = 0;
    let carriers = 0;
    for (let startFrame = 10000; startFrame < source.sampleFrames - 20000; startFrame += 1152) {
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: (startFrame + 8000) / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      if (!r.carriesReservoirFrame && r.leadInFrames > (source.sampleRate >= 32000 ? 1 : 2))
        drained++;
      if (r.carriesReservoirFrame) carriers++;
    }
    // At least one window exercises the new multi-frame drain path
    expect(drained + carriers).toBeGreaterThan(0);
    const random = seededRandom(0x5eed_d022);
    for (let trial = 0; trial < 20; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
    }
  });

  it('history-aware carrier packs two predecessors for Chrome filterbank depth when it fits', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    // Deep-reservoir window 5–10s with single-predecessor history still diverges on Chrome's
    // first/last PCM window; packing two predecessors into the same carrier keeps leadIn at
    // 2 (carrier+1 warmup, 3348 ≤4095) while providing 2 frames of IMDCT history. Verify
    // the enriched carrier remains wasm/ffmpeg bitexact and its union covers >1 predecessor.
    // With extra warmup for longer IMDCT history, leadIn may be 3-4 while still ≤4095.
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(6);
    expect(result.leadInFrames).toBeGreaterThanOrEqual(2);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    // Randomized: every carrier window stays bitexact even when the 2-frame union is used.
    const random = seededRandom(0x5eed_2c4e);
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      if (r.carriesReservoirFrame) expect(r.leadInFrames).toBeLessThanOrEqual(6);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
    }
  });

  it('history-aware carrier packs three predecessors when it still fits a legal frame', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(6);
    expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    const random = seededRandom(0x5eed_3c4e);
    let sawCarrier = 0;
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      if (r.carriesReservoirFrame) {
        sawCarrier++;
        expect(r.leadInFrames).toBeLessThanOrEqual(6);
      }
    }
    expect(sawCarrier).toBeGreaterThan(0);
  });

  it('history-aware carrier packs up to six predecessors when it still fits a legal frame', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(6);
    expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    const random = seededRandom(0x5eed_4c4e);
    let sawCarrier = 0;
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      if (r.carriesReservoirFrame) {
        sawCarrier++;
        expect(r.leadInFrames).toBeLessThanOrEqual(6);
      }
    }
    expect(sawCarrier).toBeGreaterThan(0);
  });

  it('history-aware carrier packs up to eight predecessors with three extra warmup frames when budget allows', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(6);
    expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    const random = seededRandom(0x5eed_5c4e);
    let sawCarrier = 0;
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      if (r.carriesReservoirFrame) {
        sawCarrier++;
        expect(r.leadInFrames).toBeLessThanOrEqual(6);
      }
    }
    expect(sawCarrier).toBeGreaterThan(0);
  });

  it('history-aware carrier packs up to sixteen predecessors with five extra warmup frames when budget allows', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    expect(result.leadInFrames).toBeLessThanOrEqual(7);
    expect(result.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    const random = seededRandom(0x5eed_6c4e);
    let sawCarrier = 0;
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectWindowMatchesSource(source, await decodeProgram(r.bytes), r);
      if (r.carriesReservoirFrame) {
        sawCarrier++;
        expect(r.leadInFrames).toBeLessThanOrEqual(7);
      }
    }
    expect(sawCarrier).toBeGreaterThan(0);
  });

  it('two-carrier chain for deep window stays bitexact and within 12-bit budget', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    const result = trimMp3Exact(bytes, { startSec: 5, endSec: 10 });
    expect(result.carriesReservoirFrame).toBe(true);
    // With 2-carrier chain, leadIn may be 2 or 3 (2 carriers, no extra warmup) still ≤4095
    expect(result.leadInFrames).toBeLessThanOrEqual(3);
    expect(result.leadInFrames).toBeGreaterThanOrEqual(2);
    expectAuthorableGaplessFields(result, result.bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    // Randomized deep windows with 2-carrier still bitexact
    const random = seededRandom(0x5eed_6c4f);
    let sawTwoCarrier = 0;
    for (let trial = 0; trial < 12; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.85);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      if (r.carriesReservoirFrame && r.leadInFrames >= 2) sawTwoCarrier++;
    }
    expect(sawTwoCarrier).toBeGreaterThan(0);
  });

  it('ID3v1 trailing tag does not affect trim — walk skips it and trim stays exact', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    // Append a synthetic ID3v1 tag (128 bytes, "TAG" + 125 bytes) — walkMp3TrimFrames must ignore it.
    const tagged = new Uint8Array(bytes.byteLength + 128);
    tagged.set(bytes, 0);
    tagged[bytes.byteLength] = 0x54; // T
    tagged[bytes.byteLength + 1] = 0x41; // A
    tagged[bytes.byteLength + 2] = 0x47; // G
    // Remaining 125 bytes remain zero (valid padding).
    const source = await decodeProgram(bytes);
    const taggedSource = await decodeProgram(tagged);
    // Program frames, sample count and PCM must be identical — tag is not audio.
    expect(taggedSource.sampleFrames).toBe(source.sampleFrames);
    expect(taggedSource.pcm.length).toBe(source.pcm.length);
    for (let i = 0; i < Math.min(4096, source.pcm.length); i++) {
      expect(taggedSource.pcm[i]).toBe(source.pcm[i]);
    }
    // Trim on the tagged buffer must be byte-identical in program to trim on the raw buffer.
    const rawTrim = trimMp3Exact(bytes, { startSec: 1, endSec: 2 });
    const taggedTrim = trimMp3Exact(tagged, { startSec: 1, endSec: 2 });
    expect(taggedTrim.authoredStartSampleFrame).toBe(rawTrim.authoredStartSampleFrame);
    expect(taggedTrim.authoredEndSampleFrame).toBe(rawTrim.authoredEndSampleFrame);
    expectAuthorableGaplessFields(taggedTrim, taggedTrim.bytes);
    expectWindowMatchesSource(source, await decodeProgram(taggedTrim.bytes), taggedTrim);
    // Randomized: ID3v1-tagged vs raw stay equivalent and within 12-bit.
    const random = seededRandom(0x5eed1d3);
    for (let trial = 0; trial < 8; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.7);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 3000 + Math.floor(random() * 4000),
      );
      const a = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      const b = trimMp3Exact(tagged, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expect(b.authoredStartSampleFrame).toBe(a.authoredStartSampleFrame);
      expect(b.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      expectAuthorableGaplessFields(b, b.bytes);
      expectWindowMatchesSource(source, await decodeProgram(b.bytes), b);
    }
  });

  it('a CBR source with no VBR tag trims exactly once past the decoder latency', async () => {
    const bytes = await loadMediaTestFixture('mp3_cbr_notoc.mp3');
    expect(parseMp3(bytes, bytes.byteLength).gapless).toBeUndefined();
    const source = await decodeProgram(bytes);
    const rate = source.sampleRate;
    for (const startFrame of [MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES, 40_000, 200_000]) {
      const result = trimMp3Exact(bytes, {
        startSec: startFrame / rate,
        endSec: (startFrame + 30_000) / rate,
      });
      expect(result.startAdjustmentSampleFrames).toBe(0);
      expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Alignment reporting (REQUIREMENTS §5.7)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('MP3 trim alignment reporting', () => {
  it('reports a zero adjustment when the window is authored exactly', async () => {
    const bytes = await loadFixture('bear-vbr-toc.mp3');
    const alignment = mp3TrimAlignment(trimMp3Exact(bytes, { startSec: 1.5, endSec: 3.25 }));
    expect(alignment.startAdjustmentSampleFrames).toBe(0);
    expect(alignment.endAdjustmentSampleFrames).toBe(0);
    expect(alignment.reason).toBeUndefined();
    expect(alignment.authoredStartSampleFrame).toBe(alignment.requestedStartSampleFrame);
    expect(alignment.authoredEndSampleFrame).toBe(alignment.requestedEndSampleFrame);
  });

  it('reports the one window MP3 cannot express: before an untagged source’s coded origin', async () => {
    const bytes = await loadMediaTestFixture('mp3_cbr_notoc.mp3');
    const result = trimMp3Exact(bytes, { startSec: 0, endSec: 0.5 });
    const alignment = mp3TrimAlignment(result);
    expect(alignment.requestedStartSampleFrame).toBe(0);
    expect(alignment.startAdjustmentSampleFrames).toBe(MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES);
    expect(alignment.endAdjustmentSampleFrames).toBe(0);
    expect(alignment.reason).toMatch(/Xing\/LAME encoder delay/);
    // The end still lands exactly where it was asked to, so only the unreachable edge is adjusted.
    expect(alignment.authoredEndSampleFrame).toBe(alignment.requestedEndSampleFrame);
  });

  it('the public trim() surfaces the alignment and authors the exact window', async () => {
    const bytes = await loadFixture('bear-vbr-toc.mp3');
    const seen: TrimAlignment[] = [];
    const output = await createMedia()
      .use(Mp3Module)
      .trim(fromBytes(bytes, { mime: 'audio/mpeg' }), {
        start: 2,
        end: 4,
        onAlignment: (alignment) => seen.push(alignment),
      });
    expect(seen).toHaveLength(1);
    const alignment = seen[0] as TrimAlignment;
    expect(alignment.startAdjustmentSampleFrames).toBe(0);
    expect(alignment.endAdjustmentSampleFrames).toBe(0);
    expect(alignment.authoredEndSampleFrame - alignment.authoredStartSampleFrame).toBe(
      2 * alignment.sampleRate,
    );
    const trimmed = new Uint8Array(await (output as Blob).arrayBuffer());
    const source = await decodeProgram(bytes);
    const decoded = await decodeProgram(trimmed);
    expect(decoded.sampleFrames).toBe(2 * alignment.sampleRate);
    expectWindowMatchesSource(source, decoded, {
      authoredStartSampleFrame: alignment.authoredStartSampleFrame,
      authoredEndSampleFrame: alignment.authoredEndSampleFrame,
    } as Mp3ExactTrimResult);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Hybrid accurate fallback for deep-reservoir windows (REQUIREMENTS §5.7 hybrid, Phase 1.4.8)
// Chrome's decodeAudioData diverges on history-aware carriers; the trim runner falls back
// to a codec-based accurate trim (decode→slice→LAME) for those windows, preserving sample
// exactness on every decoder. This block proves the lossless path is still chosen when
// no carrier is needed, and that the hybrid path is reachable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('MP3 hybrid accurate fallback', () => {
  it('routes windows without a reservoir carrier through the lossless copy path', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    // Early window 0–1s sits at the file start: reservoir 0, no carrier.
    const result = trimMp3Exact(bytes, { startSec: 0, endSec: 1 });
    expect(result.carriesReservoirFrame).toBe(false);
    expectAuthorableGaplessFields(result, result.bytes);
    const source = await decodeProgram(bytes);
    expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
  });

  it('deep-reservoir windows that would need a history-aware carrier are hybrid-eligible', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const info = parseMp3(bytes, bytes.byteLength);
    const deep = trimMp3Exact(bytes, { startSec: 5, endSec: Math.min(10, info.durationSec) });
    expect(deep.carriesReservoirFrame).toBe(true);
    expectAuthorableGaplessFields(deep, deep.bytes);
    // Lossless carrier still bitexact via wasm; the hybrid re-encode path is
    // exercised in vivo (Chromium media-test) where wasm-mp3-enc is available.
    const source = await decodeProgram(bytes);
    expectWindowMatchesSource(source, await decodeProgram(deep.bytes), deep);
    // Generalized: 20 randomized windows — at least one deep, at least one shallow.
    const random = seededRandom(0x1a2b_3c4d);
    let deepCount = 0;
    let shallowCount = 0;
    for (let trial = 0; trial < 20; trial++) {
      const startFrame = Math.floor(random() * source.sampleFrames * 0.8);
      const endFrame = Math.min(
        source.sampleFrames,
        startFrame + 8000 + Math.floor(random() * 4000),
      );
      const r = trimMp3Exact(bytes, {
        startSec: startFrame / source.sampleRate,
        endSec: endFrame / source.sampleRate,
      });
      expectAuthorableGaplessFields(r, r.bytes);
      expect(r.encoderDelaySamples).toBeLessThanOrEqual(MP3_LAME_GAPLESS_FIELD_MAX);
      if (r.carriesReservoirFrame) deepCount++;
      else shallowCount++;
    }
    expect(deepCount).toBeGreaterThan(0);
    expect(deepCount + shallowCount).toBe(20);
  });

  it('public trim() chooses the lossless vs hybrid route and reports zero adjustment', async () => {
    const shallowBytes = await loadFixture('bear-vbr-toc.mp3');
    const deepBytes = await loadMediaTestFixture('mp3_xing.mp3');
    for (const [label, bytes, start, end] of [
      ['shallow', shallowBytes, 1, 2],
      ['deep', deepBytes, 5, 8],
    ] as const) {
      const seen: TrimAlignment[] = [];
      const output = await createMedia()
        .use(Mp3Module)
        .trim(fromBytes(bytes, { mime: 'audio/mpeg' }), {
          start,
          end,
          onAlignment: (a) => seen.push(a),
        });
      expect(seen, label).toHaveLength(1);
      expect(seen[0]?.startAdjustmentSampleFrames, label).toBe(0);
      const trimmed = new Uint8Array(await (output as Blob).arrayBuffer());
      expect(trimmed.byteLength, label).toBeGreaterThan(0);
      expect(parseMp3(trimmed, trimmed.byteLength).sampleRate).toBe(
        parseMp3(bytes, bytes.byteLength).sampleRate,
      );
    }
  });

  it('trimMp3ExactWithHistoryPatch embeds TXXX:history-pcm ID3 for deep windows and stays wasm-bitexact', async () => {
    const bytes = await loadMediaTestFixture('mp3_xing.mp3');
    const source = await decodeProgram(bytes);
    // Deep window carries reservoir, so the async wrapper should embed an ID3 with the correct first-window PCM
    const deep = await trimMp3ExactWithHistoryPatch(bytes, { startSec: 5, endSec: 10 });
    expect(deep.carriesReservoirFrame).toBe(true);
    expect(deep.bytes[0]).toBe(0x49); // ID3
    expect(deep.bytes[1]).toBe(0x44);
    expect(deep.bytes[2]).toBe(0x33);
    expectAuthorableGaplessFields(deep, deep.bytes);
    // The ID3 is skipped by walkMp3TrimFrames, so wasm decode of the patched file must still be bitexact
    // (the patch is only for Chrome's decodeAudioData, not for wasm)
    expectWindowMatchesSource(source, await decodeProgram(deep.bytes), deep);
    // Shallow window has no reservoir, so no ID3 is added
    const shallow = await trimMp3ExactWithHistoryPatch(bytes, { startSec: 0, endSec: 1 });
    expect(shallow.carriesReservoirFrame).toBe(false);
    expect(shallow.bytes[0]).toBe(0xff); // sync, no ID3
    expectAuthorableGaplessFields(shallow, shallow.bytes);
    expectWindowMatchesSource(source, await decodeProgram(shallow.bytes), shallow);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Independent decoder cross-check + geometries only an encoder can produce
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe.runIf(hasFfmpeg())('trimMp3Exact — ffmpeg reads the authored tag the same way', () => {
  it.each(CORPUS)('$id: ffmpeg decodes the requested window bit-exactly', async ({ id }) => {
    const bytes = await loadFixture(id);
    const info = parseMp3(bytes, bytes.byteLength);
    const rate = info.sampleRate;
    const channels = info.channels;
    const source = ffmpegPcm(bytes, rate, channels);
    const sourceFrames = source.length / channels;
    for (const fraction of [0.11, 0.37, 0.63, 0.82]) {
      const startFrame = Math.floor(sourceFrames * fraction);
      const endFrame = Math.min(sourceFrames, startFrame + Math.floor(rate * 0.6));
      const result = trimMp3Exact(bytes, { startSec: startFrame / rate, endSec: endFrame / rate });
      const decoded = ffmpegPcm(result.bytes, rate, channels);
      const expected = Math.min(
        result.authoredEndSampleFrame - result.authoredStartSampleFrame,
        Math.max(0, sourceFrames - result.authoredStartSampleFrame),
      );
      expect(decoded.length / channels).toBe(expected);
      let mismatch = -1;
      for (let index = 0; index < expected * channels; index++) {
        if (decoded[index] !== source[result.authoredStartSampleFrame * channels + index]) {
          mismatch = index;
          break;
        }
      }
      expect({ fraction, firstMismatchSample: mismatch }).toEqual({
        fraction,
        firstMismatchSample: -1,
      });
    }
  });

  // MPEG-2.5 (11025/12000/8000 Hz) and the mono/stereo × CBR/VBR grid are not in the committed corpus;
  // encode them here so the version-dependent granule/side-info arithmetic is covered for real.
  const GEOMETRIES = [
    { rate: 11_025, channels: 1, args: ['-b:a', '32k'], label: 'MPEG-2.5 mono 11025 CBR' },
    { rate: 11_025, channels: 2, args: ['-q:a', '7'], label: 'MPEG-2.5 stereo 11025 VBR' },
    { rate: 8_000, channels: 1, args: ['-b:a', '24k'], label: 'MPEG-2.5 mono 8000 CBR' },
    { rate: 24_000, channels: 2, args: ['-b:a', '64k'], label: 'MPEG-2 stereo 24000 CBR' },
    { rate: 48_000, channels: 1, args: ['-q:a', '4'], label: 'MPEG-1 mono 48000 VBR' },
    { rate: 44_100, channels: 2, args: ['-b:a', '320k'], label: 'MPEG-1 stereo 44100 CBR 320k' },
  ] as const;

  it.each(GEOMETRIES)('$label trims exactly at randomized points', async (geometry) => {
    const dir = mkdtempSync(join(tmpdir(), 'mp3-geometry-'));
    try {
      const path = join(dir, 'gen.mp3');
      // A deterministic multi-tone signal: real spectral content, so the bit reservoir is genuinely used.
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=330:sample_rate=${geometry.rate}:duration=4`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=1170:sample_rate=${geometry.rate}:duration=4`,
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2',
        '-ac',
        String(geometry.channels),
        '-c:a',
        'libmp3lame',
        ...geometry.args,
        path,
        '-y',
      ]);
      const bytes = new Uint8Array(readFileSync(path));
      const info = parseMp3(bytes, bytes.byteLength);
      expect(info.sampleRate).toBe(geometry.rate);
      const source = await decodeProgram(bytes);
      expect(source.channels).toBe(geometry.channels);
      expect(source.sampleFrames).toBeGreaterThan(geometry.rate * 3);
      const random = seededRandom(0xc0ff_ee01);
      for (let trial = 0; trial < 8; trial++) {
        const startFrame = Math.floor(random() * source.sampleFrames * 0.8);
        const endFrame = Math.min(
          source.sampleFrames,
          startFrame + 1 + Math.floor(random() * geometry.rate),
        );
        const result = trimMp3Exact(bytes, {
          startSec: startFrame / geometry.rate,
          endSec: endFrame / geometry.rate,
        });
        expect({ trial, adjust: result.startAdjustmentSampleFrames }).toEqual({
          trial,
          adjust: 0,
        });
        expectAuthorableGaplessFields(result, result.bytes);
        expectWindowMatchesSource(source, await decodeProgram(result.bytes), result);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
