/**
 * First-party driver bundle — registered into an engine on demand so `media.probe(file)` works
 * zero-config (doc 07) while the eager kernel stays tiny (ADR-004). The engine `import()`s this module
 * only on a capability miss, so it (and the container parsers it pulls in) is a lazy code-split chunk,
 * never part of the eager bundle.
 */

import { ImageModule } from '../codecs/image/image-driver.ts';
import { WasmAacModule } from '../codecs/wasm-aac/wasm-aac-driver.ts';
import { WasmAv1Module } from '../codecs/wasm-av1/wasm-av1-driver.ts';
import { WasmMp3Module } from '../codecs/wasm-mp3/wasm-mp3-driver.ts';
import { WasmOpusModule } from '../codecs/wasm-opus/wasm-opus-driver.ts';
import { WasmVorbisModule } from '../codecs/wasm-vorbis/wasm-vorbis-driver.ts';
import { WasmVpxModule } from '../codecs/wasm-vpx/wasm-vpx-driver.ts';
import { WebCodecsAudioModule } from '../codecs/webcodecs-audio.ts';
import { WebcodecsVideoModule } from '../codecs/webcodecs-video.ts';
import type { DriverModule, Registry } from '../contracts/driver.ts';
import { AudioDspFilterModule } from '../filters/audio-dsp.ts';
import { CpuVideoFilterModule } from '../filters/cpu-video.ts';
import { GpuVideoFilterModule } from '../filters/gpu-video.ts';
import { AdtsModule } from './adts/adts-driver.ts';
import { AiffModule } from './aiff/aiff-driver.ts';
import { AviModule } from './avi/avi-driver.ts';
import { CafModule } from './caf/caf-driver.ts';
import { FlacCodecModule } from './flac/flac-codec.ts';
import { FlacModule } from './flac/flac-driver.ts';
import { HlsModule } from './hls/hls-driver.ts';
import { Mp3Module } from './mp3/mp3-driver.ts';
import { Mp4Module } from './mp4/mp4-driver.ts';
import { MpegTsModule } from './mpegts/mpegts-driver.ts';
import { OggModule } from './ogg/ogg-driver.ts';
import { WavModule } from './wav/wav-driver.ts';
import { WebmModule } from './webm/webm-driver.ts';

/**
 * Register all first-party drivers (idempotent by id): the TS containers, the WebCodecs codec tier
 * (video + audio, `tier:'hardware'`), and the GPU video filter substrates (WebGPU + Canvas2D). The
 * WebCodecs/GPU drivers `supports()` honestly report `false` where those APIs are absent (e.g. Node), so
 * registering them everywhere is safe — the router simply skips them and falls through to a typed miss.
 */
export function registerDefaultDrivers(reg: Registry): void {
  const modules: DriverModule[] = [
    Mp4Module,
    WavModule,
    Mp3Module,
    OggModule,
    WebmModule,
    FlacModule,
    AdtsModule,
    MpegTsModule,
    HlsModule,
    AiffModule,
    AviModule,
    CafModule,
    WebcodecsVideoModule,
    WebCodecsAudioModule,
    FlacCodecModule, // pure-TS FLAC ENCODE tail (miss-only): no browser encodes FLAC (ADR-085)
    WasmVorbisModule, // real Symphonia wasm tail (miss-only): Vorbis decode (ADR-039/041/042)
    WasmAacModule, // real Symphonia wasm tail (miss-only): AAC-LC decode
    WasmMp3Module, // real Symphonia wasm tail (miss-only): MP3 decode
    WasmOpusModule, // real libopus wasm tail (miss-only): Opus decode + encode (vendored prebuilt, ADR-088)
    WasmAv1Module, // real dav1d wasm tail (miss-only): AV1 8-bit decode (vendored prebuilt, ADR-093)
    WasmVpxModule, // real ogv.js libvpx wasm tail (miss-only): VP8/VP9 8-bit decode (vendored prebuilt, ADR-094)
    GpuVideoFilterModule,
    AudioDspFilterModule, // audio filters (resample/remix/gain) over AudioData (ADR-033)
    CpuVideoFilterModule, // CPU video filter fallback (no-WebGPU browsers): colorspace/tonemap/geometry (ADR-038)
    ImageModule, // still/animated image probe + browser ImageDecoder decode capability (ADR-049)
    // All software codec tails now co-vendor their wasm via scripts/vendor-wasm.ts (rust both-files pairs:
    // Vorbis/AAC/MP3 + dav1d AV1; self-contained inlined tails: Opus/VPx) for the lazy import.meta.url load
    // on a WebCodecs miss (ADR-042/086/090/093/094). supports()→false in Node (no VideoFrame/WebCodecs seam).
  ];
  for (const mod of modules) mod.register(reg);
}
