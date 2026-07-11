import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const root = resolve(process.cwd(), '..');
const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.m3u8', 'application/vnd.apple.mpegurl'],
  ['.ts', 'video/mp2t'],
  ['.key', 'application/octet-stream'],
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

const manifestPath = '/media-test/fixtures/media/scenarios/probe/hls_aes128/hls_aes128.m3u8';
const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/media/dist/index.js`);
  const report = await page.evaluate(
    async ({ manifestPath, port }) => {
      const { createMedia } = await import('/media/dist/index.js');
      const media = createMedia({ determinism: 'auto', worker: false });
      const manifestUrl = `http://127.0.0.1:${port}${manifestPath}`;
      const info = await media.probe(manifestUrl);
      const tracks = info.tracks.map((track) => ({
        type: track.type,
        codec: track.codec,
        durationSec: track.durationSec,
      }));
      if (info.container !== 'ts' || tracks.length < 2) {
        throw new Error(`unexpected HLS probe result: ${info.container}/${tracks.length}`);
      }
      const manifestText = await (await fetch(manifestUrl)).text();
      const mediaPrefix = '/media-test/fixtures/media/scenarios/probe/hls_aes128/';
      const detachedText = manifestText
        .replaceAll('hls_aes128.key', `${mediaPrefix}hls_aes128.key`)
        .replaceAll(/hls_aes128_\d+\.ts/g, (uri) => `${mediaPrefix}${uri}`);
      const detachedInfo = await media.probe(new Blob([detachedText], { type: 'video/mp2t' }));
      if (detachedInfo.container !== 'ts' || detachedInfo.tracks.length < 2) {
        throw new Error(
          `unexpected detached HLS probe result: ${detachedInfo.container}/${detachedInfo.tracks.length}`,
        );
      }
      return {
        manifestUrl,
        url: { container: info.container, durationSec: info.durationSec, tracks },
        detached: {
          container: detachedInfo.container,
          durationSec: detachedInfo.durationSec,
          tracks: detachedInfo.tracks.map((track) => ({
            type: track.type,
            codec: track.codec,
            durationSec: track.durationSec,
          })),
        },
      };
    },
    { manifestPath, port: address.port },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
