#!/usr/bin/env bun

import { type RgbaImage, geometryToRgba, planCpuGeometry } from '../src/filters/cpu-video.ts';

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 360;
const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 480;
const WARMUP = 3;
const SAMPLES = 21;

const data = new Uint8ClampedArray(SOURCE_WIDTH * SOURCE_HEIGHT * 4);
for (let offset = 0; offset < data.length; offset += 4) {
  data[offset] = (offset >>> 2) & 0xff;
  data[offset + 1] = (offset >>> 10) & 0xff;
  data[offset + 2] = 127;
  data[offset + 3] = 255;
}
const image: RgbaImage = { data, width: SOURCE_WIDTH, height: SOURCE_HEIGHT };
const recipe = planCpuGeometry(
  {
    mediaType: 'video',
    type: 'pad',
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    x: (OUTPUT_WIDTH - SOURCE_WIDTH) / 2,
    y: (OUTPUT_HEIGHT - SOURCE_HEIGHT) / 2,
  },
  SOURCE_WIDTH,
  SOURCE_HEIGHT,
);
let sink = 0;

function execute(): number {
  const output = geometryToRgba(recipe, image);
  return output.data[(OUTPUT_WIDTH * OUTPUT_HEIGHT - 1) * 4 + 3] ?? 0;
}

for (let index = 0; index < WARMUP; index++) sink += execute();
const elapsed: number[] = [];
for (let sample = 0; sample < SAMPLES; sample++) {
  const start = Bun.nanoseconds();
  sink += execute();
  elapsed.push((Bun.nanoseconds() - start) / 1_000_000);
}
elapsed.sort((a, b) => a - b);
const medianMs = elapsed[elapsed.length >>> 1] ?? 0;
const megapixelsPerSecond = (OUTPUT_WIDTH * OUTPUT_HEIGHT) / (medianMs / 1_000) / 1_000_000;
console.log(
  `video.pad-cpu-640x360-to-720x480: median=${medianMs.toFixed(3)}ms ` +
    `throughput=${megapixelsPerSecond.toFixed(1)}MPix/s sink=${sink}`,
);
