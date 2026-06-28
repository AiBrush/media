import type { VorbisEncRuntime } from './vorbis-enc.ts';

interface VorbisEncModuleOptions {
  readonly print?: (...args: readonly unknown[]) => void;
  readonly printErr?: (...args: readonly unknown[]) => void;
}

export default function createModule(options?: VorbisEncModuleOptions): Promise<VorbisEncRuntime>;
