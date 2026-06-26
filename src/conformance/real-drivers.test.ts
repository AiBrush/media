/**
 * Real-driver contract conformance (BUILD_INSTRUCTIONS §6.2, doc 11 §4.2; task §3.F).
 *
 * The harness.test.ts file proves the conformance suite *runs* against the no-op reference driver and can
 * *fail* (anti-cheat). THIS file proves the suite runs against **every first-party driver that ships** —
 * the 11 real `ContainerDriver`s, the 8 real `CodecDriver`s, and the 4 real `FilterDriver`s — so they are
 * all held to identical seam/lifecycle/error behavior (the whole point of a conformance harness).
 *
 * **Node vs browser facets.** This suite runs under Node (vitest's environment), where WebCodecs
 * (`VideoFrame`/`AudioData`/`EncodedVideoChunk`/`isConfigSupported`) and WebGPU are absent. The container
 * drivers are pure TS and run through the **full** `assertContainerDriverConforms` here. The codec + filter
 * drivers are browser/WASM tiers whose `supports()` is environment-dependent, so here they run through the
 * Node-checkable facet harnesses (identity, contract version, valid tier/substrate, `supports()` honesty +
 * total-function) — and the browser-only facets they ADD (true `supports()` + the close-once frame-flow)
 * are exercised by the Playwright browser harness, layered on top of these (doc 11 §4.2). The coverage map
 * test at the bottom is the anti-overfitting guard: a newly-registered first-party driver that is not wired
 * into one of these lists fails the map, so "every driver of a kind passes the same suite" cannot rot.
 */

import { describe, expect, it } from 'vitest';
// Codec drivers (8 real).
import { WasmAacDriver } from '../codecs/wasm-aac/wasm-aac-driver.ts';
import { WasmAv1Driver } from '../codecs/wasm-av1/wasm-av1-driver.ts';
import { WasmMp3Driver } from '../codecs/wasm-mp3/wasm-mp3-driver.ts';
import { WasmOpusDriver } from '../codecs/wasm-opus/wasm-opus-driver.ts';
import { WasmVorbisDriver } from '../codecs/wasm-vorbis/wasm-vorbis-driver.ts';
import { WasmVpxDriver } from '../codecs/wasm-vpx/wasm-vpx-driver.ts';
import { WebCodecsAudioDriver } from '../codecs/webcodecs-audio.ts';
import { WebcodecsVideoDriver } from '../codecs/webcodecs-video.ts';
import type { CodecDriver, ContainerDriver, FilterDriver } from '../contracts/driver.ts';
// Container drivers (11 real).
import { AdtsDriver } from '../drivers/adts/adts-driver.ts';
import { AiffDriver } from '../drivers/aiff/aiff-driver.ts';
import { AviDriver } from '../drivers/avi/avi-driver.ts';
import { CafDriver } from '../drivers/caf/caf-driver.ts';
import { registerDefaultDrivers } from '../drivers/defaults.ts';
import { FlacCodecDriver } from '../drivers/flac/flac-codec.ts';
import { FlacDriver } from '../drivers/flac/flac-driver.ts';
import { HlsModule } from '../drivers/hls/hls-driver.ts';
import { Mp3Driver } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { MpegTsDriver } from '../drivers/mpegts/mpegts-driver.ts';
import { OggDriver } from '../drivers/ogg/ogg-driver.ts';
import { WavDriver } from '../drivers/wav/wav-driver.ts';
import { WebmDriver } from '../drivers/webm/webm-driver.ts';
// Filter drivers (4 real).
import { audioDspFilterDriver } from '../filters/audio-dsp.ts';
import { cpuVideoFilterDriver } from '../filters/cpu-video.ts';
import { canvas2dVideoFilterDriver, webgpuVideoFilterDriver } from '../filters/gpu-video.ts';
import { Registry } from '../kernel/registry.ts';
import {
  ConformanceError,
  type ContainerConformanceCase,
  assertCodecDriverNodeFacets,
  assertContainerDriverConforms,
  assertFilterDriverNodeFacets,
} from './harness.ts';

// ── Container conformance (full suite, pure TS, runs in Node) ──────────────────────────────────────

/**
 * A real supported/unsupported {@link ContainerQuery} pair per container, built from the driver's actual
 * `supports()` (extension-based). The unsupported extension is always `'zzz'` (no driver claims it).
 */
