import { open, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { MediaInfo } from '../../api/types.ts';
import type { Source } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp4Module } from './mp4-driver.ts';
import { type Movie, type ParsedTrack, parseMovieMetadata } from './parse.ts';
import { Reader, boxes } from './reader.ts';

const MP4S = [
  '2x2-green.mp4',
  'movie_5.mp4',
  'test.mp4',
  'h264.mp4',
  'four-colors.mp4',
  'av1.mp4',
  'h265.mp4',
  'bear-hevc-10bit-hdr10.mp4',
  'bear-4k-hevc.mp4',
];

const HARNESS_MEDIA = new URL(
  '../../../../media-test/fixtures/media/scenarios/performance/',
  import.meta.url,
).pathname;

async function probeFilePath(path: string): Promise<MediaInfo> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const source: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/mp4',
      filename: path.slice(path.lastIndexOf('/') + 1),
      size: stat.size,
      range: async (start, end) => {
        const bytes = new Uint8Array(Math.max(0, end - start));
        const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, start);
        return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('rotated metadata probe must stay range-backed');
      },
    };
    return await createMedia().use(Mp4Module).probe(source);
  } finally {
    await file.close();
  }
}

const HEVC_MP4S = [
  { id: 'h265.mp4', codec: 'hvc1.1.6.L60.90', width: 320, height: 240, bitDepth: 8 },
  { id: 'bear-4k-hevc.mp4', codec: 'hev1.1.6.L150.90', width: 3840, height: 2160, bitDepth: 8 },
  {
    id: 'bear-hevc-10bit-hdr10.mp4',
    codec: 'hev1.2.4.L93.90',
    width: 1280,
    height: 720,
    bitDepth: 10,
  },
] as const;

describe('golden-metadata oracle (probe, mp4)', () => {
  it.each([
    ['size-ladder-extract-metadata-massive/massive_h264_1080p_2h.mp4', 48_000, 1],
    ['size-ladder-extract-metadata-massive/01.mp4', 44_100, 2],
    ['size-ladder-extract-metadata-massive/02.mp4', 44_100, 2],
    ['size-ladder-extract-metadata-massive/03.mp4', 48_000, 1],
    ['size-ladder-extract-metadata-tiny/tiny_h264_360p_2s.mp4', 48_000, 2],
    ['size-ladder-extract-metadata-tiny/01.mp4', 48_000, 2],
    ['size-ladder-extract-metadata-tiny/02.mp4', 48_000, 2],
    ['size-ladder-extract-metadata-tiny/03.mp4', 48_000, 2],
  ] as const)(
    '%s AAC ASC geometry matches ffprobe across every rotated file',
    async (path, sampleRate, channels) => {
      const info = await probeFilePath(`${HARNESS_MEDIA}${path}`);
      expect(info.tracks.find((track) => track.type === 'audio')).toMatchObject({
        codec: 'mp4a.40.2',
        sampleRate,
        channels,
      });
    },
  );

  it.each(MP4S)('%s probe matches the committed golden exactly', async (id) => {
    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource(id));
    expect(info).toEqual(await loadGoldenMetadata(id));
  });

  it.each(HEVC_MP4S)(
    '$id HEVC fixture exposes the exact hvc1/hev1 codec string ($bitDepth-bit)',
    async ({ id, codec, width, height }) => {
      const info = await createMedia()
        .use(Mp4Module)
        .probe(await fixtureSource(id));
      const videoTrack = info.tracks.find((track) => track.type === 'video');
      expect(videoTrack).toMatchObject({ codec, width, height });
      expect(info).toEqual(await loadGoldenMetadata(id));
    },
  );

  it('the oracle can fail — it rejects tampered metadata (anti-cheat, doc 11 §5)', async () => {
    const golden = (await loadGoldenMetadata('2x2-green.mp4')) as MediaInfo;
    const tampered = structuredClone(golden);
    const track = tampered.tracks[0];
    if (track) track.width = 999;

    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource('2x2-green.mp4'));
    expect(info).not.toEqual(tampered); // a wrong golden would be rejected
    expect(info).toEqual(golden); // …and the true golden still matches
  });
});

// ============ QTFF/.mov ffprobe-truth oracle (task #11 / ADR-185) ============
//
// Independent-tool corroboration: `fixtures/golden/metadata/qtff-mov-truth.json` pins what
// **ffprobe 8.0** reports for ten real QuickTime/ISO files (2 QuickTime-authored headers, 1 Apple
// AVFoundation-authored, 6 ffmpeg-authored, 1 OBS remux — recipes in the golden itself; baked by
// `scripts/bake-qtff-mov-goldens.ts`). The parser must reproduce, per file: the stream count
// **including data/timecode streams**, per-stream (in trak order) type/codec/tag, dims, rate/channels,
// `colr` (↔ ffprobe `color_primaries`/`color_transfer`/`color_space`), `pasp` (↔ `sample_aspect_ratio`),
// and the byte-exact `avcC` (↔ `extradata`).

