#!/usr/bin/env bun
import { InputError, trim } from '@aibrush/media';
import type { TrimOptions } from '@aibrush/media';
import { arg, numberArg, readMediaFile, writeOutputFile } from './util.ts';

const args = Bun.argv.slice(2);
const inputPath = arg(args, 0, 'input path');
const outputPath = arg(args, 1, 'output path');
const start = numberArg(args, 2, 'start seconds');
const end = numberArg(args, 3, 'end seconds');
const mode = trimMode(args[4]);

const input = await readMediaFile(inputPath);
const output = await trim(input, { start, end, mode });
await writeOutputFile(outputPath, output);

console.info(`wrote ${outputPath}`);

function trimMode(raw: string | undefined): TrimOptions['mode'] {
  if (raw === undefined || raw === 'keyframe') return 'keyframe';
  if (raw === 'accurate') return 'accurate';
  throw new InputError(
    'unsupported-input',
    `trim mode must be 'keyframe' or 'accurate', got '${raw}'`,
  );
}
