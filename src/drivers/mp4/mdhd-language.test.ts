import { describe, expect, it } from 'vitest';
import { decodeMdhdLanguage } from './mdhd-language.ts';

function pack(language: string): number {
  const [first = 0, second = 0, third = 0] = [...language].map(
    (letter) => letter.charCodeAt(0) - 0x60,
  );
  return (first << 10) | (second << 5) | third;
}

describe('decodeMdhdLanguage', () => {
  it('decodes the three five-bit ISO-639-2/T letters and retains explicit undetermined', () => {
    expect(decodeMdhdLanguage(pack('eng'))).toBe('eng');
    expect(decodeMdhdLanguage(0x55c4)).toBe('und');
  });

  it.each([
    ['zero/legacy value', 0],
    ['nonzero pad bit', pack('eng') | 0x8000],
    ['zero letter value', pack('en`')],
    ['reserved letter value', (27 << 10) | (14 << 5) | 7],
    ['non-integer value', pack('eng') + 0.5],
  ])('leaves an invalid %s absent', (_case, packed) => {
    expect(decodeMdhdLanguage(packed)).toBeUndefined();
  });
});
