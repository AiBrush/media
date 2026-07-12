import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { fromBytes } from '../src/sources/source.ts';

const warmup = 3;
const samples = 21;
const audioBytes = new Uint8Array(
  await readFile(new URL('../../media-test/fixtures/media/aac_adts.aac', import.meta.url)),
);
const videos = [
  ['h264_1080p_30s.mp4', '../../media-test/fixtures/media/h264_1080p_30s.mp4'],
  [
    'scenarios/mux/h264_aac_to_mov/02.mp4',
    '../../media-test/fixtures/media/scenarios/mux/h264_aac_to_mov/02.mp4',
  ],
  ['tiny_h264_360p_2s.mp4', '../../media-test/fixtures/media/tiny_h264_360p_2s.mp4'],
  ['h264_vfr.mp4', '../../media-test/fixtures/media/h264_vfr.mp4'],
  ['bear-1280x720.mp4', '../fixtures/media/bear-1280x720.mp4'],
] as const;

let hostConstructions = 0;
class ForbiddenHostChunk {
  constructor() {
    hostConstructions++;
    throw new Error('native packet fusion constructed a WebCodecs host chunk');
  }
}
Object.defineProperty(globalThis, 'EncodedVideoChunk', {
  configurable: true,
  value: ForbiddenHostChunk,
});
Object.defineProperty(globalThis, 'EncodedAudioChunk', {
  configurable: true,
  value: ForbiddenHostChunk,
});

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('empty benchmark sample');
  return value;
}

async function run(videoBytes: Uint8Array, container: 'mp4' | 'mov') {
  const media = createMedia({ worker: false });
  const videoDemux = await media.demux(fromBytes(videoBytes, { mime: 'video/mp4' }));
  const audioDemux = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
  const videoTrack = videoDemux.tracks.find((track) => track.mediaType === 'video');
  const audioTrack = audioDemux.tracks[0];
  if (videoTrack === undefined || audioTrack === undefined)
    throw new Error('missing benchmark track');
  const started = performance.now();
  const output = await media.mux(
    {
      video: { track: videoTrack, packets: videoDemux.packets(videoTrack.id) },
      audio: { track: audioTrack, packets: audioDemux.packets(audioTrack.id) },
    },
    { container, faststart: true },
  );
  if (!(output instanceof Blob)) throw new Error('expected buffered output');
  const bytes = new Uint8Array(await output.arrayBuffer());
  const info = await media.probe(
    fromBytes(bytes, { mime: container === 'mov' ? 'video/quicktime' : 'video/mp4' }),
  );
  return { elapsedMs: performance.now() - started, bytes: bytes.byteLength, info };
}

const rows = [];
for (const [path, source] of videos) {
  const videoBytes = new Uint8Array(await readFile(new URL(source, import.meta.url)));
  const container = path.includes('h264_aac_to_mov') ? 'mov' : 'mp4';
  for (let index = 0; index < warmup; index++) await run(videoBytes, container);
  const timings = [];
  let expected: string | undefined;
  let outputBytes = 0;
  for (let index = 0; index < samples; index++) {
    const result = await run(videoBytes, container);
    timings.push(result.elapsedMs);
    outputBytes = result.bytes;
    const truth = JSON.stringify(result.info);
    expected ??= truth;
    if (truth !== expected) throw new Error(`${path}: nondeterministic MediaInfo`);
  }
  rows.push({
    path,
    container,
    inputBytes: videoBytes.byteLength + audioBytes.byteLength,
    outputBytes,
    medianMs: median(timings),
  });
}
if (hostConstructions !== 0) throw new Error(`constructed ${hostConstructions} host chunks`);
console.log(
  JSON.stringify(
    { benchmark: 'session13-native-packet-fusion', warmup, samples, rows },
    undefined,
    2,
  ),
);
