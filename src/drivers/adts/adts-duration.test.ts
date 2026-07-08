/**
 * ADTS EXACT-duration validation (task: the .aac probe over-reported VBR duration by extrapolating
 * bytes-per-sample density over trailing tag/junk bytes). Oracle: ffprobe 8.0 FULL-DECODE truth
 * (`ffprobe -v error -select_streams a:0 -count_frames -show_entries stream=nb_read_frames,sample_rate`)
 * baked as committed numbers for the frozen fixtures under `fixtures/media-derived/adts/` (recipes +
 * sha256 in that directory's README.md). Duration truth = frames × 1024 ÷ header sample rate — for
 * HE-AAC/SBR the header carries the CORE rate and ffmpeg's decode (372 × 2048 @ 44100) equals the same
 * seconds, verified against a real afconvert `aach` stream. Every duration assertion is EXACT (`toBe`
 * on IEEE-754 doubles computed from the baked integers) — no tolerance bands. A live ffprobe
 * re-derivation (skipped only when ffprobe is absent) keeps the baked numbers themselves can-fail.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { AdtsDriver, enumerateAdtsFrames, parseAdts } from './adts-driver.ts';
import { probeAdtsStream, walkAdtsBuffer } from './adts-frames.ts';

const DERIVED = new URL('../../../fixtures/media-derived/adts/', import.meta.url).pathname;

/** One frozen derived fixture + its baked ffprobe-8.0 full-decode golden (see the dir README). */
interface DurationGolden {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  /** ffprobe `nb_read_frames` (decoded AAC frames; for SBR ffprobe decodes 2048-sample frames). */
  readonly frames: number;
  /** ADTS header sampling rate (HE-AAC/SBR: the CORE rate — half the decoded output rate). */
  readonly headerRate: number;
  readonly traits: string;
}

/**
 * Baked 2026-07-08 with ffmpeg/ffprobe 8.0 (recipes in fixtures/media-derived/adts/README.md).
 * durationSec truth = frames × 1024 ÷ headerRate.
 */
const GOLDENS: readonly DurationGolden[] = [
  {
    file: 'speech-vbr-44k-stereo.aac',
    sha256: 'b212cf48ed87d5b613a3c6dc4a5bb553e08925bc62cbf89a479252ccb55168ba',
    bytes: 199_394,
    frames: 739,
    headerRate: 44_100,
    traits: 'true VBR (-q:a 1.2), 44.1 kHz stereo, ~17.16 s',
  },
  {
    file: 'speech-cbr-48k-mono.aac',
    sha256: '0665601b6581c97debccedf7108453741509af18323cd1295e7db908bb44996b',
    bytes: 218_368,
    frames: 805,
    headerRate: 48_000,
    traits: 'rate-controlled CBR (-b:a 96k), 48 kHz mono, ~17.17 s',
  },
  {
    file: 'speech-vbr-lead-id3v2.aac',
    sha256: '7da8f4f9f48e2c62cc8affbbbfd19a53ec0b9a1d9f6aaae568a173c013e88ab4',
    bytes: 219_018,
    frames: 739,
    headerRate: 44_100,
    traits: 'leading 19,496-byte ID3v2.3 tag (APIC art) + trailing 128-byte ID3v1',
  },
  {
    file: 'speech-vbr-trail-id3v2.aac',
    sha256: '68fc0ea98a9a1a379a2c5bb62f414ee3aa4ba4dff052f5770c0e0d09764eb02b',
    bytes: 218_890,
    frames: 739,
    headerRate: 44_100,
    traits: 'TRAILING 19,496-byte ID3v2.3 tag — the VBR overestimate repro (was +1.68 s)',
  },
  {
    file: 'speech-heaac-sbr.aac',
    sha256: 'f89146a1b0dc9e9c4dbf4422d82b87e85287cbf0833c2ea7bbe25c6b5c53048f',
    bytes: 99_410,
    frames: 372,
    headerRate: 22_050,
    traits: 'real HE-AAC v1/SBR (afconvert aach): header carries the CORE 22.05 kHz rate',
  },
  {
    file: 'speech-vbr-long-64s-mono.aac',
    sha256: '3fc3b636c7a6541800a3dcbce13ab33df5401b244525a01f7bbfc362dda40323',
    bytes: 658_687,
    frames: 2758,
    headerRate: 44_100,
    traits: 'long-form VBR, 64 s mono 44.1 kHz',
  },
];

function goldenDurationSec(g: DurationGolden): number {
  return (g.frames * 1024) / g.headerRate;
}

