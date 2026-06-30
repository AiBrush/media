/**
 * EME/ClearKey decrypt → a clean, immediate capability-miss (NA) — never a license-fetch retry hang.
 *
 * This engine decrypts CENC (`cenc`/`cens`/`cbcs`) and HLS AES-128/SAMPLE-AES with caller-PROVIDED keys;
 * it does NOT do EME/ClearKey live key acquisition (a license-server exchange). The harness `clearkey_decrypt_na`
 * scenario must map to NA — but a naive adapter that retries a ClearKey license fetch would hang the run
 * (404 spam). The op therefore fails FAST when no static key is supplied: an empty `keys` map ⇒ a typed
 * {@link CapabilityError}, thrown **before any source read, container route, or network call** (no fetch,
 * no retry). These tests prove that — synchronously, with no real media and no I/O.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import type { DecryptOptions } from './types.ts';

/** A source that throws if anything ever tries to read its bytes, so any I/O surfaces loudly. */
const explodingSource: Source = {
  __media: 'source',
  kind: 'bytes',
  size: 8,
  mimeHint: 'video/mp4',
  stream(): ReadableStream<Uint8Array> {
    throw new Error('decrypt preflight unexpectedly read the source stream');
  },
  range(): Promise<Uint8Array> {
    throw new Error('decrypt preflight unexpectedly read a source range');
  },
};

const PROVIDED_KEY: DecryptOptions['keys'] = {
  '00000000000000000000000000000000': '00112233445566778899aabbccddeeff',
};

function runtimeDecryptOptions(scheme: string, keys = PROVIDED_KEY): DecryptOptions {
  return { scheme, keys } as unknown as DecryptOptions;
}

describe('media.decrypt — EME/ClearKey (no provided key) is an immediate NA', () => {
  for (const scheme of ['cenc', 'cens', 'cbcs', 'hls-aes128', 'hls-sample-aes'] as const) {
    it(`scheme '${scheme}' with empty keys → CapabilityError, no network/no read`, async () => {
      const err = await createMedia()
        .decrypt(explodingSource, { scheme, keys: {} })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(CapabilityError);
      expect(err).toBeInstanceOf(MediaError); // CapabilityError extends MediaError (typed model)
      expect((err as CapabilityError).code).toBe('capability-miss');
      expect((err as CapabilityError).message).toBe('keys');
    });
  }

  it('fails fast (bounded time) — no retry loop / license polling', async () => {
    const t0 = Date.now();
    await createMedia()
      .decrypt(explodingSource, { scheme: 'cenc', keys: {} })
      .catch(() => undefined);
    // A license-fetch retry loop would take seconds+; the short-circuit returns effectively immediately.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('short-circuits BEFORE touching the source (a non-MP4/garbage source still yields the EME miss)', async () => {
    // If the guard ran AFTER the container route, this garbage source would raise a demux/unsupported
    // error instead. Getting the EME message proves the guard fires first (zero source read).
    const garbage = fromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mime: 'video/mp4' });
    const err = await createMedia()
      .decrypt(garbage, { scheme: 'cenc', keys: {} })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).message).toBe('keys');
  });

  it('the capability detail names the decrypt op (so the harness can attribute the NA)', async () => {
    const err = (await createMedia()
      .decrypt(explodingSource, { scheme: 'cenc', keys: {} })
      .then(
        () => undefined,
        (e: unknown) => e,
      )) as CapabilityError;
    expect(err.detail).toMatchObject({ op: 'decrypt' });
  });

  it('a PROVIDED key does NOT short-circuit (the guard is empty-keys-only)', async () => {
    // With a key present the guard passes and the op proceeds to read the source; the garbage bytes then
    // fail as a demux error — proving the EME guard did not fire for a non-empty key map.
    const garbage = fromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { mime: 'video/mp4' });
    const err = await createMedia()
      .decrypt(garbage, { scheme: 'cenc', keys: { '00112233445566778899aabbccddeeff': '00' } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).message).not.toMatch(/EME\/ClearKey/); // proceeded past the guard
  });
});

describe('media.decrypt — unsupported encrypted-media schemes are typed misses before I/O', () => {
  for (const scheme of ['clearkey', 'cenc-cens', 'sample-aes-ctr'] as const) {
    it(`scheme '${scheme}' rejects as unsupported before touching the source`, async () => {
      const err = await createMedia()
        .decrypt(explodingSource, runtimeDecryptOptions(scheme))
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe('capability-miss');
      expect((err as CapabilityError).message).toBe('bad decrypt');
      expect((err as CapabilityError).detail).toMatchObject({ op: 'decrypt', tried: [] });
    });
  }
});
