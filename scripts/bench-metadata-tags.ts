#!/usr/bin/env bun
/**
 * Multi-sample benchmark for Session 6 R2 metadata tag writers. Each row rewrites real fixture bytes with
 * structural tags and feeds one output byte into a checksum sink so the work cannot be elided.
 */

import { readFile } from 'node:fs/promises';
import { writeMp3Id3Tags } from '../src/metadata/id3.ts';
import { writeMkvTags } from '../src/metadata/matroska-tags.ts';
import { writeMp4Tags } from '../src/metadata/mp4-tags.ts';
import { writeOggVorbisComment } from '../src/metadata/ogg-vorbis-comment.ts';
import { writeFlacVorbisComment } from '../src/metadata/vorbis-comment.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const WARMUP = 3;
const ITERS = 21;

const TAGS = {
  title: 'Conformance Clip',
  artist: 'aibrush-media-test',
  album: 'Suite Vol. 1',
  comment: 'metadata:write benchmark - '.repeat(12),
  date: '2026-06-18',
  genre: 'Test',
  trackNumber: '7',
};

const CASES = [
  {
    name: 'metadata/write_mp4_tags',
    files: ['h264.mp4', 'movie_5.mp4', 'test.mp4', '2x2-green.mp4', 'av1.mp4'],
    write: writeMp4Tags,
  },
  {
    name: 'metadata/write_mp3_id3',
    files: ['sound_5.mp3', 'bear-vbr-toc.mp3'],
    write: writeMp3Id3Tags,
  },
  {
    name: 'metadata/write_flac_vorbiscomment',
    files: [
      'sfx.flac',
      'flac-08bit.flac',
      'flac-12bit.flac',
      'flac-24bit-hires.flac',
      'flac-wasted-bits.flac',
    ],
    write: writeFlacVorbisComment,
  },
  {
    name: 'metadata/write_ogg_vorbiscomment',
    files: ['sfx-opus.ogg', 'sound_5.oga'],
    write: writeOggVorbisComment,
  },
  {
    name: 'metadata/write_mkv_tags',
    files: [
      'movie_5.webm',
      'bear-opus.webm',
      '2x2-green.webm',
      'white.webm',
      'bear-vp9-alpha.webm',
    ],
    write: writeMkvTags,
  },
] as const;

let sink = 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function timeCase(item: (typeof CASES)[number]): Promise<void> {
  const fixtures = await Promise.all(
    item.files.map(async (file) => new Uint8Array(await readFile(`${MEDIA_DIR}/${file}`))),
  );
  const totalBytes = fixtures.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const run = (): number => {
    let local = 0;
    for (const bytes of fixtures) {
      const output = item.write(bytes, TAGS);
      local = (local + (output[output.byteLength - 1] ?? 0) + output.byteLength) | 0;
    }
    return local;
  };
  for (let i = 0; i < WARMUP; i++) sink = (sink + run()) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const start = performance.now();
    sink = (sink + run()) | 0;
    samples.push(performance.now() - start);
  }
  const wallMs = median(samples);
  const mbps = totalBytes / (1024 * 1024) / (wallMs / 1000);
  console.info(
    `${item.name}: files=${fixtures.length} medianMs=${wallMs.toFixed(3)} throughputMBps=${mbps.toFixed(2)}`,
  );
}

for (const item of CASES) await timeCase(item);
console.info(`checksum=${sink}`);
