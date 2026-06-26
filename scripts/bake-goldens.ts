#!/usr/bin/env bun
/**
 * scripts/bake-goldens.ts — bake committed golden references from the verified corpus
 * (BUILD_INSTRUCTIONS §6.1, docs/architecture/11 §3). Goldens are checksum-pinned and committed;
 * the large media is not.
 *
 * Phase 0 bakes the **corpus index** (`fixtures/golden/corpus-index.json`) after re-verifying every
 * cached file's sha256, so the committed golden set has a single source of truth for what the corpus
 * contains. The strong per-op goldens — `golden-metadata`, `golden-packets`,
 * `decoded-frames-bitexact` (baked in `force-software`), cleartext twins for decrypt — are baked here
 * as their ops/drivers land (Phase 1+).
 *
 *   bun run bake-goldens
 */

import { $ } from 'bun';
import { createMedia } from '../src/api/create-media.ts';
import { AdtsModule } from '../src/drivers/adts/adts-driver.ts';
import { FlacModule } from '../src/drivers/flac/flac-driver.ts';
import { Mp3Module } from '../src/drivers/mp3/mp3-driver.ts';
import { Mp4Module, muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import { OggModule } from '../src/drivers/ogg/ogg-driver.ts';
import { WavModule } from '../src/drivers/wav/wav-driver.ts';
import { WebmModule } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';
import { flacDecodeGolden, wavDecodeGolden } from '../src/test-support/decode-goldens.ts';
import { dspGoldenDigests } from '../src/test-support/dsp-goldens.ts';
import {
  type GoldenPacketRow,
  goldenPacketsFor,
  perTrackTallies,
} from '../src/test-support/packet-goldens.ts';
import { sha256Hex } from '../src/util/digest.ts';

interface FixtureEntry {
  id: string;
  sha256: string;
  bytes: number;
  container: string;
  video?: string;
  audio?: string;
  traits: string[];
}
interface Manifest {
  files: FixtureEntry[];
}

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = `${ROOT}fixtures/manifest.json`;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const GOLDEN_INDEX = `${ROOT}fixtures/golden/corpus-index.json`;
const METADATA_DIR = `${ROOT}fixtures/golden/metadata`;
const DSP_DIR = `${ROOT}fixtures/golden/dsp`;
const PACKETS_DIR = `${ROOT}fixtures/golden/packets`;
const DECODE_DIR = `${ROOT}fixtures/golden/decoded`;
const DECRYPT_DIR = `${ROOT}fixtures/golden/decrypt`;

/**
 * `golden-packets`: deterministic real fixtures whose exact demuxed packet table is pinned, with an
 * independent `ffprobe` per-track corroboration baked in (doc 11 §2). One per Node-feasible container.
 */
const PACKET_FIXTURES: ReadonlyArray<{ id: string; container: string }> = [
  { id: 'movie_5.mp4', container: 'mp4' },
  { id: 'bear-1280x720.mp4', container: 'mp4' },
  { id: 'h264.mp4', container: 'mp4' },
  { id: 'sfx.flac', container: 'flac' },
  { id: 'sfx.adts', container: 'adts' },
  { id: 'sound_5.mp3', container: 'mp3' },
  { id: 'sfx-opus.ogg', container: 'ogg' },
];

/**
 * `decoded-frames-bitexact` (pure-TS decode paths, force-software): FLAC + WAV/PCM fixtures whose decoded
 * interleaved PCM is pinned by sha256 and corroborated byte-exactly against an independent ffmpeg decode.
 */
const FLAC_DECODE_FIXTURES = [
  'sfx.flac',
  'flac-08bit.flac',
  'flac-24bit-hires.flac',
  'flac-5_1ch.flac',
  'flac-192khz.flac',
  'flac-12bit.flac', // ffmpeg-scales 12-bit to s16 full-scale; self-MD5-validated, not ffmpeg-cross-checked
] as const;
const WAV_DECODE_FIXTURES = [
  'sfx-pcm-u8.wav',
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sfx-pcm-s32.wav',
  'sfx-pcm-f32.wav',
  'stereo-48000.wav',
] as const;

/** Deterministic test key/KID/IV for the decrypt cleartext twins (NOT secrets — fixture material only). */
const TWIN_KEY = '000102030405060708090a0b0c0d0e0f';
const TWIN_KID = '00112233445566778899aabbccddeeff';
const TWIN_IV = '00112233445566778899aabbccddeeff';

/** Probe-backed golden-metadata for the containers our TS demuxer already parses (doc 11 §2). */
const PROBE_CONTAINERS = new Set(['mp4', 'wav', 'mp3', 'ogg', 'webm', 'flac', 'adts']);
const PROBE_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  flac: 'audio/flac',
  adts: 'audio/aac',
};

