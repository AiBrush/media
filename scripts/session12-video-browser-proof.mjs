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

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/media/dist/index.js`);
  const report = await page.evaluate(
    async ({ port }) => {
      const { createMedia } = await import('/media/dist/index.js');
      const media = createMedia({ determinism: 'auto', worker: false });
      const paths = {
        main10: '/media-test/fixtures/media/scenarios/transcode/h264_two_pass_bitrate/01.mp4',
        twoPass: '/media-test/fixtures/media/scenarios/transcode/h264_two_pass_bitrate/01.mp4',
      };

      async function sourceBytes(path) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        if (!response.ok) throw new Error(`fixture fetch ${response.status}: ${path}`);
        return new Uint8Array(await response.arrayBuffer());
      }

      async function sha256(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      }

      async function outputBytes(output) {
        if (!(output instanceof Blob)) throw new Error('proof expects the default Blob output');
        return new Uint8Array(await output.arrayBuffer());
      }

      async function muxedVideoFacts(bytes) {
        const info = await media.probe(bytes);
        const video = info.tracks.find((track) => track.type === 'video');
        if (video === undefined) throw new Error('output has no video track');
        const demuxed = await media.demux(bytes);
        const track = demuxed.tracks.find((candidate) => candidate.mediaType === 'video');
        if (track === undefined) throw new Error('output demux has no video track');
        const reader = demuxed.packets(track.id).getReader();
        let payloadBytes = 0;
        let packetCount = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            payloadBytes += next.value.chunk.byteLength;
            packetCount += 1;
          }
        } finally {
          reader.releaseLock();
          await demuxed.close();
        }
        return {
          codec: video.codec,
          durationSec: video.durationSec,
          width: video.width,
          height: video.height,
          payloadBytes,
          packetCount,
          configCodec: track.config?.codec,
        };
      }

      async function convert(bytes, options) {
        return outputBytes(await media.convert(bytes, options));
      }

      async function measure(bytes, options, count) {
        await convert(bytes, options);
        const samples = [];
        const sampleSha256 = [];
        let last;
        for (let index = 0; index < count; index += 1) {
          const start = performance.now();
          last = await convert(bytes, options);
          samples.push(performance.now() - start);
          sampleSha256.push(await sha256(last));
        }
        return {
          samplesMs: samples,
          sampleSha256,
          medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
          outputBytes: last.byteLength,
          outputSha256: await sha256(last),
          facts: await muxedVideoFacts(last),
        };
      }

      const main10Input = await sourceBytes(paths.main10);
      const twoPassInput = await sourceBytes(paths.twoPass);
      const main10Options = { to: 'mp4', audio: false, video: { codec: 'hevc', bitDepth: 10 } };
      const twoPassOptions = {
        to: 'mp4',
        audio: false,
        video: { codec: 'h264', bitrate: 500_000, twoPass: true },
      };
      let main10;
      try {
        const main10Output = await convert(main10Input, main10Options);
        const main10Facts = await muxedVideoFacts(main10Output);
        if (!/^hev[1c]\.2\./i.test(main10Facts.codec ?? '')) {
          throw new Error(`Main10 output codec is not HEVC profile 2: ${main10Facts.codec}`);
        }
        const main10DeterministicA = await convert(main10Input, main10Options);
        const main10DeterministicB = await convert(main10Input, main10Options);
        if ((await sha256(main10DeterministicA)) !== (await sha256(main10DeterministicB))) {
          throw new Error('Main10 repeated output is not byte-deterministic');
        }
        main10 = {
          status: 'PASS',
          inputBytes: main10Input.byteLength,
          outputBytes: main10Output.byteLength,
          facts: main10Facts,
          deterministicSha256: await sha256(main10DeterministicA),
        };
      } catch (error) {
        if (error?.code !== 'capability-miss') throw error;
        main10 = {
          status: 'NA_BROWSER',
          inputBytes: main10Input.byteLength,
          code: error.code,
          reason: String(error.message ?? error),
        };
      }

      const twoPass = await measure(twoPassInput, twoPassOptions, 5);
      if (new Set(twoPass.sampleSha256).size !== 1) {
        throw new Error('two-pass repeated outputs are not byte-deterministic');
      }
      if (!/^avc[13]\./i.test(twoPass.facts.codec ?? '')) {
        throw new Error(`two-pass output codec is not H.264: ${twoPass.facts.codec}`);
      }
      if (twoPass.facts.packetCount < 2 || twoPass.facts.payloadBytes <= 0) {
        throw new Error('two-pass output has no real packet payload evidence');
      }

      const cancelled = media.convert(twoPassInput, twoPassOptions);
      cancelled.cancel();
      let cancellationCode;
      try {
        await cancelled;
        throw new Error('cancelled two-pass conversion unexpectedly resolved');
      } catch (error) {
        cancellationCode = error?.code;
        if (cancellationCode !== 'aborted') throw error;
      }

      return {
        browser: navigator.userAgent,
        main10,
        twoPass: {
          inputBytes: twoPassInput.byteLength,
          ...twoPass,
          bitrateBudgetBytes: Math.round((500_000 * (twoPass.facts.durationSec ?? 0)) / 8),
        },
        cancellationCode,
      };
    },
    { port: address.port },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
