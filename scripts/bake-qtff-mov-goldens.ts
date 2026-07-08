#!/usr/bin/env bun
/**
 * scripts/bake-qtff-mov-goldens.ts — bake the **independent ffprobe truth** for the QuickTime/.mov
 * parser fixtures (task #11 / ADR-185) into `fixtures/golden/metadata/qtff-mov-truth.json`.
 *
 * The oracle is ffprobe 8.0 (an independent tool, per docs/architecture/11 §2 independent-tool
 * corroboration): per file we pin the stream count **including data/timecode streams**, each stream's
 * `codec_type`/`codec_name`/`codec_tag_string`, the container colour tags (`color_range`/`color_space`/
 * `color_transfer`/`color_primaries`), `sample_aspect_ratio`, dims, audio rate/channels, and the raw
 * `extradata` bytes (the avcC record) as hex. Tests then run OUR parser on the same committed bytes and
 * must match — a can-fail gate (`golden-metadata.test.ts` tampers a copy to prove it rejects).
 *
 * Fixture recipes (all derived from openly-licensed corpus media; committed under
 * `fixtures/media-derived/`, see its README):
 *   - big_buck_bunny_1080p_h264.header.mov / h264_1080p_5s.header.mov — pre-existing verbatim
 *     `ftyp`+`moov` slices of real QuickTime-authored assets (v2/v1 sound descriptions, tmcd, colr).
 *   - mov-*.mov / mp4-nclx-fullrange.mp4 — real containers authored by `ffmpeg` 8.0 or Apple
 *     `avconvert` from `fixtures/media/movie_5.mp4` (recipes below, one per entry).
 *
 *   bun scripts/bake-qtff-mov-goldens.ts        # re-run ffprobe and rewrite the golden JSON
 */

import { $ } from 'bun';
import { sha256Hex } from '../src/util/digest.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DERIVED = `${ROOT}fixtures/media-derived`;
const MEDIA = `${ROOT}fixtures/media`;
const OUT = `${ROOT}fixtures/golden/metadata/qtff-mov-truth.json`;

/** One baked fixture: where it lives and the exact command that authored it (provenance). */
interface FixtureSpec {
  file: string;
  dir: 'derived' | 'media';
  recipe: string;
}

const FIXTURES: readonly FixtureSpec[] = [
  {
    file: 'big_buck_bunny_1080p_h264.header.mov',
    dir: 'derived',
    recipe:
      'verbatim ftyp+moov of big_buck_bunny_1080p_h264.mov (Blender Foundation, CC BY 3.0) — QuickTime-authored: v2 sound description, wave-nested esds, tmcd track, colr nclc 1/1/1',
  },
  {
    file: 'h264_1080p_5s.header.mov',
    dir: 'derived',
    recipe:
      'verbatim ftyp+moov of h264_1080p_5s.mov — QuickTime-authored: v1 sound description, untagged colour, pasp 1:1',
  },
  {
    file: 'mov-tmcd-copy.mov',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -c copy -timecode 01:00:00:00 mov-tmcd-copy.mov  (stream copy + tmcd track, moov at end, mp4a v1 wave-nested esds)',
  },
  {
    file: 'mov-bt601-aac.mov',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -t 1 -vf "scale=192:108,setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m" -c:v libx264 -preset ultrafast -crf 35 -movflags +write_colr -c:a aac -b:a 24k mov-bt601-aac.mov  (colr nclc 6/6/6)',
  },
  {
    file: 'mov-bt709matrix-sowt.mov',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -t 1 -vf "scale=192:108,setsar=4/3" -c:v libx264 -preset ultrafast -crf 35 -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +write_colr -c:a pcm_s16le mov-bt709matrix-sowt.mov  (partially-specified colr nclc 2/2/1, pasp 4:3, sowt v0 PCM)',
  },
  {
    file: 'mov-fl32-enda.mov',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -t 0.6 -vf scale=192:108 -c:v libx264 -preset ultrafast -crf 35 -c:a pcm_f32le -ar 16000 mov-fl32-enda.mov  (fl32 v1 + wave{frma,enda=1} little-endian float PCM, untagged colour)',
  },
  {
    file: 'mov-lpcm-96k-v2.mov',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -t 0.25 -vn -c:a pcm_s16le -ar 96000 mov-lpcm-96k-v2.mov  (lpcm v2 sound description: float64 rate 96000, formatSpecificFlags signed+packed LE)',
  },
  {
    file: 'mov-apple-avconvert.mov',
    dir: 'derived',
    recipe:
      'avconvert --preset PresetHighestQuality --source movie_5.mp4 --output mov-apple-avconvert.mov  (Apple AVFoundation-authored: audio-first trak order, mp4a v1 wave-nested esds with plain descriptor lengths, fiel+pasp)',
  },
  {
    file: 'mp4-nclx-fullrange.mp4',
    dir: 'derived',
    recipe:
      'ffmpeg -i movie_5.mp4 -t 1 -vf "scale=192:108,setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=bt709" -c:v libx264 -preset ultrafast -crf 35 -movflags +write_colr -c:a aac -b:a 24k mp4-nclx-fullrange.mp4  (ISO colr nclx 1/1/1 + full_range bit)',
  },
  {
    file: 'obs-remux-variable-aac.mp4',
    dir: 'media',
    recipe:
      'corpus fixture (see fixtures/manifest.json) — real OBS remux carrying colr nclx 1/1/1 tv-range',
  },
] as const;

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  extradata?: string;
}