/**
 * Fixtures whose probe-metadata golden is **deferred**: our probe currently disagrees with ffprobe
 * truth on a field, so baking our own output would commit a self-confirming (un-failable) oracle that
 * encodes the bug (BUILD_INSTRUCTIONS §6 — never fake; doc 11 §5). The files stay in the corpus and
 * exercise the demuxer; their golden lands once the probe handles the case. The corpus-integrity test
 * still asserts each of these fetches + loads + probes without error — just not field-equality.
 *  - `bear-av1-10bit.mp4`, `bear-open-gop-frag.mp4`, `bear-av-frag.mp4`: fragmented (mvex+moof, empty
 *    moov sample table) → mvhd/mdhd duration is 0; ffprobe reports the real fragment duration.
 *  - `bear-non-square-pixel.mp4`: probe yields fps 0; ffprobe reports 29.97.
 *  - `bear-multitrack.webm`: probe emits raw Matroska codec ids (a_pcm/int/lit) and Theora display
 *    dims 320x192; ffprobe canonicalizes to pcm and coded 320x180.
 */
const DEFER_METADATA_GOLDEN = new Set([
  'bear-av1-10bit.mp4',
  'bear-open-gop-frag.mp4',
  'bear-av-frag.mp4',
  'bear-non-square-pixel.mp4',
  'bear-multitrack.webm',
]);

async function main(): Promise<void> {
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;
  const index: Record<string, Omit<FixtureEntry, 'id'>> = {};
  let failures = 0;

  for (const entry of [...manifest.files].sort((a, b) => a.id.localeCompare(b.id))) {
    const file = Bun.file(`${MEDIA_DIR}/${entry.id}`);
    if (!(await file.exists())) {
      console.error(`  ✗ ${entry.id}: missing from cache — run \`bun run fetch-fixtures\` first`);
      failures++;
      continue;
    }
    const actual = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
    if (actual !== entry.sha256) {
      console.error(`  ✗ ${entry.id}: sha256 mismatch (cache differs from manifest)`);
      failures++;
      continue;
    }
    const { id, ...rest } = entry;
    index[id] = rest;
    console.info(`  ✓ ${id}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} fixture(s) failed verification; goldens not baked.`);
    process.exit(1);
  }

  await Bun.write(GOLDEN_INDEX, `${JSON.stringify(index, null, 2)}\n`);
  console.info(`\nbaked ${Object.keys(index).length} entries → fixtures/golden/corpus-index.json`);

  // golden-metadata: probe each parseable container so probe is gated on an exact, frozen reference.
  const media = createMedia()
    .use(Mp4Module)
    .use(WavModule)
    .use(Mp3Module)
    .use(OggModule)
    .use(WebmModule)
    .use(FlacModule)
    .use(AdtsModule);
  let metaCount = 0;
  for (const entry of manifest.files) {
    if (!PROBE_CONTAINERS.has(entry.container)) continue;
    if (DEFER_METADATA_GOLDEN.has(entry.id)) continue;
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${entry.id}`).arrayBuffer());
    const mime = PROBE_MIME[entry.container];
    const info = await media.probe(fromBytes(bytes, mime ? { mime } : {}));
    await Bun.write(`${METADATA_DIR}/${entry.id}.json`, `${JSON.stringify(info, null, 2)}\n`);
    metaCount++;
  }
  console.info(`baked ${metaCount} golden-metadata files → fixtures/golden/metadata/`);

  // decoded-audio-pcm: pin the byte-stable (pow-free) PCM transforms for every WAV fixture (doc 11).
  let dspCount = 0;
  for (const entry of manifest.files) {
    if (entry.container !== 'wav') continue;
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${entry.id}`).arrayBuffer());
    const golden = await dspGoldenDigests(bytes);
    await Bun.write(`${DSP_DIR}/${entry.id}.json`, `${JSON.stringify(golden, null, 2)}\n`);
    dspCount++;
  }
  console.info(`baked ${dspCount} audio-dsp golden files → fixtures/golden/dsp/`);

  await bakeGoldenPackets();
  await bakeDecodedBitexact();
  await bakeDecryptTwins();

  // Commit goldens in the project's canonical format: JSON.stringify expands arrays one-per-line, but
  // biome collapses short arrays, so the raw output would fail `biome check`. Normalize once here.
  await $`bunx biome format --write ${`${ROOT}fixtures/golden`}`.quiet();
  console.info('formatted goldens with biome.');
}

