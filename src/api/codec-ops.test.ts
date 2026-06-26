/**
 * Engine-level routing tests for the codec-tier ops (decode/encode/convert/seek), exercised in Node where
 * WebCodecs/GPU are ABSENT. They pin the parts of the wiring that are Node-reachable: the convert
 * stream-copy auto-route (a pure container change still works losslessly), the honest `CapabilityError`
 * when a re-encode/decode is genuinely needed but no codec substrate exists (NEVER a fake passthrough),
 * the lazy `decode` frame-stream contract, and the input-validation guards. The full decode/encode/
 * transcode/seek round-trips with real WebCodecs are validated by the parent in the browser harness.
 *
 * Subject media are REAL corpus MP4s (never synthetic) so the routing tracks the real demuxer output.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { fromBytes } from '../sources/source.ts';
import { encryptCenc } from '../test-support/cenc-encrypt.ts';
import { fixtureSource, loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';

/** Real, stream-copyable MP4s (h264 + aac), ≥3 distinct files of varied duration/tracks. */
const MP4_FIXTURES = ['movie_5.mp4', 'test.mp4', 'h264.mp4'] as const;
const CENC_KEY = '000102030405060708090a0b0c0d0e0f';
const CENC_KID = '00112233445566778899aabbccddeeff';

const media = () => createMedia();

async function readFirstFrame<T>(stream: ReadableStream<T> | undefined): Promise<void> {
  if (!stream) throw new Error('expected a frame stream');
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    reader.releaseLock();
  }
}

describe('convert — stream-copy auto-route (no re-encode needed)', () => {
  it('a pure container-preserving convert (mp4 → mp4, no targets) stream-copies to a non-empty Blob', async () => {
    for (const id of MP4_FIXTURES) {
      const out = await media().convert(await fixtureSource(id), { to: 'mp4' });
      expect(out).toBeInstanceOf(Blob);
      if (out instanceof Blob) expect(out.size).toBeGreaterThan(0);
    }
  });

  it('a copy convert re-lays-out the container (not an input→output passthrough)', async () => {
    const id = 'movie_5.mp4';
    const src = await fixtureSource(id);
    const input = src.range ? await src.range(0, src.size ?? 0) : new Uint8Array();
    const out = await media().convert(await fixtureSource(id), { to: 'mp4' });
    expect(out).toBeInstanceOf(Blob);
    if (out instanceof Blob) {
      const bytes = new Uint8Array(await out.arrayBuffer());
      // A genuine remux changes the byte layout (faststart moov-before-mdat); never the same bytes back.
      expect(bytes.byteLength === input.byteLength && bytes.every((b, i) => b === input[i])).toBe(
        false,
      );
    }
  });

  it('routes an explicit PCM sample-format target (pcm-s16) through the audio-dsp WAV path, not the codec seam', async () => {
    // gap #5: a canonical PCM token (pcm-s16/-s24/-f32, what the harness passes) must be recognized as
    // PCM so convert(wav→wav) flows through transformPcm (a Blob) instead of falling through to the
    // codec seam — which, having no WAV chunk muxer, would wrongly raise a CapabilityError in Node.
    const out = await media().convert(await fixtureSource('speech.wav'), {
      to: 'wav',
      audio: { codec: 'pcm-s16' as never },
    });
    expect(out).toBeInstanceOf(Blob);
    if (out instanceof Blob) expect(out.size).toBeGreaterThan(0);
  });
});