const CONTAINER_CASES: ReadonlyArray<readonly [ContainerDriver, ContainerConformanceCase]> = [
  [
    Mp4Driver,
    {
      supported: { direction: 'demux', extension: 'mp4' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    Mp4Driver,
    {
      supported: { direction: 'demux', extension: 'mov' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    WebmDriver,
    {
      supported: { direction: 'demux', extension: 'webm' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    WebmDriver,
    {
      supported: { direction: 'demux', extension: 'mkv' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    OggDriver,
    {
      supported: { direction: 'demux', extension: 'ogg' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    WavDriver,
    {
      supported: { direction: 'demux', extension: 'wav' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    AiffDriver,
    {
      supported: { direction: 'demux', extension: 'aiff' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    CafDriver,
    {
      supported: { direction: 'demux', extension: 'caf' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    Mp3Driver,
    {
      supported: { direction: 'demux', extension: 'mp3' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    FlacDriver,
    {
      supported: { direction: 'demux', extension: 'flac' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    AdtsDriver,
    {
      supported: { direction: 'demux', extension: 'adts' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    MpegTsDriver,
    {
      supported: { direction: 'demux', extension: 'ts' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    MpegTsDriver,
    {
      supported: { direction: 'demux', extension: 'm2ts' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
  [
    AviDriver,
    {
      supported: { direction: 'demux', extension: 'avi' },
      unsupported: { direction: 'demux', extension: 'zzz' },
    },
  ],
];

describe('real container drivers — every one passes the FULL conformance suite (Node)', () => {
  it.each(CONTAINER_CASES)('%o conforms', (driver, kase) => {
    expect(() => assertContainerDriverConforms(driver, kase)).not.toThrow();
  });

  it('the suite spans every shipped container family (no overfitting to one)', () => {
    const ids = new Set(CONTAINER_CASES.map(([d]) => d.id));
    for (const id of [
      'mp4',
      'webm',
      'ogg',
      'wav',
      'aiff',
      'caf',
      'mp3',
      'flac',
      'adts',
      'mpegts',
      'avi',
    ])
      expect(ids, `container ${id} must be conformance-covered`).toContain(id);
  });
});

// ── Codec conformance (Node facets; browser facets deferred to Playwright) ──────────────────────────

const REAL_CODECS: readonly CodecDriver[] = [
  WebcodecsVideoDriver,
  WebCodecsAudioDriver,
  FlacCodecDriver, // tier:'native', pure-TS FLAC encode (supports() honest-false in Node: needs AudioData)
  WasmAacDriver,
  WasmMp3Driver,
  WasmVorbisDriver,
  WasmOpusDriver,
  WasmVpxDriver,
  WasmAv1Driver,
];

describe('real codec drivers — every one passes the Node-checkable conformance facets', () => {
  it.each(REAL_CODECS.map((d) => [d.id, d] as const))(
    '%s conforms (identity + tier + supports() honesty/total-function)',
    async (_id, driver) => {
      await expect(assertCodecDriverNodeFacets(driver)).resolves.toBeUndefined();
    },
  );

  it('the suite spans both WebCodecs tiers, the native FLAC encoder, and every WASM codec tail', () => {
    const ids = new Set(REAL_CODECS.map((d) => d.id));
    for (const id of [
      'webcodecs-video',
      'webcodecs-audio',
      'flac-encode',
      'wasm-aac',
      'wasm-mp3',
      'wasm-vorbis',
      'wasm-opus',
      'wasm-vpx',
      'wasm-av1',
    ])
      expect(ids, `codec ${id} must be conformance-covered`).toContain(id);
  });

  it('browser-only facets are explicitly out of scope here (documented, not silently skipped)', () => {
    // The true-`supports()` (isConfigSupported says yes) and the close-once frame-flow facets require real
    // WebCodecs and run in the Playwright browser harness. Asserting their Node-absence keeps the split honest.
    expect(typeof globalThis.VideoFrame).toBe('undefined');
    expect(typeof globalThis.AudioData).toBe('undefined');
  });
});

// ── Filter conformance (Node facets; browser facets deferred to Playwright) ─────────────────────────

const REAL_FILTERS: readonly FilterDriver[] = [
  webgpuVideoFilterDriver,
  canvas2dVideoFilterDriver,
  cpuVideoFilterDriver,
  audioDspFilterDriver,
];

describe('real filter drivers — every one passes the Node-checkable conformance facets', () => {
  it.each(REAL_FILTERS.map((d) => [d.id, d] as const))(
    '%s conforms (identity + substrate + supports() honesty/total-function)',
    (_id, driver) => {
      expect(() => assertFilterDriverNodeFacets(driver)).not.toThrow();
    },
  );

  it('the suite spans every filter substrate (webgpu/canvas2d/native video + native audio)', () => {
    const ids = new Set(REAL_FILTERS.map((d) => d.id));
    for (const id of [
      'webgpu-video-filter',
      'canvas2d-video-filter',
      'cpu-video-filter',
      'audio-dsp-filter',
    ])
      expect(ids, `filter ${id} must be conformance-covered`).toContain(id);
  });
});

// ── HLS module: not a container, registers the MPEG-TS segment container (its real contract) ─────────

describe('HLS driver module — registers the MPEG-TS segment container (HLS is a manifest, not a container)', () => {
  it('registering HlsModule adds the conformant mpegts container and no phantom "hls" container', () => {
    const reg = new Registry();
    HlsModule.register(reg);
    const containerIds = reg.containers().map((d) => d.id);
    expect(containerIds).toContain('mpegts');
    expect(containerIds).not.toContain('hls');
    // …and that registered container passes the same conformance suite.
    const mpegts = reg.containers().find((d) => d.id === 'mpegts');
    expect(mpegts).toBeDefined();
    if (mpegts)
      expect(() =>
        assertContainerDriverConforms(mpegts, {
          supported: { direction: 'demux', extension: 'ts' },
          unsupported: { direction: 'demux', extension: 'zzz' },
        }),
      ).not.toThrow();
  });
});

// ── The facet harnesses can fail (anti-cheat: a Node facet oracle must reject a violating driver) ───

describe('Node facet harnesses can fail — they reject drivers that violate the contract', () => {
  it('codec facets reject a driver that phantom-claims support in Node (the honest-miss gate)', async () => {
    const liar: CodecDriver = {
      ...WebcodecsVideoDriver,
      supports: () => Promise.resolve({ supported: true }),
    };
    await expect(assertCodecDriverNodeFacets(liar)).rejects.toBeInstanceOf(ConformanceError);
  });

  it('codec facets reject a driver whose supports() throws (must be a total function)', async () => {
    const thrower: CodecDriver = {
      ...WasmAacDriver,
      supports: () => {
        throw new Error('boom');
      },
    };
    await expect(assertCodecDriverNodeFacets(thrower)).rejects.toBeInstanceOf(ConformanceError);
  });

  it('codec facets reject an out-of-window apiVersion', async () => {
    const future: CodecDriver = { ...WebCodecsAudioDriver, apiVersion: 999 } as CodecDriver;
    await expect(assertCodecDriverNodeFacets(future)).rejects.toBeInstanceOf(ConformanceError);
  });

  it('filter facets reject a driver that phantom-claims support in Node', () => {
    const liar: FilterDriver = { ...cpuVideoFilterDriver, supports: () => true };
    expect(() => assertFilterDriverNodeFacets(liar)).toThrow(ConformanceError);
  });

  it('filter facets reject an invalid substrate', () => {
    const bad = { ...audioDspFilterDriver, substrate: 'quantum' } as unknown as FilterDriver;
    expect(() => assertFilterDriverNodeFacets(bad)).toThrow(ConformanceError);
  });
});

// ── Coverage map: the anti-rot guard — every registered first-party driver is conformance-covered ───

describe('conformance coverage map — every first-party driver that registers is in a conformance list', () => {
  it('no registered codec/container/filter driver escapes the conformance suite', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const coveredContainers = new Set(CONTAINER_CASES.map(([d]) => d.id));
    const coveredCodecs = new Set(REAL_CODECS.map((d) => d.id));
    const coveredFilters = new Set(REAL_FILTERS.map((d) => d.id));

    // Defaults do NOT register every wasm codec (Opus/VPx/AV1 stay out as core-less scaffolds) — but the
    // conformance lists DO cover them (they ship as importable drivers). So every *registered* driver must
    // be covered; the reverse (covered-but-not-default) is allowed and intentional.
    for (const d of reg.containers())
      expect(
        coveredContainers,
        `registered container '${d.id}' is not conformance-covered`,
      ).toContain(d.id);
    for (const d of reg.codecs())
      expect(coveredCodecs, `registered codec '${d.id}' is not conformance-covered`).toContain(
        d.id,
      );
    for (const d of reg.filters())
      expect(coveredFilters, `registered filter '${d.id}' is not conformance-covered`).toContain(
        d.id,
      );
  });
});
