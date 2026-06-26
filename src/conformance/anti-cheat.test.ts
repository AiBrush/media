/**
 * Anti-cheat integrity suite (BUILD_INSTRUCTIONS §6.5, doc 11 §5; task §3.F) — the vitest mirror of
 * `scripts/anti-cheat.ts`, so the integrity gates run under `vitest run` (coverage) as well as the
 * standalone `verify:integrity` script. Same five concerns: oracles-can-fail, no-passthrough,
 * no-per-asset-hardcoding, no-degenerate-metrics, plausibility — exercised on the Node-feasible paths.
 *
 * Every assertion here is the *negative/mutation* half of a validation oracle (it proves the oracle rejects
 * wrong data) or a structural anti-shortcut check — these are the gates that caught the 3 SUSPECT findings.
 */

import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../api/create-media.ts';
import type { MediaInfo } from '../api/types.ts';
import { WebcodecsVideoDriver } from '../codecs/webcodecs-video.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { hexToBytes } from '../crypto/aes.ts';
import { decryptHlsAes128 } from '../crypto/hls-aes.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../sources/source.ts';
import { flacDecodeGolden, wavDecodeGolden } from '../test-support/decode-goldens.ts';
import { goldenPacketsFor } from '../test-support/packet-goldens.ts';
import { sha256Hex } from '../util/digest.ts';
import { ConformanceError, assertCodecDriverNodeFacets } from './harness.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const GOLDEN = `${ROOT}fixtures/golden`;

/** Read a file into a fresh `Uint8Array<ArrayBuffer>` (so it satisfies `BufferSource` for WebCrypto). */
async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await readFile(path);
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
const bytes = (id: string): Promise<Uint8Array<ArrayBuffer>> => readBytes(`${MEDIA_DIR}/${id}`);
const goldenBytes = (rel: string): Promise<Uint8Array<ArrayBuffer>> =>
  readBytes(`${GOLDEN}/${rel}`);
const json = <T>(rel: string): Promise<T> =>
  readFile(`${GOLDEN}/${rel}`, 'utf8').then((s) => JSON.parse(s) as T);

const source = (b: Uint8Array) => ({
  stream: () =>
    new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(b);
        c.close();
      },
    }),
  size: b.byteLength,
});

