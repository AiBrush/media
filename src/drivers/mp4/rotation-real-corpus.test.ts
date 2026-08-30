/**
 * Real-corpus rotation matrix: five independently-authored inputs spanning H.264, HEVC, VFR, MOV,
 * 90/180/270 degrees, and identity. ffmpeg authors the missing angle variants by packet-copying the
 * genuine repository fixtures; ffprobe and ffmpeg decode are independent structural/pixel oracles.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebmMuxer } from '../webm/ebml-write.ts';
import { parseWebm } from '../webm/webm-driver.ts';
import { fragmentMp4 } from './fragment.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { buildSamples } from './samples.ts';
import type { MuxTrackInput } from './write.ts';
import { writeMp4 } from './write.ts';

const MEDIA_DIR = new URL('../../../fixtures/media/', import.meta.url).pathname;

interface RotationCase {
  readonly fixture: string;
  readonly expectedRotation: 0 | 90 | 180 | 270;
  readonly codec: 'h264' | 'hevc';
  /** ffmpeg input display rotation (CCW-positive); omitted means retain the fixture's native matrix. */
  readonly ffmpegRotation?: number;
  readonly vfr?: true;
  readonly decodeHash: boolean;
}

const CASES: readonly RotationCase[] = [
  {
    fixture: 'bear-rotate-90.mp4',
    expectedRotation: 90,
    codec: 'h264',
    decodeHash: true,
  },
  {
    fixture: 'h264.mp4',
    ffmpegRotation: 180,
    expectedRotation: 180,
    codec: 'h264',
    decodeHash: true,
  },
  {
    fixture: 'h265.mp4',
    ffmpegRotation: 90,
    expectedRotation: 270,
    codec: 'hevc',
    decodeHash: true,
  },
  {
    fixture: 'obs-remux-variable-aac.mp4',
    ffmpegRotation: -90,
    expectedRotation: 90,
    codec: 'h264',
    vfr: true,
    // 377 1080p frames make three software-decode passes disproportionate; packet+ffprobe truth remains exact.
    decodeHash: false,
  },
  {
    fixture: 'movie_5.mp4',
    expectedRotation: 0,
    codec: 'h264',
    decodeHash: true,
  },
];

function externalToolsAvailable(): boolean {
  return (
    spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
    spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
  );
}

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return concat(chunks);
}

function rotatedSource(row: RotationCase, directory: string): string {
  const input = join(MEDIA_DIR, row.fixture);
  if (row.ffmpegRotation === undefined) return input;
  const output = join(directory, `source-${row.expectedRotation}-${row.fixture}`);
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-display_rotation:v:0',
      String(row.ffmpegRotation),
      '-i',
      input,
      '-map',
      '0',
      '-c',
      'copy',
      output,
    ],
    { stdio: 'ignore' },
  );
  return output;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetTruth(tracks: readonly MuxTrackInput[]) {
  return tracks.map((track) => ({
    mediaType: track.mediaType,
    sampleEntryType: track.sampleEntryType,
    timescale: track.timescale,
    samples: track.samples.map((sample) => ({
      durationTicks: sample.durationTicks,
      cttsTicks: sample.cttsTicks,
      keyframe: sample.keyframe,
      byteLength: sample.data.byteLength,
      sha256: sha256(sample.data),
    })),
  }));
}

interface FfprobeStream {
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly side_data_list?: ReadonlyArray<{
    readonly rotation?: number;
    readonly displaymatrix?: string;
  }>;
}

function ffprobeDisplay(path: string) {
  const parsed = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height:stream_side_data=rotation,displaymatrix',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  ) as { streams?: FfprobeStream[] };
  const stream = parsed.streams?.[0];
  if (stream === undefined) throw new Error(`ffprobe found no video stream in ${path}`);
  const display = stream.side_data_list?.find(
    (side) => side.rotation !== undefined || side.displaymatrix !== undefined,
  );
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    rotation: display?.rotation ?? 0,
    displaymatrix: display?.displaymatrix,
  };
}

interface FfprobePacket {
  readonly stream_index: number;
  readonly pts?: number;
  readonly dts?: number;
  readonly duration?: number;
  readonly size?: string;
  readonly flags?: string;
}

/** Group by stream because an MP4 is free to change inter-track byte interleave without changing packets. */
function ffprobePackets(
  path: string,
): Record<string, readonly Omit<FfprobePacket, 'stream_index'>[]> {
  const parsed = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_packets',
        '-show_entries',
        'packet=stream_index,pts,dts,duration,size,flags',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as { packets?: FfprobePacket[] };
  const grouped: Record<string, Array<Omit<FfprobePacket, 'stream_index'>>> = {};
  for (const { stream_index: streamIndex, ...packet } of parsed.packets ?? []) {
    const key = String(streamIndex);
    const packets = grouped[key] ?? [];
    packets.push(packet);
    grouped[key] = packets;
  }
  return grouped;
}

function decodedFrameHashes(path: string): string[] {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-threads', '1', '-i', path, '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) =>
      line
        .split(',')
        .slice(-2)
        .map((field) => field.trim())
        .join(':'),
    );
}

