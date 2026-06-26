import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { readAiffPcm } from '../aiff/aiff.ts';
import { readCafPcm } from '../caf/caf.ts';
import { readWavPcm } from './pcm.ts';

const SIN = 'sin_440Hz_-6dBFS_1s.wav';
const DERIVED = new URL('../../../fixtures/media-derived/aiff-caf/', import.meta.url).pathname;
const media = () => createMedia(); // zero-config: first-party WAV driver auto-registers on demand

async function bytesOf(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}
const wavSource = (bytes: Uint8Array): Source => fromBytes(bytes, { mime: 'audio/wav' });
const aiffSource = (bytes: Uint8Array): Source => fromBytes(bytes, { mime: 'audio/aiff' });
const loadDerived = async (id: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${DERIVED}${id}`));

describe('media.convert — PCM-native audio path (ADR-022)', () => {
  it('up-mixes mono → stereo (re-probes as 2ch; both channels are the source, bit-exact)', async () => {
    const orig = readWavPcm(await loadFixture(SIN));
    const out = await bytesOf(
      await media().convert(await fixtureSource(SIN), { to: 'wav', audio: { channels: 2 } }),
    );

    const re = readWavPcm(out);
    expect(re.channels).toBe(2);
    expect(re.frames).toBe(orig.frames);
    expect(re.format).toBe('s16'); // source sample-format preserved
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
    expect(channelAt(re.planar, 1)).toEqual(channelAt(orig.planar, 0));

    const info = await media().probe(wavSource(out));
    expect(info.tracks[0]?.channels).toBe(2);
  });

  it('round-trips mono → stereo → mono to the bit-exact original (end-to-end through the public API)', async () => {
    const orig = readWavPcm(await loadFixture(SIN));
    const stereo = await bytesOf(
      await media().convert(await fixtureSource(SIN), { to: 'wav', audio: { channels: 2 } }),
    );
    const monoBack = await bytesOf(
      await media().convert(wavSource(stereo), { to: 'wav', audio: { channels: 1 } }),
    );

    const re = readWavPcm(monoBack);
    expect(re.channels).toBe(1);
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
  });

  it('a no-op convert (no audio opts) is lossless — PCM survives byte-for-byte', async () => {
    const orig = readWavPcm(await loadFixture('speech.wav'));
    const out = await bytesOf(
      await media().convert(await fixtureSource('speech.wav'), { to: 'wav' }),
    );
    const re = readWavPcm(out);
    expect(re.frames).toBe(orig.frames);
    expect(re.channels).toBe(orig.channels);
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
  });

  it('accepts an explicit pcm codec at the same sample rate (no resample needed)', async () => {
    const out = await bytesOf(
      await media().convert(await fixtureSource(SIN), {
        to: 'wav',
        audio: { codec: 'pcm', sampleRate: 44100 },
      }),
    );
    expect(readWavPcm(out).sampleRate).toBe(44100);
  });

  it.each([
    ['sfx-pcm-s24.wav', 's24'],
    ['sfx-pcm-f32.wav', 'f32'],
  ])('converts %s to an explicit pcm-s16 WAV target', async (id, sourceFormat) => {
    const orig = readWavPcm(await loadFixture(id));
    expect(orig.format).toBe(sourceFormat);
    const out = await bytesOf(
      await media().convert(await fixtureSource(id), {
        to: 'wav',
        audio: { codec: 'pcm-s16' as never },
      }),
    );

    const re = readWavPcm(out);
    expect(re.format).toBe('s16');
    expect(re.sampleRate).toBe(orig.sampleRate);
    expect(re.channels).toBe(orig.channels);
    expect(re.frames).toBe(orig.frames);
    const info = await media().probe(wavSource(out));
    expect(info.tracks[0]?.codec).toBe('pcm-s16');
  });

  it('converts big-endian AIFF PCM to little-endian WAV without changing samples', async () => {
    const input = await loadDerived('sfx.aiff');
    const orig = readAiffPcm(input);
    expect(orig.format).toBe('s16');
    expect(orig.endian).toBe('be');

    const out = await bytesOf(
      await media().convert(aiffSource(input), {
        to: 'wav',
        audio: { codec: 'pcm-s16' as never },
      }),
    );

    const re = readWavPcm(out);
    expect(re.format).toBe('s16');
    expect(re.sampleRate).toBe(orig.sampleRate);
    expect(re.channels).toBe(orig.channels);
    expect(re.frames).toBe(orig.frames);
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
    const info = await media().probe(wavSource(out));
    expect(info.container).toBe('wav');
    expect(info.tracks[0]?.codec).toBe('pcm-s16');
  });

  it('converts little-endian WAV PCM to big-endian AIFF without changing samples', async () => {
    const orig = readWavPcm(await loadFixture(SIN));
    const out = await bytesOf(
      await media().convert(await fixtureSource(SIN), {
        to: 'aiff',
        audio: { codec: 'pcm-s16be' as never },
      }),
    );

    const re = readAiffPcm(out);
    expect(re.kind).toBe('aiff');
    expect(re.format).toBe('s16');
    expect(re.endian).toBe('be');
    expect(re.sampleRate).toBe(orig.sampleRate);
    expect(re.channels).toBe(orig.channels);
    expect(re.frames).toBe(orig.frames);
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
    const info = await media().probe(aiffSource(out));
    expect(info.container).toBe('aiff');
    expect(info.tracks[0]?.codec).toBe('pcm-s16be');
  });

  it('converts WAV PCM to CAF through the same native PCM path', async () => {
    const orig = readWavPcm(await loadFixture(SIN));
    const out = await bytesOf(
      await media().convert(await fixtureSource(SIN), {
        to: 'caf',
        audio: { codec: 'pcm-s16' as never },
      }),
    );

    const re = readCafPcm(out);
    expect(re.format).toBe('s16');
    expect(re.endian).toBe('le');
    expect(re.sampleRate).toBe(orig.sampleRate);
    expect(re.channels).toBe(orig.channels);
    expect(re.frames).toBe(orig.frames);
    expect(channelAt(re.planar, 0)).toEqual(channelAt(orig.planar, 0));
  });

  it('resamples PCM to a new sample rate via the windowed-sinc tail (ADR-022)', async () => {
    const orig = readWavPcm(
      await bytesOf(await media().convert(await fixtureSource(SIN), { to: 'wav' })),
    );
    const out = readWavPcm(
      await bytesOf(
        await media().convert(await fixtureSource(SIN), {
          to: 'wav',
          audio: { sampleRate: 22050 },
        }),
      ),
    );
    expect(out.sampleRate).toBe(22050);
    expect(out.channels).toBe(orig.channels);
    const origLen = channelAt(orig.planar, 0).length;
    expect(channelAt(out.planar, 0).length).toBe(Math.round((origLen * 22050) / orig.sampleRate));
  });

  it('rejects a lossy/cross-container target that needs the codec seam', async () => {
    // wav → mp3 (lossy encode) and mp3 → wav (decode) both require the browser codec layer.
    await expect(media().convert(await fixtureSource(SIN), { to: 'mp3' })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(
      media().convert(await fixtureSource('sound_5.mp3'), { to: 'wav', audio: { channels: 1 } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects dropping audio from a PCM file (audio:false) — nothing to encode', async () => {
    await expect(
      media().convert(await fixtureSource(SIN), { to: 'wav', audio: false }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('is cancellable via the returned handle', async () => {
    const handle = media().convert(await fixtureSource(SIN), { to: 'wav', audio: { channels: 2 } });
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});
