import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { decodeFlac } from '../../codecs/flac/decode.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { readWavPcm } from '../wav/pcm.ts';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const flacSource = (b: Uint8Array) => fromBytes(b, { mime: 'audio/flac' });

async function blobBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}
/** Independent `data`-chunk locator. */
function wavData(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[pos] ?? 0,
      bytes[pos + 1] ?? 0,
      bytes[pos + 2] ?? 0,
      bytes[pos + 3] ?? 0,
    );
    const size = dv.getUint32(pos + 4, true);
    if (id === 'data')
      return bytes.subarray(pos + 8, pos + 8 + Math.min(size, bytes.byteLength - pos - 8));
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

describe('media.convert — FLAC → WAV (pure-TS decode, ADR-024)', () => {
  it('16-bit FLAC → WAV: the output PCM MD5 matches the FLAC STREAMINFO digest (end-to-end)', async () => {
    // For 16-bit FLAC the WAV s16 PCM IS the codec's original PCM, so its MD5 must equal STREAMINFO's.
    const flacBytes = await loadFixture('flac-wasted-bits.flac'); // 16-bit stereo
    const expected = hex(decodeFlac(flacBytes).md5);
    const out = await blobBytes(await createMedia().convert(flacSource(flacBytes), { to: 'wav' }));
    expect(md5(wavData(out))).toBe(expected);
  });

  it('a second 16-bit FLAC (LPC qlp-2) also round-trips to the STREAMINFO digest', async () => {
    const flacBytes = await loadFixture('flac-qlp2.flac');
    const expected = hex(decodeFlac(flacBytes).md5);
    const out = await blobBytes(await createMedia().convert(flacSource(flacBytes), { to: 'wav' }));
    expect(md5(wavData(out))).toBe(expected);
  });

  it('probe sees the FLAC→WAV output as PCM', async () => {
    const out = await blobBytes(
      await createMedia().convert(await fixtureSource('sfx.flac'), { to: 'wav' }),
    );
    const info = await createMedia().probe(fromBytes(out, { mime: 'audio/wav' }));
    expect(info.container).toBe('wav');
    expect(info.tracks[0]?.codec).toMatch(/^pcm-/);
    expect(info.tracks[0]?.sampleRate).toBe(48000);
  });

  it('up-mixes during decode (mono sfx.flac → stereo WAV)', async () => {
    const out = await blobBytes(
      await createMedia().convert(await fixtureSource('sfx.flac'), {
        to: 'wav',
        audio: { channels: 2 },
      }),
    );
    const wav = readWavPcm(out);
    expect(wav.channels).toBe(2);
    expect(wav.frames).toBe(10240);
  });

  it('rejects true resampling with a typed CapabilityError', async () => {
    await expect(
      createMedia().convert(await fixtureSource('sfx.flac'), {
        to: 'wav',
        audio: { sampleRate: 22050 },
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('is cancellable via the handle', async () => {
    const handle = createMedia().convert(await fixtureSource('sfx.flac'), { to: 'wav' });
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});
