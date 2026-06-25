/**
 * Unit tests for the WebCodecs **audio** driver's pure, Node-runnable surface (BUILD §6): config
 * normalization (incl. AAC `description` survival), the prefer-hardware vs prefer-software determinism
 * switch, the backpressure threshold predicate, and the encode→muxer decoder-config bridge. WebCodecs
 * (`AudioDecoder`/`AudioEncoder`/`AudioData`) is **absent in Node and must not be mocked** (ADR-018);
 * the full decode/encode round-trip is validated by the parent in the browser harness. Here we also
 * assert the honest WebCodecs-absent behavior: `supports()` answers `false` (never throws) and the
 * coders reject with a typed `CapabilityError` when driven.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import WebCodecsAudioModule, {
  AUDIO_CODEC_PREFIXES,
  BACKPRESSURE_THRESHOLD,
  type EnqueueSink,
  decoderConfigFromEncoderMeta,
  decoderErrorToCapabilityMiss,
  enqueueOrClose,
  enqueueOrDrop,
  hardwareAccelerationFor,
  isAudioCodecString,
  normalizeAudioDecoderConfig,
  normalizeAudioEncoderConfig,
  shouldApplyBackpressure,
  unsupported,
  WebCodecsAudioDriver,
} from './webcodecs-audio.ts';

// AudioSpecificConfig for AAC-LC @ 44.1 kHz stereo (the `description` the MP4 `esds` carries).
const AAC_ASC = new Uint8Array([0x12, 0x10]);

/** A fake closable `AudioData` recording its close count (close-exactly-once assertions). */
class FakeData {
  closeCount = 0;
  close(): void {
    this.closeCount++;
  }
}

/** A fake enqueue sink that records enqueues and can simulate a closed-readable throw. */
class FakeController<T> implements EnqueueSink<T> {
  readonly enqueued: T[] = [];
  throwOnEnqueue = false;
  enqueue(chunk: T): void {
    if (this.throwOnEnqueue) {
      throw new TypeError('Cannot enqueue a chunk into a closed readable stream');
    }
    this.enqueued.push(chunk);
  }
}

describe('enqueueOrClose — the decoder-output close-race guard (AudioData close-exactly-once)', () => {
  it('enqueues when open; the consumer owns the AudioData (guard does not close it)', () => {
    const ctrl = new FakeController<FakeData>();
    const data = new FakeData();
    expect(enqueueOrClose(ctrl, data, () => false)).toBe(true);
    expect(ctrl.enqueued).toEqual([data]);
    expect(data.closeCount).toBe(0);
  });
  it('closes the AudioData and does not enqueue when the readable is already closed', () => {
    const ctrl = new FakeController<FakeData>();
    const data = new FakeData();
    expect(enqueueOrClose(ctrl, data, () => true)).toBe(false);
    expect(ctrl.enqueued).toEqual([]);
    expect(data.closeCount).toBe(1);
  });
  it('closes the AudioData (no rethrow) when enqueue loses the close race', () => {
    const ctrl = new FakeController<FakeData>();
    ctrl.throwOnEnqueue = true;
    const data = new FakeData();
    expect(() => enqueueOrClose(ctrl, data, () => false)).not.toThrow();
    expect(data.closeCount).toBe(1);
  });
});

