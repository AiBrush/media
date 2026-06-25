/**
 * AVI container driver — structural oracle on REAL `.avi` media (BUILD_INSTRUCTIONS §6.1/§6.2).
 *
 * Subject media: two committed real AVIs under `fixtures/media-derived/` — `mjpeg_pcm_160p.avi`
 * (MJPEG + PCM s16) and `mpeg4_mp3_160p.avi` (MPEG-4/XVID + MP3). They are genuine AVI bytes written by
 * ffmpeg from the public-domain WPT `movie_5.mp4` (the container is real AVI; the content is real
 * licensed media). The oracle is **can-fail**, gated on ffprobe ground truth: RIFF/AVI recognition,
 * per-stream codec (from BITMAPINFOHEADER `biCompression` / WAVEFORMATEX `wFormatTag`), coded dims, fps,
 * audio sampleRate/channels, duration (within a frame), and `movi` chunk→stream attribution. A non-RIFF
 * input and a truncated `movi` are handled cleanly; mutation flips the reported codec (anti-cheat).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { AviDriver, AviModule } from './avi-driver.ts';
import { parseAvi } from './avi-parse.ts';

const DERIVED = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

async function bytesFromDerived(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${name}`));
}

/** Real committed AVIs + their ffprobe ground truth (the structural oracle). */
interface AviGolden {
  name: string;
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  audioCodec: string;
  sampleRate: number;
  channels: number;
  /** ffprobe `format=duration` (seconds); the probe duration must land within FRAME_TOLERANCE_SEC. */
  durationSec: number;
  videoFrames: number;
}
const GOLDENS: readonly AviGolden[] = [
  {
    name: 'mjpeg_pcm_160p.avi',
    videoCodec: 'mjpeg',
    width: 160,
    height: 120,
    fps: 24,
    audioCodec: 'pcm',
    sampleRate: 16000,
    channels: 1,
    durationSec: 1.0,
    videoFrames: 24,
  },
  {
    name: 'mpeg4_mp3_160p.avi',
    videoCodec: 'mpeg4',
    width: 160,
    height: 120,
    fps: 24,
    audioCodec: 'mp3',
    sampleRate: 16000,
    channels: 1,
    durationSec: 1.083333,
    videoFrames: 26,
  },
];

/** One video frame at 24 fps — the doc-09 ±1-frame duration tolerance. */
const FRAME_TOLERANCE_SEC = 1 / 24 + 1e-4;

describe('AviDriver.supports', () => {
  it('recognizes AVI by RIFF…AVI magic, mime, and extension; rejects RIFF/WAVE and others', async () => {
    const head = (await bytesFromDerived('mjpeg_pcm_160p.avi')).subarray(0, 16);
    expect(AviDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(AviDriver.supports({ direction: 'demux', mime: 'video/x-msvideo' })).toBe(true);
    expect(AviDriver.supports({ direction: 'demux', extension: 'avi' })).toBe(true);
    // RIFF…WAVE is NOT an AVI (the form type at offset 8 disambiguates).
    const wave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(AviDriver.supports({ direction: 'demux', head: wave })).toBe(false);
    expect(AviDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(AviDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('parseAvi — RIFF/hdrl/strl structural oracle', () => {
  it('yields the video + audio streams with correct stream indices and codecs', async () => {
    const parsed = parseAvi(await bytesFromDerived('mjpeg_pcm_160p.avi'));
    expect(parsed.tracks).toHaveLength(2);
    const [video, audio] = parsed.tracks;
    expect(video?.stream).toMatchObject({ index: 0, mediaType: 'video', codec: 'mjpeg' });
    expect(audio?.stream).toMatchObject({ index: 1, mediaType: 'audio', codec: 'pcm' });
    // Video dims from BITMAPINFOHEADER, audio params from WAVEFORMATEX.
    expect(video?.stream.width).toBe(160);
    expect(video?.stream.height).toBe(120);
    expect(audio?.stream.sampleRate).toBe(16000);
    expect(audio?.stream.channels).toBe(1);
  });

  it('attributes movi data chunks to streams and derives monotonic PTS', async () => {
    const parsed = parseAvi(await bytesFromDerived('mjpeg_pcm_160p.avi'));
    const video = parsed.tracks[0];
    const audio = parsed.tracks[1];
    expect(video?.chunks.length).toBe(24); // 24 MJPEG frames (== ffprobe nb_frames)
    expect((video?.chunks.length ?? 0) > 0).toBe(true);
    expect(audio && audio.chunks.length > 0).toBe(true);
    expect(video?.chunks[0]?.ptsUs).toBe(0);
    expect(video?.chunks[0]?.keyframe).toBe(true); // MJPEG: every frame is intra
    for (const t of parsed.tracks) {
      const pts = t.chunks.map((c) => c.ptsUs);
      for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1] ?? 0);
    }
  });
});

describe('probe across the real AVI corpus — golden structure + frame-accurate duration', () => {
  it.each(GOLDENS)('$name — exact tracks, codecs, dims, fps and duration', async (g) => {
    const info = await createMedia()
      .use(AviModule)
      .probe(fromBytes(await bytesFromDerived(g.name), { mime: 'video/x-msvideo' }));
    expect(info.container).toBe('avi');
    const video = info.tracks.find((t) => t.type === 'video');
    const audio = info.tracks.find((t) => t.type === 'audio');
    expect(video).toMatchObject({ codec: g.videoCodec, width: g.width, height: g.height });
    expect(video?.fps).toBeCloseTo(g.fps, 3);
    expect(audio).toMatchObject({
      codec: g.audioCodec,
      sampleRate: g.sampleRate,
      channels: g.channels,
    });
    expect(info.durationSec).toBeGreaterThan(0);
    expect(Math.abs(info.durationSec - g.durationSec)).toBeLessThanOrEqual(FRAME_TOLERANCE_SEC);
  });
});

describe('demux — packet seam (browser-gated like mp4/mpegts)', () => {
  it('exposes the tracks but the EncodedChunk seam is a typed capability gap in node', async () => {
    const demuxed = await AviDriver.demux(
      fromBytes(await bytesFromDerived('mjpeg_pcm_160p.avi'), { mime: 'video/x-msvideo' }),
    );
    expect(demuxed.tracks).toHaveLength(2);
    expect(demuxed.tracks[0]?.mediaType).toBe('video');
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(99)).toThrowError(MediaError); // unknown track id
    await demuxed.close();
  });

  it('reads a non-seekable stream source (no range) by buffering the whole file', async () => {
    const bytes = await bytesFromDerived('mpeg4_mp3_160p.avi');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            const mid = bytes.byteLength >> 1;
            c.enqueue(bytes.subarray(0, mid)); // two chunks exercise the accumulation path
            c.enqueue(bytes.subarray(mid));
            c.close();
          },
        }),
    };
    const demuxed = await AviDriver.demux(streamSource);
    expect(demuxed.tracks.map((t) => t.codec)).toEqual(['mpeg4', 'mp3']);
    await demuxed.close();
  });
});

