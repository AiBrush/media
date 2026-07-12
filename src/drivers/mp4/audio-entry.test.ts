/**
 * QuickTime / ISO `AudioSampleEntry` version 0 / 1 / 2 parsing (parse.ts `parseAudioEntry`).
 *
 * After the 8-byte preamble (6 reserved + 2 `data_reference_index`) a sound sample description carries
 * a `version`; the field layout then differs (ISO/IEC 14496-12 §12.2.3.2 + Apple QTFF "Sound Sample
 * Descriptions"). v0 was the only case handled before, so v1/v2 entries read the wrong bytes — the
 * classic symptom being `sampleRate === 1` (the v0 16.16 slot landing on the v2 `always65536`
 * constant) and `channels === 3` (the `always3` constant) — and then failed to locate the codec config
 * (`esds`, which QuickTime nests inside a `wave` box), yielding `audio:unknown` on reimport.
 *
 * Real fixtures (genuine bytes, not synthetic): the verbatim `ftyp`+`moov` headers of the acceptance
 * harness assets `big_buck_bunny_1080p_h264.mov` (v2, 5.1ch) and `h264_1080p_5s.mov` (v1, stereo),
 * extracted into `fixtures/media-derived/`. A header-only container is a valid probe input (probe reads
 * only `ftyp`+`moov`). The EXPECTED metadata is the harness golden truth, not a guess:
 *   - `fixtures/golden/big_buck_bunny_1080p_h264.mov.meta.json` → audio aac, 48000 Hz, 6 channels
 *   - `fixtures/golden/h264_1080p_5s.mov.meta.json`             → audio aac, 48000 Hz, 2 channels
 * (`mp4a.40.2` is AAC-LC; the harness adapter maps the RFC 6381 codec string to the `aac` family.)
 *
 * v0 is kept as a regression via the existing in-corpus `movie_5.mp4` / `test.mp4` (direct-`esds` AAC).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { MediaInfo, MediaInfoTrack } from '../../api/types.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp4Module } from './mp4-driver.ts';
import { type ParsedTrack, parseMovieMetadata } from './parse.ts';
import { Reader, boxes } from './reader.ts';

const DERIVED_DIR = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

/** A probe `Source` over a committed, real-bytes header fixture (loaded by direct path, not the manifest). */
async function headerSource(name: string): Promise<Source> {
  const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}${name}`));
  return fromBytes(bytes, { mime: 'video/quicktime' });
}

async function probeAudioTrack(source: Source): Promise<MediaInfoTrack> {
  const info: MediaInfo = await createMedia().use(Mp4Module).probe(source);
  const audio = info.tracks.find((t) => t.type === 'audio');
  expect(audio, 'probe must expose an audio track').toBeDefined();
  // Narrow for the type checker; the assertion above already guarantees presence at runtime.
  if (!audio) throw new Error('unreachable: audio track asserted above');
  return audio;
}

describe('AudioSampleEntry version parsing (probe, real MOV headers)', () => {
  it('v2 (big_buck_bunny, 5.1): reads f64 sampleRate + numAudioChannels and the wave-nested esds', async () => {
    const audio = await probeAudioTrack(await headerSource('big_buck_bunny_1080p_h264.header.mov'));
    // Source of truth: fixtures/golden/big_buck_bunny_1080p_h264.mov.meta.json (audio track).
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(6);
    expect(audio.codec).toBe('mp4a.40.2'); // AAC-LC; not the bare `mp4a` fourcc fallback
  });

  it('v1 (h264_1080p_5s, stereo): keeps the v0 channel/rate slots, skips the 16 extra bytes to the esds', async () => {
    const audio = await probeAudioTrack(await headerSource('h264_1080p_5s.header.mov'));
    // Source of truth: fixtures/golden/h264_1080p_5s.mov.meta.json (audio track).
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(2);
    expect(audio.codec).toBe('mp4a.40.2');
  });

  it('v0 regression (movie_5.mp4 / test.mp4): direct-esds AAC still matches the committed golden', async () => {
    // Gate against the committed per-file goldens (the v0 audio truth), so the v1/v2 change provably
    // does not disturb the version-0 path: movie_5 = mp4a.40.2/22050/1ch, test = mp4a.40.2/44100/2ch.
    for (const id of ['movie_5.mp4', 'test.mp4']) {
      const info: MediaInfo = await createMedia()
        .use(Mp4Module)
        .probe(await fixtureSource(id));
      expect(info).toEqual(await loadGoldenMetadata(id));
      const audio = info.tracks.find((t) => t.type === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
    }
  });

  it('owns escaped esds metadata instead of retaining the source backing store', async () => {
    const file = new Uint8Array(await readFile(`${DERIVED_DIR}h264_1080p_5s.header.mov`));
    const r = new Reader(file);
    let audio: ParsedTrack | undefined;
    for (const box of boxes(r, file.byteLength)) {
      if (box.type !== 'moov') continue;
      audio = parseMovieMetadata('qt  ', file.subarray(box.payloadStart, box.end)).tracks.find(
        (track) => track.mediaType === 'audio',
      );
      break;
    }

    expect(audio?.codecPrivate?.boxType).toBe('esds');
    expect(audio?.codecPrivate?.data.byteLength).toBeGreaterThan(0);
    expect(audio?.codecPrivate?.data.buffer).not.toBe(file.buffer);
    const description = (audio?.config as AudioDecoderConfig | undefined)?.description;
    expect(description).toBeDefined();
    if (description === undefined) throw new Error('AAC description was asserted above');
    const descriptionView = ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);
    expect(descriptionView.buffer).not.toBe(file.buffer);
  });

  it('the oracle can fail — v2 channels are genuinely 6, not the v0-misread 3 (anti-cheat, doc 11 §5)', async () => {
    const audio = await probeAudioTrack(await headerSource('big_buck_bunny_1080p_h264.header.mov'));
    // 3 / 1 are exactly what the old version-0-only parser produced (always3 / always65536>>16);
    // asserting against them proves the test would reject a regression to that bug.
    expect(audio.channels).not.toBe(3);
    expect(audio.sampleRate).not.toBe(1);
  });
});

// ============ QuickTime PCM sound descriptions (task #11 / ADR-185) ============
//
// Real ffmpeg-8-authored `.mov` fixtures (recipes in fixtures/golden/metadata/qtff-mov-truth.json):
// the QT PCM sample-entry fourccs must classify to the engine's honest PCM tokens matching ffprobe's
// `codec_name` — `sowt` v0 → pcm-s16 (pcm_s16le), `fl32` v1 + `wave`/`enda`(=1 little-endian) →
// pcm-f32 (pcm_f32le), `lpcm` v2 (float64 rate, formatSpecificFlags) → pcm-s16 @ 96 kHz — never a raw
// fourcc with no meaning to the decode/DSP seams, and never a dropped/other-typed audio track.

async function parseAudioTrackOf(name: string): Promise<ParsedTrack> {
  const file = new Uint8Array(await readFile(`${DERIVED_DIR}${name}`));
  const r = new Reader(file);
  let brand = 'mp42';
  for (const box of boxes(r, file.byteLength)) {
    if (box.type === 'ftyp') {
      brand = String.fromCharCode(...file.subarray(box.payloadStart, box.payloadStart + 4));
    }
    if (box.type === 'moov') {
      const movie = parseMovieMetadata(brand, file.subarray(box.payloadStart, box.end));
      const audio = movie.tracks.find((t) => t.mediaType === 'audio');
      if (!audio) throw new Error(`${name}: no audio track parsed`);
      return audio;
    }
  }
  throw new Error(`${name}: no moov`);
}

describe('QuickTime PCM sample entries classify to honest engine PCM tokens', () => {
  it("sowt v0 (mov-bt709matrix-sowt.mov) → 'pcm-s16', 22050 Hz mono (ffprobe pcm_s16le)", async () => {
    const audio = await parseAudioTrackOf('mov-bt709matrix-sowt.mov');
    expect(audio.sampleEntryType).toBe('sowt');
    expect(audio.codec).toBe('pcm-s16');
    expect(audio.config.codec).toBe('pcm-s16');
    expect(audio.sampleRate).toBe(22050);
    expect(audio.channels).toBe(1);
  });

  it("fl32 v1 + wave/enda little-endian (mov-fl32-enda.mov) → 'pcm-f32', 16000 Hz (ffprobe pcm_f32le)", async () => {
    const audio = await parseAudioTrackOf('mov-fl32-enda.mov');
    expect(audio.sampleEntryType).toBe('fl32');
    expect(audio.codec).toBe('pcm-f32'); // enda==1 ⇒ little-endian, NOT the fl32 big-endian default
    expect(audio.sampleRate).toBe(16000);
    expect(audio.channels).toBe(1);
  });

  it("lpcm v2 (mov-lpcm-96k-v2.mov) → 'pcm-s16' from formatSpecificFlags, f64 rate 96000", async () => {
    const audio = await parseAudioTrackOf('mov-lpcm-96k-v2.mov');
    expect(audio.sampleEntryType).toBe('lpcm');
    expect(audio.codec).toBe('pcm-s16'); // flags: signed-integer + packed, LE (no big-endian bit)
    expect(audio.sampleRate).toBe(96000);
    expect(audio.channels).toBe(1);
  });

  it('Apple AVFoundation-authored mp4a v1 (mov-apple-avconvert.mov): wave-nested esds with plain descriptor lengths', async () => {
    const audio = await parseAudioTrackOf('mov-apple-avconvert.mov');
    expect(audio.sampleEntryType).toBe('mp4a');
    expect(audio.codec).toBe('mp4a.40.2'); // esds found through `wave`, lengths without 0x80 padding
    expect(audio.sampleRate).toBe(22050);
    expect(audio.channels).toBe(1);
    const config = audio.config as AudioDecoderConfig;
    expect(config.description, 'AudioSpecificConfig extracted').toBeDefined();
  });

  it('ffmpeg-8-authored mp4a v1 wave (mov-tmcd-copy.mov): 0x80-padded descriptor lengths still resolve', async () => {
    const audio = await parseAudioTrackOf('mov-tmcd-copy.mov');
    expect(audio.codec).toBe('mp4a.40.2');
    expect(audio.sampleRate).toBe(22050);
    expect(audio.channels).toBe(1);
  });
});
