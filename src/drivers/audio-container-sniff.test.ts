import { describe, expect, it } from 'vitest';
import {
  matchesAdts,
  matchesAiff,
  matchesCaf,
  matchesMp3,
  matchesOgg,
  matchesWav,
} from './audio-container-sniff.ts';

function bytes(text: string, length = text.length): Uint8Array {
  const value = new Uint8Array(length);
  value.set(Array.from(text, (character) => character.charCodeAt(0)));
  return value;
}

describe('lazy audio-container sniff predicates', () => {
  it('normalizes MIME parameters and extension case', () => {
    expect(matchesWav({ direction: 'demux', mime: ' Audio/X-WAV ; rate=48000' })).toBe(true);
    expect(matchesMp3({ direction: 'demux', extension: 'MP3' })).toBe(true);
    expect(matchesOgg({ direction: 'demux', extension: 'OPUS' })).toBe(true);
    expect(matchesAdts({ direction: 'demux', mime: 'audio/AACP' })).toBe(true);
    expect(matchesAiff({ direction: 'demux', extension: 'AIFC' })).toBe(true);
    expect(matchesCaf({ direction: 'demux', extension: 'CAFF' })).toBe(true);
  });

  it('recognizes exact byte signatures without accepting truncated or neighboring formats', () => {
    const wav = bytes('RIFF....WAVE');
    const aiff = bytes('FORM....AIFF');
    const aifc = bytes('FORM....AIFC');
    expect(matchesWav({ direction: 'demux', head: wav })).toBe(true);
    expect(matchesWav({ direction: 'demux', head: bytes('RIFF') })).toBe(false);
    expect(matchesMp3({ direction: 'demux' })).toBe(false);
    expect(matchesMp3({ direction: 'demux', head: bytes('ID3') })).toBe(true);
    expect(matchesMp3({ direction: 'demux', head: new Uint8Array([0xff, 0xfa, 0]) })).toBe(true);
    expect(matchesMp3({ direction: 'demux', head: new Uint8Array([0xff, 0xf8, 0]) })).toBe(false);
    expect(matchesOgg({ direction: 'demux', head: bytes('OggS') })).toBe(true);
    expect(matchesAiff({ direction: 'demux', head: aiff })).toBe(true);
    expect(matchesAiff({ direction: 'demux', head: aifc })).toBe(true);
    expect(matchesCaf({ direction: 'demux', head: bytes('caff') })).toBe(true);
    expect(matchesCaf({ direction: 'demux' })).toBe(false);
  });

  it('finds ADTS after complete stacked ID3 tags, including a footer', () => {
    const head = new Uint8Array(10 + 20 + 7);
    head.set(bytes('ID3'), 0);
    head[5] = 0x10;
    head.set(bytes('ID3'), 20);
    head.set([0xff, 0xf1], 30);
    expect(matchesAdts({ direction: 'demux', head })).toBe(true);
  });

  it('rejects incomplete, escaping, and invalid ADTS signatures', () => {
    expect(matchesAdts({ direction: 'demux' })).toBe(false);
    expect(matchesAdts({ direction: 'demux', head: new Uint8Array(6) })).toBe(false);
    const escapingId3 = new Uint8Array(17);
    escapingId3.set(bytes('ID3'));
    escapingId3[9] = 127;
    expect(matchesAdts({ direction: 'demux', head: escapingId3 })).toBe(false);
    expect(
      matchesAdts({ direction: 'demux', head: new Uint8Array([0xff, 0xf7, 0, 0, 0, 0, 0]) }),
    ).toBe(false);
  });
});