describe('MP4/MOV real rotation corpus vs ffmpeg/ffprobe', () => {
  const haveExternalTruth = externalToolsAvailable();

  it.each(CASES)(
    '$fixture -> $expectedRotation° preserves raw transform, packets, probe truth, and decoded pixels',
    async (row) => {
      if (!haveExternalTruth) {
        console.warn(
          '[rotation-real-corpus] ffmpeg/ffprobe missing; external rotation oracle skipped',
        );
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), 'aibrush-rotation-corpus-'));
      try {
        const sourcePath = rotatedSource(row, directory);
        const source = new Uint8Array(readFileSync(sourcePath));
        const sourceMovie = await readMovie(randomAccess(source));
        const sourceVideo = sourceMovie.tracks.find((track) => track.mediaType === 'video');
        expect(sourceVideo).toBeDefined();
        if (sourceVideo === undefined) return;
        expect(sourceVideo.rotation ?? 0).toBe(row.expectedRotation);
        expect(sourceVideo.displayTransform).toBeDefined();
        expect(
          row.codec === 'h264'
            ? sourceVideo.codec.startsWith('avc')
            : sourceVideo.codec.startsWith('hvc') || sourceVideo.codec.startsWith('hev'),
        ).toBe(true);
        if (row.vfr === true) {
          expect(new Set(sourceVideo.samples.timeToSample.deltas).size).toBeGreaterThan(1);
        }

        const sourceTracks = await muxTracksFromMovie(randomAccess(source), sourceMovie);
        const expectedPackets = packetTruth(sourceTracks);
        const progressive = writeMp4(sourceTracks, {
          brand: sourceMovie.brand.trim() === 'qt' ? 'mov' : 'mp4',
        });
        const fragmented = concat(fragmentMp4(sourceTracks));
        const progressivePath = join(directory, 'progressive.mp4');
        const fragmentedPath = join(directory, 'fragmented.mp4');
        writeFileSync(progressivePath, progressive);
        writeFileSync(fragmentedPath, fragmented);

        for (const output of [progressive, fragmented]) {
          const movie = await readMovie(randomAccess(output));
          const video = movie.tracks.find((track) => track.mediaType === 'video');
          expect(video?.displayTransform).toEqual(sourceVideo.displayTransform);
          expect(video?.rotation ?? 0).toBe(row.expectedRotation);
          expect(packetTruth(await muxTracksFromMovie(randomAccess(output), movie))).toEqual(
            expectedPackets,
          );
        }

        const sourceDisplay = ffprobeDisplay(sourcePath);
        expect(ffprobeDisplay(progressivePath)).toEqual(sourceDisplay);
        expect(ffprobeDisplay(fragmentedPath)).toEqual(sourceDisplay);
        const sourcePacketTruth = ffprobePackets(sourcePath);
        expect(ffprobePackets(progressivePath)).toEqual(sourcePacketTruth);
        expect(ffprobePackets(fragmentedPath)).toEqual(sourcePacketTruth);

        if (row.decodeHash) {
          const decoded = decodedFrameHashes(sourcePath);
          expect(decodedFrameHashes(progressivePath)).toEqual(decoded);
          expect(decodedFrameHashes(fragmentedPath)).toEqual(decoded);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.each(CASES)(
    '$fixture -> Matroska ProjectionPoseRoll preserves presentation and coded geometry',
    async (row) => {
      if (!haveExternalTruth) {
        console.warn('[rotation-real-corpus] ffmpeg/ffprobe missing; Matroska oracle skipped');
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), 'aibrush-rotation-matroska-'));
      try {
        const sourcePath = rotatedSource(row, directory);
        const source = new Uint8Array(readFileSync(sourcePath));
        const sourceMovie = await readMovie(randomAccess(source));
        const video = sourceMovie.tracks.find((track) => track.mediaType === 'video');
        expect(video).toBeDefined();
        if (video === undefined) return;

        const muxer = new WebmMuxer(undefined, 'matroska');
        const trackId = muxer.addTrack({
          id: video.id,
          mediaType: 'video',
          codec: video.codec,
          durationSec: video.durationSec,
          ...(video.fps !== undefined ? { fps: video.fps } : {}),
          ...(video.rotation !== undefined ? { rotation: video.rotation } : {}),
          config: video.config,
        });
        for (const sample of buildSamples(video)) {
          muxer.addChunkStruct(trackId, {
            timestampUs: sample.ptsUs,
            durationUs: sample.durationUs,
            dtsUs: sample.dtsUs,
            key: sample.keyframe,
            data: source.slice(sample.offset, sample.offset + sample.size),
          });
        }
        const outputPromise = collect(muxer.output);
        await muxer.finalize();
        const output = await outputPromise;
        const outputPath = join(directory, 'output.mkv');
        writeFileSync(outputPath, output);

        const parsed = parseWebm(output, { scanClusters: true });
        const parsedVideo = parsed.tracks.find((track) => track.mediaType === 'video');
        expect(parsedVideo?.rotation ?? 0).toBe(row.expectedRotation);
        expect(parsedVideo?.width).toBe(video.width);
        expect(parsedVideo?.height).toBe(video.height);

        const sourceDisplay = ffprobeDisplay(sourcePath);
        const outputDisplay = ffprobeDisplay(outputPath);
        expect({
          codec: outputDisplay.codec,
          width: outputDisplay.width,
          height: outputDisplay.height,
          rotation: outputDisplay.rotation,
        }).toEqual({
          codec: sourceDisplay.codec,
          width: sourceDisplay.width,
          height: sourceDisplay.height,
          rotation: sourceDisplay.rotation,
        });

        if (row.decodeHash) {
          expect(decodedFrameHashes(outputPath)).toEqual(decodedFrameHashes(sourcePath));
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
