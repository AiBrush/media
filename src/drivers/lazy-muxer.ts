/**
 * The one lazy muxer behind every lazy container proxy (ADR-004 miss-only loading). Tracks may be
 * added and validated synchronously before the driver chunk loads; the real muxer is created on the
 * first `write`/`finalize`, replays the queued tracks, and pumps its output into the handle the
 * caller already holds. Single-track families (FLAC) express their constraint as a `validateTrack`
 * rule — a config, not a class.
 */

import type { ContainerDriver, MuxOptions, Muxer, Packet, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';

/** Loads (and caches) the real container driver behind a lazy proxy. */
export type LazyContainerLoader = () => Promise<ContainerDriver>;

/** The typed miss a lazy proxy raises when its loaded module lacks an advertised method. */
export function missingLazyMethod(id: string, method: string): CapabilityError {
  return new CapabilityError(`lazy ${id} driver lacks ${method}`, {
    op: { kind: 'route', id: method, facts: { driver: id } },
    tried: [id],
  });
}

export interface LazyMuxerConfig {
  /** Driver id used for typed miss/error attribution. */
  readonly driverId: string;
  readonly load: LazyContainerLoader;
  readonly muxOptions: MuxOptions | undefined;
  /** Synchronous pre-load track validation (family constraints, e.g. FLAC's single audio stream). */
  readonly validateTrack?: ((track: TrackInfo, trackCount: number) => void) | undefined;
  /**
   * Expose the optional raw-PCM frame seam. Only families whose real muxer can implement it should
   * advertise it — a consumer probes `writePcm` presence to choose between the PCM and encode paths.
   */
  readonly pcmSeam?: boolean;
}

export class LazyMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;
  readonly writePcm?: (trackId: number, data: Uint8Array) => Promise<void>;
  readonly #config: LazyMuxerConfig;
  readonly #ready: Promise<void>;
  readonly #tracks: TrackInfo[] = [];
  readonly #targetTrackIds: number[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #resolveReady: (() => void) | undefined;
  #muxer: Muxer | undefined;
  #muxerPromise: Promise<Muxer> | undefined;

  constructor(config: LazyMuxerConfig) {
    this.#config = config;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
    if (config.pcmSeam === true) {
      this.writePcm = (trackId, data): Promise<void> => this.#writePcm(trackId, data);
    }
  }

  addTrack(info: TrackInfo): number {
    this.#config.validateTrack?.(info, this.#tracks.length);
    const id = this.#tracks.length;
    this.#tracks.push(info);
    if (this.#muxer !== undefined) {
      this.#targetTrackIds[id] = this.#muxer.addTrack(info);
    }
    return id;
  }

  async write(trackId: number, packet: Packet): Promise<void> {
    const muxer = await this.#ensureMuxer();
    const targetTrackId = this.#targetTrackIds[trackId];
    if (targetTrackId === undefined)
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    await muxer.write(targetTrackId, packet);
  }

  async finalize(): Promise<void> {
    const muxer = await this.#ensureMuxer();
    await muxer.finalize();
  }

  async #writePcm(trackId: number, data: Uint8Array): Promise<void> {
    const muxer = await this.#ensureMuxer();
    const targetTrackId = this.#targetTrackIds[trackId];
    if (targetTrackId === undefined)
      throw new MediaError('mux-error', `write PCM to unknown track ${trackId}`);
    if (muxer.writePcm === undefined) {
      throw new CapabilityError('the selected muxer has no raw PCM frame seam', {
        op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'pcm' } },
        tried: [this.#config.driverId],
      });
    }
    await muxer.writePcm(targetTrackId, data);
  }

  async #ensureMuxer(): Promise<Muxer> {
    if (this.#muxer !== undefined) return this.#muxer;
    this.#muxerPromise ??= this.#createMuxer();
    return this.#muxerPromise;
  }

  async #createMuxer(): Promise<Muxer> {
    try {
      const driver = await this.#config.load();
      const muxer = driver.createMuxer(this.#config.muxOptions);
      this.#muxer = muxer;
      this.#pumpOutput(muxer.output);
      for (const track of this.#tracks) this.#targetTrackIds.push(muxer.addTrack(track));
      return muxer;
    } catch (error) {
      await this.#errorOutput(error);
      throw error;
    }
  }

  #pumpOutput(output: ReadableStream<Uint8Array>): void {
    void (async (): Promise<void> => {
      await this.#ready;
      const controller = this.#controller;
      if (controller === undefined) return;
      const reader = output.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async #errorOutput(error: unknown): Promise<void> {
    await this.#ready;
    this.#controller?.error(error);
  }
}
