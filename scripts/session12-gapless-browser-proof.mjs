import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const root = resolve(process.cwd(), '..');
const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  const path = resolve(root, `.${pathname}`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    response.writeHead(200, {
      'content-length': String(bytes.byteLength),
      'content-type': contentTypes.get(extname(path)) ?? 'application/octet-stream',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('server did not bind TCP');

const fixturePath = '/media-test/fixtures/media/scenarios/audio-dsp/edge_gapless_aac_decode/05.mp4';
const expectedSamples = 50_784;
const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/media/dist/index.js`);
  const report = await page.evaluate(
    async ({ fixturePath, port, expectedSamples }) => {
      const { createMedia } = await import('/media/dist/index.js');
      const media = createMedia({ determinism: 'auto', worker: false });
      const response = await fetch(`http://127.0.0.1:${port}${fixturePath}`);
      if (!response.ok) throw new Error(`fixture fetch ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const info = await media.probe(bytes);
      const audioTrack = info.tracks.find((track) => track.type === 'audio');
      if (audioTrack === undefined) throw new Error('gapless fixture has no audio track');
      const demuxed = await media.demux(bytes);
      const demuxTrack = demuxed.tracks.find((track) => track.mediaType === 'audio');
      if (demuxTrack === undefined) throw new Error('gapless demux has no audio track');
      const packetReader = demuxed.packets(demuxTrack.id).getReader();
      const packetRows = [];
      try {
        for (;;) {
          const next = await packetReader.read();
          if (next.done) break;
          packetRows.push({
            timestamp: next.value.chunk.timestamp,
            duration: next.value.chunk.duration,
            type: next.value.chunk.type,
          });
        }
      } finally {
        packetReader.releaseLock();
        await demuxed.close();
      }

      const reader = media.decode(bytes).audio.getReader();
      let frameCount = 0;
      let sampleCount = 0;
      let sampleRate;
      let channels;
      const firstFrames = [];
      const lastFrames = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const frame = next.value;
          const row = {
            timestamp: frame.timestamp,
            frames: frame.numberOfFrames,
            sampleRate: frame.sampleRate,
            channels: frame.numberOfChannels,
          };
          if (firstFrames.length < 3) firstFrames.push(row);
          lastFrames.push(row);
          if (lastFrames.length > 3) lastFrames.shift();
          frameCount += 1;
          sampleCount += frame.numberOfFrames;
          sampleRate = frame.sampleRate;
          channels = frame.numberOfChannels;
          frame.close();
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      return {
        status: sampleCount === expectedSamples ? 'PASS' : 'FAIL',
        expectedSamples,
        fixturePath,
        inputBytes: bytes.byteLength,
        probe: {
          container: info.container,
          durationSec: info.durationSec,
          audio: {
            codec: audioTrack.codec,
            durationSec: audioTrack.durationSec,
            gapless: audioTrack.gapless,
          },
        },
        packets: {
          count: packetRows.length,
          first: packetRows.slice(0, 3),
          last: packetRows.slice(-3),
        },
        decode: { frameCount, sampleCount, sampleRate, channels, firstFrames, lastFrames },
      };
    },
    { fixturePath, port: address.port, expectedSamples },
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') {
    throw new Error(
      `gapless public decode produced ${report.decode.sampleCount} samples, expected ${report.expectedSamples}`,
    );
  }
} finally {
  await browser.close();
  server.close();
}
