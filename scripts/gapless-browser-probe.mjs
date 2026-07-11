import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const root = resolve(process.cwd(), '..');
const candidateRoot = '/private/tmp/gapless-candidates';
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  const path = pathname.startsWith('/gapless-candidates/')
    ? resolve(candidateRoot, `.${pathname.slice('/gapless-candidates'.length)}`)
    : resolve(root, `.${pathname}`);
  const allowedRoot = pathname.startsWith('/gapless-candidates/') ? candidateRoot : root;
  if (path !== allowedRoot && !path.startsWith(`${allowedRoot}${sep}`)) {
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/media/dist/index.js`);
  const files = [
    '/media-test/fixtures/media/scenarios/audio-dsp/edge_gapless_aac_decode/gapless_aac.m4a',
    '/private/tmp/gapless-candidates/tiny-clip.mp4',
    '/private/tmp/gapless-candidates/front-discard.mp4',
    '/private/tmp/gapless-candidates/chromium-bear-1280x720.mp4',
    '/private/tmp/gapless-candidates/chromium-bear.mp4',
  ];
  const results = await page.evaluate(async ({ port, files: paths }) => {
    const { createMedia } = await import('/media/dist/index.js');
    const rows = [];
    for (const path of paths) {
      try {
      const url = path.startsWith('/private/tmp/')
        ? `http://127.0.0.1:${port}/gapless-candidates/${path.split('/').at(-1)}`
        : `http://127.0.0.1:${port}${path}`;
      const bytes = await (await fetch(url)).arrayBuffer();
      const demuxed = await createMedia().demux(bytes);
      const track = demuxed.tracks.find((candidate) => candidate.mediaType === 'audio');
      if (track?.config === undefined) throw new Error(`no audio config for ${path}`);
      const nativeRows = [];
      let nativeError;
      const decoder = new AudioDecoder({
        output(frame) {
          nativeRows.push({
            timestamp: frame.timestamp,
            frames: frame.numberOfFrames,
            rate: frame.sampleRate,
          });
          frame.close();
        },
        error(error) {
          nativeError = String(error);
        },
      });
      decoder.configure(track.config);
      const packets = demuxed.packets(track.id).getReader();
      const packetRows = [];
      let firstNegativePacket;
      for (;;) {
        const next = await packets.read();
        if (next.done) break;
        packetRows.push({
          timestamp: next.value.chunk.timestamp,
          duration: next.value.chunk.duration,
          type: next.value.chunk.type,
        });
        if (firstNegativePacket === undefined && next.value.chunk.timestamp < 0) {
          firstNegativePacket = next.value.chunk;
        }
        decoder.decode(next.value.chunk);
      }
      await decoder.flush();
      decoder.close();
      const prefixRows = [];
      if (firstNegativePacket !== undefined) {
        const prefixDecoder = new AudioDecoder({
          output(frame) {
            prefixRows.push(frame.numberOfFrames);
            frame.close();
          },
          error() {},
        });
        prefixDecoder.configure(track.config);
        prefixDecoder.decode(firstNegativePacket);
        await prefixDecoder.flush();
        prefixDecoder.close();
      }
      await demuxed.close();
      const reader = createMedia().decode(bytes).audio.getReader();
      let frames = 0;
      let samples = 0;
      let sampleRate;
      let channels;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        frames += 1;
        samples += next.value.numberOfFrames;
        sampleRate = next.value.sampleRate;
        channels = next.value.numberOfChannels;
        next.value.close();
      }
      rows.push({
        path,
        track: { codec: track.codec, gapless: track.gapless },
        native: {
          error: nativeError,
          frames: nativeRows.length,
          samples: nativeRows.reduce((sum, row) => sum + row.frames, 0),
          first: nativeRows.slice(0, 3),
          last: nativeRows.slice(-3),
        },
        packets: {
          count: packetRows.length,
          first: packetRows.slice(0, 3),
          last: packetRows.slice(-3),
        },
        prefix: { frames: prefixRows.length, samples: prefixRows.reduce((sum, n) => sum + n, 0) },
        public: { frames, samples, sampleRate, channels },
      });
      } catch (error) {
        rows.push({ path, error: String(error) });
      }
    }
    return rows;
  }, { port: address.port, files });
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.close();
}
