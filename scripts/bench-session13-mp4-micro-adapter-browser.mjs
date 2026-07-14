#!/usr/bin/env node
/** Exact browser-harness micro-MP4 profile: raw GET/Range controls versus the complete adapter call. */

import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const BASE_URL = process.env.AIBRUSH_BENCH_BASE_URL ?? 'http://localhost:5174';
const FIXTURE_URL = `${BASE_URL}/fixtures/media/micro_h264_1frame.mp4`;
const WARMUP = 7;
const SAMPLES = 31;

const fixtureResponse = await fetch(FIXTURE_URL, { cache: 'no-store' });
if (!fixtureResponse.ok) throw new Error(`fixture discovery failed: ${fixtureResponse.status}`);
const fixtureBytes = (await fixtureResponse.arrayBuffer()).byteLength;
if (fixtureBytes <= 0) throw new Error('fixture discovery returned an empty response');

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/index.html?autorun=0`);
  const report = await page.evaluate(
    async ({ fixtureBytes, fixtureUrl, samples, warmup }) => {
      const registry = await import('/src/core/registry.ts');
      const { registerAibrushMedia } = await import('/src/engines/aibrush-media/adapter.ts');
      const { Meter } = await import('/src/core/measure.ts');
      registry.__resetRegistry();
      registerAibrushMedia();
      const registered = registry.getEngine('aibrush-media');
      if (registered === undefined) throw new Error('aibrush adapter did not register');
      const engine = registered.factory();
      await engine.init();
      const modes = [
        'adapter',
        'adapter-outer-timeout',
        'adapter-meter',
        'adapter-runner-shape',
        'raw-get',
        'raw-range',
        'raw-range-high',
      ];
      const timings = Object.fromEntries(modes.map((mode) => [mode, []]));
      let sequence = 0;
      const input = () => ({
        id: 'micro_h264_1frame.mp4',
        url: `${fixtureUrl}?profile=${sequence++}`,
        mime: 'video/mp4',
        sizeBytes: fixtureBytes,
        mutated: false,
        async arrayBuffer() {
          const response = await fetch(this.url);
          if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
          return response.arrayBuffer();
        },
        async blob() {
          return new Blob([await this.arrayBuffer()], { type: 'video/mp4' });
        },
      });
      const assertTruth = (metadata) => {
        const track = metadata.tracks[0];
        if (
          metadata.container !== 'mp4' ||
          metadata.durationSec !== 1 ||
          metadata.tracks.length !== 1 ||
          track?.type !== 'video' ||
          track.codec !== 'h264' ||
          track.width !== 320 ||
          track.height !== 240 ||
          track.fps !== 1
        ) {
          throw new Error(`incorrect adapter truth: ${JSON.stringify(metadata)}`);
        }
      };
      const raw = async (range, priority) => {
        const url = `${fixtureUrl}?profile=${sequence++}`;
        const response = await fetch(url, {
          cache: 'no-store',
          ...(range === undefined ? {} : { headers: { Range: range } }),
          ...(priority === undefined ? {} : { priority }),
        });
        const bytes = await response.arrayBuffer();
        if (!response.ok || bytes.byteLength !== fixtureBytes) {
          throw new Error(`raw ${response.status} returned ${bytes.byteLength} bytes`);
        }
      };
      const withOuterTimeout = async (work) => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('runner profile timeout')), 120_000);
        });
        try {
          return await Promise.race([work(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      };
      const meteredAdapter = async (outerTimeout) => {
        const meter = new Meter({ observeLongtasks: false });
        meter.begin();
        if (outerTimeout) {
          await withOuterTimeout(async () => assertTruth(await engine.probe(input())));
        } else {
          assertTruth(await engine.probe(input()));
        }
        return (await meter.end({ ops: 1 })).wallMs;
      };
      const run = async (mode) => {
        const started = performance.now();
        if (mode === 'adapter') {
          assertTruth(await engine.probe(input()));
        } else if (mode === 'adapter-outer-timeout') {
          await withOuterTimeout(async () => assertTruth(await engine.probe(input())));
        } else if (mode === 'adapter-meter') {
          return meteredAdapter(false);
        } else if (mode === 'adapter-runner-shape') {
          return meteredAdapter(true);
        } else if (mode === 'raw-get') {
          await raw(undefined, undefined);
        } else if (mode === 'raw-range') {
          await raw(`bytes=0-${fixtureBytes - 1}`, undefined);
        } else {
          await raw(`bytes=0-${fixtureBytes - 1}`, 'high');
        }
        return performance.now() - started;
      };
      for (let index = 0; index < warmup; index++) {
        for (const mode of modes) await run(mode);
      }
      for (let index = 0; index < samples; index++) {
        for (let offset = 0; offset < modes.length; offset++) {
          const mode = modes[(index + offset) % modes.length];
          timings[mode].push(await run(mode));
        }
      }
      await engine.dispose();
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty profile');
        return value;
      };
      return Object.fromEntries(
        modes.map((mode) => {
          const values = timings[mode];
          const center = median(values);
          return [
            mode,
            {
              medianMs: center,
              madMs: median(values.map((value) => Math.abs(value - center))),
              samples: values,
            },
          ];
        }),
      );
    },
    {
      fixtureBytes,
      fixtureUrl: FIXTURE_URL,
      samples: SAMPLES,
      warmup: WARMUP,
    },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-mp4-micro-adapter-browser',
        baseUrl: BASE_URL,
        fixtureBytes,
        warmup: WARMUP,
        samples: SAMPLES,
        report,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
