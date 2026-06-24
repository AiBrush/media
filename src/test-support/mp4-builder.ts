/**
 * Test-only ISO-BMFF box builders — assemble minimal but valid MP4 structures to exercise parser
 * branches (format variants, top-level layouts) the real corpus doesn't cover. Not shipped.
 */

export const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
export const be32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
export const be64 = (n: number): number[] => [...be32(Math.floor(n / 2 ** 32)), ...be32(n >>> 0)];
export const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
export const zeros = (n: number): number[] => new Array<number>(n).fill(0);
export const cat = (...parts: number[][]): number[] => parts.flat();
export const bytes = (parts: number[]): Uint8Array => new Uint8Array(parts);

export function box(type: string, payload: number[]): number[] {
  return cat(be32(8 + payload.length), str(type), payload);
}
export function full(type: string, version: number, payload: number[]): number[] {
  return box(type, cat([version, 0, 0, 0], payload));
}

const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
const visualEntry = (type: string, w: number, h: number): number[] =>
  box(type, cat(zeros(6), be16(1), zeros(16), be16(w), be16(h), zeros(50), avcC));
const audioEntry = (channels: number, rate: number): number[] =>
  box('mp4a', cat(zeros(6), be16(1), zeros(8), be16(channels), zeros(6), be32(rate << 16)));

const stbl = (entry: number[], tables: number[]): number[] =>
  box('stbl', cat(full('stsd', 0, cat(be32(1), entry)), tables));

function mdia(
  handler: string,
  version: number,
  timescale: number,
  duration: number,
  stblBox: number[],
): number[] {
  const mdhdBody =
    version === 1
      ? cat(zeros(16), be32(timescale), be64(duration), zeros(4))
      : cat(zeros(8), be32(timescale), be32(duration), zeros(4));
  return box(
    'mdia',
    cat(
      full('mdhd', version, mdhdBody),
      full('hdlr', 0, cat(zeros(4), str(handler), zeros(12))),
      box('minf', stblBox),
    ),
  );
}

function tkhd(version: number, trackId: number, a: number, b: number): number[] {
  const time =
    version === 1
      ? cat(zeros(16), be32(trackId), zeros(4), be64(0))
      : cat(zeros(8), be32(trackId), zeros(4), be32(0));
  return full(
    'tkhd',
    version,
    cat(
      time,
      zeros(8 + 2 + 2 + 2 + 2),
      be32(a),
      be32(b),
      zeros(4),
      be32(0),
      be32(0),
      zeros(16),
      zeros(8),
    ),
  );
}

const ID = 0x00010000; // 1.0 in 16.16

export interface MoovOptions {
  /** Video sample-entry fourcc (default 'avc1'; a non-avc type exercises the codec fallback). */
  videoType?: string;
  /** tkhd matrix (a, b) in 16.16 (default [0, 1] = 90°). */
  rotationAB?: [number, number];
}

/** A full `moov` box: a rotated video track + a stereo mp4a audio track + a skipped text track. */
export function moovBox(opts: MoovOptions = {}): number[] {
  const videoType = opts.videoType ?? 'avc1';
  const [a, b] = opts.rotationAB ?? [0, ID]; // 90° default
  const video = box(
    'trak',
    cat(
      tkhd(1, 1, a, b),
      mdia(
        'vide',
        1,
        600,
        1200,
        stbl(
          visualEntry(videoType, 4, 4),
          cat(
            full('stts', 0, cat(be32(1), be32(2), be32(300))),
            full('ctts', 0, cat(be32(1), be32(2), be32(100))),
            full('stsz', 0, cat(be32(0), be32(2), be32(5), be32(7))),
            full('stsc', 0, cat(be32(1), be32(1), be32(2), be32(1))),
            full('co64', 0, cat(be32(1), be64(1000))),
            full('stss', 0, cat(be32(1), be32(1))),
          ),
        ),
      ),
    ),
  );
  const audio = box(
    'trak',
    cat(
      tkhd(0, 2, ID, 0),
      mdia(
        'soun',
        0,
        48000,
        48000,
        stbl(
          audioEntry(2, 48000),
          cat(
            full('stts', 0, cat(be32(1), be32(1), be32(48000))),
            full('stsz', 0, cat(be32(100), be32(1))),
            full('stsc', 0, cat(be32(1), be32(1), be32(1), be32(1))),
            full('stco', 0, cat(be32(1), be32(2000))),
          ),
        ),
      ),
    ),
  );
  const text = box(
    'trak',
    cat(tkhd(0, 3, ID, 0), mdia('text', 0, 1000, 1000, stbl(box('tx3g', zeros(8)), []))),
  );
  return box(
    'moov',
    cat(full('mvhd', 1, cat(zeros(16), be32(600), be64(1200), zeros(4))), video, audio, text),
  );
}

/** The `moov` payload (what `parseMovie` consumes — the box stripped of its 8-byte header). */
export function moovPayload(): Uint8Array {
  return bytes(moovBox().slice(8));
}

/** An `ftyp` box with the given 4-char major brand. */
export function ftyp(brand: string): number[] {
  return box('ftyp', cat(str(brand), be32(0x200), str(brand)));
}

/** A `moov` box rewritten to use the 64-bit `largesize` header form. */
export function moovBoxLargesize(): number[] {
  const normal = moovBox();
  const payload = normal.slice(8);
  return cat(be32(1), str('moov'), be64(16 + payload.length), payload);
}