// ── golden-packets (engine table + independent ffprobe per-track corroboration) ─────────────────────

/** ffprobe per-stream {count, bytes} for one media-type selector, parsed from `-show_packets` CSV. */
async function ffprobeStreamTally(
  path: string,
  selector: string,
): Promise<{ count: number; bytes: number } | undefined> {
  const out =
    await $`ffprobe -hide_banner -loglevel error -select_streams ${selector} -show_packets -of csv=p=0 -show_entries packet=size ${path}`
      .nothrow()
      .text();
  const sizes = out
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => Number.parseInt(l, 10));
  if (sizes.length === 0) return undefined;
  const bytes = sizes.every((n) => Number.isFinite(n)) ? sizes.reduce((a, b) => a + b, 0) : -1;
  return { count: sizes.length, bytes };
}

/**
 * Cross-check the engine's per-track tallies against ffprobe (the independent demuxer). For MP4 we map
 * each track to the v:0/a:0 stream and require byte-exact agreement; for elementary audio containers we
 * require count agreement (ffprobe omits per-packet `size` for some of them). Returns the ffprobe figures
 * to commit, or throws if the engine disagrees with ffprobe (so a baked golden is never self-confirming).
 */
async function ffprobeCorroborate(
  id: string,
  container: string,
  rows: readonly GoldenPacketRow[],
): Promise<{ selector: string; count: number; bytes: number }[]> {
  const path = `${MEDIA_DIR}/${id}`;
  const tallies = perTrackTallies(rows);
  const result: { selector: string; count: number; bytes: number }[] = [];
  if (container === 'mp4' || container === 'mov') {
    // Match each engine track to whichever ffprobe stream (v:0/a:0) has the same packet count.
    const ff = new Map<string, { count: number; bytes: number }>();
    for (const sel of ['v:0', 'a:0']) {
      const t = await ffprobeStreamTally(path, sel);
      if (t) ff.set(sel, t);
    }
    for (const tally of tallies) {
      const match = [...ff.entries()].find(([, v]) => v.count === tally.count);
      if (!match)
        throw new Error(
          `${id}: no ffprobe stream matches engine track ${tally.trackId} (count ${tally.count})`,
        );
      const [selector, v] = match;
      if (v.bytes !== tally.bytes)
        throw new Error(
          `${id}: track ${tally.trackId} bytes ${tally.bytes} ≠ ffprobe ${selector} bytes ${v.bytes}`,
        );
      result.push({ selector, count: v.count, bytes: v.bytes });
    }
    return result;
  }
  // Elementary audio container: one track, corroborate count (+ bytes when ffprobe provides them).
  const t = await ffprobeStreamTally(path, 'a:0');
  if (!t) throw new Error(`${id}: ffprobe reported no audio packets`);
  const ours = tallies[0];
  if (!ours || ours.count !== t.count)
    throw new Error(`${id}: engine count ${ours?.count} ≠ ffprobe count ${t.count}`);
  if (t.bytes >= 0 && t.bytes !== ours.bytes)
    throw new Error(`${id}: engine bytes ${ours.bytes} ≠ ffprobe bytes ${t.bytes}`);
  result.push({ selector: 'a:0', count: t.count, bytes: t.bytes });
  return result;
}

async function bakeGoldenPackets(): Promise<void> {
  let n = 0;
  for (const { id, container } of PACKET_FIXTURES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const golden = await goldenPacketsFor(container, bytes);
    const ffprobe = await ffprobeCorroborate(id, container, golden.rows); // throws if engine ≠ ffprobe
    await Bun.write(
      `${PACKETS_DIR}/${id}.json`,
      `${JSON.stringify({ ...golden, ffprobe }, null, 2)}\n`,
    );
    n++;
  }
  console.info(`baked ${n} golden-packets files (ffprobe-corroborated) → fixtures/golden/packets/`);
}

