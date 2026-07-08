/**
 * Bake the fragmented-MP4 per-sample oracle: for each fragmented corpus fixture's clean video track,
 * record every packet's byte offset, size, decode/presentation time (container ticks) and keyframe flag
 * as reported by an INDEPENDENT tool (ffprobe 8.0). `fragment-samples.test.ts` asserts our
 * `parseFragmentSamples` reproduces this byte-exactly. Re-run offline to refresh; the JSON is committed.
 *
 *   bun run scripts/bake-fragment-samples-golden.ts
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const MEDIA_DIR = new URL('../fixtures/media/', import.meta.url).pathname;

interface GoldenSample {
  readonly offset: number;
  readonly size: number;
  readonly dts: number;
  readonly pts: number;
  readonly keyframe: boolean;
}

const FIXTURES = ['bear-open-gop-frag.mp4', 'bear-av-frag.mp4'] as const;

interface FfprobePacket {
  readonly pos: string;
  readonly size: string;
  readonly dts: string;
  readonly pts: string;
  readonly flags?: string;
}

function ffprobePackets(path: string, stream: string): GoldenSample[] {
  const raw = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    stream,
    '-show_packets',
    '-show_entries',
    'packet=pts,dts,size,pos,flags',
    '-of',
    'json',
    path,
  ]).toString();
  const packets = (JSON.parse(raw) as { packets: FfprobePacket[] }).packets;
  return packets.map((p) => ({
    offset: Number(p.pos),
    size: Number(p.size),
    dts: Number(p.dts),
    pts: Number(p.pts),
    keyframe: (p.flags ?? '').includes('K'),
  }));
}

const golden: Record<string, { videoTrackSamples: GoldenSample[] }> = {};
for (const id of FIXTURES) {
  golden[id] = { videoTrackSamples: ffprobePackets(`${MEDIA_DIR}${id}`, 'v:0') };
}
writeFileSync('fixtures/golden/mp4/fragment-samples.json', `${JSON.stringify(golden, null, 1)}\n`);
console.info(
  `baked fragment-samples golden: ${FIXTURES.map((id) => `${id}=${golden[id]?.videoTrackSamples.length}`).join(', ')}`,
);
