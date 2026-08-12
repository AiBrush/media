import { describe, expect, it, vi } from 'vitest';
import type {
  CodecQuery,
  ContainerQuery,
  FilterSpec,
  WasmRuntimeProfile,
} from '../contracts/driver.ts';

const mocks = vi.hoisted(() => ({ loadAacCore: vi.fn(() => Promise.resolve(null)) }));

vi.mock('../codecs/wasm-aac/wasm-aac-driver.ts', () => ({
  loadAacCore: mocks.loadAacCore,
}));

import { type PreloadHost, runPreload } from './preload.ts';

describe('preload runtime controls', () => {
  it('passes the engine-resolved profile and absolute asset root to a ready-level WASM warmup', async () => {
    const wasmRuntime: WasmRuntimeProfile = {
      kind: 'baseline',
      simd: false,
      threads: false,
      sharedArrayBuffer: false,
      reason: 'threads disabled by request',
    };
    const host: PreloadHost = {
      tasks: new Map(),
      wasmRuntime,
      wasmAssetBaseUrl: 'https://app.example/media/cores/',
      ensureDefaultDrivers: () => Promise.resolve(),
      warmOperationChunks: () => Promise.resolve(),
      pickContainer: (_query: ContainerQuery) => {},
      pickCodec: (_query: CodecQuery) => Promise.resolve(),
      pickFilter: (_spec: FilterSpec) => {},
    };

    await runPreload(host, [{ op: 'decode', audio: 'aac', level: 'ready' }]);

    expect(mocks.loadAacCore).toHaveBeenCalledTimes(1);
    expect(mocks.loadAacCore).toHaveBeenCalledWith(wasmRuntime, 'https://app.example/media/cores/');
  });
});
