#!/usr/bin/env bun
import { probe } from '@aibrush/media';
import { arg, readMediaFile } from './util.ts';

const args = Bun.argv.slice(2);
const inputPath = arg(args, 0, 'input path');

const input = await readMediaFile(inputPath);
const info = await probe(input);

console.info(JSON.stringify(info, null, 2));