interface GoldenStream {
  index: number;
  codecType: string;
  codecName: string | null;
  codecTag: string;
  width: number | null;
  height: number | null;
  sampleAspectRatio: string | null;
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  sampleRate: number | null;
  channels: number | null;
  extradataHex: string | null;
}

interface GoldenFile {
  file: string;
  recipe: string;
  sha256: string;
  nbStreams: number;
  streams: GoldenStream[];
}

/** Flatten ffprobe's xxd-style `extradata` dump ("00000000: 014d 4029 ...  ascii") into plain hex. */
function extradataToHex(dump: string): string {
  let hex = '';
  for (const line of dump.split('\n')) {
    const m = /^[0-9a-f]{8}:((?: [0-9a-f]{2,4})+)/.exec(line.trim().toLowerCase());
    if (!m?.[1]) continue;
    hex += m[1].replaceAll(' ', '');
  }
  return hex;
}

async function bakeOne(spec: FixtureSpec): Promise<GoldenFile> {
  const path = `${spec.dir === 'derived' ? DERIVED : MEDIA}/${spec.file}`;
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const raw =
    await $`ffprobe -v error -show_data -show_entries stream=index,codec_type,codec_name,codec_tag_string,width,height,sample_aspect_ratio,color_range,color_space,color_transfer,color_primaries,sample_rate,channels,extradata -of json ${path}`
      .quiet()
      .text();
  const parsed = JSON.parse(raw) as { streams: FfprobeStream[] };
  const streams = parsed.streams.map(
    (s): GoldenStream => ({
      index: s.index,
      codecType: s.codec_type ?? '',
      codecName: s.codec_name ?? null,
      codecTag: s.codec_tag_string ?? '',
      width: s.width ?? null,
      height: s.height ?? null,
      sampleAspectRatio: s.sample_aspect_ratio ?? null,
      colorRange: s.color_range ?? null,
      colorSpace: s.color_space ?? null,
      colorTransfer: s.color_transfer ?? null,
      colorPrimaries: s.color_primaries ?? null,
      sampleRate: s.sample_rate !== undefined ? Number(s.sample_rate) : null,
      channels: s.channels ?? null,
      extradataHex: s.codec_type === 'video' && s.extradata ? extradataToHex(s.extradata) : null,
    }),
  );
  return {
    file: spec.file,
    recipe: spec.recipe,
    sha256: await sha256Hex(bytes),
    nbStreams: streams.length,
    streams,
  };
}

async function main(): Promise<void> {
  const ffprobeVersion = (await $`ffprobe -version`.quiet().text()).split('\n')[0] ?? 'unknown';
  const files: GoldenFile[] = [];
  for (const spec of FIXTURES) files.push(await bakeOne(spec));
  const golden = {
    note: 'Independent ffprobe truth for the QuickTime/.mov parser fixtures (ADR-185). Regenerate with `bun scripts/bake-qtff-mov-goldens.ts`. Tests compare OUR parser output against this — never the other way around.',
    ffprobe: ffprobeVersion,
    files,
  };
  await Bun.write(OUT, `${JSON.stringify(golden, null, 2)}\n`);
  console.info(`baked ${files.length} ffprobe-truth entries → ${OUT}`);
  for (const f of files) console.info(`  ${f.file}: ${f.nbStreams} streams`);
}

await main();
