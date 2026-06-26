#!/usr/bin/env bun
import { convert } from '@aibrush/media';
import type { Container, ConvertOptions } from '@aibrush/media';
import { arg, containerFromPath, readMediaFile, writeOutputFile } from './util.ts';

const args = Bun.argv.slice(2);
const inputPath = arg(args, 0, 'input path');
const outputPath = arg(args, 1, 'output path');

const input = await readMediaFile(inputPath);
const container = containerFromPath(outputPath);
const output = await convert(input, convertOptions(container));
await writeOutputFile(outputPath, output);

console.info(`wrote ${outputPath}`);

function convertOptions(container: Container): ConvertOptions {
  if (container === 'wav' || container === 'aiff' || container === 'caf') {
    return {
      to: container,
      video: false,
      audio: { codec: 'pcm-s16', sampleRate: 48_000 },
    };
  }
  if (container === 'webm' || container === 'mkv') {
    return {
      to: container,
      video: { codec: 'vp9', height: 720, fit: 'contain' },
      audio: { codec: 'opus', sampleRate: 48_000 },
    };
  }
  return {
    to: container,
    video: { codec: 'h264', height: 720, fit: 'contain' },
    audio: { codec: 'aac', sampleRate: 48_000 },
    faststart: container === 'mp4' || container === 'mov',
  };
}