interface TruthStream {
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
interface TruthFile {
  file: string;
  recipe: string;
  sha256: string;
  nbStreams: number;
  streams: TruthStream[];
}
interface Truth {
  ffprobe: string;
  files: TruthFile[];
}

const DERIVED_DIR = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;
const TRUTH_PATH = new URL('../../../fixtures/golden/metadata/qtff-mov-truth.json', import.meta.url)
  .pathname;

let truthCache: Truth | undefined;
async function loadTruth(): Promise<Truth> {
  truthCache ??= JSON.parse(await readFile(TRUTH_PATH, 'utf8')) as Truth;
  return truthCache;
}

async function loadTruthBytes(entry: TruthFile): Promise<Uint8Array> {
  if (entry.recipe.startsWith('corpus fixture')) return loadFixture(entry.file);
  return new Uint8Array(await readFile(`${DERIVED_DIR}${entry.file}`));
}

/** Locate the `ftyp` brand + `moov` payload — the exact input `parseMovieMetadata` consumes. */
function moovPayloadOf(file: Uint8Array): { brand: string; moov: Uint8Array } {
  const r = new Reader(file);
  let brand = 'mp42';
  for (const box of boxes(r, file.byteLength)) {
    if (box.type === 'ftyp') {
      brand = String.fromCharCode(...file.subarray(box.payloadStart, box.payloadStart + 4));
    }
    if (box.type === 'moov') return { brand, moov: file.subarray(box.payloadStart, box.end) };
  }
  throw new Error('no moov box in fixture');
}

async function parseTruthFile(entry: TruthFile): Promise<Movie> {
  const { brand, moov } = moovPayloadOf(await loadTruthBytes(entry));
  return parseMovieMetadata(brand, moov);
}

/** All declared traks (AV + other), in moov trak order — what ffprobe's stream list corresponds to. */
function mergedTrackOrder(
  movie: Movie,
): Array<{ kind: 'av'; track: ParsedTrack } | { kind: 'other'; handler: string; codec: string }> {
  const av = movie.tracks.map((track) => ({
    kind: 'av' as const,
    track,
    order: track.trakIndex ?? Number.MAX_SAFE_INTEGER,
  }));
  const other = (movie.otherTracks ?? []).map((t) => ({
    kind: 'other' as const,
    handler: t.handler,
    codec: t.codec,
    order: t.trakIndex,
  }));
  return [...av, ...other].sort((a, b) => a.order - b.order);
}

/** Map our parsed codec string to ffprobe's `codec_name` (can-fail: unmapped codecs throw). */
function ffprobeCodecName(codec: string): string {
  if (codec.startsWith('avc1.') || codec.startsWith('avc3.')) return 'h264';
  if (codec.startsWith('mp4a.40')) return 'aac';
  const pcm = /^pcm-(u8|s8|s16|s24|s32|f32|f64)(be)?$/.exec(codec);
  if (pcm?.[1]) {
    if (pcm[1] === 'u8' || pcm[1] === 's8') return `pcm_${pcm[1]}`;
    return `pcm_${pcm[1]}${pcm[2] === 'be' ? 'be' : 'le'}`;
  }
  throw new Error(`no ffprobe codec_name mapping for parsed codec '${codec}'`);
}

// ffprobe colour-name ↔ WebCodecs VideoColorSpaceInit value (only names present in the truth set —
// extending the corpus extends this table; an unknown name throws, keeping the oracle can-fail). The
// spec tokens the bundled lib.dom colour enums still omit (bt2020/pq/hlg/linear/bt2020-ncl) are widened
// here exactly as the parser produces them (ADR-185), never `any`.
type ColorPrimariesExt = VideoColorPrimaries | 'bt2020' | 'smpte432';
type TransferExt = VideoTransferCharacteristics | 'pq' | 'hlg' | 'linear';
type MatrixExt = VideoMatrixCoefficients | 'bt2020-ncl';
const FFPROBE_PRIMARIES: Record<string, ColorPrimariesExt> = {
  bt709: 'bt709',
  smpte170m: 'smpte170m',
  bt470bg: 'bt470bg',
  bt2020: 'bt2020',
};
const FFPROBE_TRANSFER: Record<string, TransferExt> = {
  bt709: 'bt709',
  smpte170m: 'smpte170m',
  smpte2084: 'pq',
  'arib-std-b67': 'hlg',
  'iec61966-2-1': 'iec61966-2-1',
  linear: 'linear',
};
const FFPROBE_MATRIX: Record<string, MatrixExt> = {
  bt709: 'bt709',
  smpte170m: 'smpte170m',
  bt470bg: 'bt470bg',
  bt2020nc: 'bt2020-ncl',
};

function expectedColorValue<T extends string>(
  table: Record<string, T>,
  ffprobeName: string | null,
): T | undefined {
  if (ffprobeName === null) return undefined;
  const mapped = table[ffprobeName];
  if (mapped === undefined) throw new Error(`no WebCodecs mapping for ffprobe '${ffprobeName}'`);
  return mapped;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('QTFF/.mov ffprobe-truth oracle (task #11 / ADR-185)', () => {
  const FILES = [
    'big_buck_bunny_1080p_h264.header.mov',
    'h264_1080p_5s.header.mov',
    'mov-tmcd-copy.mov',
    'mov-bt601-aac.mov',
    'mov-bt709matrix-sowt.mov',
    'mov-fl32-enda.mov',
    'mov-lpcm-96k-v2.mov',
    'mov-apple-avconvert.mov',
    'mp4-nclx-fullrange.mp4',
    'obs-remux-variable-aac.mp4',
  ] as const;

  async function truthFor(file: string): Promise<TruthFile> {
    const entry = (await loadTruth()).files.find((f) => f.file === file);
    if (!entry) throw new Error(`no ffprobe truth baked for ${file}`);
    return entry;
  }

  it.each(FILES)(
    '%s — every declared trak is enumerated: count + order + type + codec',
    async (file) => {
      const entry = await truthFor(file);
      const movie = await parseTruthFile(entry);
      const merged = mergedTrackOrder(movie);

      // Truth: ffprobe nb_streams counts data/timecode streams too — so must we.
      expect(merged, 'track count == ffprobe nb_streams').toHaveLength(entry.nbStreams);

      for (const [i, truth] of entry.streams.entries()) {
        const ours = merged[i];
        expect(ours, `stream ${i} present`).toBeDefined();
        if (!ours) continue;
        if (truth.codecType === 'video' || truth.codecType === 'audio') {
          expect(ours.kind, `stream ${i} is ${truth.codecType}`).toBe('av');
          if (ours.kind !== 'av') continue;
          expect(ours.track.mediaType).toBe(truth.codecType);
          expect(ours.track.sampleEntryType, `stream ${i} sample-entry fourcc`).toBe(
            truth.codecTag,
          );
          if (truth.codecName !== null) {
            expect(ffprobeCodecName(ours.track.codec), `stream ${i} codec`).toBe(truth.codecName);
          }
          if (truth.codecType === 'video') {
            expect(ours.track.width).toBe(truth.width);
            expect(ours.track.height).toBe(truth.height);
          } else {
            expect(ours.track.sampleRate).toBe(truth.sampleRate);
            expect(ours.track.channels).toBe(truth.channels);
          }
        } else {
          // Non-media stream (e.g. tmcd timecode): surfaced honestly, never dropped.
          expect(ours.kind, `stream ${i} is a non-media trak`).toBe('other');
          if (ours.kind !== 'other') continue;
          expect(ours.codec, `stream ${i} sample-entry fourcc`).toBe(truth.codecTag);
        }
      }
    },
  );

  it.each(FILES)(
    '%s — colr/pasp match ffprobe color_*/SAR; avcC is byte-identical to extradata',
    async (file) => {
      const entry = await truthFor(file);
      const movie = await parseTruthFile(entry);

      for (const truth of entry.streams) {
        if (truth.codecType !== 'video') continue;
        const track = movie.tracks.find(
          (t) => t.mediaType === 'video' && t.sampleEntryType === truth.codecTag,
        );
        expect(track, 'video track parsed').toBeDefined();
        if (!track) continue;

        // colr ↔ ffprobe color_primaries / color_transfer / color_space (matrix). A per-field
        // "unspecified" (code 2) must map to undefined exactly where ffprobe reports nothing.
        const expected = {
          primaries: expectedColorValue(FFPROBE_PRIMARIES, truth.colorPrimaries),
          transfer: expectedColorValue(FFPROBE_TRANSFER, truth.colorTransfer),
          matrix: expectedColorValue(FFPROBE_MATRIX, truth.colorSpace),
        };
        expect(track.colorSpace?.primaries, `${file} primaries`).toBe(expected.primaries);
        expect(track.colorSpace?.transfer, `${file} transfer`).toBe(expected.transfer);
        expect(track.colorSpace?.matrix, `${file} matrix`).toBe(expected.matrix);

        // The decode seam: the same mapping must ride on the VideoDecoderConfig the decoder consumes.
        const config = track.config as VideoDecoderConfig;
        expect(config.colorSpace?.primaries ?? undefined).toBe(expected.primaries);
        expect(config.colorSpace?.transfer ?? undefined).toBe(expected.transfer);
        expect(config.colorSpace?.matrix ?? undefined).toBe(expected.matrix);

        // full-range flag: carried by `nclx` only (QuickTime `nclc` has no range field — the golden's
        // color_range then reflects the bitstream VUI, which the parser must NOT invent).
        if (track.colr?.colourType === 'nclx' && truth.colorRange !== null) {
          expect(track.colr.fullRange, `${file} nclx full_range`).toBe(truth.colorRange === 'pc');
          expect(config.colorSpace?.fullRange ?? undefined).toBe(truth.colorRange === 'pc');
        }
        if (track.colr?.colourType === 'nclc') {
          expect(track.colr.fullRange, 'nclc carries no range flag').toBeUndefined();
        }

        // pasp ↔ ffprobe sample_aspect_ratio. Without a pasp atom ffprobe may still report 1:1 (VUI);
        // the parser must not invent one — but any non-square truth requires the atom to be read.
        if (track.pasp) {
          expect(`${track.pasp.hSpacing}:${track.pasp.vSpacing}`).toBe(truth.sampleAspectRatio);
          if (track.pasp.hSpacing !== track.pasp.vSpacing) {
            const displayWidth = config.displayAspectWidth;
            const displayHeight = config.displayAspectHeight;
            expect(displayWidth, `${file} decoder displayAspectWidth`).toBeDefined();
            expect(displayHeight, `${file} decoder displayAspectHeight`).toBeDefined();
            if (
              displayWidth !== undefined &&
              displayHeight !== undefined &&
              truth.width !== null &&
              truth.height !== null
            ) {
              // Independent ffprobe oracle: decoder DAR must equal coded width:height multiplied by SAR.
              expect(displayWidth * truth.height * track.pasp.vSpacing).toBe(
                displayHeight * truth.width * track.pasp.hSpacing,
              );
            }
          }
        } else {
          expect(
            truth.sampleAspectRatio === null || truth.sampleAspectRatio === '1:1',
            `${file}: missing pasp for SAR ${truth.sampleAspectRatio}`,
          ).toBe(true);
        }

        // avcC bytes ↔ ffprobe extradata, byte-identical (the decode `description`).
        if (truth.extradataHex !== null) {
          expect(track.codecPrivate, 'codecPrivate present').toBeDefined();
          expect(hex(track.codecPrivate?.data ?? new Uint8Array()), `${file} avcC`).toBe(
            truth.extradataHex,
          );
          const description = (track.config as VideoDecoderConfig).description;
          expect(description instanceof Uint8Array ? hex(description) : '').toBe(
            truth.extradataHex,
          );
        }
      }
    },
  );

  it('regression pin: big_buck_bunny header enumerates 3 streams incl. the tmcd trak (was 2)', async () => {
    const movie = await parseTruthFile(await truthFor('big_buck_bunny_1080p_h264.header.mov'));
    expect(movie.tracks).toHaveLength(2); // decodable AV tracks stay exactly the AV pair
    expect(movie.otherTracks).toHaveLength(1);
    const tmcd = movie.otherTracks?.[0];
    expect(tmcd?.handler).toBe('tmcd');
    expect(tmcd?.codec).toBe('tmcd');
    expect(tmcd?.trakIndex).toBe(1); // second trak in the file, between video and audio
    expect(tmcd?.sampleCount).toBeGreaterThan(0);
    expect(tmcd?.timescale).toBeGreaterThan(0);
    // Header-only fixture = no mdat exists, so passing proves enumeration reads no payload bytes.
  });

  it('the oracle can fail — a tampered truth (extra stream / wrong colr) is rejected', async () => {
    const entry = await truthFor('mov-bt601-aac.mov');
    const movie = await parseTruthFile(entry);
    const merged = mergedTrackOrder(movie);
    expect(merged).toHaveLength(entry.nbStreams);
    expect(merged).not.toHaveLength(entry.nbStreams + 1); // count tamper would fail

    const video = movie.tracks.find((t) => t.mediaType === 'video');
    expect(video?.colorSpace?.matrix).toBe('smpte170m');
    expect(video?.colorSpace?.matrix).not.toBe('bt709'); // colr tamper would fail
  });
});
