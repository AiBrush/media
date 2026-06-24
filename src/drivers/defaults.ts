/**
 * First-party driver bundle — registered into an engine on demand so `media.probe(file)` works
 * zero-config (doc 07) while the eager kernel stays tiny (ADR-004). The engine `import()`s this module
 * only on a capability miss, so it (and the container parsers it pulls in) is a lazy code-split chunk,
 * never part of the eager bundle.
 */

import type { Registry } from '../contracts/driver.ts';
import { AdtsModule } from './adts/adts-driver.ts';
import { FlacModule } from './flac/flac-driver.ts';
import { Mp3Module } from './mp3/mp3-driver.ts';
import { Mp4Module } from './mp4/mp4-driver.ts';
import { OggModule } from './ogg/ogg-driver.ts';
import { WavModule } from './wav/wav-driver.ts';
import { WebmModule } from './webm/webm-driver.ts';

/** Register all first-party container drivers (idempotent by id). */
export function registerDefaultDrivers(reg: Registry): void {
  for (const mod of [
    Mp4Module,
    WavModule,
    Mp3Module,
    OggModule,
    WebmModule,
    FlacModule,
    AdtsModule,
  ]) {
    mod.register(reg);
  }
}
