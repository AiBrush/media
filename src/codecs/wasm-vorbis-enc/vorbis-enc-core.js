import createModule from './vorbis-enc-wasm.js';

const MAX_FEED_FRAMES = 8192;

let runtimePromise;

async function runtime() {
  runtimePromise ??= createModule({ print() {}, printErr() {} });
  return runtimePromise;
}

export default async function initVorbisEncCore() {
  await runtime();
}

function mustLive(freed) {
  if (freed()) throw new Error('vorbis-enc: encoder already freed');
}

export function createVorbisEncCore() {
  return {
    async createEncoder(init) {
      const mod = await runtime();
      const bitrate = init.bitrate === 'auto' ? 0 : init.bitrate;
      const handle = mod._ab_vorbis_create(init.sampleRate, init.channels, bitrate, init.quality);
      if (handle === 0) throw new Error('vorbis-enc: failed to create encoder');
      let freed = false;

      const collect = () => {
        const count = mod._ab_vorbis_packet_count(handle);
        const packets = [];
        for (let i = 0; i < count; i++) {
          const ptr = mod._ab_vorbis_packet_data(handle, i);
          const bytes = mod._ab_vorbis_packet_bytes(handle, i);
          if (bytes < 0 || (bytes > 0 && ptr === 0)) {
            mod._ab_vorbis_clear_packets(handle);
            throw new Error('vorbis-enc: invalid packet returned by wasm core');
          }
          const data = mod.HEAPU8.slice(ptr, ptr + bytes);
          packets.push({
            data,
            granulepos: mod._ab_vorbis_packet_granulepos(handle, i),
            eos: mod._ab_vorbis_packet_eos(handle, i) !== 0,
          });
        }
        mod._ab_vorbis_clear_packets(handle);
        return packets;
      };

      return {
        headers() {
          mustLive(() => freed);
          if (mod._ab_vorbis_headers(handle) !== 1) {
            throw new Error('vorbis-enc: failed to produce setup headers');
          }
          const packets = collect();
          if (packets.length !== 3) {
            throw new Error(`vorbis-enc: expected 3 setup headers, got ${packets.length}`);
          }
          return [packets[0].data, packets[1].data, packets[2].data];
        },
        encode(interleaved, frames) {
          mustLive(() => freed);
          if (frames < 0 || !Number.isInteger(frames)) {
            throw new Error(`vorbis-enc: invalid frame count ${frames}`);
          }
          const channels = init.channels;
          if (interleaved.length !== frames * channels) {
            throw new Error(
              `vorbis-enc: input has ${interleaved.length} samples, expected ${frames * channels}`,
            );
          }
          if (interleaved.length === 0 && frames === 0) return [];
          const packets = [];
          for (let offsetFrames = 0; offsetFrames < frames; offsetFrames += MAX_FEED_FRAMES) {
            const chunkFrames = Math.min(MAX_FEED_FRAMES, frames - offsetFrames);
            const sampleStart = offsetFrames * channels;
            const sampleEnd = sampleStart + chunkFrames * channels;
            const view = interleaved.subarray(sampleStart, sampleEnd);
            const ptr = mod._malloc(view.byteLength);
            if (ptr === 0) throw new Error('vorbis-enc: wasm allocation failed');
            try {
              mod.HEAPF32.set(view, ptr >> 2);
              if (mod._ab_vorbis_feed(handle, ptr, chunkFrames) !== 1) {
                throw new Error('vorbis-enc: feed failed');
              }
            } finally {
              mod._free(ptr);
            }
            packets.push(...collect());
          }
          return packets;
        },
        finish() {
          mustLive(() => freed);
          if (mod._ab_vorbis_finish(handle) !== 1) {
            throw new Error('vorbis-enc: finish failed');
          }
          return collect();
        },
        free() {
          if (freed) return;
          freed = true;
          mod._ab_vorbis_destroy(handle);
        },
      };
    },
  };
}