/** The MP4 driver always provides `streamCopy` (a documented invariant); narrow the optional method once. */
function mp4StreamCopy(): NonNullable<typeof Mp4Driver.streamCopy> {
  const fn = Mp4Driver.streamCopy;
  if (!fn) throw new Error('the MP4 driver must provide streamCopy');
  return fn.bind(Mp4Driver);
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

describe('anti-cheat §5: oracles must be able to fail (mutation self-checks)', () => {
  it('golden-metadata rejects a tampered field but accepts the truth', async () => {
    const golden = await json<MediaInfo>('metadata/movie_5.mp4.json');
    const info = await createMedia().probe(
      fromBytes(await bytes('movie_5.mp4'), { mime: 'video/mp4' }),
    );
    const tampered = structuredClone(golden);
    if (tampered.tracks[0]) tampered.tracks[0].codec = 'TAMPERED';
    expect(info).not.toEqual(tampered);
    expect(info).toEqual(golden);
  });

  it('golden-packets rejects a different fixture (no constant digest)', async () => {
    const golden = await json<{ sha256: string }>('packets/sfx.adts.json');
    const wrong = await goldenPacketsFor('flac', await bytes('sfx.flac'));
    expect(wrong.sha256).not.toBe(golden.sha256);
    const right = await goldenPacketsFor('adts', await bytes('sfx.adts'));
    expect(right.sha256).toBe(golden.sha256);
  });

  it('decoded-bitexact rejects a corrupted FLAC (different digest or a typed throw)', async () => {
    const golden = await json<{ sha256: string }>('decoded/sfx.flac.json');
    const corrupt = (await bytes('sfx.flac')).slice();
    const from = Math.floor(corrupt.length * 0.8);
    for (let i = from; i < from + 64 && i < corrupt.length; i++)
      corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
    const out = await flacDecodeGolden(corrupt).then(
      (g) => g.sha256,
      () => 'THREW',
    );
    expect(out).not.toBe(golden.sha256);
  });

  it('decrypt-twin rejects a wrong HLS key (openssl ciphertext)', async () => {
    const twin = await json<{
      keyHex: string;
      ivHex: string;
      cipherFile: string;
      plaintextSha256: string;
    }>('decrypt/hls-aes128.json');
    const cipher = await goldenBytes(`decrypt/${twin.cipherFile}`);
    const wrong = await decryptHlsAes128(
      cipher,
      hexToBytes('ff'.repeat(16)),
      hexToBytes(twin.ivHex),
    ).then(
      (b) => sha256Hex(b),
      () => 'THREW',
    );
    expect(wrong).not.toBe(twin.plaintextSha256);
    const good = await decryptHlsAes128(cipher, hexToBytes(twin.keyHex), hexToBytes(twin.ivHex));
    expect(await sha256Hex(good)).toBe(twin.plaintextSha256);
  });

  it('conformance rejects a codec that phantom-claims support in Node', async () => {
    const liar = { ...WebcodecsVideoDriver, supports: () => Promise.resolve({ supported: true }) };
    await expect(assertCodecDriverNodeFacets(liar)).rejects.toBeInstanceOf(ConformanceError);
    await expect(assertCodecDriverNodeFacets(WebcodecsVideoDriver)).resolves.toBeUndefined();
  });
});

describe('anti-cheat §5: no input→output passthrough passing as work', () => {
  it.each(['movie_5.mp4', 'bear-1280x720.mp4', 'test.mp4'])(
    '%s: remux re-serializes (output ≠ input) and trim cuts packets',
    async (id) => {
      const input = await bytes(id);
      const remux = await collect(await mp4StreamCopy()(source(input), { faststart: true }));
      expect(await sha256Hex(remux)).not.toBe(await sha256Hex(input)); // not a byte passthrough
      const reprobe = await createMedia().probe(fromBytes(remux, { mime: 'video/mp4' }));
      expect(reprobe.tracks.length).toBeGreaterThan(0); // …but still a valid mp4

      const fullDemux = await Mp4Driver.demux(source(input));
      const fullCount = (fullDemux.packetTable?.() ?? []).length;
      await fullDemux.close();
      const trimmed = await collect(
        await mp4StreamCopy()(source(input), { trim: { startSec: 0, endSec: 1 } }),
      );
      const trimDemux = await Mp4Driver.demux(source(trimmed));
      const trimCount = (trimDemux.packetTable?.() ?? []).length;
      await trimDemux.close();
      expect(trimCount).toBeGreaterThan(0);
      expect(trimCount).toBeLessThan(fullCount); // a genuine cut, not a copy
    },
  );
});

describe('anti-cheat §5: no per-asset hardcoding (matrix → distinct digests)', () => {
  it('distinct WAV fixtures yield distinct decoded digests', async () => {
    const ids = ['sfx-pcm-u8.wav', 'sfx-pcm-s16.wav', 'sfx-pcm-s24.wav', 'stereo-48000.wav'];
    const shas = await Promise.all(
      ids.map(async (id) => (await wavDecodeGolden(await bytes(id))).sha256),
    );
    expect(new Set(shas).size).toBe(shas.length);
  });

  it('distinct containers yield distinct packet digests', async () => {
    const pkts = await Promise.all([
      goldenPacketsFor('adts', await bytes('sfx.adts')),
      goldenPacketsFor('mp3', await bytes('sound_5.mp3')),
      goldenPacketsFor('flac', await bytes('sfx.flac')),
      goldenPacketsFor('mp4', await bytes('movie_5.mp4')),
    ]);
    expect(new Set(pkts.map((p) => p.sha256)).size).toBe(pkts.length);
  });
});

interface BenchOp {
  wallMs?: number;
  mbPerSec?: number;
  bytes?: number;
}
interface BenchGoldenFile {
  files?: { ops?: BenchOp[] }[];
}

describe('anti-cheat §5: no degenerate perf metrics (committed bench goldens)', () => {
  it('every bench op has wallMs > 0 and no faked throughput / ∞ / NaN / negative', async () => {
    const benchDir = `${GOLDEN}/bench`;
    let totalOps = 0;
    const violations: string[] = [];
    for (const file of await readdir(benchDir)) {
      if (!file.endsWith('.json')) continue;
      const golden = await json<BenchGoldenFile>(`bench/${file}`);
      for (const [fi, f] of (golden.files ?? []).entries()) {
        for (const [oi, op] of (f.ops ?? []).entries()) {
          totalOps++;
          const where = `${file}.files[${fi}].ops[${oi}]`;
          for (const [k, v] of Object.entries(op as Record<string, unknown>))
            if (typeof v === 'number' && (!Number.isFinite(v) || v < 0))
              violations.push(`${where}.${k}=${v}`);
          if (op.wallMs === 0) violations.push(`${where}.wallMs=0`);
          if (op.mbPerSec === 0 && typeof op.bytes === 'number' && op.bytes > 0)
            violations.push(`${where}.mbPerSec=0 with bytes`);
        }
      }
    }
    expect(totalOps).toBeGreaterThan(0);
    expect(violations, violations.slice(0, 5).join('; ')).toEqual([]);
  });

  it('the N/A-not-0 policy: a metric over an empty sample set is N/A, never 0', () => {
    const metricOrNA = (samples: readonly number[]): number | 'N/A' => {
      if (samples.length === 0) return 'N/A';
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[sorted.length >> 1] ?? 'N/A';
    };
    expect(metricOrNA([])).toBe('N/A');
    expect(typeof metricOrNA([1, 2, 3])).toBe('number');
  });
});

describe('anti-cheat §5: plausibility (real physical ranges)', () => {
  it('probe of movie_5.mp4 is physically plausible', async () => {
    const info = await createMedia().probe(
      fromBytes(await bytes('movie_5.mp4'), { mime: 'video/mp4' }),
    );
    expect(info.durationSec).toBeGreaterThan(1);
    expect(info.durationSec).toBeLessThan(30);
    expect(info.tracks.some((t) => t.type === 'video')).toBe(true);
    expect(info.tracks.some((t) => t.type === 'audio')).toBe(true);
  });

  it('decrypt with a missing key is a typed CapabilityError (graceful, not wrong output)', async () => {
    const twin = await json<{ cipherFile: string }>('decrypt/cenc-aes-ctr.json');
    const enc = await goldenBytes(`decrypt/${twin.cipherFile}`);
    await expect(
      createMedia().decrypt(fromBytes(enc, { mime: 'video/mp4' }), { scheme: 'cenc', keys: {} }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