describe('enqueueOrDrop — the encoder-output close-race guard (EncodedAudioChunks: no close, just drop)', () => {
  // EncodedAudioChunk has no close(); a dropped chunk is a plain byte buffer the GC frees — the only
  // observable is "was it enqueued?". A fake chunk stands in (the guard never calls a method on it).
  it('enqueues a chunk when the readable is open', () => {
    const ctrl = new FakeController<object>();
    const chunk = { byteLength: 4 };
    expect(enqueueOrDrop(ctrl, chunk, () => false)).toBe(true);
    expect(ctrl.enqueued).toEqual([chunk]);
  });
  it('drops the chunk (no enqueue) when the readable is already closed', () => {
    const ctrl = new FakeController<object>();
    expect(enqueueOrDrop(ctrl, { byteLength: 4 }, () => true)).toBe(false);
    expect(ctrl.enqueued).toEqual([]);
  });
  it('drops the chunk (no rethrow) when enqueue loses the close race', () => {
    const ctrl = new FakeController<object>();
    ctrl.throwOnEnqueue = true;
    let result: boolean | undefined;
    expect(() => {
      result = enqueueOrDrop(ctrl, { byteLength: 4 }, () => false);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe('decoderErrorToCapabilityMiss — native-decoder failure → cross-browser capability miss (NA)', () => {
  it('maps a decoder DOMException to a CapabilityError (capability-miss), preserving the cause', () => {
    const err = decoderErrorToCapabilityMiss(
      new DOMException('Decoder failure', 'EncodingError'),
      'opus',
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe('capability-miss');
    expect(err.message).toContain('opus');
    expect(err.message).toContain('EncodingError');
    expect(err.detail).toMatchObject({ op: 'decode', tried: ['webcodecs-audio'] });
  });
  it('degrades gracefully when the codec is unknown', () => {
    const err = decoderErrorToCapabilityMiss(new Error('boom'), undefined);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toContain('this stream');
  });
});

describe('isAudioCodecString — the audio codec families this driver routes (RFC 6381 prefixes)', () => {
  it('matches AAC / Opus / MP3 / FLAC / Vorbis codec strings', () => {
    for (const codec of [
      'mp4a.40.2', // AAC-LC
      'mp4a.40.5', // HE-AAC
      'mp4a.69', // MP3-in-MP4
      'mp4a.6b',
      'opus',
      'mp3',
      'flac',
      'vorbis',
    ]) {
      expect(isAudioCodecString(codec)).toBe(true);
    }
  });
  it('rejects non-audio / video codec strings', () => {
    for (const codec of ['avc1.42001f', 'vp09.00.10.08', 'av01.0.04M.08', 'hvc1.1.6.L93.B0', '']) {
      expect(isAudioCodecString(codec)).toBe(false);
    }
  });
  it('exposes every prefix exactly once', () => {
    expect(new Set(AUDIO_CODEC_PREFIXES).size).toBe(AUDIO_CODEC_PREFIXES.length);
    expect([...AUDIO_CODEC_PREFIXES]).toEqual(['mp4a', 'opus', 'mp3', 'flac', 'vorbis']);
  });
});

describe('webcodecs-audio — driver identity & module', () => {
  it('declares the contracted identity', () => {
    expect(WebCodecsAudioDriver.id).toBe('webcodecs-audio');
    expect(WebCodecsAudioDriver.kind).toBe('codec');
    expect(WebCodecsAudioDriver.tier).toBe('hardware'); // ranked first in the codec ladder
    expect(WebCodecsAudioDriver.apiVersion).toBe(1);
  });

  it('registers exactly itself as a codec (and nothing else)', () => {
    const added: unknown[] = [];
    let containers = 0;
    let filters = 0;
    WebCodecsAudioModule.register({
      addCodec: (d) => added.push(d),
      addContainer: () => containers++,
      addFilter: () => filters++,
    });
    expect(added).toEqual([WebCodecsAudioDriver]);
    expect(containers).toBe(0);
    expect(filters).toBe(0);
  });
});

describe('hardwareAccelerationFor — determinism → acceleration preference (ADR-007)', () => {
  it('force-software pins prefer-software for cross-machine reproducibility', () => {
    expect(hardwareAccelerationFor('force-software')).toBe('prefer-software');
  });
  it('auto / undefined leave no-preference so the platform picks the fastest path', () => {
    expect(hardwareAccelerationFor('auto')).toBe('no-preference');
    expect(hardwareAccelerationFor(undefined)).toBe('no-preference');
  });
});

describe('normalizeAudioDecoderConfig — carries fields + AAC description', () => {
  it('preserves the AAC `description` (AudioSpecificConfig) byte-for-byte', () => {
    const out = normalizeAudioDecoderConfig(
      { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: AAC_ASC },
      'auto',
    );
    expect(out.codec).toBe('mp4a.40.2');
    expect(out.sampleRate).toBe(44100);
    expect(out.numberOfChannels).toBe(2);
    expect(out.description).toBe(AAC_ASC); // same bytes, not dropped/copied away
    expect(out.hardwareAcceleration).toBe('no-preference');
  });

  it('force-software flips the decoder to prefer-software', () => {
    const out = normalizeAudioDecoderConfig(
      { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      'force-software',
    );
    expect(out.hardwareAcceleration).toBe('prefer-software');
  });

  it('leaves description-less codecs (Opus/MP3/FLAC/Vorbis) without a description key', () => {
    const out = normalizeAudioDecoderConfig(
      { codec: 'flac', sampleRate: 44100, numberOfChannels: 2 },
      'auto',
    );
    expect('description' in out).toBe(false); // exactOptionalPropertyTypes: absent, not `undefined`
  });
});

describe('normalizeAudioEncoderConfig — honors codec/rate/channels/bitrate', () => {
  it('threads sampleRate, numberOfChannels, and bitrate through unchanged', () => {
    const out = normalizeAudioEncoderConfig(
      { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
      'auto',
    );
    expect(out.codec).toBe('mp4a.40.2');
    expect(out.sampleRate).toBe(48000);
    expect(out.numberOfChannels).toBe(2);
    expect(out.bitrate).toBe(128_000);
    expect(out.hardwareAcceleration).toBe('no-preference');
  });

  it('force-software flips the encoder to prefer-software', () => {
    const out = normalizeAudioEncoderConfig(
      { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64_000 },
      'force-software',
    );
    expect(out.hardwareAcceleration).toBe('prefer-software');
  });
});

describe('decoderConfigFromEncoderMeta — the encode→muxer AAC description bridge', () => {
  it('extracts the decoderConfig (incl. AAC `description`) the encoder publishes', () => {
    const meta: EncodedAudioChunkMetadata = {
      decoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        description: AAC_ASC,
      },
    };
    const cfg = decoderConfigFromEncoderMeta(meta);
    expect(cfg?.codec).toBe('mp4a.40.2');
    expect(cfg?.description).toBe(AAC_ASC); // what the muxer writes into `esds`
  });

  it('returns undefined when the metadata (or chunk) carries no decoder config', () => {
    expect(decoderConfigFromEncoderMeta({})).toBeUndefined();
    expect(decoderConfigFromEncoderMeta(undefined)).toBeUndefined();
  });
});

describe('shouldApplyBackpressure — pace against the coder queue', () => {
  it('waits only at/over the threshold', () => {
    expect(BACKPRESSURE_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(BACKPRESSURE_THRESHOLD)).toBe(true);
    expect(shouldApplyBackpressure(0)).toBe(false);
    expect(shouldApplyBackpressure(BACKPRESSURE_THRESHOLD - 1)).toBe(false);
    expect(shouldApplyBackpressure(BACKPRESSURE_THRESHOLD)).toBe(true);
    expect(shouldApplyBackpressure(BACKPRESSURE_THRESHOLD + 5)).toBe(true);
  });
  it('honors an explicit threshold override', () => {
    expect(shouldApplyBackpressure(2, 4)).toBe(false);
    expect(shouldApplyBackpressure(4, 4)).toBe(true);
  });
});

describe('unsupported — honest CodecSupport shape', () => {
  it('is a non-supported result carrying the reason', () => {
    expect(unsupported('nope')).toEqual({ supported: false, reason: 'nope' });
  });
});

describe('supports() — honest when WebCodecs is absent (no throw in Node)', () => {
  it('returns false for a non-audio query', async () => {
    const s = await WebCodecsAudioDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'avc1.42E01E' },
    });
    expect(s.supported).toBe(false);
  });

  it('returns false (never throws) for decode when AudioDecoder is absent', async () => {
    expect(typeof AudioDecoder).toBe('undefined'); // precondition: Node has no WebCodecs
    const s = await WebCodecsAudioDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/AudioDecoder/);
  });

  it('returns false (never throws) for encode when AudioEncoder is absent', async () => {
    expect(typeof AudioEncoder).toBe('undefined');
    const s = await WebCodecsAudioDriver.supports({
      mediaType: 'audio',
      direction: 'encode',
      config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/AudioEncoder/);
  });
});

describe('createDecoder / createEncoder — typed CapabilityError when WebCodecs is absent', () => {
  // The WebCodecs-absent guard fires eagerly at construction (fail-fast), before a stream is built —
  // the router only reaches here in Node by misroute, since `supports()` already answered false.
  it('createDecoder throws CapabilityError synchronously when AudioDecoder is absent', () => {
    expect(typeof AudioDecoder).toBe('undefined');
    const build = (): unknown =>
      WebCodecsAudioDriver.createDecoder({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        description: AAC_ASC,
      });
    expect(build).toThrow(CapabilityError);
    expect(build).toThrow(/AudioDecoder/);
  });

  it('createEncoder throws CapabilityError synchronously when AudioEncoder is absent', () => {
    expect(typeof AudioEncoder).toBe('undefined');
    const build = (): unknown =>
      WebCodecsAudioDriver.createEncoder({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        bitrate: 128_000,
      });
    expect(build).toThrow(CapabilityError);
    expect(build).toThrow(/AudioEncoder/);
  });

  it('aborts up front with a typed `aborted` MediaError when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const build = (): unknown =>
      WebCodecsAudioDriver.createDecoder(
        { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
        { signal: ctrl.signal },
      );
    expect(build).toThrow(MediaError);
    expect(build).toThrow(/aborted/);
  });
});