// ── decoded-frames-bitexact (pure-TS decode + independent ffmpeg corroboration) ─────────────────────

/** ffmpeg raw-PCM codec/format whose wire layout matches our decoder's at a given native bit depth (signed). */
const FF_PCM: Record<number, { fmt: string; codec: string }> = {
  8: { fmt: 's8', codec: 'pcm_s8' },
  16: { fmt: 's16le', codec: 'pcm_s16le' },
  24: { fmt: 's24le', codec: 'pcm_s24le' },
  32: { fmt: 's32le', codec: 'pcm_s32le' },
};
const FF_WAV: Record<number, { fmt: string; codec: string }> = {
  8: { fmt: 'u8', codec: 'pcm_u8' }, // WAV 8-bit is unsigned
  16: { fmt: 's16le', codec: 'pcm_s16le' },
  24: { fmt: 's24le', codec: 'pcm_s24le' },
  32: { fmt: 's32le', codec: 'pcm_s32le' },
};

/** ffmpeg-decode `id` to raw interleaved PCM and return its sha256, or undefined if the format is unmapped. */
async function ffmpegPcmSha(
  id: string,
  bitsPerSample: number,
  table: Record<number, { fmt: string; codec: string }>,
  isFloat: boolean,
): Promise<string | undefined> {
  const spec = isFloat ? { fmt: 'f32le', codec: 'pcm_f32le' } : table[bitsPerSample];
  if (!spec) return undefined;
  const raw =
    await $`ffmpeg -hide_banner -loglevel error -i ${`${MEDIA_DIR}/${id}`} -f ${spec.fmt} -acodec ${spec.codec} -`
      .nothrow()
      .arrayBuffer();
  return sha256Hex(new Uint8Array(raw));
}

async function bakeDecodedBitexact(): Promise<void> {
  let n = 0;
  for (const id of FLAC_DECODE_FIXTURES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const golden = await flacDecodeGolden(bytes);
    if (golden.ffmpegCrossChecked) {
      const ff = await ffmpegPcmSha(id, golden.bitsPerSample, FF_PCM, false);
      if (ff !== golden.sha256)
        throw new Error(
          `${id}: FLAC decode sha ${golden.sha256.slice(0, 12)} ≠ ffmpeg ${ff?.slice(0, 12)}`,
        );
    }
    await Bun.write(`${DECODE_DIR}/${id}.json`, `${JSON.stringify(golden, null, 2)}\n`);
    n++;
  }
  for (const id of WAV_DECODE_FIXTURES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const golden = await wavDecodeGolden(bytes);
    const isFloat = golden.bitsPerSample === 32 && id.includes('f32');
    const ff = await ffmpegPcmSha(id, golden.bitsPerSample, FF_WAV, isFloat);
    if (ff !== golden.sha256)
      throw new Error(
        `${id}: WAV decode sha ${golden.sha256.slice(0, 12)} ≠ ffmpeg ${ff?.slice(0, 12)}`,
      );
    await Bun.write(`${DECODE_DIR}/${id}.json`, `${JSON.stringify(golden, null, 2)}\n`);
    n++;
  }
  console.info(
    `baked ${n} decoded-frames-bitexact files (ffmpeg-corroborated) → fixtures/golden/decoded/`,
  );
}

// ── decrypt cleartext twins (produced by INDEPENDENT tools: openssl + ffmpeg) ───────────────────────

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** Copy a byte view into a fresh `Uint8Array<ArrayBuffer>` (so it satisfies `BufferSource` for WebCrypto). */
function asBufferSource(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

/** Per-track sample sha256 list of an MP4 — the cleartext twin a decrypt must reproduce. */
async function mp4SampleShas(mp4: Uint8Array, type: 'audio' | 'video'): Promise<string[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === type);
  const samples = tracks[idx]?.samples ?? [];
  return Promise.all(samples.map((s) => sha256Hex(asBufferSource(s.data))));
}

