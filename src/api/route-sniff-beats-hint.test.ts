/**
 * A wrong container label (MIME or extension) must not send random-access bytes to a driver that cannot
 * read them: definite magic in the head overrides the hint, while a head no driver claims keeps the
 * hinted route (an `mdat`-first movie still belongs to the MP4 driver its label names).
 */

import { describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { FIRST_PARTY_CONTAINER_IDS } from '../drivers/container-ids.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS } from '../drivers/defaults.ts';

describe('container routing — definite magic beats a wrong hint', () => {
  it('demuxes MPEG-TS bytes labelled video/mp4 and MP4 bytes labelled video/webm', async () => {
    const media = createMedia();
    try {
      const ts = await loadFixture('bear-1280x720.ts');
      const mp4 = await loadFixture('bear-1280x720.mp4');
      const tsDemux = await media.demux(fromBytes(ts, { mime: 'video/mp4' }));
      try {
        expect(tsDemux.tracks.map((track) => track.mediaType).sort()).toEqual(['audio', 'video']);
      } finally {
        await tsDemux.close();
      }
      const mp4Demux = await media.demux(fromBytes(mp4, { mime: 'video/webm' }));
      try {
        expect(mp4Demux.tracks.some((track) => track.codec.startsWith('avc1'))).toBe(true);
      } finally {
        await mp4Demux.close();
      }
      const probed = await media.probe(fromBytes(ts, { mime: 'video/mp4' }));
      expect(probed.container).toBe('ts');
    } finally {
      await media.dispose();
    }
  });

  it('keeps the hinted route when no magic claims the head (mdat-first MP4)', async () => {
    const media = createMedia();
    try {
      const original = await loadFixture('bear-1280x720.mp4');
      // Move `ftyp` behind a leading `free` box so the first eight bytes name no container.
      const dv = new DataView(original.buffer, original.byteOffset, original.byteLength);
      const ftypSize = dv.getUint32(0);
      expect(String.fromCharCode(...original.subarray(4, 8))).toBe('ftyp');
      const lead = 16;
      const shifted = new Uint8Array(original.byteLength + lead);
      new DataView(shifted.buffer).setUint32(0, lead);
      shifted.set(new TextEncoder().encode('skip'), 4);
      shifted.set(original, lead);
      void ftypSize;
      const info = await media.probe(fromBytes(shifted, { mime: 'video/mp4' }));
      expect(info.container).toBe('mp4');
      expect(info.tracks.length).toBe(2);
    } finally {
      await media.dispose();
    }
  });
});

describe('first-party container id constant', () => {
  it('names exactly the ids the defaults module registers', () => {
    expect([...FIRST_PARTY_CONTAINER_IDS].sort()).toEqual(
      DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => spec.id).sort(),
    );
  });
});
