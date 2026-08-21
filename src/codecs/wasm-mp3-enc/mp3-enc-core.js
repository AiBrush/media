/**
 * Hand-written glue for the vendored LAME WebAssembly core (`mp3_enc_wasm_bg.wasm`, npm
 * `wasm-media-encoders@0.7.0` — see BUILD.md). The core is a freestanding WASI-reactor module, not an
 * Emscripten bundle, so it ships no generated loader; this file is the whole runtime seam.
 *
 * Its shape deliberately mirrors the wasm-bindgen `--target web` glue the other tails vendor: a default
 * async `init(moduleOrPath)` that accepts a URL (browser, fetched same-origin), raw bytes, or a
 * pre-compiled `WebAssembly.Module` (so Node tests instantiate without fetch), plus a
 * `createMp3EncCore()` factory returning the {@link Mp3EncWasmCore} contract declared in `mp3-enc.ts`.
 *
 * Everything policy-shaped (config validation, bitrate legality, the parameter block, frame splitting)
 * lives in `mp3-enc.ts` and is Node-tested; this file only marshals bytes across the ABI.
 */

/** Cap on samples handed to one `enc_get_pcm`/`enc_encode` pair, bounding the core's PCM staging buffer. */
const MAX_ENCODE_SAMPLES = 1152 * 16;

/** Instance exports of the single vendored core, shared by every encoder (LAME state hangs off `ref`). */
let wasm;
/** In-flight/settled instantiation, so concurrent callers instantiate the module exactly once. */
let readyPromise;

function coreImports() {
  return {
    env: {
      // The core allocates its heap up front and every view below is derived at point of use from the
      // live `memory.buffer`, so a growth notification needs no cache invalidation here.
      emscripten_notify_memory_growth: () => {},
    },
    wasi_snapshot_preview1: {
      proc_exit: (code) => {
        throw new Error(`mp3-enc: core called proc_exit(${code})`);
      },
    },
  };
}

/**
 * Instantiate from the inlined copy of the core.
 *
 * Imported dynamically and only from the URL path's failure branch, so bundlers give it its own chunk
 * and its bytes are fetched only once serving the sibling `.wasm` has already failed — the common route
 * never pays for it. See `./mp3-enc-wasm-fallback.js` for when that happens.
 */
async function instantiateFromInlinedCopy(imports) {
  const { default: fallbackBytes } = await import('./mp3-enc-wasm-fallback.js');
  return (await WebAssembly.instantiate(fallbackBytes(), imports)).instance;
}

async function instantiate(moduleOrPath) {
  const imports = coreImports();
  let input = moduleOrPath;
  if (input !== undefined && Object.getPrototypeOf(input) === Object.prototype) {
    // wasm-bindgen-style `{ module_or_path }` envelope (what `wasmInitForProfile` hands the driver).
    ({ module_or_path: input } = input);
  }
  if (input instanceof WebAssembly.Module) {
    return new WebAssembly.Instance(input, imports);
  }
  if (typeof input === 'string' || (typeof URL === 'function' && input instanceof URL)) {
    // A host may refuse to serve the sibling artifact even though the module itself loaded (a
    // filesystem allow-list that does not cover a symlinked dependency's real path, a restrictive CSP,
    // an asset pipeline that moved the chunk but not its `.wasm`). Falling back to the inlined copy
    // keeps the codec available there instead of reporting an unactionable capability miss.
    try {
      if (typeof WebAssembly.instantiateStreaming === 'function') {
        return (await WebAssembly.instantiateStreaming(fetch(input), imports)).instance;
      }
      const response = await fetch(input);
      if (!response.ok) throw new Error(`mp3-enc: core fetch failed with HTTP ${response.status}`);
      input = await response.arrayBuffer();
    } catch {
      return instantiateFromInlinedCopy(imports);
    }
  } else if (typeof Response === 'function' && input instanceof Response) {
    input = await input.arrayBuffer();
  }
  if (input === undefined) {
    // Deliberate: the driver always resolves the sibling core through
    // `new URL('./mp3_enc_wasm_bg.wasm', import.meta.url)`, and Node tests hand over a pre-compiled
    // `WebAssembly.Module`. Guessing here would only turn a wiring mistake into a confusing later fault.
    throw new Error('mp3-enc: no wasm module or URL was provided');
  }
  return (await WebAssembly.instantiate(input, imports)).instance;
}

