/**
 * AAC ADTS-frame parser — the robustness error branches (truncated header / lost syncword / overrun).
 * These are pure, Node-reachable rejects that the real-decode oracle (aac.test.ts) doesn't drive, so they
 * are covered here with crafted *garbled* byte sequences — a real "must throw, never fabricate a frame"
 * check (not synthetic *media*; these are deliberately-invalid headers exercising the typed-error guards).
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '../../contracts/errors.ts';
import { parseAdtsFrame } from './aac.ts';

describe('aac ADTS parse — typed-error branches', () => {
  it('throws InputError when the 7-byte header is truncated', () => {
    // only 3 bytes from the offset ⇒ offset+7 overruns ⇒ truncated-header guard.
    expect(() => parseAdtsFrame(new Uint8Array([0xff, 0xf1, 0x00]), 0)).toThrow(InputError);
  });

  it('throws InputError on a lost ADTS syncword (0xFFF expected)', () => {
    // 7 bytes present, but the leading 12 bits are not the ADTS syncword.
    expect(() => parseAdtsFrame(new Uint8Array([0x00, 0x00, 0, 0, 0, 0, 0]), 0)).toThrow(
      InputError,
    );
  });
});