describe('robustness — corrupt / non-AVI inputs reject or survive cleanly (§6.2)', () => {
  it('rejects a non-RIFF / non-AVI input', () => {
    expect(() => parseAvi(new Uint8Array(0))).toThrowError(InputError);
    expect(() => parseAvi(new Uint8Array(64))).toThrowError(InputError); // zeroed: no RIFF magic
    // RIFF but WAVE (not AVI) → rejected as not-AVI.
    const wave = new Uint8Array(64);
    wave.set([0x52, 0x49, 0x46, 0x46], 0);
    wave.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(() => parseAvi(wave)).toThrowError(InputError);
  });

  it('survives a tail-truncated AVI (movi cut mid-chunk) — still recovers the stream table', async () => {
    const full = await bytesFromDerived('mjpeg_pcm_160p.avi');
    const truncated = full.subarray(0, Math.floor(full.byteLength * 0.6)); // cut into movi
    const parsed = parseAvi(truncated);
    expect(parsed.tracks.map((t) => t.stream.codec).sort()).toEqual(['mjpeg', 'pcm']);
    // It must not crash and must still expose the (partial) chunk list, not fabricate data.
    expect(parsed.tracks[0]?.chunks.length).toBeGreaterThan(0);
  });
});

describe('anti-cheat — the oracle rejects mutated structure (it can fail)', () => {
  it('flipping the BITMAPINFOHEADER compression 4CC changes the reported codec', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    expect(parseAvi(original).tracks[0]?.stream.codec).toBe('mjpeg');

    // The codec comes from the strf BITMAPINFOHEADER `biCompression` (body offset 16) — NOT the
    // redundant strh `fccHandler` — so we mutate that authoritative field: 'MJPG' → 'H264'.
    const mutated = original.slice();
    const strfIdx = indexOfAscii(mutated, 'strf');
    expect(strfIdx).toBeGreaterThan(0);
    const compressionOff = strfIdx + 8 + 16; // 'strf'(4) + size(4) → biCompression at body+16
    expect(String.fromCharCode(...mutated.subarray(compressionOff, compressionOff + 4))).toBe(
      'MJPG',
    );
    mutated.set([0x48, 0x32, 0x36, 0x34], compressionOff); // 'H264'
    const codec = parseAvi(mutated).tracks.find((t) => t.stream.mediaType === 'video')?.stream
      .codec;
    expect(codec).toBe('h264');
    expect(codec).not.toBe('mjpeg');
  });

  it('flipping the WAVEFORMATEX format tag changes the reported audio codec', async () => {
    const original = await bytesFromDerived('mjpeg_pcm_160p.avi');
    expect(parseAvi(original).tracks[1]?.stream.codec).toBe('pcm');
    // The audio strf is a WAVEFORMATEX with wFormatTag=0x0001 (PCM); the strh fccType 'auds' precedes
    // its strf. Locate 'auds', then the next 'strf' chunk, and flip its first u16 to 0x0055 (MP3).
    const mutated = original.slice();
    const audsIdx = indexOfAscii(mutated, 'auds');
    expect(audsIdx).toBeGreaterThan(0);
    const strfIdx = indexOfAscii(mutated.subarray(audsIdx), 'strf') + audsIdx;
    const fmtTagOff = strfIdx + 8; // 'strf'(4) + size(4) → WAVEFORMATEX body
    mutated[fmtTagOff] = 0x55;
    mutated[fmtTagOff + 1] = 0x00;
    expect(parseAvi(mutated).tracks.find((t) => t.stream.mediaType === 'audio')?.stream.codec).toBe(
      'mp3',
    );
  });
});

/** Byte index of the first ASCII occurrence of `needle` (for locating a 4CC to mutate). */
function indexOfAscii(haystack: Uint8Array, needle: string): number {
  const pat = Uint8Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + pat.length <= haystack.byteLength; i++) {
    for (let j = 0; j < pat.length; j++) if (haystack[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}
