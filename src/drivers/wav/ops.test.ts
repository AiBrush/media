import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { readWavPcm } from './pcm.ts';

const SIN = 'sin_440Hz_-6dBFS_1s.wav';
const media = () => createMedia(); // zero-config: first-party WAV driver auto-registers on demand

async function bytesOf(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}
const wavSource = (bytes: Uint8Array): Source => fromBytes(bytes, { mime: 'audio/wav' });

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

  it('rejects true resampling with a typed CapabilityError (needs the WASM tail)', async () => {
    await expect(
      media().convert(await fixtureSource(SIN), { to: 'wav', audio: { sampleRate: 22050 } }),
    ).rejects.toBeInstanceOf(CapabilityError);
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
