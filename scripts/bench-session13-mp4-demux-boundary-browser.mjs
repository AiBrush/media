#!/usr/bin/env node

import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const DIST = new URL('../dist/', import.meta.url);
const SUBJECTS = [
  {
    id: 'large4k',
    path: new URL(
      '../../media-test/fixtures/media/scenarios/performance/size-ladder-iterate-packets-large4k/02.mp4',
      import.meta.url,
    ),
  },
  {
    id: 'massive',
    path: new URL(
      '../../media-test/fixtures/media/scenarios/performance/size-ladder-iterate-packets-massive/massive_h264_1080p_2h.mp4',
      import.meta.url,
    ),
  },
];
const WARMUP = 1;
const SAMPLES = 5;
const subjectFiles = new Map(SUBJECTS.map((subject) => [subject.id, Bun.file(subject.path)]));

const commonHeaders = {
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
};
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>MP4 demux boundary</title>',
        {
          headers: { ...commonHeaders, 'content-type': 'text/html' },
        },
      );
    }
    if (url.pathname.startsWith('/fixture/')) {
      const file = subjectFiles.get(url.pathname.slice('/fixture/'.length));
      if (file === undefined) return new Response('missing', { status: 404 });
      return new Response(file, {
        headers: { ...commonHeaders, 'content-type': 'video/mp4' },
      });
    }
    if (url.pathname.startsWith('/dist/')) {
      const relative = url.pathname.slice('/dist/'.length);
      if (relative.includes('..')) return new Response('invalid path', { status: 400 });
      const file = Bun.file(new URL(relative, DIST));
      if (!(await file.exists())) return new Response('missing', { status: 404 });
      return new Response(file, {
        headers: {
          ...commonHeaders,
          'content-type': relative.endsWith('.wasm')
            ? 'application/wasm'
            : relative.endsWith('.js')
              ? 'text/javascript'
              : 'application/octet-stream',
        },
      });
    }
    return new Response('missing', { status: 404 });
  },
});

const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: false,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const result = await page.evaluate(
    async ({ subjects, warmup, samples }) => {
      const { createMedia } = await import('/dist/index.js');
      const media = createMedia({ worker: false });
      const hashRow = (hash, track, size, pts, dts, duration, key) => {
        let out = Math.imul(hash ^ track, 0x01000193) >>> 0;
        out = Math.imul(out ^ size, 0x01000193) >>> 0;
        out = Math.imul(out ^ pts, 0x01000193) >>> 0;
        out = Math.imul(out ^ dts, 0x01000193) >>> 0;
        out = Math.imul(out ^ duration, 0x01000193) >>> 0;
        return Math.imul(out ^ (key ? 1 : 0), 0x01000193) >>> 0;
      };
      const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const summarize = (runs) => {
        const wall = runs.map((run) => run.wallMs);
        const center = median(wall);
        return {
          medianMs: center,
          madMs: median(wall.map((value) => Math.abs(value - center))),
          samples: wall,
          rows: runs[0].rows,
          hash: runs[0].hash,
          peakHeapBytes: Math.max(...runs.map((run) => run.peakHeapBytes)),
        };
      };
      const measure = async (run) => {
        const memory = performance.memory;
        let peakHeapBytes = memory?.usedJSHeapSize ?? 0;
        const timer = setInterval(() => {
          peakHeapBytes = Math.max(peakHeapBytes, memory?.usedJSHeapSize ?? 0);
        }, 1);
        const started = performance.now();
        try {
          const value = await run();
          peakHeapBytes = Math.max(peakHeapBytes, memory?.usedJSHeapSize ?? 0);
          return { ...value, wallMs: performance.now() - started, peakHeapBytes };
        } finally {
          clearInterval(timer);
        }
      };
      const benchmark = async (run) => {
        for (let index = 0; index < warmup; index++) await measure(run);
        const out = [];
        for (let index = 0; index < samples; index++) out.push(await measure(run));
        return summarize(out);
      };

      const results = [];
      for (const subject of subjects) {
        const blob = await (await fetch(`/fixture/${subject.id}`)).blob();
        const packetTable = async () => {
          const demuxed = await media.demux(blob);
          try {
            const rows = demuxed.packetTable?.() ?? [];
            let hash = 0x811c9dc5;
            for (const row of rows) {
              hash = hashRow(
                hash,
                row.trackId,
                row.sizeBytes,
                row.ptsUs,
                row.dtsUs,
                row.durationUs ?? 0,
                row.keyframe,
              );
            }
            return { rows: rows.length, hash };
          } finally {
            await demuxed.close();
          }
        };
        const drain = async () => {
          const demuxed = await media.demux(blob);
          let rows = 0;
          let hash = 0x811c9dc5;
          try {
            for (const track of demuxed.tracks) {
              const reader = demuxed.packets(track.id).getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  hash = hashRow(
                    hash,
                    track.id,
                    value.sizeBytes,
                    value.chunk.timestamp,
                    value.dtsUs,
                    value.chunk.duration ?? 0,
                    value.chunk.type === 'key',
                  );
                  rows++;
                }
              } finally {
                reader.releaseLock();
              }
            }
            return { rows, hash };
          } finally {
            await demuxed.close();
          }
        };

        const table = await benchmark(packetTable);
        const packets = await benchmark(drain);
        if (table.rows !== packets.rows || table.hash !== packets.hash) {
          throw new Error(`${subject.id}: native packet drain differs from packet-table truth`);
        }

        const NativeReadableStream = globalThis.ReadableStream;
        let pulls = 0;
        globalThis.ReadableStream = class ObservedReadableStream extends NativeReadableStream {
          constructor(source, strategy) {
            const resolvedSource = source ?? {};
            const originalPull = resolvedSource.pull;
            super(
              originalPull === undefined
                ? resolvedSource
                : {
                    ...resolvedSource,
                    pull(controller) {
                      pulls++;
                      return originalPull.call(resolvedSource, controller);
                    },
                  },
              strategy,
            );
          }
        };
        try {
          const observed = await drain();
          if (observed.rows !== packets.rows || observed.hash !== packets.hash) {
            throw new Error(`${subject.id}: observed drain differs from measured drain`);
          }
        } finally {
          globalThis.ReadableStream = NativeReadableStream;
        }
        results.push({
          id: subject.id,
          fixtureBytes: blob.size,
          packetTable: table,
          drain: packets,
          producerPulls: pulls,
          packetsPerPull: packets.rows / pulls,
        });
      }
      return { warmup, samples, results };
    },
    { subjects: SUBJECTS.map(({ id }) => ({ id })), warmup: WARMUP, samples: SAMPLES },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
  server.stop(true);
}