/** Instantiate the vendored core (at most once per module instance) and run its WASI reactor start. */
export default async function initMp3EncCore(moduleOrPath) {
  readyPromise ??= (async () => {
    const instance = await instantiate(moduleOrPath);
    instance.exports._initialize();
    wasm = instance.exports;
    return wasm;
  })().catch((e) => {
    readyPromise = undefined; // a failed load must not poison a later retry
    throw e;
  });
  return readyPromise;
}

function u8(ptr, length) {
  return new Uint8Array(wasm.memory.buffer, ptr, length);
}

function i32(ptr, length) {
  return new Int32Array(wasm.memory.buffer, ptr, length);
}

function f32(ptr, length) {
  return new Float32Array(wasm.memory.buffer, ptr, length);
}

/** Read a NUL-terminated C string the core returns (`version()` / `mime_type()`). */
function cString(ptr) {
  const bytes = new Uint8Array(wasm.memory.buffer, ptr);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end < 0 ? 0 : end));
}

/** Copy `params` into the core's heap, call `enc_init`, and free the staging block either way. */
function initEncoder(params) {
  const ptr = wasm.malloc(params.length);
  if (!ptr) throw new Error('mp3-enc: failed to allocate the parameter block');
  let ref;
  try {
    u8(ptr, params.length).set(params);
    ref = wasm.enc_init(ptr);
  } finally {
    wasm.free(ptr);
  }
  if (!ref) throw new Error('mp3-enc: LAME rejected the encoder parameters');
  return ref;
}

function concat(runs, total) {
  if (runs.length === 1) return runs[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const run of runs) {
    out.set(run, offset);
    offset += run.length;
  }
  return out;
}

/** The {@link Mp3EncWasmCore} the driver consumes. `initMp3EncCore` must have resolved first. */
export function createMp3EncCore() {
  if (wasm === undefined) throw new Error('mp3-enc: core is not initialized');
  return {
    mimeType: cString(wasm.mime_type()),
    version: cString(wasm.version()),
    createEncoder(params, channels) {
      const ref = initEncoder(params);
      let freed = false;
      let flushed = false;

      const live = () => {
        if (freed) throw new Error('mp3-enc: encoder already freed');
      };

      return {
        encode(planes, frames) {
          live();
          if (flushed) throw new Error('mp3-enc: encoder already flushed');
          if (planes.length !== channels) {
            throw new Error(`mp3-enc: expected ${channels} planar channel(s), got ${planes.length}`);
          }
          const runs = [];
          let total = 0;
          for (let offset = 0; offset < frames; offset += MAX_ENCODE_SAMPLES) {
            const count = Math.min(MAX_ENCODE_SAMPLES, frames - offset);
            // `enc_get_pcm` may grow the heap, so every view below is derived after it returns.
            const pcmPtr = wasm.enc_get_pcm(ref, count);
            if (!pcmPtr) throw new Error('mp3-enc: PCM buffer allocation failed');
            const planePtrs = i32(pcmPtr, channels);
            for (let c = 0; c < channels; c++) {
              f32(planePtrs[c], count).set(planes[c].subarray(offset, offset + count));
            }
            const length = wasm.enc_encode(ref, count);
            if (length < 0) throw new Error(`mp3-enc: LAME encode failed (${length})`);
            if (length > 0) {
              runs.push(u8(wasm.enc_get_out_buf(ref), length).slice());
              total += length;
            }
          }
          return total === 0 ? new Uint8Array(0) : concat(runs, total);
        },
        finish() {
          live();
          if (flushed) return new Uint8Array(0);
          flushed = true;
          const length = wasm.enc_flush(ref);
          if (length < 0) throw new Error(`mp3-enc: LAME flush failed (${length})`);
          if (length === 0) return new Uint8Array(0);
          return u8(wasm.enc_get_out_buf(ref), length).slice();
        },
        free() {
          if (freed) return;
          freed = true;
          wasm.enc_free(ref);
        },
      };
    },
  };
}
