import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const mediaRoot = resolve(process.cwd());
const fixtureRoot = resolve(
  mediaRoot,
  '../media-test/fixtures/media/scenarios/metadata/write_mkv_tags',
);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>MKV attachment verification</title>');
    return;
  }
  const route = pathname.startsWith('/dist/')
    ? { root: resolve(mediaRoot, 'dist'), suffix: pathname.slice('/dist'.length) }
    : pathname.startsWith('/fixture/')
      ? { root: fixtureRoot, suffix: pathname.slice('/fixture'.length) }
      : undefined;
  if (route === undefined) {
    response.writeHead(404).end();
    return;
  }
  const path = resolve(route.root, `.${route.suffix}`);
  if (path !== route.root && !path.startsWith(`${route.root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    response.writeHead(200, {
      'content-length': String(bytes.byteLength),
      'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'video/x-matroska',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('server did not bind TCP');

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const results = await page.evaluate(
    async ({ port }) => {
      const { createMedia } = await import('/dist/index.js');
      const source = new Uint8Array(
        await (
          await fetch(`http://127.0.0.1:${port}/fixture/03.mkv`, { cache: 'no-store' })
        ).arrayBuffer(),
      );

      const outputBytes = async (output) => {
        if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
        if (output instanceof ReadableStream) {
          const reader = output.getReader();
          const parts = [];
          let length = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            parts.push(next.value);
            length += next.value.byteLength;
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
          }
          return bytes;
        }
        throw new Error('expected media output');
      };

      const digest = async (bytes) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');

      const summarize = async (label, bytes) => {
        const media = createMedia();
        const probe = await media.probe(bytes);
        const demuxed = await media.demux(bytes);
        try {
          const bundle = demuxed.tracks
            .flatMap((track) => track.containerSideData ?? [])
            .find((item) => item.kind === 'matroska-attachments');
          return {
            label,
            size: bytes.byteLength,
            probeTracks: probe.tracks.map((track) => ({ type: track.type, codec: track.codec })),
            demuxTracks: demuxed.tracks.map((track) => ({
              id: track.id,
              mediaType: track.mediaType,
              codec: track.codec,
              nonMedia: track.nonMedia === true,
              projection: track.containerProjection?.kind,
            })),
            attachmentHashes:
              bundle === undefined
                ? []
                : await Promise.all(bundle.attachedFilePayloads.map((payload) => digest(payload))),
          };
        } finally {
          await demuxed.close();
        }
      };

      const media = createMedia();
      const rows = [await summarize('source', source)];
      rows.push(
        await summarize(
          'remux-tags',
          await outputBytes(
            await media.remux(source, {
              to: 'mkv',
              tags: { title: 'Session 11 exact attachment browser verification' },
            }),
          ),
        ),
      );
      rows.push(
        await summarize('remux-copy', await outputBytes(await media.remux(source, { to: 'mkv' }))),
      );

      const packetMux = async (label, mode) => {
        const demuxed = await media.demux(source);
        try {
          const copyable = demuxed.tracks.filter(
            (track) =>
              track.config !== undefined &&
              (mode === 'all' || track.codec === 'h264' || track.codec === 'aac'),
          );
          const tracks = [];
          for (const track of copyable) {
            if (mode !== 'prepared') {
              tracks.push({ track, packets: demuxed.packets(track.id) });
              continue;
            }
            const packets = [];
            const reader = demuxed.packets(track.id).getReader();
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              packets.push(next.value);
            }
            tracks.push({ track: structuredClone(track), packetsArray: packets });
          }
          return summarize(
            label,
            await outputBytes(await media.mux({ tracks }, { container: 'mkv' })),
          );
        } finally {
          await demuxed.close();
        }
      };

      rows.push(await packetMux('packet-all', 'all'));
      rows.push(await packetMux('packet-av', 'av'));
      rows.push(await packetMux('packet-prepared', 'prepared'));
      return rows;
    },
    { port: address.port },
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  server.close();
}