describe('convert — codec seam reached and fails honestly without WebCodecs', () => {
  it('a re-encode request (video codec change) raises a typed CapabilityError in Node (no fake output)', async () => {
    for (const id of MP4_FIXTURES) {
      await expect(
        media().convert(await fixtureSource(id), { video: { codec: 'vp9' } }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });

  it('a resize request raises a typed CapabilityError in Node (decode needed, WebCodecs absent)', async () => {
    await expect(
      media().convert(await fixtureSource('movie_5.mp4'), { video: { width: 320, height: 240 } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('a cross-container copy raises a typed CapabilityError in Node (packet seam needs WebCodecs)', async () => {
    // mp4 → webm is not a same-container stream-copy; webm HAS a chunk muxer, so it routes through the
    // demux→muxer packet seam — which needs WebCodecs EncodedChunk (absent in Node) → typed miss, not fake.
    await expect(
      media().convert(await fixtureSource('movie_5.mp4'), { to: 'webm' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('remux — generalized container routing (ADR-021/012)', () => {
  it('same-container stream-copy (mp4 → mp4) re-lays-out a real container in Node (pure TS)', async () => {
    const out = await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mp4' });
    const blob = out as Blob;
    expect(blob.size).toBeGreaterThan(0);
    // The output re-probes as a real MP4 with the source's codecs (a genuine remux, not a passthrough).
    const info = await media().probe(blob);
    expect(info.container).toBe('mp4');
    expect(info.tracks.length).toBeGreaterThan(0);
  });

  it('cross-family same-driver stream-copy (mp4 → mov) writes a real container in Node', async () => {
    const out = await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mov' });
    const blob = out as Blob;
    expect(blob.size).toBeGreaterThan(0);
    // The MP4 driver writes both mp4 and mov (its `formats`) → a pure-TS stream-copy (no seam). probe
    // canonicalizes the ISO-BMFF family to 'mp4' (the QuickTime ftyp-brand distinction is covered by
    // mov-brand.test.ts); here we assert it is a valid re-importable container with the source tracks.
    const info = await media().probe(blob);
    expect(info.container).toBe('mp4');
    expect(info.tracks.length).toBeGreaterThan(0);
  });

  it('cross-container remux (mp4 → mkv) routes the packet seam → typed miss in Node (browser path)', async () => {
    // mkv now HAS a muxer, so remux proceeds to demux→muxer; the verbatim packet copy needs WebCodecs
    // EncodedChunk (absent in Node) → a typed CapabilityError, never a crash or a wrong/empty container.
    await expect(
      media().remux(await fixtureSource('movie_5.mp4'), { to: 'mkv' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('remux to a container with no muxer (mp4 → mp3 / → aiff) is an honest typed miss', async () => {
    for (const to of ['mp3', 'aiff'] as const) {
      await expect(
        media().remux(await fixtureSource('movie_5.mp4'), { to }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });
});

describe('decode — lazy frame streams (contract)', () => {
  it('returns a MediaStreams shape synchronously', () => {
    const streams = media().decode(new Uint8Array([1, 2, 3, 4]));
    expect(streams.video).toBeInstanceOf(ReadableStream);
    expect(streams.audio).toBeInstanceOf(ReadableStream);
  });

  it('rejects when pulled in Node (no WebCodecs decoder), surfacing a typed CapabilityError', async () => {
    const streams = media().decode(await fixtureSource('movie_5.mp4'));
    await expect(readFirstFrame(streams.video)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects an unnormalizable input synchronously (bad input shape)', () => {
    expect(() => media().decode(123 as never)).toThrowError(InputError);
  });

  it('yields an empty stream for a media type the source lacks (no decodable video in a WAV)', async () => {
    // speech.wav has audio only; decode(...).video has no track to route, so its stream closes empty
    // (no error, no frames) rather than raising — the absence of a track is not a capability miss.
    const streams = media().decode(await fixtureSource('speech.wav'));
    const reader = streams.video?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    }
  });

  it('rejects protected MP4 ciphertext before explicit decrypt', async () => {
    const encrypted = await encryptCenc(await loadFixture('movie_5.mp4'), {
      keyHex: CENC_KEY,
      kidHex: CENC_KID,
      mediaType: 'video',
    });
    const streams = media().decode(fromBytes(encrypted, { mime: 'video/mp4' }));
    await expect(readFirstFrame(streams.video)).rejects.toBeInstanceOf(MediaError);
  });
});

describe('encode — input validation', () => {
  it('rejects empty frame streams with a typed InputError', async () => {
    await expect(media().encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a non-chunk-muxable target with a typed CapabilityError', async () => {
    const streams = media().decode(await fixtureSource('movie_5.mp4'));
    // wav has no EncodedChunk muxer; the encode must surface that honest miss (the streams are unread).
    await expect(media().encode(streams, { to: 'wav' })).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects a video stream with no video target (InputError) and a video target with no encoder (CapabilityError)', async () => {
    // A frame stream that is never pulled (so no frames are produced) — the engine must cancel it.
    const neverPulled = new ReadableStream<VideoFrame>({ pull() {} });
    await expect(media().encode({ video: neverPulled }, { to: 'mp4' })).rejects.toBeInstanceOf(
      InputError,
    );
    // With a video target, the encode builds the config and routes the encoder, which misses in Node.
    const v2 = new ReadableStream<VideoFrame>({ pull() {} });
    await expect(
      media().encode(
        { video: v2 },
        { to: 'mp4', video: { codec: 'h264', width: 320, height: 240 } },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('routes an audio encoder for an audio stream + target (CapabilityError in Node)', async () => {
    const audio = new ReadableStream<AudioData>({ pull() {} });
    await expect(
      media().encode(
        { audio },
        { to: 'mp4', audio: { codec: 'aac', sampleRate: 48000, channels: 2 } },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('seek — routing + guards', () => {
  it('routes to the video decoder and raises a typed CapabilityError in Node (no WebCodecs)', async () => {
    for (const id of MP4_FIXTURES) {
      await expect(media().seek(await fixtureSource(id), 0)).rejects.toBeInstanceOf(
        CapabilityError,
      );
    }
  });

  it('rejects protected MP4 video seek before explicit decrypt', async () => {
    const encrypted = await encryptCenc(await loadFixture('movie_5.mp4'), {
      keyHex: CENC_KEY,
      kidHex: CENC_KID,
      mediaType: 'video',
    });
    await expect(
      media().seek(fromBytes(encrypted, { mime: 'video/mp4' }), 0),
    ).rejects.toBeInstanceOf(MediaError);
  });

  it('rejects a negative or non-finite seek time with a typed InputError', async () => {
    await expect(media().seek(await fixtureSource('movie_5.mp4'), -1)).rejects.toBeInstanceOf(
      InputError,
    );
    await expect(
      media().seek(await fixtureSource('movie_5.mp4'), Number.NaN),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('exposes .cancel() on the seek handle', async () => {
    const handle = media().seek(await fixtureSource('test.mp4'), 1_000_000);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});