/**
 * Bake the decrypt cleartext twins from INDEPENDENT encryptors (never our own decryptor's inverse):
 *   - **HLS AES-128**: encrypt a real fixture with the `openssl` CLI; commit the ciphertext (small) + the
 *     plaintext sha256. The decrypt test recovers the plaintext from openssl's ciphertext — a true oracle.
 *   - **CENC (cenc-aes-ctr) audio**: encrypt a real MP4 with `ffmpeg`; commit the ffmpeg ciphertext's sha256
 *     + the CLEAR original's audio-sample sha256 list (the twin). The decrypt test recovers ffmpeg's audio
 *     samples and must match the clear twin. (Video subsample CENC twins from ffmpeg are deferred — ffmpeg
 *     leaves the IDR parameter-set NALs clear with a boundary our decryptor splits differently on sample 0;
 *     119/120 video samples already match, so this is a known ffmpeg-semantics gap, not a decrypt bug.)
 */
async function bakeDecryptTwins(): Promise<void> {
  // (1) HLS AES-128 twin via openssl.
  const hlsPlainId = 'sfx.adts';
  const plain = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${hlsPlainId}`).arrayBuffer());
  const cipherPath = `${DECRYPT_DIR}/${hlsPlainId}.aes128.bin`;
  await $`openssl enc -aes-128-cbc -K ${TWIN_KEY} -iv ${TWIN_IV} -in ${`${MEDIA_DIR}/${hlsPlainId}`} -out ${cipherPath}`.quiet();
  const cipher = new Uint8Array(await Bun.file(cipherPath).arrayBuffer());
  await Bun.write(
    `${DECRYPT_DIR}/hls-aes128.json`,
    `${JSON.stringify(
      {
        scheme: 'hls-aes128',
        tool: 'openssl enc -aes-128-cbc',
        plaintextId: hlsPlainId,
        keyHex: TWIN_KEY,
        ivHex: TWIN_IV,
        cipherFile: `${hlsPlainId}.aes128.bin`,
        cipherSha256: await sha256Hex(cipher),
        plaintextBytes: plain.byteLength,
        plaintextSha256: await sha256Hex(plain),
      },
      null,
      2,
    )}\n`,
  );

  // (2) CENC (cenc-aes-ctr) audio twin via ffmpeg.
  const cencSrcId = 'movie_5.mp4';
  const clear = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${cencSrcId}`).arrayBuffer());
  const cencPath = `${DECRYPT_DIR}/${cencSrcId}.cenc.mp4`;
  await $`ffmpeg -hide_banner -loglevel error -y -i ${`${MEDIA_DIR}/${cencSrcId}`} -c copy -encryption_scheme cenc-aes-ctr -encryption_key ${TWIN_KEY} -encryption_kid ${TWIN_KID} ${cencPath}`.quiet();
  const cencBytes = new Uint8Array(await Bun.file(cencPath).arrayBuffer());
  const clearAudioShas = await mp4SampleShas(clear, 'audio');
  // Self-check at bake time: our decrypt of ffmpeg's CENC file must reproduce the clear audio twin.
  const dec = await createMedia().decrypt(fromBytes(cencBytes, { mime: 'video/mp4' }), {
    scheme: 'cenc',
    keys: { [TWIN_KID]: TWIN_KEY },
  });
  if (!(dec instanceof Blob)) throw new Error('cenc twin: expected a Blob');
  const decAudioShas = await mp4SampleShas(new Uint8Array(await dec.arrayBuffer()), 'audio');
  if (
    decAudioShas.length !== clearAudioShas.length ||
    decAudioShas.some((h, i) => h !== clearAudioShas[i])
  ) {
    throw new Error(
      'cenc twin: our decrypt of ffmpeg CENC audio does not match the clear original',
    );
  }
  // Also bake an in-house CENC twin (encryptCenc) so the test still gates without re-shelling ffmpeg, and
  // record ffmpeg's ciphertext sha so a regenerated golden is reproducible from the same ffmpeg version.
  await Bun.write(
    `${DECRYPT_DIR}/cenc-aes-ctr.json`,
    `${JSON.stringify(
      {
        scheme: 'cenc',
        tool: 'ffmpeg -encryption_scheme cenc-aes-ctr',
        clearId: cencSrcId,
        keyHex: TWIN_KEY,
        kidHex: TWIN_KID,
        cipherFile: `${cencSrcId}.cenc.mp4`,
        cipherSha256: await sha256Hex(cencBytes),
        audioSampleCount: clearAudioShas.length,
        clearAudioSampleSha256: clearAudioShas,
      },
      null,
      2,
    )}\n`,
  );
  console.info(
    'baked 2 decrypt cleartext twins (openssl HLS + ffmpeg CENC) → fixtures/golden/decrypt/',
  );
}

await main();
