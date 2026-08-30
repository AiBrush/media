import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { hexToBytes } from './aes.ts';
import {
  errorLeaksBytes,
  errorLeaksKeyMaterial,
  redactKeys,
  redactKid,
  wipeBytes,
} from './key-hygiene.ts';

const KID = '00112233445566778899aabbccddeeff';
const KEY_HEX = 'ffeeddccbbaa99887766554433221100';
const CLEAR = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe('key hygiene — wipe + redact', () => {
  it('wipeBytes zero-fills in place and is length-preserving', () => {
    const buf = new Uint8Array([1, 2, 3, 255]);
    wipeBytes(buf);
    expect([...buf]).toEqual([0, 0, 0, 0]);
    expect(buf.byteLength).toBe(4);
  });

  it('redactKid preserves nothing useful, redactKeys replaces values', () => {
    expect(redactKid(KID)).not.toContain(KID);
    expect(redactKid(KID)).toContain('***');
    const redacted = redactKeys({ [KID]: KEY_HEX });
    expect(Object.values(redacted)[0]).toBe('[redacted]');
    expect(JSON.stringify(redacted).toLowerCase()).not.toContain(KEY_HEX.toLowerCase());
  });

  it('hexToBytes + validate pattern never leaks key hex into thrown error', () => {
    const badHex = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    let caught: unknown;
    try {
      hexToBytes(badHex);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InputError);
    expect(errorLeaksKeyMaterial(caught, { [KID]: KEY_HEX })).toBe(false);
    expect(errorLeaksKeyMaterial(caught, { [KID]: badHex })).toBe(false);
  });

  it('errorLeaksBytes detects clear-sample hex in error text', () => {
    const err = new InputError(
      `failed at ${[...CLEAR].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    expect(errorLeaksBytes(err, CLEAR)).toBe(true);
    const safe = new InputError('generic decrypt failure');
    expect(errorLeaksBytes(safe, CLEAR)).toBe(false);
    expect(errorLeaksKeyMaterial(safe, { [KID]: KEY_HEX })).toBe(false);
  });

  it('malformed decrypt keys — error never contains key hex', () => {
    const badKeys = { [KID]: 'short' };
    let err: unknown;
    try {
      // simulate validateDecryptKeys throwing
      if (badKeys[KID]!.length !== 32)
        throw new InputError(
          `decrypt cenc: key for '${KID}' must be 16 bytes (32 hex chars), got ${badKeys[KID]!.length / 2}`,
        );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InputError);
    expect(errorLeaksKeyMaterial(err, { [KID]: KEY_HEX })).toBe(false);
  });

  it('20× randomized keys — generic errors never leak key material', () => {
    for (let i = 0; i < 20; i++) {
      const kid = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
      const key = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
      const generic = new InputError('decrypt failed: invalid key length');
      expect(errorLeaksKeyMaterial(generic, { [kid]: key })).toBe(false);
      const withKey = new InputError(`decrypt failed: key ${key} invalid`);
      expect(errorLeaksKeyMaterial(withKey, { [kid]: key })).toBe(true);
      const safe = new InputError(`decrypt cenc: KID '${redactKid(kid)}' must be 16 bytes`);
      expect(errorLeaksKeyMaterial(safe, { [kid]: key })).toBe(false);
    }
  });

  it('wipe after use leaves no key bytes in temporary buffer', () => {
    const tmp = hexToBytes(KEY_HEX);
    expect([...tmp].some((b) => b !== 0)).toBe(true);
    wipeBytes(tmp);
    expect([...tmp].every((b) => b === 0)).toBe(true);
  });

  it('empty and boundary inputs do not throw', () => {
    const empty = new Uint8Array(0);
    wipeBytes(empty);
    expect(empty.byteLength).toBe(0);
    expect(redactKid('')).toBe('***');
    expect(redactKid('ab')).toBe('***');
    expect(errorLeaksKeyMaterial(new InputError('ok'), {})).toBe(false);
    expect(errorLeaksBytes(new InputError('ok'), empty)).toBe(false);
  });
});