async function loadDerived(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${file}`));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Whether ffprobe (the independent full-decode reference) is installed. */
function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fresh ffprobe full-decode: `{ nbReadFrames, sampleRate }` for the first audio stream. */
function ffprobeDecodeStats(path: string): { nbReadFrames: number; sampleRate: number } {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames,sample_rate',
      '-of',
      'default=noprint_wrappers=1',
      path,
    ],
    { encoding: 'utf8' },
  );
  const frames = /nb_read_frames=(\d+)/.exec(out);
  const rate = /sample_rate=(\d+)/.exec(out);
  if (frames?.[1] === undefined || rate?.[1] === undefined) {
    throw new Error(`ffprobe gave no decode stats for ${path}: ${out}`);
  }
  return { nbReadFrames: Number(frames[1]), sampleRate: Number(rate[1]) };
}

/** A range-capable ByteSource that records every read so bounded-read behavior is assertable. */
function instrumentedSource(
  bytes: Uint8Array,
  log: number[],
): ByteSource & { readonly reads: number[] } {
  return {
    reads: log,
    size: bytes.byteLength,
    range: (start: number, end: number): Promise<Uint8Array> => {
      log.push(end - start);
      return Promise.resolve(bytes.subarray(start, end));
    },
    stream: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(bytes);
          c.close();
        },
      }),
  };
}

/** A stream-only ByteSource (no `range`, no `size`) emitting fixed-size chunks. */
function chunkedStreamSource(bytes: Uint8Array, chunkBytes: number): ByteSource {
  return {
    stream: (): ReadableStream<Uint8Array> => {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(c): void {
          if (offset >= bytes.byteLength) {
            c.close();
            return;
          }
          const next = Math.min(offset + chunkBytes, bytes.byteLength);
          c.enqueue(bytes.subarray(offset, next));
          offset = next;
        },
      });
    },
  };
}

/** Deterministic pseudo-random junk (xorshift32) with a fake 0xFFF sync planted mid-way. */
function junkBlock(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  // Plant a fake ADTS-looking sync whose declared frame body is garbage: the resync guard must
  // reject it via the double-sync confirmation instead of locking on and mis-framing the stream.
  const mid = Math.floor(length / 2);
  out.set([0xff, 0xf1, 0x50, 0x80, 0x0f, 0xff, 0xfc], mid);
  return out;
}

/** Splice `junk` into `bytes` immediately after frame `afterFrame` of the real stream. */
function withMidStreamJunk(bytes: Uint8Array, afterFrame: number, junk: Uint8Array): Uint8Array {
  const frames = enumerateAdtsFrames(bytes);
  const frame = frames[afterFrame];
  if (frame === undefined) throw new Error(`fixture has no frame ${afterFrame}`);
  const cut = frame.offset + frame.size;
  const out = new Uint8Array(bytes.byteLength + junk.byteLength);
  out.set(bytes.subarray(0, cut), 0);
  out.set(junk, cut);
  out.set(bytes.subarray(cut), cut + junk.byteLength);
  return out;
}

/** An ID3v2 header (10 bytes) + zero-padded body; `withFooter` builds a v2.4 tag with its footer. */
function id3v2Block(bodySize: number, withFooter = false): Uint8Array {
  const out = new Uint8Array(10 + bodySize + (withFooter ? 10 : 0));
  out.set([0x49, 0x44, 0x33, withFooter ? 0x04 : 0x03, 0x00, withFooter ? 0x10 : 0x00]);
  out[6] = (bodySize >> 21) & 0x7f;
  out[7] = (bodySize >> 14) & 0x7f;
  out[8] = (bodySize >> 7) & 0x7f;
  out[9] = bodySize & 0x7f;
  if (withFooter) {
    out.set([0x33, 0x44, 0x49, 0x04, 0x00, 0x10], 10 + bodySize); // '3DI' footer mirror
    out[10 + bodySize + 6] = (bodySize >> 21) & 0x7f;
    out[10 + bodySize + 7] = (bodySize >> 14) & 0x7f;
    out[10 + bodySize + 8] = (bodySize >> 7) & 0x7f;
    out[10 + bodySize + 9] = bodySize & 0x7f;
  }
  return out;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe('ADTS exact duration — frozen real corpus vs baked ffprobe full-decode goldens', () => {
  for (const golden of GOLDENS) {
    it(`${golden.file} — ${golden.traits}`, async () => {
      const bytes = await loadDerived(golden.file);
      expect(bytes.byteLength, 'frozen fixture byte size').toBe(golden.bytes);
      expect(sha256Hex(bytes), 'frozen fixture sha256').toBe(golden.sha256);

      const truth = goldenDurationSec(golden);

      // Driver-level parse: exact frame count, header rate, and EXACT duration (no estimation).
      const info = parseAdts(bytes);
      expect(info.frames, 'walked frame count == ffprobe decoded frame count').toBe(golden.frames);
      expect(info.sampleRate).toBe(golden.headerRate);
      expect(info.durationSec, 'parseAdts duration is exact').toBe(truth);

      // Engine probe (the graded seam): identical exact duration.
      const probed = await createMedia().probe(fromBytes(bytes, { mime: 'audio/aac' }));
      expect(probed.container).toBe('adts');
      expect(probed.durationSec, 'engine probe duration is exact').toBe(truth);
      expect(probed.tracks[0]?.durationSec).toBe(truth);

      // Bounded windowed walk (the probe transport): same totals from 64 KiB windows.
      const stats = await probeAdtsStream(fromBytes(bytes, { mime: 'audio/aac' }), {
        windowBytes: 64 * 1024,
      });
      expect(stats.frames).toBe(golden.frames);
      expect(stats.durationSec).toBe(truth);
    });
  }

  it('re-derives every baked golden with a fresh ffprobe full decode (independent tool)', async () => {
    if (!hasFfprobe()) {
      console.warn('[adts-duration] no ffprobe on PATH — baked-golden re-derivation skipped');
      return;
    }
    for (const golden of GOLDENS) {
      const fresh = ffprobeDecodeStats(`${DERIVED}${golden.file}`);
      expect(fresh.nbReadFrames, `${golden.file} nb_read_frames`).toBe(golden.frames);
      // ffprobe reports the DECODED rate: the core rate, except SBR where it is doubled and the
      // decoded frames carry 2048 samples — either way frames × 1024 ÷ headerRate is the duration.
      const decodedRateRatio = fresh.sampleRate / golden.headerRate;
      expect(decodedRateRatio === 1 || decodedRateRatio === 2).toBe(true);
    }
  }, 120_000);
});

describe('ADTS exact duration — tag/junk/truncation robustness (the failing modes)', () => {
  it('a trailing ID3v2 tag adds ZERO seconds (was +1.68 s via density extrapolation)', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const tagged = await loadDerived('speech-vbr-trail-id3v2.aac');
    expect(parseAdts(tagged).durationSec).toBe(parseAdts(clean).durationSec);
    expect(enumerateAdtsFrames(tagged)).toHaveLength(739);
  });

  it('a trailing ID3v1 tag adds ZERO seconds (was +11 ms on the lead-id3v2 fixture)', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]); // 'TAG'
    expect(parseAdts(concatBytes(clean, id3v1)).durationSec).toBe(parseAdts(clean).durationSec);
  });

  it('mid-stream junk (with a planted fake syncword) resyncs and keeps the exact frame count', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const junk = junkBlock(256, 0xc0ffee);
    const corrupted = withMidStreamJunk(clean, 100, junk);

    const stats = walkAdtsBuffer(corrupted);
    expect(stats.frames).toBe(739);
    expect(stats.junkBytes).toBe(256);
    expect(stats.durationSec).toBe((739 * 1024) / 44_100);

    // Packet enumeration resyncs identically: frame 101 starts right after the junk, and the PTS
    // clock stays on the nominal 1024-sample cadence (no phantom gap seconds).
    const cleanFrames = enumerateAdtsFrames(clean);
    const frames = enumerateAdtsFrames(corrupted);
    expect(frames).toHaveLength(cleanFrames.length);
    const before = frames[100];
    const after = frames[101];
    if (before === undefined || after === undefined) throw new Error('missing resync frames');
    expect(after.offset).toBe(before.offset + before.size + junk.byteLength);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]?.ptsUs).toBe(Math.round((i * 1024 * 1_000_000) / 44_100));
    }
  });

  it('a truncated final frame is excluded from the duration (matches decode truth)', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const truncated = clean.subarray(0, clean.byteLength - 37);
    const stats = walkAdtsBuffer(truncated);
    expect(stats.frames).toBe(738);
    expect(stats.truncated).toBe(true);
    expect(stats.durationSec).toBe((738 * 1024) / 44_100);
    expect(parseAdts(truncated).frames).toBe(738);
  });

  it('stacked leading ID3v2 tags — including one with a footer — are all skipped exactly', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const stacked = concatBytes(id3v2Block(300), id3v2Block(150, true), clean);
    const stats = walkAdtsBuffer(stacked);
    expect(stats.frames).toBe(739);
    expect(stats.durationSec).toBe((739 * 1024) / 44_100);
    const frames = enumerateAdtsFrames(stacked);
    expect(frames[0]?.offset).toBe(310 + 170); // both tags (10+300, 10+150+10-footer) skipped
  });

  it('an ID3v2 tag larger than one probe window is skipped without reading its bytes', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const tagged = concatBytes(id3v2Block(96 * 1024), clean);
    const reads: number[] = [];
    const stats = await probeAdtsStream(instrumentedSource(tagged, reads), {
      windowBytes: 16 * 1024,
    });
    expect(stats.frames).toBe(739);
    expect(stats.durationSec).toBe((739 * 1024) / 44_100);
    expect(Math.max(...reads), 'no read exceeds the window').toBeLessThanOrEqual(16 * 1024);
    const totalRead = reads.reduce((a, b) => a + b, 0);
    expect(totalRead, 'the tag body is seeked over, not read').toBeLessThan(tagged.byteLength);
  });

  it('trailing APE/LYRICS-style tag blocks add zero seconds', async () => {
    const clean = await loadDerived('speech-vbr-44k-stereo.aac');
    const ape = concatBytes(
      new Uint8Array([0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58]), // 'APETAGEX'
      junkBlock(96, 0xbadcafe),
    );
    expect(parseAdts(concatBytes(clean, ape)).durationSec).toBe((739 * 1024) / 44_100);
  });

  it('rejects pure garbage and empty inputs with typed InputError', () => {
    expect(() => walkAdtsBuffer(new Uint8Array(0))).toThrowError(InputError);
    expect(() => walkAdtsBuffer(junkBlock(4096, 0xdead00d))).toThrowError(InputError);
    expect(() => parseAdts(junkBlock(4096, 0xdead00d))).toThrowError(InputError);
  });
});

describe('AdtsDriver.probe — bounded-read metadata-only probe', () => {
  it('is wired on the driver and matches the demux-derived track facts on sfx.adts', async () => {
    const probe = AdtsDriver.probe;
    if (probe === undefined) throw new Error('AdtsDriver must expose the bounded probe');
    const bytes = await loadFixture('sfx.adts');
    const tracks = await probe.call(AdtsDriver, fromBytes(bytes, { mime: 'audio/aac' }));
    const demuxed = await AdtsDriver.demux(fromBytes(bytes, { mime: 'audio/aac' }));
    expect(tracks).toEqual(demuxed.tracks);
    await demuxed.close();
  });

  it('probes a long file through small windows: every read bounded, none materializes the file', async () => {
    const probe = AdtsDriver.probe;
    if (probe === undefined) throw new Error('AdtsDriver must expose the bounded probe');
    const bytes = await loadDerived('speech-vbr-long-64s-mono.aac');
    const reads: number[] = [];
    const src = instrumentedSource(bytes, reads);
    const stats = await probeAdtsStream(src, { windowBytes: 32 * 1024 });
    expect(stats.durationSec).toBe((2758 * 1024) / 44_100);
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(32 * 1024);
  });

  it('probes a stream-only source (no range/size) in odd-sized chunks to the same exact duration', async () => {
    const bytes = await loadDerived('speech-vbr-44k-stereo.aac');
    const stats = await probeAdtsStream(chunkedStreamSource(bytes, 1009));
    expect(stats.frames).toBe(739);
    expect(stats.durationSec).toBe((739 * 1024) / 44_100);
  });

  it('walks sfx.adts through a pathologically tiny window without drift', async () => {
    const bytes = await loadFixture('sfx.adts');
    const stats = await probeAdtsStream(fromBytes(bytes, { mime: 'audio/aac' }), {
      windowBytes: 61,
    });
    expect(stats.frames).toBe(10);
    expect(stats.durationSec).toBe(10_240 / 48_000);
  });

  it('keeps typed errors: aborted signal, channel-config 0, reserved frequency index', async () => {
    const probe = AdtsDriver.probe;
    if (probe === undefined) throw new Error('AdtsDriver must expose the bounded probe');
    const bytes = await loadFixture('sfx.adts');
    await expect(
      probe.call(AdtsDriver, fromBytes(bytes, { mime: 'audio/aac' }), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrowError(/abort/i);

    // channel_configuration 0 (PCE-carried) mirrors the demux path's typed MediaError.
    const chCfg0 = new Uint8Array([0xff, 0xf1, 0x4c, 0x20, 0x01, 0xa0, 0xfc, 0, 0, 0, 0, 0, 0]);
    await expect(probe.call(AdtsDriver, fromBytes(chCfg0))).rejects.toThrowError(
      /channel configuration 0/,
    );

    // A reserved sampling-frequency index on the first header stays a MediaError, not a hang.
    const reserved = new Uint8Array([0xff, 0xf1, 0x74, 0x80, 0x01, 0xa0, 0xfc, 0, 0, 0, 0, 0, 0]);
    await expect(probe.call(AdtsDriver, fromBytes(reserved))).rejects.toThrowError(
      /sampling-frequency/,
    );
    expect(() => parseAdts(reserved)).toThrowError(MediaError);
  });
});
